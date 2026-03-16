require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ── Security headers ──────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "https://unpkg.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      imgSrc:     ["'self'", "data:", "https://*.tile.openstreetmap.org"],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrcAttr:  ["'unsafe-inline'"]
    }
  },
  crossOriginEmbedderPolicy: false,  // required for Leaflet tiles
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// ── CORS — restrict to own origin in production ───────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin: isProd
    ? (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) cb(null, true);
        else cb(new Error('CORS: origin not allowed'));
      }
    : true,          // allow all in dev
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── Body parsing with size limits ────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Rate limiting ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many upload requests, please try again later.' }
});

const recheckLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 20,
  message: { success: false, error: 'Re-check limit reached, please wait before retrying.' }
});

app.use('/api/', apiLimiter);
app.use('/api/batches/upload', uploadLimiter);
app.use('/api/metadata/upload', uploadLimiter);
app.use('/api/changes/recheck', recheckLimiter);

// ── Azure Easy Auth identity header ──────────────────────────
// In production, Azure injects X-MS-CLIENT-PRINCIPAL-NAME after auth
// Requests without it are blocked by App Service before reaching here
app.use((req, res, next) => {
  if (isProd) {
    const user = req.headers['x-ms-client-principal-name'];
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    req.user = user;
  }
  next();
});

// ── Static files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ────────────────────────────────────────────────
app.use('/api/batches',  require('./routes/api/batches'));
app.use('/api/projects', require('./routes/api/projects'));
app.use('/api/changes',  require('./routes/api/changes'));
app.use('/api/metadata', require('./routes/api/metadata'));

// ── SPA catch-all ─────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    error: isProd ? 'Internal server error' : err.message
  });
});

// ── Database + listen ─────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`));
  })
  .catch(err => { console.error('MongoDB error:', err.message); process.exit(1); });
