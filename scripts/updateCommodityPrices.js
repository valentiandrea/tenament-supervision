#!/usr/bin/env node
/**
 * updateCommodityPrices.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches commodity price timeseries from commoditypriceapi.com and saves it
 * to MongoDB. Run this on a schedule (e.g. daily via cron or Azure Function)
 * to keep prices fresh without hitting the API on every user request.
 *
 * Usage:
 *   node scripts/updateCommodityPrices.js
 *   node scripts/updateCommodityPrices.js --symbols XAU,XAG,COPPER
 *   node scripts/updateCommodityPrices.js --from 2022-01-01
 *   node scripts/updateCommodityPrices.js --symbols XAU --from 2020-01-01
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios    = require('axios');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
const API_KEY   = process.env.COMMODITY_API_KEY || 'f720da6d-f4df-4b1f-9996-28223d7cd024';
const API_BASE  = 'https://api.commoditypriceapi.com/v2';

if (!MONGO_URI) {
  console.error('ERROR: MONGODB_URI is not set in .env');
  process.exit(1);
}

// ─── All symbols to fetch by default ──────────────────────────────────────────
// Symbols verified against /v2/symbols endpoint
const DEFAULT_SYMBOLS = [
  { symbol: 'XAU',         name: 'Gold',            unit: 'T.oz' },
  { symbol: 'XAG',         name: 'Silver',          unit: 'T.oz' },
  { symbol: 'PL',          name: 'Platinum',        unit: 'T.oz' },
  { symbol: 'PA',          name: 'Palladium',       unit: 'T.oz' },
  { symbol: 'HG-SPOT',     name: 'Copper',          unit: 'Lb'   },
  { symbol: 'NICKEL-FUT',  name: 'Nickel',          unit: 'MT'   },
  { symbol: 'ZINC',        name: 'Zinc',            unit: 'MT'   },
  { symbol: 'LEAD-SPOT',   name: 'Lead',            unit: 'MT'   },
  { symbol: 'AL-SPOT',     name: 'Aluminium',       unit: 'MT'   },
  { symbol: 'COB',         name: 'Cobalt',          unit: 'MT'   },
  { symbol: 'LC',          name: 'Lithium',         unit: 'MT', currency: 'CNY' },
  { symbol: 'UXA',         name: 'Uranium',         unit: 'Lb'   },
  { symbol: 'IORECR',      name: 'Iron Ore',        unit: 'DMT'  },
  { symbol: 'MANGELE',     name: 'Manganese',       unit: 'MT'   },
  { symbol: 'COAL',        name: 'Coal',            unit: 'MT'   },
  { symbol: 'WTIOIL-FUT',  name: 'Crude Oil (WTI)', unit: 'Bbl'  },
  { symbol: 'NG-FUT',      name: 'Natural Gas',     unit: 'MMBtu'},
];

// ─── MongoDB model (inline so script is self-contained) ───────────────────────
const pricePointSchema = new mongoose.Schema({
  date:  { type: Date,   required: true },
  open:  { type: Number },
  high:  { type: Number },
  low:   { type: Number },
  close: { type: Number, required: true }
}, { _id: false });

const CommodityPrice = mongoose.models.CommodityPrice ||
  mongoose.model('CommodityPrice', new mongoose.Schema({
    symbol:      { type: String, required: true, unique: true, trim: true },
    name:        String,
    unit:        String,
    currency:    { type: String, default: 'USD' },
    timeseries:  [pricePointSchema],
    lastUpdated: Date
  }));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function apiGet(path) {
  const url = `${API_BASE}${path}`;
  try {
    const res = await axios.get(url, {
      timeout: 30000,
      headers: { 'x-api-key': API_KEY }
    });
    return res.data;
  } catch (e) {
    const body = e.response?.data;
    const msg  = (typeof body === 'object' ? JSON.stringify(body) : body) || e.message;
    throw new Error(`HTTP ${e.response?.status}: ${msg}`);
  }
}

// ─── Fetch one year of timeseries for a symbol ────────────────────────────────
async function fetchChunk(symbol, startDate, endDate) {
  // Correct endpoint: /v2/rates/time-series  auth via x-api-key header
  const path = `/rates/time-series?symbols=${symbol}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}`;
  const resp = await apiGet(path);

  if (resp.success === false) {
    const msg = resp.error?.message || resp.message || JSON.stringify(resp);
    throw new Error(msg);
  }

  // Response: { rates: { 'YYYY-MM-DD': { SYMBOL: { open, high, low, close } } } }
  const rates  = resp.rates || {};
  const points = [];

  for (const [dateStr, dayRates] of Object.entries(rates)) {
    // Each day has { SYMBOL: { open, high, low, close } }
    const v = dayRates[symbol] ?? dayRates[symbol.toUpperCase()] ?? dayRates[symbol.toLowerCase()];
    if (!v) continue;
    const close = v.close ?? v.Close;
    if (close == null || isNaN(Number(close))) continue;

    points.push({
      date:  new Date(dateStr),
      open:  v.open != null ? Number(v.open) : null,
      high:  v.high != null ? Number(v.high) : null,
      low:   v.low  != null ? Number(v.low)  : null,
      close: Number(close)
    });
  }

  return points.sort((a, b) => a.date - b.date);
}

// ─── Upsert points into MongoDB (merge with existing, no duplicates) ──────────
async function upsertCommodity(symInfo, allPoints) {
  if (!allPoints.length) {
    await CommodityPrice.updateOne(
      { symbol: symInfo.symbol },
      { $set: { name: symInfo.name, unit: symInfo.unit, lastUpdated: new Date() } },
      { upsert: true }
    );
    return 0;
  }

  const doc = await CommodityPrice.findOne({ symbol: symInfo.symbol }, { 'timeseries.date': 1 }).lean();
  const existingMs = new Set((doc?.timeseries || []).map(p => new Date(p.date).getTime()));

  const newPoints = allPoints.filter(p => !existingMs.has(p.date.getTime()));
  if (!newPoints.length) return 0;

  await CommodityPrice.findOneAndUpdate(
    { symbol: symInfo.symbol },
    {
      $set:  { name: symInfo.name, unit: symInfo.unit, currency: symInfo.currency || 'USD', lastUpdated: new Date() },
      $push: { timeseries: { $each: newPoints, $sort: { date: 1 } } }
    },
    { upsert: true }
  );
  return newPoints.length;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // --symbols XAU,XAG,COPPER
  const symbolArg = args.find(a => a.startsWith('--symbols='))?.slice(10)
                 ?? (args.includes('--symbols') ? args[args.indexOf('--symbols') + 1] : null);

  // --from 2022-01-01
  const fromArg = args.find(a => a.startsWith('--from='))?.slice(7)
               ?? (args.includes('--from') ? args[args.indexOf('--from') + 1] : null);

  const targetSymbols = symbolArg
    ? symbolArg.split(',').map(s => s.trim().toUpperCase())
    : null;

  const symbols = DEFAULT_SYMBOLS.filter(s =>
    !targetSymbols || targetSymbols.includes(s.symbol)
  );

  if (!symbols.length) {
    console.error(`No matching symbols found for: ${targetSymbols?.join(', ')}`);
    console.error(`Available: ${DEFAULT_SYMBOLS.map(s => s.symbol).join(', ')}`);
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB\n');

  const now       = new Date();
  const tenYears  = new Date(now.getFullYear() - 10, now.getMonth(), now.getDate());
  const startDate = fromArg ? new Date(fromArg) : tenYears;

  if (isNaN(startDate)) {
    console.error(`Invalid --from date: ${fromArg}`);
    process.exit(1);
  }

  console.log(`Date range : ${fmtDate(startDate)} → ${fmtDate(now)}`);
  console.log(`Symbols    : ${symbols.map(s => s.symbol).join(', ')}\n`);

  let totalNew = 0;
  let errors   = 0;

  for (const sym of symbols) {
    try {
      // Split into ≤1-year chunks (API constraint)
      const chunks = [];
      let chunkStart = new Date(startDate);
      while (chunkStart < now) {
        // 364 days max per chunk (safely under 1-year limit including leap years)
        const next = new Date(chunkStart.getTime() + 364 * 86400000);
        chunks.push({ start: new Date(chunkStart), end: next > now ? now : next });
        chunkStart = new Date(next.getTime() + 86400000);
      }

      let allPoints = [];
      for (const { start, end } of chunks) {
        process.stdout.write(`  [${sym.symbol}] ${fmtDate(start)} → ${fmtDate(end)} ... `);
        const pts = await fetchChunk(sym.symbol, start, end);
        console.log(`${pts.length} points`);
        allPoints = allPoints.concat(pts);
        if (chunks.length > 1) await sleep(600);  // polite pacing
      }

      const added = await upsertCommodity(sym, allPoints);
      console.log(`  [${sym.symbol}] +${added} new point(s) saved\n`);
      totalNew += added;
      await sleep(350);  // stay well within per-minute rate limit

    } catch (e) {
      console.error(`  [${sym.symbol}] FAILED: ${e.message}\n`);
      errors++;
    }
  }

  console.log(`─────────────────────────────────────────`);
  console.log(`Done. ${totalNew} new price points saved across ${symbols.length - errors} symbol(s).`);
  if (errors) console.log(`${errors} symbol(s) failed — check errors above.`);

  await mongoose.disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
