require('dotenv').config();
const express      = require('express');
const mongoose     = require('mongoose');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path         = require('path');

const { requireAuth, requireRole } = require('./middleware/auth');

const app = express();
app.set('trust proxy', 1);
const PORT   = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters');
  process.exit(1);
}

// ── Security headers ──────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "https://unpkg.com", "https://cdn.jsdelivr.net"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.jsdelivr.net"],
      imgSrc:         ["'self'", "data:", "https://server.arcgisonline.com", "https://earthengine.googleapis.com", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      connectSrc:     ["'self'", "https://earthengine.googleapis.com"],
      fontSrc:        ["'self'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrcAttr:  ["'unsafe-inline'"]   // required: dynamic table rows use onclick= attributes
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false
}));

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin: isProd
    ? (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) cb(null, true);
        else cb(new Error('CORS: origin not allowed'));
      }
    : true,
  methods:          ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders:   ['Content-Type'],
  credentials:      true   // needed for cookies
}));

// ── Body + cookie parsing ─────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// ── Rate limiting ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many upload requests, please try again later.' }
});

const recheckLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Re-check limit reached, please wait before retrying.' }
});

app.use('/api/',                   apiLimiter);
app.use('/api/batches/upload',     uploadLimiter);
app.use('/api/metadata/upload',    uploadLimiter);
app.use('/api/changes/recheck',    recheckLimiter);

// ── Azure Easy Auth (production outer layer) ──────────────────
app.use((req, res, next) => {
  if (isProd) {
    const azureUser = req.headers['x-ms-client-principal-name'];
    if (!azureUser) return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
});

// ── Static files (login page served without auth) ─────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Clean URL routes for auth pages ──────────────────────────
app.get('/login',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/change-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'change-password.html')));

// ── Auth routes (no requireAuth — handles login/refresh/logout) ─
app.use('/api/auth', require('./routes/api/auth'));

// ── Protected API routes ──────────────────────────────────────
app.use('/api/batches',      requireAuth, require('./routes/api/batches'));
app.use('/api/projects',     requireAuth, require('./routes/api/projects'));
app.use('/api/changes',      requireAuth, require('./routes/api/changes'));
app.use('/api/metadata',     requireAuth, require('./routes/api/metadata'));
app.use('/api/intelligence', requireAuth, require('./routes/api/intelligence'));
app.use('/api/prices',       requireAuth, require('./routes/api/prices'));
app.use('/api/flora',        requireAuth, require('./routes/api/flora'));
app.use('/api/drillprograms',requireAuth, require('./routes/api/drillprograms'));

// Admin-only routes get an extra role check in each router
// (destructive batch/changes/upload ops already gated inside their routers)

// ── SPA catch-all ─────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[error]', err.stack);
  res.status(err.status || 500).json({ success: false, error: 'Internal server error' });
});

// ── Database + listen ─────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`));
  })
  .catch(err => { console.error('MongoDB error:', err.message); process.exit(1); });
