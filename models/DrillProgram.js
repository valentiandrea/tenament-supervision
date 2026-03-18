const mongoose = require('mongoose');

const drillHoleSchema = new mongoose.Schema({
  type:        { type: String, enum: ['DD', 'RC'], required: true },
  name:        { type: String, required: true },
  easting:     { type: Number, required: true },
  northing:    { type: Number, required: true },
  azimuth:     { type: Number, required: true },
  dip:         { type: Number, required: true },
  targetDepth:   { type: Number, required: true },
  status:        { type: String, enum: ['Planned', 'Active', 'Complete', 'On Hold'], default: 'Planned' },
  metresDrilled: { type: Number, default: 0 },
  notes:         { type: String, default: '' }
}, { _id: false });

const drillProgramSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  kmlName:   { type: String },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'KMLProject' },
  holes:     [drillHoleSchema],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('DrillProgram', drillProgramSchema);
