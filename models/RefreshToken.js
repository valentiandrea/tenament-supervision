const mongoose = require('mongoose');
const crypto   = require('crypto');

const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const refreshTokenSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },  // SHA-256 of raw token
  expiresAt: { type: Date,   required: true },
  userAgent: { type: String, default: '' },
  ip:        { type: String, default: '' },
  createdAt: { type: Date,   default: Date.now }
});

// MongoDB TTL index — auto-deletes expired documents
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

refreshTokenSchema.statics.issue = async function(userId, req) {
  const raw  = crypto.randomBytes(48).toString('hex');
  await this.create({
    userId,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + EXPIRY_MS),
    userAgent: (req.headers['user-agent'] || '').slice(0, 200),
    ip:        req.ip || ''
  });
  return raw;
};

refreshTokenSchema.statics.consume = async function(raw) {
  // Atomically find and delete — prevents replay even under concurrency
  const doc = await this.findOneAndDelete({
    tokenHash: hashToken(raw),
    expiresAt: { $gt: new Date() }
  });
  return doc; // null if not found / expired
};

refreshTokenSchema.statics.revokeAll = async function(userId) {
  return this.deleteMany({ userId });
};

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
