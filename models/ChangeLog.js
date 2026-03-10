const mongoose = require('mongoose');

const changeLogSchema = new mongoose.Schema({
  sessionId:   { type: mongoose.Schema.Types.ObjectId, ref: 'CheckSession', required: true },
  projectId:   { type: mongoose.Schema.Types.ObjectId, ref: 'KMLProject',   required: true },
  kmlName:     { type: String },
  projectName: { type: String },
  tenementId:  { type: String },   // which tenement changed (null = project-level)

  changeType: {
    type: String,
    enum: [
      'status_change',       // LIVE ↔ PENDING etc.
      'new_tenement',        // a new tenement now intersects the KML
      'tenement_removed',    // a tenement no longer intersects
      'holder_change',       // holder name changed
      'license_change',      // tenement type changed
      'area_change',         // legal area changed
      'end_date_change'      // expiry date changed
    ],
    required: true
  },

  field:    { type: String },   // which field changed
  oldValue: { type: String },
  newValue: { type: String },

  detectedAt: { type: Date, default: Date.now }
});

changeLogSchema.index({ sessionId: 1 });
changeLogSchema.index({ projectId: 1 });
changeLogSchema.index({ changeType: 1 });

module.exports = mongoose.model('ChangeLog', changeLogSchema);
