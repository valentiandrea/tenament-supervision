const express = require('express');
const router  = express.Router();
const CheckSession = require('../../models/CheckSession');
const ChangeLog    = require('../../models/ChangeLog');
const KMLProject   = require('../../models/KMLProject');
const { queryByGeometry, mapApiDataToTenement } = require('../../services/tengraphService');

// ─── GET /api/changes/sessions — list all sessions ───────────
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await CheckSession.find().sort({ startedAt: -1 }).limit(50);
    res.json({ success: true, data: sessions });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// ─── GET /api/changes/sessions/:id — session + its changes ───
router.get('/sessions/:id', async (req, res) => {
  try {
    const session = await CheckSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    const changes = await ChangeLog.find({ sessionId: req.params.id }).sort({ detectedAt: 1 });
    res.json({ success: true, data: { session, changes } });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// ─── GET /api/changes — latest changes (all sessions) ────────
router.get('/', async (req, res) => {
  try {
    const { sessionId, changeType, projectId } = req.query;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200));
    const filter = {};
    if (sessionId)  filter.sessionId  = sessionId;
    if (changeType) filter.changeType = changeType;
    if (projectId)  filter.projectId  = projectId;

    const changes = await ChangeLog.find(filter)
      .sort({ detectedAt: -1 })
      .limit(limit);
    res.json({ success: true, data: changes });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// ─── POST /api/changes/recheck — trigger re-check ────────────
router.post('/recheck', async (req, res) => {
  const { projectIds } = req.body;  // optional: limit to specific project IDs

  const session = new CheckSession({
    name: `Check ${new Date().toLocaleString('en-AU')}`,
    status: 'running'
  });
  await session.save();

  // Return immediately, process in background
  res.json({ success: true, data: { sessionId: session._id } });

  runRecheck(session, projectIds).catch(async err => {
    console.error('Recheck error:', err);
    await CheckSession.findByIdAndUpdate(session._id, { status: 'failed', error: err.message });
  });
});

// ─── DELETE /api/changes/sessions/:id ────────────────────────
router.delete('/sessions/:id', async (req, res) => {
  try {
    await ChangeLog.deleteMany({ sessionId: req.params.id });
    await CheckSession.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    const msg = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message; res.status(500).json({ success: false, error: msg });
  }
});

// ─── Re-check logic ───────────────────────────────────────────
async function runRecheck(session, projectIds) {
  const filter = projectIds && projectIds.length > 0 ? { _id: { $in: projectIds } } : {};
  const projects = await KMLProject.find(filter).lean();

  const allChanges = [];
  let projectsChecked = 0;

  for (const project of projects) {
    if (!project.polygon || project.polygon.length < 3) continue;

    // Re-query TENGRAPH
    const freshApiResults = await queryByGeometry(project.polygon, project.kmlName);
    const freshTenements  = freshApiResults.map(mapApiDataToTenement);

    // Compare against stored
    const detected = detectChanges(project, freshTenements, session._id);
    allChanges.push(...detected);

    // Update the project's stored tenements with fresh data
    if (freshTenements.length > 0 || project.tenements.length > 0) {
      await KMLProject.findByIdAndUpdate(project._id, {
        tenements:    freshTenements,
        matchedCount: freshTenements.length,
        updatedAt:    new Date()
      });
    }

    projectsChecked++;
  }

  // Bulk insert changes
  if (allChanges.length > 0) await ChangeLog.insertMany(allChanges);

  await CheckSession.findByIdAndUpdate(session._id, {
    projectsChecked,
    changesFound:  allChanges.length,
    status:        'completed',
    completedAt:   new Date()
  });

  console.log(`Recheck done: ${projectsChecked} projects, ${allChanges.length} changes`);
}

function fmtVal(v) {
  if (v == null) return 'N/A';
  if (v instanceof Date || (typeof v === 'string' && v.match(/^\d{4}-/))) {
    const d = new Date(v);
    if (!isNaN(d)) return d.getFullYear() > 2900 ? 'Ongoing' : d.toLocaleDateString('en-AU');
  }
  return String(v);
}

function detectChanges(project, freshTenements, sessionId) {
  const changes = [];
  const base    = { sessionId, projectId: project._id, kmlName: project.kmlName, projectName: project.projectName || '' };

  const storedMap = new Map((project.tenements || []).map(t => [t.tenementId, t]));
  const freshMap  = new Map(freshTenements.map(t => [t.tenementId, t]));

  // Tenements that disappeared
  for (const [tid, t] of storedMap) {
    if (!freshMap.has(tid)) {
      changes.push({
        ...base, tenementId: tid, changeType: 'tenement_removed',
        field: 'tenementId', oldValue: `${tid} (${t.tenStatus || '?'})`, newValue: 'No longer intersecting'
      });
    }
  }

  // New tenements or field changes
  for (const [tid, fresh] of freshMap) {
    if (!storedMap.has(tid)) {
      changes.push({
        ...base, tenementId: tid, changeType: 'new_tenement',
        field: 'tenementId', oldValue: 'Not present', newValue: `${tid} (${fresh.tenStatus || '?'})`
      });
      continue;
    }

    const stored = storedMap.get(tid);

    // Status
    if (fresh.tenStatus !== stored.tenStatus) {
      changes.push({
        ...base, tenementId: tid, changeType: 'status_change',
        field: 'Status', oldValue: stored.tenStatus || 'N/A', newValue: fresh.tenStatus || 'N/A'
      });
    }

    // Licence type
    if (fresh.tenType !== stored.tenType) {
      changes.push({
        ...base, tenementId: tid, changeType: 'license_change',
        field: 'Licence Type', oldValue: stored.tenType || 'N/A', newValue: fresh.tenType || 'N/A'
      });
    }

    // Legal area
    const areaOld = stored.legalArea != null ? Number(stored.legalArea).toFixed(3) : null;
    const areaNew = fresh.legalArea  != null ? Number(fresh.legalArea).toFixed(3)  : null;
    if (areaOld !== areaNew) {
      changes.push({
        ...base, tenementId: tid, changeType: 'area_change',
        field: 'Legal Area',
        oldValue: areaOld ? `${areaOld} ${stored.areaUnit || ''}` : 'N/A',
        newValue: areaNew ? `${areaNew} ${fresh.areaUnit  || ''}` : 'N/A'
      });
    }

    // End date
    const endOld = fmtVal(stored.endDate);
    const endNew = fmtVal(fresh.endDate);
    if (endOld !== endNew) {
      changes.push({
        ...base, tenementId: tid, changeType: 'end_date_change',
        field: 'End Date', oldValue: endOld, newValue: endNew
      });
    }

    // Primary holder
    const holderOld = stored.holders && stored.holders[0] ? stored.holders[0].name : null;
    const holderNew = fresh.holders  && fresh.holders[0]  ? fresh.holders[0].name  : null;
    if (holderOld !== holderNew) {
      changes.push({
        ...base, tenementId: tid, changeType: 'holder_change',
        field: 'Primary Holder', oldValue: holderOld || 'N/A', newValue: holderNew || 'N/A'
      });
    }
  }

  return changes;
}

module.exports = router;
