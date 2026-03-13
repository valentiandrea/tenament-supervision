const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const ProjectData = require('../../models/ProjectData');

const PRECIOUS_METALS = new Set(['gold', 'silver', 'platinum', 'palladium', 'rhodium']);
const T_TO_OZ = 32150.7467;  // troy oz per metric ton

function isPrecious(name) {
  return name && PRECIOUS_METALS.has(name.toLowerCase());
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    const allowedMimes = ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream'];
    if (ext === '.csv' && allowedMimes.includes(mime)) cb(null, true);
    else cb(new Error('Only CSV files are allowed'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }  // 5 MB max
});

// Parse CSV text into array of objects
function parseCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (values[i] || '').trim(); });
    return row;
  });
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

// POST /api/metadata/upload  — upload ProjectsData.csv
router.post('/upload', upload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const rows = parseCSV(req.file.buffer.toString('utf-8'));

    // Group by OreBodyID
    const grouped = {};
    for (const row of rows) {
      const id = row.OreBodyID;
      if (!id) continue;
      if (!grouped[id]) {
        grouped[id] = {
          oreBodyId: id,
          country: row.Country || '',
          cumulativeML: num(row.CumulativeML),
          mineLife: num(row.MineLife),
          commodity1: row.Commodity1 || '',
          commodity2: row.Commodity2 || '',
          commodity3: row.Commodity3 || '',
          centerX: num(row.CenterX),
          centerY: num(row.CenterY),
          subdivisions: []
        };
      }
      const cm1Raw = num(row.ContainedMetalTons1);
      const cm2Raw = num(row.ContainedMetalTons2);
      const cm3Raw = num(row.ContainedMetalTons3);
      const g = grouped[id];
      grouped[id].subdivisions.push({
        subdivisionId: row.ProjectID,
        insituBillion: num(row.InsituBillion),
        evBillion: num(row.EVBillion),
        tonnages: num(row.Tonnages),
        grade1: num(row.Grade1),
        grade2: num(row.Grade2),
        grade3: num(row.Grade3),
        containedMetal1: cm1Raw != null && isPrecious(g.commodity1) ? cm1Raw * T_TO_OZ : cm1Raw,
        containedMetal2: cm2Raw != null && isPrecious(g.commodity2) ? cm2Raw * T_TO_OZ : cm2Raw,
        containedMetal3: cm3Raw != null && isPrecious(g.commodity3) ? cm3Raw * T_TO_OZ : cm3Raw,
        strike: num(row.Strike),
        width: num(row.Width),
        ceiling: num(row.Ceiling),
        floor: num(row.Floor),
        waterProximity: num(row.WaterProximity),
        distanceBetween: num(row.DistanceBetween)
      });
    }

    // Compute aggregated totals and upsert
    let upserted = 0;
    for (const [oreBodyId, data] of Object.entries(grouped)) {
      const subs = data.subdivisions;
      const totalInsituBillion   = subs.reduce((s, r) => s + (r.insituBillion   || 0), 0);
      const totalEVBillion       = subs.reduce((s, r) => s + (r.evBillion       || 0), 0);
      const totalTonnages        = subs.reduce((s, r) => s + (r.tonnages        || 0), 0);
      const totalContainedMetal1 = subs.reduce((s, r) => s + (r.containedMetal1 || 0), 0);
      const totalContainedMetal2 = subs.reduce((s, r) => s + (r.containedMetal2 || 0), 0);
      const totalContainedMetal3 = subs.reduce((s, r) => s + (r.containedMetal3 || 0), 0);

      await ProjectData.findOneAndUpdate(
        { oreBodyId },
        {
          ...data,
          totalInsituBillion,
          totalEVBillion,
          totalTonnages,
          totalContainedMetal1,
          totalContainedMetal2,
          totalContainedMetal3,
          importedAt: new Date()
        },
        { upsert: true, new: true }
      );
      upserted++;
    }

    res.json({ success: true, message: `Imported ${upserted} projects from CSV`, count: upserted });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// GET /api/metadata/:oreBodyId
router.get('/:oreBodyId', async (req, res) => {
  try {
    const data = await ProjectData.findOne({ oreBodyId: req.params.oreBodyId }).lean();
    if (!data) return res.json({ success: true, data: null });
    res.json({ success: true, data });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/metadata/migrate-precious-metals — one-time conversion of existing DB values
router.post('/migrate-precious-metals', async (req, res) => {
  try {
    const docs = await ProjectData.find();
    let updated = 0;
    for (const doc of docs) {
      const comms = [doc.commodity1, doc.commodity2, doc.commodity3];
      let changed = false;

      // Update subdivision-level values
      for (const sub of doc.subdivisions) {
        if (isPrecious(comms[0]) && sub.containedMetal1 != null) { sub.containedMetal1 *= T_TO_OZ; changed = true; }
        if (isPrecious(comms[1]) && sub.containedMetal2 != null) { sub.containedMetal2 *= T_TO_OZ; changed = true; }
        if (isPrecious(comms[2]) && sub.containedMetal3 != null) { sub.containedMetal3 *= T_TO_OZ; changed = true; }
      }

      // Update totals
      if (isPrecious(comms[0]) && doc.totalContainedMetal1) { doc.totalContainedMetal1 *= T_TO_OZ; changed = true; }
      if (isPrecious(comms[1]) && doc.totalContainedMetal2) { doc.totalContainedMetal2 *= T_TO_OZ; changed = true; }
      if (isPrecious(comms[2]) && doc.totalContainedMetal3) { doc.totalContainedMetal3 *= T_TO_OZ; changed = true; }

      if (changed) { await doc.save(); updated++; }
    }
    res.json({ success: true, message: `Migrated ${updated} project(s) to oz for precious metals` });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
    res.status(500).json({ success: false, error: msg });
  }
});

// GET /api/metadata — all, or filtered
router.get('/', async (req, res) => {
  try {
    const all = await ProjectData.find().lean();
    res.json({ success: true, data: all });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

module.exports = router;
