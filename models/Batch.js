const mongoose = require('mongoose');

const batchSchema = new mongoose.Schema({
  name: { type: String, required: true },
  totalFiles: { type: Number, default: 0 },
  totalTenements: { type: Number, default: 0 },
  matchedCount: { type: Number, default: 0 },
  internalCount: { type: Number, default: 0 },
  externalCount: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['processing', 'completed', 'failed'],
    default: 'processing'
  },
  error: { type: String },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
});

module.exports = mongoose.model('Batch', batchSchema);
