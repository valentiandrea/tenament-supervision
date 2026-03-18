const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const SALT_ROUNDS  = 12;
const MAX_FAILED   = 5;
const LOCKOUT_MS   = 15 * 60 * 1000; // 15 min

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]).{10,128}$/;

const userSchema = new mongoose.Schema({
  username: {
    type:      String,
    required:  true,
    unique:    true,
    trim:      true,
    lowercase: true,
    minlength: 3,
    maxlength: 50,
    match:     [/^[a-z0-9._-]+$/, 'Username may only contain letters, digits, dots, hyphens, underscores']
  },
  passwordHash:       { type: String, required: true, select: false },
  role:               { type: String, enum: ['admin', 'user'], default: 'user' },
  displayName:        { type: String, trim: true, maxlength: 100 },
  mustChangePassword: { type: Boolean, default: false },
  failedAttempts:     { type: Number, default: 0 },
  lockedUntil:        { type: Date,   default: null },
  lastLoginAt:        { type: Date,   default: null },
  passwordChangedAt:  { type: Date,   default: Date.now },
  createdAt:          { type: Date,   default: Date.now },
  updatedAt:          { type: Date,   default: Date.now }
});

// ── Statics ──────────────────────────────────────────────────
userSchema.statics.validatePasswordStrength = function(pw) {
  if (!PASSWORD_REGEX.test(pw)) {
    return 'Password must be at least 10 characters and include uppercase, lowercase, digit, and special character';
  }
  return null;
};

// ── Methods ──────────────────────────────────────────────────
userSchema.methods.setPassword = async function(plaintext) {
  const err = mongoose.model('User').validatePasswordStrength(plaintext);
  if (err) throw new Error(err);
  this.passwordHash      = await bcrypt.hash(plaintext, SALT_ROUNDS);
  this.passwordChangedAt = new Date();
  this.updatedAt         = new Date();
};

userSchema.methods.verifyPassword = async function(plaintext) {
  return bcrypt.compare(plaintext, this.passwordHash);
};

userSchema.methods.isLocked = function() {
  return this.lockedUntil && this.lockedUntil > new Date();
};

userSchema.methods.recordFailedAttempt = async function() {
  this.failedAttempts += 1;
  if (this.failedAttempts >= MAX_FAILED) {
    this.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
  }
  this.updatedAt = new Date();
  await this.save();
};

userSchema.methods.recordSuccessfulLogin = async function() {
  this.failedAttempts = 0;
  this.lockedUntil    = null;
  this.lastLoginAt    = new Date();
  this.updatedAt      = new Date();
  await this.save();
};

userSchema.methods.toSafeObject = function() {
  return {
    id:                 this._id,
    username:           this.username,
    role:               this.role,
    displayName:        this.displayName,
    mustChangePassword: this.mustChangePassword,
    lastLoginAt:        this.lastLoginAt,
    createdAt:          this.createdAt
  };
};

module.exports = mongoose.model('User', userSchema);
