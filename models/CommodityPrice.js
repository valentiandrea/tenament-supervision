const mongoose = require('mongoose');

const pricePointSchema = new mongoose.Schema({
  date:  { type: Date,   required: true },
  open:  { type: Number },
  high:  { type: Number },
  low:   { type: Number },
  close: { type: Number, required: true }
}, { _id: false });

const commodityPriceSchema = new mongoose.Schema({
  symbol:      { type: String, required: true, unique: true, trim: true },
  name:        { type: String },
  unit:        { type: String },
  currency:    { type: String, default: 'USD' },
  timeseries:  [pricePointSchema],
  lastUpdated: { type: Date }
}, { timestamps: false });

module.exports = mongoose.model('CommodityPrice', commodityPriceSchema);
