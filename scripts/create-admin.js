/**
 * Run once to create the first admin user:
 *   node scripts/create-admin.js
 *
 * Reads ADMIN_USERNAME and ADMIN_PASSWORD from environment (or .env).
 * Password must meet strength requirements:
 *   - 10+ chars, uppercase, lowercase, digit, special character
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('../models/User');

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const displayName = process.env.ADMIN_DISPLAY || 'Administrator';

  if (!username || !password) {
    console.error('Set ADMIN_USERNAME and ADMIN_PASSWORD in environment or .env');
    process.exit(1);
  }

  const strengthErr = User.validatePasswordStrength(password);
  if (strengthErr) { console.error('Password too weak:', strengthErr); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const existing = await User.findOne({ username: username.toLowerCase() });
  if (existing) {
    console.log(`User "${username}" already exists (role: ${existing.role}). Nothing changed.`);
    return;
  }

  const user = new User({ username, role: 'admin', displayName });
  await user.setPassword(password);
  await user.save();

  console.log(`Admin user "${username}" created successfully.`);
}

main()
  .catch(err => { console.error(err.message); process.exit(1); })
  .finally(() => mongoose.disconnect());
