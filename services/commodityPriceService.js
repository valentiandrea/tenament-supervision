// Commodity name (from ProjectData) → API symbol mapping
// Covers common Western Australian mining commodities
// Symbols verified against commoditypriceapi.com /v2/symbols endpoint
const COMMODITY_MAP = {
  'GOLD':        { symbol: 'XAU',         name: 'Gold',            unit: 'T.oz' },
  'SILVER':      { symbol: 'XAG',         name: 'Silver',          unit: 'T.oz' },
  'PLATINUM':    { symbol: 'PL',          name: 'Platinum',        unit: 'T.oz' },
  'PALLADIUM':   { symbol: 'PA',          name: 'Palladium',       unit: 'T.oz' },
  'COPPER':      { symbol: 'HG-SPOT',     name: 'Copper',          unit: 'Lb'   },
  'NICKEL':      { symbol: 'NICKEL-FUT',  name: 'Nickel',          unit: 'MT'   },
  'ZINC':        { symbol: 'ZINC',        name: 'Zinc',            unit: 'MT'   },
  'LEAD':        { symbol: 'LEAD-SPOT',   name: 'Lead',            unit: 'MT'   },
  'ALUMINIUM':   { symbol: 'AL-SPOT',     name: 'Aluminium',       unit: 'MT'   },
  'ALUMINUM':    { symbol: 'AL-SPOT',     name: 'Aluminium',       unit: 'MT'   },
  'COBALT':      { symbol: 'COB',         name: 'Cobalt',          unit: 'MT'   },
  'LITHIUM':     { symbol: 'LC',          name: 'Lithium',         unit: 'MT'   },
  'URANIUM':     { symbol: 'UXA',         name: 'Uranium',         unit: 'Lb'   },
  'IRON ORE':    { symbol: 'IORECR',      name: 'Iron Ore',        unit: 'DMT'  },
  'IRON':        { symbol: 'IORECR',      name: 'Iron Ore',        unit: 'DMT'  },
  'MANGANESE':   { symbol: 'MANGELE',     name: 'Manganese',       unit: 'MT'   },
  'COAL':        { symbol: 'COAL',        name: 'Coal',            unit: 'MT'   },
  'CRUDE OIL':   { symbol: 'WTIOIL-FUT',  name: 'Crude Oil (WTI)', unit: 'Bbl'  },
  'OIL':         { symbol: 'WTIOIL-FUT',  name: 'Crude Oil (WTI)', unit: 'Bbl'  },
  'NATURAL GAS': { symbol: 'NG-FUT',      name: 'Natural Gas',     unit: 'MMBtu'},
  'GAS':         { symbol: 'NG-FUT',      name: 'Natural Gas',     unit: 'MMBtu'},
};

function mapCommodity(name) {
  if (!name) return null;
  return COMMODITY_MAP[name.toUpperCase().trim()] || null;
}

