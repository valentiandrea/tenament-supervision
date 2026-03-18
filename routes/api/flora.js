'use strict';
const express = require('express');
const router  = express.Router();
const gee     = require('../../services/geeService');

// GET /api/flora/map
// Returns the NDVI tile-layer URL for the 2024 Sentinel-2 composite (global).
router.get('/map', async (req, res) => {
  try {
    const data = await gee.getNDVITiles();
    res.json({ success: true, data });
  } catch (e) {
    console.error('[flora/map]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/flora/map  { geometry: GeoJSON geometry }
// Returns NDVI tile-layer URL clipped to the given polygon.
router.post('/map', async (req, res) => {
  try {
    const { geometry } = req.body;
    if (!geometry || !geometry.type || !geometry.coordinates) {
      return res.status(400).json({ success: false, error: 'geometry (GeoJSON) required' });
    }
    if (!['Polygon', 'MultiPolygon'].includes(geometry.type)) {
      return res.status(400).json({ success: false, error: 'geometry must be Polygon or MultiPolygon' });
    }
    const data = await gee.getNDVITilesClipped(geometry);
    res.json({ success: true, data });
  } catch (e) {
    console.error('[flora/map POST]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/flora/point  { lon, lat }
// Returns NDVI time series (2018-2025) for a 30m buffer around the point.
router.post('/point', async (req, res) => {
  try {
    const { lon, lat } = req.body;
    if (typeof lon !== 'number' || typeof lat !== 'number') {
      return res.status(400).json({ success: false, error: 'lon and lat must be numbers' });
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      return res.status(400).json({ success: false, error: 'Coordinates out of range' });
    }
    const data = await gee.getPointTimeSeries(lon, lat);
    res.json({ success: true, data });
  } catch (e) {
    console.error('[flora/point]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/flora/polygon  { geometry: GeoJSON geometry }
// Returns NDVI time series (2018-2025) for the polygon area.
router.post('/polygon', async (req, res) => {
  try {
    const { geometry } = req.body;
    if (!geometry || !geometry.type || !geometry.coordinates) {
      return res.status(400).json({ success: false, error: 'geometry (GeoJSON) required' });
    }
    if (!['Polygon', 'MultiPolygon'].includes(geometry.type)) {
      return res.status(400).json({ success: false, error: 'geometry must be Polygon or MultiPolygon' });
    }
    const data = await gee.getPolygonTimeSeries(geometry);
    res.json({ success: true, data });
  } catch (e) {
    console.error('[flora/polygon]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
