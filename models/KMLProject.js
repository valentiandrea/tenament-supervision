const mongoose = require('mongoose');

const tenementSchema = new mongoose.Schema({
  tenementId: { type: String },       // fmt_tenid e.g. "E 38/4003"
  tenStatus:  { type: String },       // LIVE, PENDING, etc
  tenType:    { type: String },
  commodity:      { type: String },
  lodgeDate:      { type: Date },
  reportDue:      { type: Date },
  pendStatus:     { type: String },
  localGovt:      { type: String },
  shire:          { type: String },
  stateRegion:    { type: String },
  blocks:         { type: Number },
  subBlocks:      { type: Number },
  natRes:         { type: String },
  nativeTitle:    { type: String },
  mortgagee:      { type: String },
  purposeAppl:    { type: String },
  miningActivity: { type: String },
  legalArea:  { type: Number },
  areaUnit:   { type: String },
  surveyStatus: { type: String },
  grantDate:  { type: Date },
  startDate:  { type: Date },
  endDate:    { type: Date },
  holderCount: { type: Number, default: 0 },
  holders: [{
    name:    { type: String },
    address: { type: String },
    _id: false
  }],
  apiRawData: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const kmlProjectSchema = new mongoose.Schema({
  // KML identity
  kmlName:        { type: String, required: true },
  projectName:    { type: String, default: '' },   // user-defined display name
  sourceFile:     { type: String, required: true },
  rawCoordinates: { type: String },
  polygon:        { type: [[Number]] },   // [[lon, lat], ...]

  // TENGRAPH results (one entry per intersecting tenement)
  tenements:      [tenementSchema],
  matchedCount:   { type: Number, default: 0 },

  // User classification (on the KML/project level)
  classification: {
    type: String,
    enum: ['internal', 'external', 'unclassified'],
    default: 'unclassified'
  },
  classificationNote: { type: String },
  classifiedAt:   { type: Date },

  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

kmlProjectSchema.index({ batchId: 1 });
kmlProjectSchema.index({ classification: 1 });

module.exports = mongoose.model('KMLProject', kmlProjectSchema);
