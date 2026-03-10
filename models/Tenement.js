const mongoose = require('mongoose');

const holderSchema = new mongoose.Schema({
  name: { type: String },
  address: { type: String }
}, { _id: false });

const tenementSchema = new mongoose.Schema({
  // From KML
  kmlName: { type: String, required: true },
  sourceFile: { type: String, required: true },
  rawCoordinates: { type: String },
  polygon: { type: [[Number]] }, // array of [lon, lat] pairs

  // From TENGRAPH API
  matched: { type: Boolean, default: false },
  tenementId: { type: String },      // fmt_tenid e.g. "E 38/4003"
  tenStatus: { type: String },       // LIVE, PENDING, etc
  tenType: { type: String },         // EXPLORATION LICENCE, MINING LEASE, etc
  legalArea: { type: Number },
  areaUnit: { type: String },
  surveyStatus: { type: String },
  grantDate: { type: Date },
  startDate: { type: Date },
  endDate: { type: Date },
  holderCount: { type: Number, default: 0 },
  holders: [holderSchema],
  apiRawData: { type: mongoose.Schema.Types.Mixed },

  // User classification
  classification: {
    type: String,
    enum: ['internal', 'external', 'unclassified'],
    default: 'unclassified'
  },
  classificationNote: { type: String },
  classifiedAt: { type: Date },
  classifiedBy: { type: String },

  // Reference to batch
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

tenementSchema.index({ batchId: 1 });
tenementSchema.index({ classification: 1 });
tenementSchema.index({ tenStatus: 1 });
tenementSchema.index({ tenementId: 1 });

module.exports = mongoose.model('Tenement', tenementSchema);
