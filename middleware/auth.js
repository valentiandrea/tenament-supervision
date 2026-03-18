const jwt  = require('jsonwebtoken');

const JWT_SECRET = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET env var not set');
  return process.env.JWT_SECRET;
};

// Role level: higher = more privileges
const ROLE_LEVEL = { admin: 2, user: 1 };

// Which roles may access each view
const PAGE_ACCESS = {
  dashboard:    ['user', 'admin'],
  projects:     ['user', 'admin'],
  map:          ['user', 'admin'],
  intelligence: ['user', 'admin'],
  prices:       ['user', 'admin'],
  flora:        ['user', 'admin'],
  drill:        ['user', 'admin'],
  batches:      ['admin'],
  upload:       ['admin'],
  changes:      ['admin'],
  users:        ['admin'],
};

// ── Token helpers ─────────────────────────────────────────────
function issueAccessToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), username: user.username, role: user.role, mcp: user.mustChangePassword ? 1 : 0 },
    JWT_SECRET(),
    { expiresIn: '15m', algorithm: 'HS256' }
  );
}

const COOKIE_BASE = {
  httpOnly:  true,
  sameSite:  'Strict',
  path:      '/'
};

function setAccessCookie(res, token) {
  res.cookie('at', token, {
    ...COOKIE_BASE,
    secure:  process.env.NODE_ENV === 'production',
    maxAge:  15 * 60 * 1000
  });
}

function setRefreshCookie(res, token) {
  res.cookie('rt', token, {
    ...COOKIE_BASE,
    secure:  process.env.NODE_ENV === 'production',
    maxAge:  7 * 24 * 60 * 60 * 1000,
    path:    '/api/auth'   // scope refresh cookie to auth endpoints only
  });
}

function clearAuthCookies(res) {
  res.clearCookie('at',  { ...COOKIE_BASE });
  res.clearCookie('rt',  { ...COOKIE_BASE, path: '/api/auth' });
}

// ── Middleware ────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.at;
  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required', code: 'UNAUTHENTICATED' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET(), { algorithms: ['HS256'] });
    req.user = { id: payload.sub, username: payload.username, role: payload.role, mustChangePassword: !!payload.mcp };

    // Block all protected routes until user sets a new password
    if (payload.mcp) {
      const url = req.originalUrl;
      const allowed = url.startsWith('/api/auth/change-password') || url.startsWith('/api/auth/logout');
      if (!allowed) {
        return res.status(403).json({ success: false, error: 'You must change your password before continuing.', code: 'MUST_CHANGE_PASSWORD' });
      }
    }

    next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    return res.status(401).json({ success: false, error: 'Session expired', code });
  }
}

function requireRole(role) {
  return [requireAuth, (req, res, next) => {
    if ((ROLE_LEVEL[req.user.role] || 0) < (ROLE_LEVEL[role] || 0)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' });
    }
    next();
  }];
}

module.exports = { requireAuth, requireRole, issueAccessToken, setAccessCookie, setRefreshCookie, clearAuthCookies, PAGE_ACCESS };
