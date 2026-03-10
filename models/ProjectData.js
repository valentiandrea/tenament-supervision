const mongoose = require('mongoose');

const subdivisionSchema = new mongoose.Schema({
  subdivisionId:    { type: String },  // e.g. "6-272017/0"
  insituBillion:    { type: Number },
  evBillion:        { type: Number },
  tonnages:         { type: Number },
  grade1: { type: Number }, grade2: { type: Number }, grade3: { type: Number },
  containedMetal1:  { type: Number },
  containedMetal2:  { type: Number },
  containedMetal3:  { type: Number },
  strike: { type: Number }, width:  { type: Number },
  ceiling: { type: Number }, floor: { type: Number },
  waterProximity:   { type: Number },
  distanceBetween:  { type: Number }
}, { _id: false });

const projectDataSchema = new mongoose.Schema({
  oreBodyId:   { type: String, required: true, unique: true }, // matches KMLProject.kmlName

  country:     { type: String },
  cumulativeML: { type: Number },
  mineLife:    { type: Number },

  commodity1:  { type: String },
  commodity2:  { type: String },
  commodity3:  { type: String },

  centerX:     { type: Number },
  centerY:     { type: Number },

  subdivisions: [subdivisionSchema],

  // Aggregated across all subdivisions
  totalInsituBillion:  { type: Number, default: 0 },
  totalEVBillion:      { type: Number, default: 0 },
  totalTonnages:       { type: Number, default: 0 },
  totalContainedMetal1: { type: Number, default: 0 },
  totalContainedMetal2: { type: Number, default: 0 },
  totalContainedMetal3: { type: Number, default: 0 },

  importedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProjectData', projectDataSchema);
