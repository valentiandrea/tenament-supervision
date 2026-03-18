const express      = require('express');
const router       = express.Router();
const multer       = require('multer');
const mongoose     = require('mongoose');
const DrillProgram = require('../../models/DrillProgram');
const KMLProject   = require('../../models/KMLProject');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (ext === 'csv' && (file.mimetype.startsWith('text/') || file.mimetype === 'application/octet-stream')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

const err500 = (res, err) => {
  console.error('[drillprograms]', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
};

// GET /api/drillprograms/template — download CSV template
router.get('/template', (req, res) => {
  const csv = [
    'Type,Drillhole Name,East (WGS 84 UTM zone 50),North (WGS 84 UTM zone 50),Azimuth,Dip,Target Depth',
    'DD,WBDD001,651704.5932,6785964.954,90,70,400',
    'DD,WBDD002,651720.0857,6785601.32,90,70,400',
    'RC,WBRC001,651642.6232,6785964.954,90,70,250',
    'RC,WBRC002,651828.5332,6785964.954,270,70,200',
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="drill_program_template.csv"');
  res.send(csv);
});

// GET /api/drillprograms
router.get('/', async (req, res) => {
  try {
    const programs = await DrillProgram.find({}).lean();
    res.json({ success: true, data: programs });
  } catch (err) { err500(res, err); }
});

// GET /api/drillprograms/:id
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, error: 'Invalid id' });
    const prog = await DrillProgram.findById(req.params.id).lean();
    if (!prog) return res.status(404).json({ success: false, error: 'Drill program not found' });
    res.json({ success: true, data: prog });
  } catch (err) { err500(res, err); }
});

// POST /api/drillprograms — create from CSV upload
router.post('/', upload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'CSV file required' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Program name required' });

    const lines = req.file.buffer.toString('utf8').trim().split(/\r?\n/);
    if (lines.length < 2) return res.status(400).json({ success: false, error: 'CSV has no data rows' });

    const holes = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      if (cols.length < 7 || !cols[0]) continue;
      const type = cols[0].toUpperCase();
      if (!['DD', 'RC'].includes(type)) continue;

      const holeName   = String(cols[1] || '').slice(0, 50);
      const easting    = parseFloat(cols[2]);
      const northing   = parseFloat(cols[3]);
      const azimuth    = parseFloat(cols[4]);
      const dip        = Math.abs(parseFloat(cols[5]));
      const targetDepth = parseFloat(cols[6]);

      // Validate numerics and ranges
      if (!holeName) continue;
      if (isNaN(easting) || isNaN(northing)) continue;
      if (isNaN(azimuth) || azimuth < 0 || azimuth > 360) continue;
      if (isNaN(dip)     || dip < 0     || dip > 90)      continue;
      if (isNaN(targetDepth) || targetDepth <= 0)          continue;

      holes.push({ type, name: holeName, easting, northing, azimuth, dip, targetDepth });
    }
    if (!holes.length) return res.status(400).json({ success: false, error: 'No valid drill holes found in CSV' });

    // optional project link
    let projectId;
    if (req.body.projectId && mongoose.Types.ObjectId.isValid(req.body.projectId)) {
      const proj = await KMLProject.findById(req.body.projectId, 'kmlName').lean();
      if (proj) projectId = proj._id;
    }

    const prog = await DrillProgram.create({ name, projectId, holes });
    res.status(201).json({ success: true, data: prog });
  } catch (err) { err500(res, err); }
});

// PATCH /api/drillprograms/:id/holes/:holeName
router.patch('/:id/holes/:holeName', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, error: 'Invalid id' });

    const prog = await DrillProgram.findById(req.params.id);
    if (!prog) return res.status(404).json({ success: false, error: 'Not found' });

    const hole = prog.holes.find(h => h.name === req.params.holeName);
    if (!hole) return res.status(404).json({ success: false, error: 'Hole not found' });

    const { status, metresDrilled, notes } = req.body;
    const validStatuses = ['Planned', 'Active', 'Complete', 'On Hold'];

    if (status !== undefined) {
      if (!validStatuses.includes(status))
        return res.status(400).json({ success: false, error: 'Invalid status' });
      hole.status = status;
    }
    if (metresDrilled !== undefined) {
      const m = parseFloat(metresDrilled);
      if (isNaN(m) || m < 0)
        return res.status(400).json({ success: false, error: 'Invalid metresDrilled' });
      hole.metresDrilled = m;
    }
    if (notes !== undefined) hole.notes = String(notes).slice(0, 2000);

    await prog.save();
    res.json({ success: true, data: prog });
  } catch (err) { err500(res, err); }
});

// DELETE /api/drillprograms/:id
router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, error: 'Invalid id' });
    const prog = await DrillProgram.findByIdAndDelete(req.params.id);
    if (!prog) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true });
  } catch (err) { err500(res, err); }
});

module.exports = router;
