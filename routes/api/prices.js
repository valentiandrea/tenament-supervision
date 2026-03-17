const express        = require('express');
const router         = express.Router();
const CommodityPrice = require('../../models/CommodityPrice');
const { holtForecast } = require('../../services/commodityPriceService');

// GET /api/prices  — list all symbols available in the database
router.get('/', async (req, res) => {
  try {
    const docs = await CommodityPrice.aggregate([
      {
        $project: {
          symbol:      1,
          name:        1,
          unit:        1,
          currency:    1,
          lastUpdated: 1,
          latestClose: { $last:  '$timeseries.close' },
          latestDate:  { $last:  '$timeseries.date'  },
          pointCount:  { $size:  '$timeseries'        }
        }
      },
      { $sort: { name: 1 } }
    ]);
    res.json({ success: true, data: docs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/prices/:symbol  — timeseries slice + Holt forecast
// Query params:
//   days     (default 365, max 1825) — historical window
//   forecast (default 180, max 365) — forecast horizon in days
router.get('/:symbol', async (req, res) => {
  try {
    const symbol       = req.params.symbol.toUpperCase().replace(/[^A-Z0-9\-]/g, '');
    const days         = Math.min(Math.max(parseInt(req.query.days)     || 365, 30), 3650);
    const forecastDays = Math.min(Math.max(parseInt(req.query.forecast) || 180, 7),  365);

    const doc = await CommodityPrice.findOne({ symbol }).lean();
    if (!doc || !doc.timeseries.length) {
      return res.status(404).json({ success: false, error: `No price data for ${symbol}` });
    }

    // Full display series — sorted ascending, sliced to the requested window
    const cutoff = new Date(Date.now() - days * 86400000);
    const series = doc.timeseries
      .filter(p => new Date(p.date) >= cutoff)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    if (series.length < 4) {
      return res.status(404).json({ success: false, error: 'Not enough data in requested window (min 4 points)' });
    }

    // Pass the full available history to the forecast model.
    // The Analog model needs several years of data to find meaningful pattern matches.
    // Holt and OU internally slice to their own TREND_WINDOW (last 90 days).
    const allPrices = doc.timeseries
      .slice()
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map(p => p.close);

    const model = holtForecast(allPrices, forecastDays);

    // Build forecast dates anchored to the last available price date
    const lastDate = new Date(series[series.length - 1].date);
    const forecast = model ? model.forecast.map((f, i) => ({
      date:  new Date(lastDate.getTime() + (i + 1) * 86400000).toISOString(),
      value: f.value,
      lower: f.lower,
      upper: f.upper
    })) : [];

    res.json({
      success: true,
      data: {
        symbol:      doc.symbol,
        name:        doc.name,
        unit:        doc.unit,
        currency:    doc.currency || 'USD',
        lastUpdated: doc.lastUpdated,
        timeseries:  series,
        forecast,
        model: model ? { alpha: model.alpha, beta: model.beta, rmse: model.rmse } : null,
        stats: _computeStats(series.map(p => p.close), series)
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

function _computeStats(closePrices, series) {
  const n      = closePrices.length;
  const latest = closePrices[n - 1];

  function pctChange(daysBack) {
    const idx = n - 1 - daysBack;
    if (idx < 0) return null;
    const old = closePrices[idx];
    if (!old) return null;
    return Math.round(((latest - old) / old) * 10000) / 100;
  }

  const min52w = Math.min(...closePrices);
  const max52w = Math.max(...closePrices);

  return {
    latest,
    change30d:  pctChange(30),
    change90d:  pctChange(90),
    change365d: pctChange(Math.min(n - 1, 365)),
    min52w:     Math.round(min52w  * 1000) / 1000,
    max52w:     Math.round(max52w  * 1000) / 1000,
    rangePercent: Math.round(((max52w - min52w) / min52w) * 10000) / 100
  };
}

module.exports = router;
