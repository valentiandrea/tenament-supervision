const mongoose = require('mongoose');

const checkSessionSchema = new mongoose.Schema({
  name:            { type: String },
  projectsChecked: { type: Number, default: 0 },
  changesFound:    { type: Number, default: 0 },
  status:          { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
  error:           { type: String },
  startedAt:       { type: Date, default: Date.now },
  completedAt:     { type: Date }
});

module.exports = mongoose.model('CheckSession', checkSessionSchema);
