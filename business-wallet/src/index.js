require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');

const webhookRoutes      = require('./routes/webhook');
const customerRoutes     = require('./routes/customers');
const conversationRoutes = require('./routes/conversations');
const sellerRoutes       = require('./routes/seller');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. mobile apps, Postman)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api', rateLimit({
  windowMs: 60_000,   // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}));

// The webhook route does its own raw body capture, so we mount it BEFORE
// express.json() to avoid stream conflicts.
app.use('/api', webhookRoutes);

// ── JSON body parsing (all other routes) ─────────────────────────────────────
app.use(express.json({ limit: '64kb' }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/customers',      customerRoutes);
app.use('/api/conversations',  conversationRoutes);
app.use('/api/seller',         sellerRoutes);

// ── Health check (used by Render to verify the service is up) ─────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Business Wallet API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
