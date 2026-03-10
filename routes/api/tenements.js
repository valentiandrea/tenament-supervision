const express = require('express');
const router = express.Router();
const Tenement = require('../../models/Tenement');
const Batch = require('../../models/Batch');

// GET /api/tenements — list tenements with filters
router.get('/', async (req, res) => {
  try {
    const {
      batchId,
      classification,
      tenStatus,
      search,
      page = 1,
      limit = 50
    } = req.query;

    const filter = {};
    if (batchId) filter.batchId = batchId;
    if (classification) filter.classification = classification;
    if (tenStatus) filter.tenStatus = tenStatus;
    if (search) {
      filter.$or = [
        { kmlName: { $regex: search, $options: 'i' } },
        { tenementId: { $regex: search, $options: 'i' } },
        { 'holders.name': { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [tenements, total] = await Promise.all([
      Tenement.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Tenement.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: tenements,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tenements/stats — overall statistics
router.get('/stats', async (req, res) => {
  try {
    const [
      total,
      matched,
      internal,
      external,
      unclassified,
      statusBreakdown,
      typeBreakdown
    ] = await Promise.all([
      Tenement.countDocuments(),
      Tenement.countDocuments({ matched: true }),
      Tenement.countDocuments({ classification: 'internal' }),
      Tenement.countDocuments({ classification: 'external' }),
      Tenement.countDocuments({ classification: 'unclassified' }),
      Tenement.aggregate([
        { $group: { _id: '$tenStatus', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Tenement.aggregate([
        { $match: { tenType: { $ne: null } } },
        { $group: { _id: '$tenType', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    res.json({
      success: true,
      data: {
        total,
        matched,
        unmatched: total - matched,
        internal,
        external,
        unclassified,
        statusBreakdown,
        typeBreakdown
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/tenements/bulk/classification — bulk update classification
router.patch('/bulk/classification', async (req, res) => {
  try {
    const { ids, classification, note } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'No IDs provided' });
    }
    if (!['internal', 'external', 'unclassified'].includes(classification)) {
      return res.status(400).json({ success: false, error: 'Invalid classification value' });
    }

    await Tenement.updateMany(
      { _id: { $in: ids } },
      {
        classification,
        classificationNote: note || '',
        classifiedAt: new Date(),
        updatedAt: new Date()
      }
    );

    res.json({ success: true, message: `${ids.length} tenements updated` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tenements/:id — single tenement
router.get('/:id', async (req, res) => {
  try {
    const tenement = await Tenement.findById(req.params.id).lean();
    if (!tenement) return res.status(404).json({ success: false, error: 'Tenement not found' });
    res.json({ success: true, data: tenement });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/tenements/:id/classification — update classification
router.patch('/:id/classification', async (req, res) => {
  try {
    const { classification, note } = req.body;

    if (!['internal', 'external', 'unclassified'].includes(classification)) {
      return res.status(400).json({ success: false, error: 'Invalid classification value' });
    }

    const tenement = await Tenement.findByIdAndUpdate(
      req.params.id,
      {
        classification,
        classificationNote: note || '',
        classifiedAt: new Date(),
        updatedAt: new Date()
      },
      { new: true }
    );

    if (!tenement) return res.status(404).json({ success: false, error: 'Tenement not found' });

    // Update batch counts
    const counts = await Tenement.aggregate([
      { $match: { batchId: tenement.batchId } },
      { $group: {
        _id: null,
        internal: { $sum: { $cond: [{ $eq: ['$classification', 'internal'] }, 1, 0] } },
        external: { $sum: { $cond: [{ $eq: ['$classification', 'external'] }, 1, 0] } }
      }}
    ]);

    if (counts.length > 0) {
      await Batch.findByIdAndUpdate(tenement.batchId, {
        internalCount: counts[0].internal,
        externalCount: counts[0].external
      });
    }

    res.json({ success: true, data: tenement });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
