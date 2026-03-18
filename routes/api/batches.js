const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Batch = require('../../models/Batch');
const KMLProject = require('../../models/KMLProject');
const { parseKmlFile } = require('../../services/kmlParser');
const { queryByGeometry, mapApiDataToTenement } = require('../../services/tengraphService');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  // Safe filename — no user-controlled characters, prevents path traversal
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.kml`)
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    const allowedMimes = ['application/vnd.google-earth.kml+xml', 'text/xml', 'application/xml', 'text/plain', 'application/octet-stream'];
    if (ext === '.kml' && allowedMimes.includes(mime)) cb(null, true);
    else cb(new Error('Only KML files are allowed'));
  },
  limits: { fileSize: 10 * 1024 * 1024, files: 200 }
});

// GET /api/batches
router.get('/', async (req, res) => {
  try {
    const batches = await Batch.find().sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, data: batches });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// GET /api/batches/:id
router.get('/:id', async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.id);
    if (!batch) return res.status(404).json({ success: false, error: 'Batch not found' });
    const projects = await KMLProject.find({ batchId: req.params.id });
    res.json({ success: true, data: { batch, projects } });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/batches/upload
router.post('/upload', upload.array('kmlFiles', 200), async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0)
    return res.status(400).json({ success: false, error: 'No KML files uploaded' });

  const batchName = (req.body.batchName || '').trim().slice(0, 200) || `Upload ${new Date().toLocaleString()}`;
  const batch = new Batch({ name: batchName, totalFiles: files.length, status: 'processing' });
  await batch.save();

  res.json({ success: true, data: { batchId: batch._id, message: 'Processing started' } });

  processBatch(batch, files).catch(async err => {
    console.error('Batch processing error:', err);
    await Batch.findByIdAndUpdate(batch._id, { status: 'failed', error: err.message }).catch(e => console.error('Failed to update batch error status:', e));
  });
});

async function processBatch(batch, files) {
  const projectDocs = [];
  let matchedCount = 0;

  for (const file of files) {
    try {
      const parsed = await parseKmlFile(file.path, file.originalname);

      for (const kmlData of parsed) {
        const tenements = [];

        if (kmlData.polygon && kmlData.polygon.length >= 3) {
          const apiResults = await queryByGeometry(kmlData.polygon, kmlData.kmlName);
          for (const apiData of apiResults) {
            tenements.push(mapApiDataToTenement(apiData));
          }
        }

        if (tenements.length > 0) matchedCount++;

        projectDocs.push({
          kmlName:        kmlData.kmlName,
          sourceFile:     kmlData.sourceFile,
          rawCoordinates: kmlData.rawCoordinates,
          polygon:        kmlData.polygon,
          tenements,
          matchedCount:   tenements.length,
          batchId:        batch._id
        });
      }
    } catch (err) {
      console.error(`Error processing ${file.originalname}:`, err.message);
    } finally {
      try { fs.unlinkSync(file.path); } catch {}
    }
  }

  if (projectDocs.length > 0) await KMLProject.insertMany(projectDocs);

  await Batch.findByIdAndUpdate(batch._id, {
    totalTenements: projectDocs.length,
    matchedCount,
    status: 'completed',
    completedAt: new Date()
  });

  console.log(`Batch ${batch._id} done: ${projectDocs.length} KML projects`);
}

// DELETE /api/batches/:id
router.delete('/:id', async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.id);
    if (!batch) return res.status(404).json({ success: false, error: 'Batch not found' });
    await KMLProject.deleteMany({ batchId: req.params.id });
    await Batch.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Batch deleted' });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

module.exports = router;
