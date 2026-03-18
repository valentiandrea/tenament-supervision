const express    = require('express');
const router     = express.Router();
const KMLProject = require('../../models/KMLProject');

// Fills null schema fields from apiRawData for pre-existing records
const BACKFILL_STAGE = { $addFields: {
  'tenements.commodity':      { $ifNull: ['$tenements.commodity',      '$tenements.apiRawData.prim_comm'] },
  'tenements.stateRegion':    { $ifNull: ['$tenements.stateRegion',    { $ifNull: ['$tenements.apiRawData.stateregion', '$tenements.apiRawData.region'] }] },
  'tenements.shire':          { $ifNull: ['$tenements.shire',          '$tenements.apiRawData.shire'] },
  'tenements.localGovt':      { $ifNull: ['$tenements.localGovt',      '$tenements.apiRawData.localgovt'] },
  'tenements.natRes':         { $ifNull: ['$tenements.natRes',         '$tenements.apiRawData.natres'] },
  'tenements.mortgagee':      { $ifNull: ['$tenements.mortgagee',      '$tenements.apiRawData.mortgagee'] },
  'tenements.miningActivity': { $ifNull: ['$tenements.miningActivity', '$tenements.apiRawData.minact'] },
  'tenements.purposeAppl':    { $ifNull: ['$tenements.purposeAppl',    '$tenements.apiRawData.purpappl'] },
  'tenements.pendStatus':     { $ifNull: ['$tenements.pendStatus',     '$tenements.apiRawData.pendstatus'] },
  // Backfill endDate from raw Unix-ms timestamp for records stored before schema migration
  'tenements.endDate': { $ifNull: [
    '$tenements.endDate',
    { $cond: {
      if:   { $and: [{ $gt: ['$tenements.apiRawData.enddate', 0] }, { $ne: ['$tenements.apiRawData.enddate', null] }] },
      then: { $toDate: '$tenements.apiRawData.enddate' },
      else: null
    }}
  ]},
}};

// GET /api/intelligence/filters — distinct values for all dropdowns
router.get('/filters', async (req, res) => {
  try {
    const distinct = (field) => KMLProject.aggregate([
      { $unwind: '$tenements' },
      BACKFILL_STAGE,
      { $match:  { [`tenements.${field}`]: { $nin: [null, ''] } } },
      { $group:  { _id: `$tenements.${field}` } },
      { $sort:   { _id: 1 } }
    ]).then(r => r.map(x => x._id));

    const [commodities, statuses, types, regions, natResVals] = await Promise.all([
      distinct('commodity'),
      distinct('tenStatus'),
      distinct('tenType'),
      distinct('stateRegion'),
      distinct('natRes')
    ]);

    res.json({ success: true, data: { commodities, statuses, types, regions, natResVals } });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
    res.status(500).json({ success: false, error: msg });
  }
});

// GET /api/intelligence — flattened tenements with filters + pagination
router.get('/', async (req, res) => {
  try {
    const { commodity, tenStatus, tenType, stateRegion, natRes, hasMortgagee, expiryWithin, search } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));

    const match = { 'tenements.tenementId': { $ne: null } };
    if (tenStatus)   match['tenements.tenStatus']   = tenStatus;
    if (tenType)     match['tenements.tenType']     = tenType;
    if (commodity)   match['tenements.commodity']   = commodity;
    if (stateRegion) match['tenements.stateRegion'] = stateRegion;
    if (natRes)      match['tenements.natRes']      = natRes;
    if (hasMortgagee === 'yes') match['tenements.mortgagee'] = { $nin: [null, ''] };
    if (hasMortgagee === 'no')  match['tenements.mortgagee'] = { $in:  [null, ''] };
    if (expiryWithin === 'expired') {
      match['tenements.endDate'] = { $lt: new Date(), $gt: new Date(0) };
    } else if (expiryWithin) {
      const days = parseInt(expiryWithin, 10);
      if (isNaN(days) || days < 1 || days > 3650)
        return res.status(400).json({ success: false, error: 'expiryWithin must be "expired" or a number of days between 1 and 3650' });
      const cutoff = new Date(Date.now() + days * 86400000);
      match['tenements.endDate'] = { $lte: cutoff, $gt: new Date(0) };
    }
    if (search) {
      const esc = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 200);
      match.$or = [
        { 'tenements.tenementId':   { $regex: esc, $options: 'i' } },
        { 'tenements.holders.name': { $regex: esc, $options: 'i' } },
        { kmlName:                  { $regex: esc, $options: 'i' } }
      ];
    }

    const base = [
      { $unwind: '$tenements' },
      BACKFILL_STAGE,
      { $match: match }
    ];

    const [rows, countAgg] = await Promise.all([
      KMLProject.aggregate([
        ...base,
        // Sort by endDate ascending, NULLs last
        { $addFields: { _sortDate: { $ifNull: ['$tenements.endDate', new Date('9999-12-31')] } } },
        { $sort: { _sortDate: 1 } },
        { $skip:  (page - 1) * limit },
        { $limit: limit },
        { $project: { projectId: '$_id', kmlName: 1, projectName: 1, classification: 1, t: '$tenements' } }
      ]),
      KMLProject.aggregate([...base, { $count: 'n' }])
    ]);

    const total = countAgg[0]?.n || 0;
    res.json({ success: true, data: rows, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
    res.status(500).json({ success: false, error: msg });
  }
});

module.exports = router;
