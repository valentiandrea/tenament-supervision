const express      = require('express');
const rateLimit    = require('express-rate-limit');
const bcrypt       = require('bcrypt');
const User         = require('../../models/User');
const RefreshToken = require('../../models/RefreshToken');
const { requireAuth, requireRole, issueAccessToken, setAccessCookie, setRefreshCookie, clearAuthCookies, PAGE_ACCESS } = require('../../middleware/auth');

const router = express.Router();

// Strict rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many attempts. Try again later.' }
});

// Even stricter for login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      8,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' }
});

// ── Dummy hash used to prevent user-enumeration via timing ────
const DUMMY_HASH = '$2b$12$invalidsaltinvalidhashvalueplaceholderabc';

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    // Always fetch with passwordHash even though it's select:false
    const user = await User.findOne({ username: username.toLowerCase().trim() }).select('+passwordHash');

    // Always run bcrypt to prevent timing-based user enumeration
    const match = user
      ? await user.verifyPassword(password)
      : await bcrypt.compare(password, DUMMY_HASH).catch(() => false);

    if (!user || !match) {
      if (user) await user.recordFailedAttempt();
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (user.isLocked()) {
      const mins = Math.ceil((user.lockedUntil - Date.now()) / 60000);
      return res.status(423).json({ success: false, error: `Account locked. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` });
    }

    await user.recordSuccessfulLogin();

    const accessToken  = issueAccessToken(user);
    const refreshToken = await RefreshToken.issue(user._id, req);

    setAccessCookie(res, accessToken);
    setRefreshCookie(res, refreshToken);

    res.json({ success: true, user: user.toSafeObject(), pageAccess: PAGE_ACCESS });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', authLimiter, async (req, res) => {
  try {
    const raw = req.cookies && req.cookies.rt;
    if (!raw) return res.status(401).json({ success: false, error: 'No refresh token', code: 'UNAUTHENTICATED' });

    // consume() atomically deletes the token (prevents replay)
    const stored = await RefreshToken.consume(raw);
    if (!stored) {
      clearAuthCookies(res);
      return res.status(401).json({ success: false, error: 'Session expired', code: 'UNAUTHENTICATED' });
    }

    const user = await User.findById(stored.userId);
    if (!user) {
      clearAuthCookies(res);
      return res.status(401).json({ success: false, error: 'User not found', code: 'UNAUTHENTICATED' });
    }

    // Issue rotated tokens
    const accessToken      = issueAccessToken(user);
    const newRefreshToken  = await RefreshToken.issue(user._id, req);

    setAccessCookie(res, accessToken);
    setRefreshCookie(res, newRefreshToken);

    res.json({ success: true, user: user.toSafeObject(), pageAccess: PAGE_ACCESS });
  } catch (err) {
    console.error('[auth/refresh]', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const raw = req.cookies && req.cookies.rt;
    if (raw) await RefreshToken.consume(raw).catch(() => {});
    clearAuthCookies(res);
    res.json({ success: true });
  } catch (err) {
    console.error('[auth/logout]', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user: user.toSafeObject(), pageAccess: PAGE_ACCESS });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/auth/change-password ───────────────────────────
router.post('/change-password', requireAuth, authLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Current and new password required' });
    }

    const user = await User.findById(req.user.id).select('+passwordHash');
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const match = await user.verifyPassword(currentPassword);
    if (!match) return res.status(401).json({ success: false, error: 'Current password is incorrect' });

    if (currentPassword === newPassword) {
      return res.status(400).json({ success: false, error: 'New password must differ from current password' });
    }

    const strengthErr = User.validatePasswordStrength(newPassword);
    if (strengthErr) return res.status(400).json({ success: false, error: strengthErr });

    await user.setPassword(newPassword);
    user.mustChangePassword = false;
    await user.save();

    // Revoke all refresh tokens → force re-login on other devices
    await RefreshToken.revokeAll(user._id);
    clearAuthCookies(res);

    res.json({ success: true, message: 'Password changed. Please log in again.' });
  } catch (err) {
    console.error('[auth/change-password]', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Admin: list users ─────────────────────────────────────────
router.get('/users', requireRole('admin'), async (req, res) => {
  try {
    const users = await User.find({}).lean();
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Admin: create user ────────────────────────────────────────
router.post('/users', requireRole('admin'), async (req, res) => {
  try {
    const { username, password, role, displayName } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const strengthErr = User.validatePasswordStrength(password);
    if (strengthErr) return res.status(400).json({ success: false, error: strengthErr });

    const user = new User({ username, role: role || 'user', displayName: displayName || '', mustChangePassword: true });
    await user.setPassword(password);
    await user.save();

    res.status(201).json({ success: true, data: user.toSafeObject() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, error: 'Username already exists' });
    console.error('[auth/create-user]', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Admin: update user role / displayName ─────────────────────
router.patch('/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const { role, displayName } = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Prevent admin from demoting themselves
    if (req.params.id === req.user.id && role && role !== 'admin') {
      return res.status(400).json({ success: false, error: 'Cannot change your own role' });
    }

    if (role)        user.role        = role;
    if (displayName !== undefined) user.displayName = String(displayName).slice(0, 100);
    user.updatedAt = new Date();
    await user.save();

    res.json({ success: true, data: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Admin: reset user password ────────────────────────────────
router.post('/users/:id/reset-password', requireRole('admin'), async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword) return res.status(400).json({ success: false, error: 'New password required' });

    const strengthErr = User.validatePasswordStrength(newPassword);
    if (strengthErr) return res.status(400).json({ success: false, error: strengthErr });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    await user.setPassword(newPassword);
    user.mustChangePassword = true;
    await user.save();

    // Revoke all their sessions
    await RefreshToken.revokeAll(user._id);

    res.json({ success: true, message: 'Password reset. User must log in again.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Admin: delete user ────────────────────────────────────────
router.delete('/users/:id', requireRole('admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    await RefreshToken.revokeAll(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