function getUniqueMappings(names) {
  const seen = new Set();
  const result = [];
  for (const n of names) {
    const m = mapCommodity(n);
    if (m && !seen.has(m.symbol)) {
      seen.add(m.symbol);
      result.push(m);
    }
  }
  return result;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function _r2(v)   { return Math.round(v * 100) / 100; }
function _max0(v) { return Math.max(0, v); }

function _mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function _stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = _mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function _logReturns(prices) {
  const r = [];
  for (let i = 1; i < prices.length; i++) {
    r.push(prices[i] > 0 && prices[i - 1] > 0 ? Math.log(prices[i] / prices[i - 1]) : 0);
  }
  return r;
}

function _zScore(arr) {
  const m = _mean(arr);
  const s = _stdDev(arr);
  return s > 0 ? arr.map(v => (v - m) / s) : arr.map(() => 0);
}

function _pearson(a, b) {
  // Both already z-scored; dot product / length = Pearson r
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s / n;
}

// ─── Model A: Analog / Historical Pattern Replay ─────────────────────────────
// Searches the full available history for the window most similar to the recent
// QUERY_LEN days (Pearson correlation on z-scored log-returns).
//
// THE KEY RULE: the central forecast value is taken DIRECTLY from the single
// best-matching analog — no averaging across multiple matches.
// Averaging cancels peaks in one match against troughs in another, producing
// the small flat line the user observed. By using one match, the full peak/trough
// shape of that historical path is preserved and projected onto the current price.
//
// The confidence interval is derived from the spread across the top matches,
// so it widens naturally when analogues disagree (high uncertainty) and stays
// tight when they agree.

const QUERY_LEN  = 45;   // recent days used as the "fingerprint" pattern
const TOP_K_CI   = 7;    // how many matches to use for the CI spread

function _analogModel(prices, horizonDays) {
  if (prices.length < QUERY_LEN * 2 + horizonDays) return null;

  const queryNorm = _zScore(_logReturns(prices.slice(-QUERY_LEN)));
  const lastPrice = prices[prices.length - 1];

  // Collect all candidate windows (must have horizonDays of future data)
  const maxStart = prices.length - QUERY_LEN - horizonDays;
  const candidates = [];

  for (let start = 0; start <= maxStart - QUERY_LEN; start++) {
    const winNorm = _zScore(_logReturns(prices.slice(start, start + QUERY_LEN)));
    const corr    = _pearson(queryNorm, winNorm);
    if (!isFinite(corr)) continue;
    const future      = prices.slice(start + QUERY_LEN, start + QUERY_LEN + horizonDays);
    const anchorPrice = prices[start + QUERY_LEN - 1];
    candidates.push({ corr, anchorPrice, future });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.corr - a.corr);
  const topMatches = candidates.slice(0, TOP_K_CI);
  const best       = topMatches[0];   // single best match drives the central forecast

  // RMSE proxy: average absolute deviation of top matches from the best match
  // at the mid-horizon point (gives a sense of how much matches diverge)
  const midH  = Math.floor(horizonDays / 2);
  const diffs = topMatches.map(m =>
    Math.abs(lastPrice * ((m.future[midH] - m.anchorPrice) / m.anchorPrice) -
             lastPrice * ((best.future[midH] - best.anchorPrice) / best.anchorPrice))
  );
  const analogRMSE = _mean(diffs);

  const forecast = [];
  for (let h = 0; h < horizonDays; h++) {
    // Central value: direct replay of the best single analog (preserves peaks/lows)
    const bestPct = (best.future[h] - best.anchorPrice) / best.anchorPrice;
    const value   = lastPrice * (1 + bestPct);

    // CI: 1.96 × std-dev of projected prices across all top matches at this horizon
    const projValues = topMatches.map(m => lastPrice * (1 + (m.future[h] - m.anchorPrice) / m.anchorPrice));
    const spread = Math.max(1.96 * _stdDev(projValues), Math.abs(value) * 0.005);

    forecast.push({
      value: _max0(_r2(value)),
      lower: _max0(_r2(value - spread)),
      upper: _r2(value + spread)
    });
  }

  return { fitted: prices.slice(1), forecast, rmse: _r2(analogRMSE) };
}

// ─── Model B: Damped Holt's Linear Trend ─────────────────────────────────────
// Calibrated to the last TREND_WINDOW days. Provides the current trend direction.
// Dampening factor φ prevents runaway extrapolation at long horizons.

const TREND_WINDOW = 90;

function _holtFit(prices, alpha, beta, phi) {
  let L = prices[0], T = prices[1] - prices[0];
  const fitted = new Array(prices.length);
  for (let i = 0; i < prices.length; i++) {
    const pL = L, pT = T;
    L = alpha * prices[i] + (1 - alpha) * (pL + phi * pT);
    T = beta  * (L - pL)  + (1 - beta)  * phi * pT;
    fitted[i] = L + phi * T;
  }
  return { L, T, fitted };
}

function _holtModel(prices, horizonDays) {
  const w = prices.length > TREND_WINDOW ? prices.slice(-TREND_WINDOW) : prices;
  if (w.length < 4) return null;

  const alphas = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const betas  = [0.01, 0.05, 0.1, 0.2, 0.3];
  const phis   = [0.80, 0.85, 0.90, 0.95, 0.98, 1.0];
  let best = { alpha: 0.3, beta: 0.1, phi: 0.9, mse: Infinity };

  for (const alpha of alphas)
    for (const beta of betas)
      for (const phi of phis) {
        let s = 0;
        const { fitted } = _holtFit(w, alpha, beta, phi);
        for (let i = 1; i < w.length; i++) s += (w[i] - fitted[i - 1]) ** 2;
        const mse = s / (w.length - 1);
        if (mse < best.mse) best = { alpha, beta, phi, mse };
      }

  const { alpha, beta, phi } = best;
  const { L, T, fitted } = _holtFit(w, alpha, beta, phi);
  let sse = 0;
  for (let i = 1; i < w.length; i++) sse += (w[i] - fitted[i - 1]) ** 2;
  const sigma = Math.sqrt(sse / (w.length - 1));

  const forecast = [];
  let dampedSum = 0;
  for (let h = 1; h <= horizonDays; h++) {
    dampedSum += Math.pow(phi, h);
    const value = L + dampedSum * T;
    const spread = 1.96 * sigma * Math.sqrt(h);
    forecast.push({
      value: _max0(_r2(value)),
      lower: _max0(_r2(value - spread)),
      upper: _r2(value + spread)
    });
  }
  return { fitted, forecast, rmse: _r2(sigma), alpha, beta };
}

// ─── Model C: Ornstein-Uhlenbeck Mean Reversion ───────────────────────────────
// Calibrated to the last TREND_WINDOW days. AR(1) on price levels around the
// sample mean. The contrarian component — always pulls toward the recent average.

function _ouModel(prices, horizonDays) {
  const w = prices.length > TREND_WINDOW ? prices.slice(-TREND_WINDOW) : prices;
  const n = w.length;
  if (n < 4) return null;

  const mean = _mean(w);
  let num = 0, den = 0;
  for (let i = 1; i < n; i++) {
    num += (w[i] - mean) * (w[i - 1] - mean);
    den += (w[i - 1] - mean) ** 2;
  }
  const theta = Math.max(0, Math.min(0.99, den > 0 ? num / den : 0.9));

  const fitted = [w[0]];
  for (let i = 1; i < n; i++) fitted.push(mean + theta * (w[i - 1] - mean));
  let sse = 0;
  for (let i = 1; i < n; i++) sse += (w[i] - fitted[i]) ** 2;
  const sigma = Math.sqrt(sse / (n - 1));

  const last = w[n - 1];
  const forecast = [];
  for (let h = 1; h <= horizonDays; h++) {
    const value   = mean + Math.pow(theta, h) * (last - mean);
    const predVar = sigma * sigma * (1 - Math.pow(theta, 2 * h)) / Math.max(1e-6, 1 - theta * theta);
    const spread  = 1.96 * Math.sqrt(Math.max(0, predVar));
    forecast.push({
      value: _max0(_r2(value)),
      lower: _max0(_r2(value - spread)),
      upper: _r2(value + spread)
    });
  }
  return { fitted: fitted.slice(0, -1), forecast, rmse: _r2(sigma) };
}

// ─── Ensemble Forecast ────────────────────────────────────────────────────────
// Fixed blend: 60 % Analog + 25 % Holt + 15 % OU.
//
// Why fixed weights instead of walk-forward RMSE?
// Conservative models (Holt, OU) always achieve lower walk-forward RMSE because
// they never stray far from the current price. If RMSE-based weighting is used,
// they dominate and flatten the ensemble back to a near-monotonic line, defeating
// the purpose of the Analog model entirely.
//
// Fixed weights guarantee the oscillatory Analog shape is always visible while
// Holt provides the current trend direction and OU provides a mean-reversion check.
//
// A fallback RMSE is computed from the Holt component for the accuracy readout.

const W_ANALOG = 0.60;
const W_HOLT   = 0.25;
const W_OU     = 0.15;

/**
 * @param {number[]} prices      - Full available history, ascending chronological.
 *                                 Must include several years for Analog to work well.
 * @param {number}   horizonDays - Days ahead to forecast.
 * @returns {{ fitted, forecast, alpha, beta, rmse } | null}
 *   forecast[i] = { value, lower, upper }  (95 % confidence interval)
 */
function holtForecast(prices, horizonDays) {
  if (!prices || prices.length < 10) return null;

  const mAnalog = _analogModel(prices, horizonDays);
  const mHolt   = _holtModel(prices, horizonDays);
  const mOU     = _ouModel(prices, horizonDays);

  // If Analog is unavailable (not enough history) fall back to Holt + OU only
  const hasAnalog = !!mAnalog;
  const wA = hasAnalog ? W_ANALOG : 0;
  const wH = hasAnalog ? W_HOLT   : (mHolt ? 0.65 : 0);
  const wO = hasAnalog ? W_OU     : (mOU   ? 0.35 : 0);
  const wSum = wA + wH + wO;
  if (wSum === 0) return null;

  const forecast = [];
  for (let h = 0; h < horizonDays; h++) {
    let value = 0, lower = 0, upper = 0;

    if (hasAnalog && mAnalog.forecast[h]) {
      value += (wA / wSum) * mAnalog.forecast[h].value;
      lower += (wA / wSum) * mAnalog.forecast[h].lower;
      upper += (wA / wSum) * mAnalog.forecast[h].upper;
    }
    if (mHolt && mHolt.forecast[h]) {
      value += (wH / wSum) * mHolt.forecast[h].value;
      lower += (wH / wSum) * mHolt.forecast[h].lower;
      upper += (wH / wSum) * mHolt.forecast[h].upper;
    }
    if (mOU && mOU.forecast[h]) {
      value += (wO / wSum) * mOU.forecast[h].value;
      lower += (wO / wSum) * mOU.forecast[h].lower;
      upper += (wO / wSum) * mOU.forecast[h].upper;
    }

    forecast.push({
      value: _max0(_r2(value)),
      lower: _max0(_r2(lower)),
      upper: _r2(upper)
    });
  }

  return {
    fitted:  mHolt ? mHolt.fitted : (mAnalog ? mAnalog.fitted : []),
    forecast,
    alpha:   mHolt?.alpha ?? null,
    beta:    mHolt?.beta  ?? null,
    rmse:    mHolt?.rmse  ?? mAnalog?.rmse ?? null
  };
}

module.exports = { mapCommodity, getUniqueMappings, holtForecast, COMMODITY_MAP };
