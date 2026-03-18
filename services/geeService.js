'use strict';
/**
 * Google Earth Engine service.
 *
 * Required environment variables:
 *   GEE_PROJECT_ID   — your GEE Cloud project ID (e.g. "my-project-123456")
 *   GEE_PRIVATE_KEY  — JSON string of a service-account private key (for non-GCP deployments)
 *                      OR leave unset to fall back on Application Default Credentials
 *                      (works automatically on Google Cloud / after `gcloud auth application-default login`)
 *
 * The module initialises Earth Engine once and caches the result.
 * Every exported function awaits that initialisation before running.
 */

const ee = require('@google/earthengine');
const path = require('path');

let _ready   = false;
let _promise = null;

// ─── Initialisation ───────────────────────────────────────────────────────────

function _authenticate() {
  // Option A: explicit private-key JSON string (cloud deployments, env var)
  const keyStr  = process.env.GEE_PRIVATE_KEY;
  if (keyStr) {
    return new Promise((resolve, reject) => {
      try {
        const key = JSON.parse(keyStr);
        ee.data.authenticateViaPrivateKey(key, resolve,
          err => reject(new Error(`GEE auth failed: ${err}`)));
      } catch (e) {
        reject(new Error(`GEE_PRIVATE_KEY is not valid JSON: ${e.message}`));
      }
    });
  }

  // Option B: path to a key file on disk (local development)
  const keyFile = process.env.GEE_KEY_FILE;
  if (keyFile) {
    return new Promise((resolve, reject) => {
      try {
        const key = require(path.resolve(keyFile));
        ee.data.authenticateViaPrivateKey(key, resolve,
          err => reject(new Error(`GEE auth failed: ${err}`)));
      } catch (e) {
        reject(new Error(`Cannot load GEE_KEY_FILE "${keyFile}": ${e.message}`));
      }
    });
  }

  // Option C: Application Default Credentials (GCP, gcloud login)
  return Promise.resolve();
}

function _init() {
  if (_ready)   return Promise.resolve();
  if (_promise) return _promise;

  _promise = _authenticate().then(() => new Promise((resolve, reject) => {
    ee.initialize(
      null, null,
      () => { _ready = true; resolve(); },
      err  => reject(new Error(`GEE init failed: ${err}`)),
      null,
      process.env.GEE_PROJECT_ID || null
    );
  }));

  return _promise;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a per-image mean+stdDev FeatureCollection and return sorted rows.
 */
function _timeSeries(geometry, resolve, reject) {
  const s2 = ee.ImageCollection('COPERNICUS/S2_SR')
    .filterDate('2018-01-01', '2025-12-31')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
    .filterBounds(geometry);

  const fc = ee.FeatureCollection(
    s2.map(img => {
      const ndvi  = img.normalizedDifference(['B8', 'B4']).rename('ndvi');
      const stats = ndvi.reduceRegion({
        reducer:   ee.Reducer.mean().combine({ reducer2: ee.Reducer.stdDev(), sharedInputs: true }),
        geometry,
        scale:     10,
        maxPixels: 1e8,
        bestEffort: true
      });
      return ee.Feature(null, {
        date:   ee.Date(img.get('system:time_start')).format('YYYY-MM-dd'),
        mean:   stats.get('ndvi_mean'),
        stdDev: stats.get('ndvi_stdDev')
      });
    })
  );

  fc.filter(ee.Filter.notNull(['mean']))
    .sort('date')
    .getInfo(info => {
      if (!info) return reject(new Error('Earth Engine returned no data'));
      const rows = info.features
        .map(f => ({
          date:   f.properties.date,
          mean:   f.properties.mean   != null ? +Number(f.properties.mean).toFixed(4)   : null,
          stdDev: f.properties.stdDev != null ? +Number(f.properties.stdDev).toFixed(4) : null
        }))
        .filter(r => r.mean !== null);
      resolve(rows);
    }, err => reject(new Error(String(err))));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns an NDVI tile-layer URL (Leaflet-compatible {z}/{x}/{y} template)
 * for a median Sentinel-2 composite of 2024.
 */
async function getNDVITiles() {
  await _init();
  const palette = ['#8A3F02', '#d9f0a3', '#44b365', '#268643', '#01582f', '#003621'];
  return new Promise((resolve, reject) => {
    const s2 = ee.ImageCollection('COPERNICUS/S2_SR')
      .filterDate('2024-01-01', '2024-12-31')
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30));
    const ndvi = s2.map(img => img.normalizedDifference(['B8', 'B4'])).median();

    ndvi.getMap({ min: 0, max: 1, palette }, (mapId, err) => {
      if (err) return reject(new Error(String(err)));
      resolve({ tileUrl: mapId.urlFormat, palette, min: 0, max: 1 });
    });
  });
}

/**
 * NDVI time series for a 30-metre buffer around a clicked point.
 * @param {number} lon
 * @param {number} lat
 */
async function getPointTimeSeries(lon, lat) {
  await _init();
  return new Promise((resolve, reject) => {
    const geom = ee.Geometry.Point([lon, lat]).buffer(30);
    _timeSeries(geom, resolve, reject);
  });
}

/**
 * NDVI time series for a drawn or KML-uploaded polygon.
 * @param {{ type: string, coordinates: any }} geojson
 */
async function getPolygonTimeSeries(geojson) {
  await _init();
  return new Promise((resolve, reject) => {
    const geom = ee.Geometry(geojson);
    _timeSeries(geom, resolve, reject);
  });
}

/**
 * Returns an NDVI tile-layer URL clipped to the given GeoJSON geometry.
 */
async function getNDVITilesClipped(geojson) {
  await _init();
  const palette = ['#8A3F02', '#d9f0a3', '#44b365', '#268643', '#01582f', '#003621'];
  return new Promise((resolve, reject) => {
    const geom = ee.Geometry(geojson);
    const s2 = ee.ImageCollection('COPERNICUS/S2_SR')
      .filterDate('2024-01-01', '2024-12-31')
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
      .filterBounds(geom);
    const ndvi = s2.map(img => img.normalizedDifference(['B8', 'B4'])).median().clip(geom);

    ndvi.getMap({ min: 0, max: 1, palette }, (mapId, err) => {
      if (err) return reject(new Error(String(err)));
      resolve({ tileUrl: mapId.urlFormat, palette, min: 0, max: 1 });
    });
  });
}

module.exports = { getNDVITiles, getNDVITilesClipped, getPointTimeSeries, getPolygonTimeSeries };
