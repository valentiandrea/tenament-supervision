const express = require('express');
const router = express.Router();
const KMLProject = require('../../models/KMLProject');
const Batch = require('../../models/Batch');

// GET /api/projects — list KML projects with filters
router.get('/', async (req, res) => {
  try {
    const { batchId, classification, search } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));

    const filter = {};
    if (batchId) filter.batchId = batchId;
    if (classification && ['internal','external','unclassified'].includes(classification))
      filter.classification = classification;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 200);
      filter.$or = [
        { kmlName:                  { $regex: escaped, $options: 'i' } },
        { sourceFile:               { $regex: escaped, $options: 'i' } },
        { 'tenements.tenementId':   { $regex: escaped, $options: 'i' } },
        { 'tenements.holders.name': { $regex: escaped, $options: 'i' } }
      ];
    }

    const skip = (page - 1) * limit;
    const [projects, total] = await Promise.all([
      KMLProject.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      KMLProject.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: projects,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// GET /api/projects/stats
router.get('/stats', async (req, res) => {
  try {
    const [total, internal, external, unclassified, withTenements, free] = await Promise.all([
      KMLProject.countDocuments(),
      KMLProject.countDocuments({ classification: 'internal' }),
      KMLProject.countDocuments({ classification: 'external' }),
      KMLProject.countDocuments({ classification: 'unclassified' }),
      KMLProject.countDocuments({ matchedCount: { $gt: 0 } }),
      KMLProject.countDocuments({ matchedCount: 0 })
    ]);

    // Total tenement count across all projects
    const tenementAgg = await KMLProject.aggregate([
      { $group: { _id: null, totalTenements: { $sum: '$matchedCount' } } }
    ]);
    const totalTenements = tenementAgg[0]?.totalTenements || 0;

    // Status breakdown across embedded tenements
    const statusAgg = await KMLProject.aggregate([
      { $unwind: { path: '$tenements', preserveNullAndEmptyArrays: false } },
      { $group: { _id: '$tenements.tenStatus', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      data: { total, internal, external, unclassified, withTenements, free, totalTenements, statusBreakdown: statusAgg }
    });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// GET /api/projects/:id
router.get('/:id', async (req, res) => {
  try {
    const project = await KMLProject.findById(req.params.id).lean();
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    res.json({ success: true, data: project });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// PATCH /api/projects/:id/name
router.patch('/:id/name', async (req, res) => {
  try {
    const { projectName } = req.body;
    if (typeof projectName !== 'string' || projectName.trim().length > 200)
      return res.status(400).json({ success: false, error: 'projectName must be a string under 200 characters' });

    const project = await KMLProject.findByIdAndUpdate(
      req.params.id,
      { projectName: projectName.trim(), updatedAt: new Date() },
      { new: true }
    );
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    res.json({ success: true, data: project });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// PATCH /api/projects/bulk/classification
router.patch('/bulk/classification', async (req, res) => {
  try {
    const { ids, classification, note } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500)
      return res.status(400).json({ success: false, error: 'IDs must be an array of 1–500 items' });
    if (!['internal', 'external', 'unclassified'].includes(classification))
      return res.status(400).json({ success: false, error: 'Invalid classification' });
    if (note && typeof note !== 'string')
      return res.status(400).json({ success: false, error: 'Note must be a string' });

    await KMLProject.updateMany(
      { _id: { $in: ids } },
      { classification, classificationNote: note || '', classifiedAt: new Date(), updatedAt: new Date() }
    );
    res.json({ success: true, message: `${ids.length} projects updated` });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// PATCH /api/projects/:id/classification
router.patch('/:id/classification', async (req, res) => {
  try {
    const { classification, note } = req.body;
    if (!['internal', 'external', 'unclassified'].includes(classification))
      return res.status(400).json({ success: false, error: 'Invalid classification' });

    const project = await KMLProject.findByIdAndUpdate(
      req.params.id,
      { classification, classificationNote: note || '', classifiedAt: new Date(), updatedAt: new Date() },
      { new: true }
    );
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });

    // Update batch counts
    const counts = await KMLProject.aggregate([
      { $match: { batchId: project.batchId } },
      { $group: {
        _id: null,
        internal: { $sum: { $cond: [{ $eq: ['$classification', 'internal'] }, 1, 0] } },
        external: { $sum: { $cond: [{ $eq: ['$classification', 'external'] }, 1, 0] } }
      }}
    ]);
    if (counts.length > 0) {
      await Batch.findByIdAndUpdate(project.batchId, {
        internalCount: counts[0].internal,
        externalCount: counts[0].external
      });
    }

    res.json({ success: true, data: project });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

module.exports = router;
