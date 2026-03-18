/* ============================================================
   Tenement Supervision — App JS (KML-centric model)
   ============================================================ */

const App = (() => {

  let state = {
    view: 'dashboard',
    projects: [],
    pagination: { page: 1, limit: 80, total: 0, pages: 0 },
    filters: { search: '', classification: '', batchId: '', primaryCommodity: '', secondaryCommodity: '' },
    selectedIds: new Set(),
    expandedIds: new Set(),
    currentProject: null,
    pendingCls: null,
    mapInstance: null,
    mapLayers: [],
    mapReady: false,
    searchTimer: null,
    metadataMap: {}  // oreBodyId -> ProjectData
  };

  // ─── Navigation ──────────────────────────────────────────
  // ─── Auth state ──────────────────────────────────────────────
  let authUser      = null;  // { id, username, role, displayName, mustChangePassword }
  let pageAccess    = {};    // from server: { view: ['user','admin'], … }

  // Intercept all fetch calls — on 401 TOKEN_EXPIRED try silent refresh once
  const _origFetch = window.fetch.bind(window);
  let _refreshing   = null;

  async function apiFetch(url, opts = {}) {
    opts.credentials = opts.credentials || 'same-origin';
    let res = await _origFetch(url, opts);
    if (res.status === 403) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.code === 'MUST_CHANGE_PASSWORD') {
        window.location.href = '/change-password';
        return res;
      }
    }
    if (res.status === 401) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.code === 'TOKEN_EXPIRED' || body.code === 'UNAUTHENTICATED') {
        // Try refresh once
        if (!_refreshing) {
          _refreshing = _origFetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
            .then(r => r.json())
            .finally(() => { _refreshing = null; });
        }
        const refreshData = await _refreshing;
        if (refreshData && refreshData.success) {
          authUser   = refreshData.user;
          pageAccess = refreshData.pageAccess || pageAccess;
          // Retry original request
          res = await _origFetch(url, opts);
        } else {
          window.location.href = '/login';
          return res;
        }
      }
    }
    return res;
  }

  // Replace the global fetch used by all functions in this module
  // (we shadow 'fetch' locally via a wrapper)
  const fetch = apiFetch;

  function navigate(view) {
    // Role gate — redirect if user lacks permission
    if (pageAccess[view] && authUser && !pageAccess[view].includes(authUser.role)) {
      showToast('Access denied', 'error');
      return;
    }
    const titles = { dashboard: 'Dashboard', upload: 'Upload KML', projects: 'Projects', map: 'Map View', batches: 'Batches', changes: 'Change Monitoring', intelligence: 'Expiration', prices: 'Price Intelligence', flora: 'Flora & Fauna', drill: 'Drill Programs', users: 'User Management' };

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');
    const navEl = document.querySelector(`[data-view="${view}"]`);
    if (navEl) navEl.classList.add('active');

    document.getElementById('view-title').textContent = titles[view] || view;
    state.view = view;

    const content   = document.getElementById('content-area');
    const mapView   = document.getElementById('view-map');
    const floraView = document.getElementById('view-flora');

    if (view === 'map') {
      content.style.display = 'none';
      mapView.classList.add('active');
      floraView.classList.remove('active');
      initMap();
    } else if (view === 'flora') {
      content.style.display = 'none';
      floraView.classList.add('active');
      mapView.classList.remove('active');
      _floraInit();
    } else {
      content.style.display = '';
      mapView.classList.remove('active');
      floraView.classList.remove('active');
    }

    if (view === 'dashboard') loadDashboard();
    if (view === 'projects') { state.pagination.page = 1; loadMetadata().then(loadProjects); loadBatchFilter(); loadCommodityFilter(); }
    if (view === 'batches') loadBatches();
    if (view === 'changes') loadSessions();
    if (view === 'intelligence') { intelState.page = 1; loadIntelligence(); }
    if (view === 'prices') loadPriceSymbols();
    if (view === 'drill') drillLoadList();
    if (view === 'users') usersLoad();
  }

  // ─── Dashboard ───────────────────────────────────────────
  async function loadMetadata() {
    try {
      const res = await fetch('/api/metadata');
      const data = await res.json();
      if (data.success) {
        state.metadataMap = {};
        for (const m of data.data) state.metadataMap[m.oreBodyId] = m;
      }
    } catch {}
  }

  async function loadDashboard() {
    try {
      const [sRes, bRes, mRes] = await Promise.all([fetch('/api/projects/stats'), fetch('/api/batches'), fetch('/api/metadata')]);
      const stats = await sRes.json();
      const batches = await bRes.json();
      const metaData = await mRes.json();

      if (stats.success) {
        const d = stats.data;
        setText('s-total',        d.total);
        setText('s-tenements',    d.totalTenements);
        setText('s-internal',     d.internal);
        setText('s-external',     d.external);
        setText('s-unclassified', d.unclassified);
        setText('s-free',         d.free ?? (d.total - d.withTenements));
        document.getElementById('sidebar-count').textContent = d.total;

        // Status breakdown
        const sb = document.getElementById('d-status');
        if (d.statusBreakdown && d.statusBreakdown.length > 0) {
          sb.innerHTML = d.statusBreakdown.map(s => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
              <div style="display:flex;align-items:center;gap:8px;">
                <div style="width:8px;height:8px;border-radius:50%;background:${statusColor(s._id)};flex-shrink:0;"></div>
                <span style="color:var(--text-2);font-size:13px;">${s._id || 'Unknown'}</span>
              </div>
              <span style="font-weight:700;color:var(--text-1);">${s.count}</span>
            </div>`).join('');
        } else {
          sb.innerHTML = '<p style="color:var(--text-3);font-size:13px;">No tenements found yet</p>';
        }
      }

      if (batches.success) {
        const recent = batches.data.slice(0, 4);
        const el = document.getElementById('d-batches');
        if (recent.length === 0) {
          el.innerHTML = '<p style="color:var(--text-3);font-size:13px;">No batches yet. <a href="#" onclick="App.navigate(\'upload\')" style="color:var(--blue)">Upload KML files</a> to start.</p>';
        } else {
          el.innerHTML = recent.map(b => miniBatchRow(b)).join('');
        }
      }

      // Commodity breakdown
      const comEl = document.getElementById('d-commodities');
      if (metaData.success && metaData.data.length > 0) {
        const commodityTotals = {};
        const containedMetalKeys = ['totalContainedMetal1', 'totalContainedMetal2', 'totalContainedMetal3'];
        for (const m of metaData.data) {
          const comms = [m.commodity1, m.commodity2, m.commodity3];
          comms.forEach((c, i) => {
            if (!c) return;
            if (!commodityTotals[c]) commodityTotals[c] = { primary: 0, secondary: 0, totalInsitu: 0, totalTonnages: 0, totalContainedMetal: 0 };
            if (i === 0) commodityTotals[c].primary++;
            else         commodityTotals[c].secondary++;
            commodityTotals[c].totalInsitu         += m.totalInsituBillion || 0;
            commodityTotals[c].totalTonnages       += m.totalTonnages || 0;
            commodityTotals[c].totalContainedMetal += m[containedMetalKeys[i]] || 0;
          });
        }
        const sorted = Object.entries(commodityTotals).sort((a,b) => b[1].primary - a[1].primary || b[1].secondary - a[1].secondary);
        const th = (t) => `<th style="text-align:right;padding:6px 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-3);">${t}</th>`;
        comEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border);">
              ${th('Commodity')}${th('Primary')}${th('Secondary')}${th('In-Situ (B)')}${th('Ore Tonnage')}${th('Contained Metal')}
            </tr>
          </thead>
          <tbody>
            ${sorted.map(([c, v]) => `
            <tr style="border-bottom:1px solid var(--border);">
              <td style="padding:8px 10px 8px 0;font-weight:700;color:var(--text-1);"><span class="comm-badge">${esc(c)}</span></td>
              <td style="padding:8px 8px;text-align:right;">
                ${v.primary > 0 ? `<span style="font-weight:700;color:var(--blue);">${v.primary}</span>` : `<span style="color:var(--text-3);">—</span>`}
              </td>
              <td style="padding:8px 8px;text-align:right;">
                ${v.secondary > 0 ? `<span style="color:var(--text-2);">${v.secondary}</span>` : `<span style="color:var(--text-3);">—</span>`}
              </td>
              <td style="padding:8px 8px;text-align:right;color:var(--text-2);">${fmtNum(v.totalInsitu, 3)}</td>
              <td style="padding:8px 8px;text-align:right;color:var(--text-2);">${fmtNum(v.totalTonnages/1e6, 2)}M t</td>
              <td style="padding:8px 0 8px 8px;text-align:right;color:var(--text-2);">${v.totalContainedMetal ? fmtNum(v.totalContainedMetal, 0)+' '+metalUnit(c) : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
      } else {
        comEl.innerHTML = '<div style="color:var(--text-3);font-size:13px;">No metadata imported yet — <a href="#" onclick="App.navigate(\'upload\')" style="color:var(--blue)">upload ProjectsData.csv</a></div>';
      }
    } catch (e) { console.error(e); }
  }

  function miniBatchRow(b) { return miniRow(b); }
  function miniRow(b) {
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;" onclick="App.viewBatch('${b._id}')">
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--text-1);">${esc(b.name)}</div>
        <div style="font-size:11.5px;color:var(--text-3);">${fmtDate(b.createdAt)} · ${b.totalFiles || 0} files</div>
      </div>
      <div style="display:flex;gap:10px;text-align:center;">
        <div><div style="font-size:16px;font-weight:800;color:var(--text-1);">${b.totalTenements||0}</div><div style="font-size:10.5px;color:var(--text-3);">Projects</div></div>
        <div><div style="font-size:16px;font-weight:800;color:var(--blue);">${b.internalCount||0}</div><div style="font-size:10.5px;color:var(--text-3);">Internal</div></div>
        <div><div style="font-size:16px;font-weight:800;color:var(--orange);">${b.externalCount||0}</div><div style="font-size:10.5px;color:var(--text-3);">External</div></div>
      </div>
    </div>`;
  }

  // ─── Projects ─────────────────────────────────────────────
  async function loadProjects() {
    document.getElementById('projects-tbody').innerHTML =
      '<tr><td colspan="7" class="loading-cell"><div style="display:flex;align-items:center;justify-content:center;gap:8px;"><div class="spinner"></div>Loading...</div></td></tr>';

    const params = new URLSearchParams({
      page:  state.pagination.page,
      limit: state.pagination.limit,
      ...(state.filters.search             && { search:             state.filters.search }),
      ...(state.filters.classification     && { classification:     state.filters.classification }),
      ...(state.filters.batchId            && { batchId:            state.filters.batchId }),
      ...(state.filters.primaryCommodity   && { primaryCommodity:   state.filters.primaryCommodity }),
      ...(state.filters.secondaryCommodity && { secondaryCommodity: state.filters.secondaryCommodity })
    });

    try {
      const res  = await fetch(`/api/projects?${params}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      state.projects   = data.data;
      state.pagination = { ...state.pagination, ...data.pagination };
      state.selectedIds.clear();
      updateBulkBar();

      renderProjects();
      renderPagination();
      document.getElementById('projects-sub').textContent =
        `${data.pagination.total.toLocaleString()} projects`;
    } catch (e) {
      const cell = document.createElement('td');
      cell.colSpan = 7; cell.className = 'loading-cell'; cell.style.color = 'var(--red)';
      cell.textContent = 'Error: ' + e.message;
      const tr = document.createElement('tr'); tr.appendChild(cell);
      document.getElementById('projects-tbody').replaceChildren(tr);
    }
  }

  function renderProjects() {
    const tbody = document.getElementById('projects-tbody');
    if (state.projects.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7">
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <h3>No KML projects found</h3>
          <p>Upload KML files or adjust filters</p>
        </div></td></tr>`;
      return;
    }

    const rows = [];
    for (const p of state.projects) {
      rows.push(projectRow(p));
      if (state.expandedIds.has(p._id)) rows.push(expandRow(p));
    }
    tbody.innerHTML = rows.join('');
  }

  function projectRow(p) {
    const checked = state.selectedIds.has(p._id) ? 'checked' : '';
    const selected = state.selectedIds.has(p._id) ? 'selected' : '';

    // Tenement count + status summary
    const count = p.matchedCount || 0;
    const tenements = p.tenements || [];
    const live    = tenements.filter(t => t.tenStatus === 'LIVE').length;
    const pending = tenements.filter(t => t.tenStatus === 'PENDING').length;
    const other   = count - live - pending;

    const countHTML = count === 0
      ? `<span class="badge badge-free">Free</span>`
      : `<span class="tenement-count"><span class="count-bubble">${count}</span> tenement${count !== 1 ? 's' : ''}</span>`;

    const pillsHTML = count > 0 ? `<div class="status-pills">
      ${live    > 0 ? `<span class="status-pill sp-live">${live} Live</span>` : ''}
      ${pending > 0 ? `<span class="status-pill sp-pending">${pending} Pending</span>` : ''}
      ${other   > 0 ? `<span class="status-pill sp-other">${other} Free</span>` : ''}
    </div>` : '';

    // Classification toggle
    const cls = p.classification || 'unclassified';
    const clsHTML = `<div class="cls-toggle">
      <button class="cls-btn ${cls === 'internal' ? 'active-internal' : ''}"
        onclick="App.quickClassify('${p._id}','internal',event)">Internal</button>
      <button class="cls-btn ${cls === 'external' ? 'active-external' : ''}"
        onclick="App.quickClassify('${p._id}','external',event)">External</button>
    </div>`;

    const expanded = state.expandedIds.has(p._id);
    const displayName = p.projectName || p.kmlName;
    const meta = state.metadataMap[p.kmlName];
    const commodityHTML = meta
      ? [meta.commodity1, meta.commodity2, meta.commodity3].filter(Boolean)
          .map(c => `<span class="comm-badge">${esc(c)}</span>`).join('')
      : '<span style="color:var(--text-3);font-size:12px;">—</span>';

    return `<tr class="${selected}" data-id="${p._id}">
      <td class="cb-col"><input type="checkbox" ${checked} onchange="App.toggleSelect('${p._id}',this)" /></td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;" id="name-view-${p._id}">
          <div class="project-name">${esc(displayName)}</div>
          <button onclick="App.startEditName('${p._id}')" title="Edit project name"
            style="background:none;border:none;cursor:pointer;padding:2px;color:var(--text-3);display:flex;align-items:center;flex-shrink:0;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
        <div id="name-edit-${p._id}" style="display:none;align-items:center;gap:5px;">
          <input type="text" value="${esc(displayName)}"
            style="font-size:13px;font-weight:600;padding:3px 7px;border-radius:5px;border:1px solid var(--blue);width:200px;outline:none;"
            onkeydown="App.onNameKey('${p._id}',event)"
            id="name-input-${p._id}" />
          <button onclick="App.saveProjectName('${p._id}')" class="btn btn-primary btn-xs">Save</button>
          <button onclick="App.cancelEditName('${p._id}')" class="btn btn-secondary btn-xs">Cancel</button>
        </div>
        ${p.projectName ? `<div class="project-file">${esc(p.kmlName)}</div>` : `<div class="project-file">${esc(p.sourceFile)}</div>`}
      </td>
      <td><div style="display:flex;flex-wrap:wrap;gap:3px;">${commodityHTML}</div></td>
      <td>
        ${countHTML}
        ${pillsHTML}
      </td>
      <td>
        ${count > 0 ? statusSummaryHTML(tenements) : '<span style="color:var(--text-3);font-size:12px;">—</span>'}
      </td>
      <td>${clsHTML}</td>
      <td>
        <button class="expand-btn ${expanded ? 'open' : ''}" onclick="App.toggleExpand('${p._id}')" title="${expanded ? 'Collapse' : 'Show details'}" style="display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:5px;border:1px solid var(--border);background:var(--gray-light);color:var(--text-2);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          ${expanded ? 'Close' : 'Details'}
        </button>
      </td>
    </tr>`;
  }

  function statusSummaryHTML(tenements) {
    if (!tenements || tenements.length === 0) return '';
    // Unique statuses with counts
    const counts = {};
    for (const t of tenements) {
      const s = t.tenStatus || 'Unknown';
      counts[s] = (counts[s] || 0) + 1;
    }
    return Object.entries(counts).map(([s, n]) =>
      `<span style="font-size:12px;color:${statusColor(s)};">${n} ${statusLabel(s)}</span>`
    ).join(' · ');
  }

  function expandRow(p) {
    const tenements = p.tenements || [];
    const meta = state.metadataMap[p.kmlName];

    // Metadata section
    let metaHTML = '';
    if (meta) {
      const comms = [meta.commodity1, meta.commodity2, meta.commodity3].filter(Boolean);
      const subs   = meta.subdivisions || [];
      const subTable = subs.length > 0 ? `
        <div style="margin-top:8px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-3);margin-bottom:6px;">Subdivision Breakdown (${subs.length})</div>
          <div class="sub-table-wrap">
            <table class="sub-table">
              <thead><tr>
                <th>Subdivision</th>
                ${comms[0]?`<th>Grade ${esc(comms[0])} (%)</th>`:''}
                ${comms[1]?`<th>Grade ${esc(comms[1])} (%)</th>`:''}
                ${comms[2]?`<th>Grade ${esc(comms[2])} (%)</th>`:''}
                <th>Tonnages (t)</th>
                <th>In-Situ (B)</th>
                <th>EV (B)</th>
                ${comms[0]?`<th>${esc(comms[0])} Metal (${metalUnit(comms[0])})</th>`:''}
                ${comms[1]?`<th>${esc(comms[1])} Metal (${metalUnit(comms[1])})</th>`:''}
                ${comms[2]?`<th>${esc(comms[2])} Metal (${metalUnit(comms[2])})</th>`:''}
              </tr></thead>
              <tbody>
                ${subs.map(s => `<tr>
                  <td style="font-family:var(--font-mono);font-size:11.5px;font-weight:600;">${esc(s.subdivisionId||'—')}</td>
                  ${comms[0]?`<td style="font-size:12px;">${s.grade1!=null?s.grade1.toFixed(3):'—'}</td>`:''}
                  ${comms[1]?`<td style="font-size:12px;">${s.grade2!=null?s.grade2.toFixed(3):'—'}</td>`:''}
                  ${comms[2]?`<td style="font-size:12px;">${s.grade3!=null?s.grade3.toFixed(3):'—'}</td>`:''}
                  <td style="font-size:12px;">${s.tonnages!=null?fmtNum(s.tonnages,0):'—'}</td>
                  <td style="font-size:12px;">${s.insituBillion!=null?s.insituBillion.toFixed(4):'—'}</td>
                  <td style="font-size:12px;">${s.evBillion!=null?s.evBillion.toFixed(4):'—'}</td>
                  ${comms[0]?`<td style="font-size:12px;">${s.containedMetal1!=null?fmtNum(s.containedMetal1,0):'—'}</td>`:''}
                  ${comms[1]?`<td style="font-size:12px;">${s.containedMetal2!=null?fmtNum(s.containedMetal2,0):'—'}</td>`:''}
                  ${comms[2]?`<td style="font-size:12px;">${s.containedMetal3!=null?fmtNum(s.containedMetal3,0):'—'}</td>`:''}
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : '';

      metaHTML = `<div style="padding:10px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-3);">Project Metadata</div>
          ${comms.map(c=>`<span class="comm-badge">${esc(c)}</span>`).join('')}
          ${meta.country?`<span style="font-size:12px;color:var(--text-3);">· ${esc(meta.country)}</span>`:''}
          ${meta.mineLife?`<span style="font-size:12px;color:var(--text-3);">· Mine life: ${meta.mineLife} yr</span>`:''}
          ${meta.cumulativeML?`<span style="font-size:12px;color:var(--text-3);">· Cumulative ML: ${meta.cumulativeML}</span>`:''}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8px;">
          <div style="background:var(--gray-light);border-radius:6px;padding:7px 12px;">
            <div style="font-size:10.5px;color:var(--text-3);">Total In-Situ</div>
            <div style="font-size:14px;font-weight:700;color:var(--text-1);">${meta.totalInsituBillion!=null?meta.totalInsituBillion.toFixed(3):'-'} B</div>
          </div>
          <div style="background:var(--gray-light);border-radius:6px;padding:7px 12px;">
            <div style="font-size:10.5px;color:var(--text-3);">Total EV</div>
            <div style="font-size:14px;font-weight:700;color:var(--text-1);">${meta.totalEVBillion!=null?meta.totalEVBillion.toFixed(3):'-'} B</div>
          </div>
          <div style="background:var(--gray-light);border-radius:6px;padding:7px 12px;">
            <div style="font-size:10.5px;color:var(--text-3);">Total Tonnages</div>
            <div style="font-size:14px;font-weight:700;color:var(--text-1);">${meta.totalTonnages!=null?fmtNum(meta.totalTonnages,0):'-'} t</div>
          </div>
          ${comms[0]&&meta.totalContainedMetal1?`<div style="background:var(--gray-light);border-radius:6px;padding:7px 12px;">
            <div style="font-size:10.5px;color:var(--text-3);">${esc(comms[0])} Metal</div>
            <div style="font-size:14px;font-weight:700;color:var(--text-1);">${fmtNum(meta.totalContainedMetal1,0)} ${metalUnit(comms[0])}</div>
          </div>`:''}
          ${comms[1]&&meta.totalContainedMetal2?`<div style="background:var(--gray-light);border-radius:6px;padding:7px 12px;">
            <div style="font-size:10.5px;color:var(--text-3);">${esc(comms[1])} Metal</div>
            <div style="font-size:14px;font-weight:700;color:var(--text-1);">${fmtNum(meta.totalContainedMetal2,0)} ${metalUnit(comms[1])}</div>
          </div>`:''}
          ${comms[2]&&meta.totalContainedMetal3?`<div style="background:var(--gray-light);border-radius:6px;padding:7px 12px;">
            <div style="font-size:10.5px;color:var(--text-3);">${esc(comms[2])} Metal</div>
            <div style="font-size:14px;font-weight:700;color:var(--text-1);">${fmtNum(meta.totalContainedMetal3,0)} ${metalUnit(comms[2])}</div>
          </div>`:''}
        </div>
        ${subTable}
      </div>`;
    }

    const tenementInner = tenements.length === 0
      ? `<div class="no-tenements">No intersecting tenements found in TENGRAPH</div>`
      : `<div class="sub-table-wrap">
          <table class="sub-table">
            <thead><tr>
              <th>Tenement ID</th><th>Status</th><th>Type</th>
              <th>Area</th><th>End Date</th><th>Primary Holder</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${tenements.map((t, i) => `<tr style="cursor:pointer;" onclick="App.showTenementDetail('${p._id}',${i})" title="Click to view full details">
                <td style="font-family:var(--font-mono);font-weight:600;color:var(--text-1);">${esc(t.tenementId || '—')}</td>
                <td>${statusBadge(t.tenStatus)}</td>
                <td style="font-size:12px;">${truncate(t.tenType || '—', 30)}</td>
                <td style="font-size:12px;">${t.legalArea ? `${t.legalArea.toFixed(1)} ${t.areaUnit||''}` : '—'}</td>
                <td style="font-size:12px;">${fmtDate(t.endDate, true)}</td>
                <td style="font-size:12px;">${truncate(t.holders && t.holders[0] ? t.holders[0].name : '—', 32)}</td>
                <td><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;

    return `<tr class="expand-row" data-expand="${p._id}">
      <td colspan="7">
        <div class="expand-panel">
          ${metaHTML}
          <div class="expand-title">Tenements intersecting this KML boundary (${tenements.length})${tenements.length>0?' — click any row for full details':''}</div>
          ${tenementInner}
          <div style="margin-top:10px;">
            <button class="btn btn-secondary btn-sm" onclick="App.openDetail('${p._id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              Full Project Details &amp; Classify
            </button>
          </div>
        </div>
      </td>
    </tr>`;
  }

  function toggleExpand(id) {
    if (state.expandedIds.has(id)) state.expandedIds.delete(id);
    else state.expandedIds.add(id);
    renderProjects();
  }

  function statusBadge(status) {
    if (status === 'LIVE')    return '<span class="badge badge-live">Live</span>';
    if (status === 'PENDING') return '<span class="badge badge-pending">Pending</span>';
    return '<span class="badge badge-notfound">Free</span>';
  }

  function statusLabel(status) {
    if (status === 'LIVE')    return 'Live';
    if (status === 'PENDING') return 'Pending';
    return 'Free';
  }

  function showTenementDetail(projectId, tenIdx) {
    // Find project in current state (also check allTenements for map)
    const project = state.projects.find(p => p._id === projectId);
    if (!project) return;
    const t = (project.tenements || [])[tenIdx];
    if (!t) return;

    const holders = t.holders && t.holders.length > 0
      ? t.holders.map((h, i) => `
          <div style="padding:8px 0;${i > 0 ? 'border-top:1px solid var(--border);' : ''}">
            <div style="font-weight:600;color:var(--text-1);font-size:13px;">${esc(h.name)}</div>
            ${h.address ? `<div style="font-size:12px;color:var(--text-3);margin-top:2px;">${esc(h.address)}</div>` : ''}
          </div>`).join('')
      : '<span style="color:var(--text-3);font-size:13px;">No holders recorded</span>';

    const raw = t.apiRawData || {};

    document.getElementById('tmodal-title').textContent = t.tenementId || 'Tenement Details';
    document.getElementById('tmodal-body').innerHTML = `
      <div style="margin-bottom:14px;">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);">KML Project</span>
        <div style="font-size:13px;color:var(--text-2);margin-top:2px;">${esc(project.kmlName)} <span style="color:var(--text-3);">· ${esc(project.sourceFile)}</span></div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:3px;">Tenement ID</div>
          <div style="font-family:var(--font-mono);font-size:20px;font-weight:800;color:var(--text-1);">${esc(t.tenementId || '—')}</div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:5px;">Status</div>
          <div>${statusBadge(t.tenStatus)}</div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:3px;">Type</div>
          <div style="font-size:13px;color:var(--text-1);">${esc(t.tenType || '—')}</div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:3px;">Survey Status</div>
          <div style="font-size:13px;color:var(--text-1);">${esc(t.surveyStatus || '—')}</div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:3px;">Legal Area</div>
          <div style="font-size:13px;color:var(--text-1);font-weight:600;">${t.legalArea != null ? `${Number(t.legalArea).toFixed(3)} ${t.areaUnit || ''}` : '—'}</div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:3px;">Holder Count</div>
          <div style="font-size:13px;color:var(--text-1);">${t.holderCount || 0}</div>
        </div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:14px;margin-bottom:14px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:10px;">Dates</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
          <div>
            <div style="font-size:11px;color:var(--text-3);margin-bottom:2px;">Grant Date</div>
            <div style="font-size:13px;font-weight:600;color:var(--text-1);">${fmtDate(t.grantDate, true)}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-3);margin-bottom:2px;">Start Date</div>
            <div style="font-size:13px;font-weight:600;color:var(--text-1);">${fmtDate(t.startDate)}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-3);margin-bottom:2px;">End Date</div>
            <div style="font-size:13px;font-weight:600;color:var(--text-1);">${fmtDate(t.endDate, true)}</div>
          </div>
        </div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:14px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:8px;">Holders</div>
        ${holders}
      </div>
    `;

    document.getElementById('tmodal').classList.add('open');
  }

  function closeTenementModal() {
    document.getElementById('tmodal').classList.remove('open');
  }

  // ─── Inline project name editing ─────────────────────────
  function startEditName(id) {
    document.getElementById(`name-view-${id}`).style.display = 'none';
    const editEl = document.getElementById(`name-edit-${id}`);
    editEl.style.display = 'flex';
    const input = document.getElementById(`name-input-${id}`);
    input.focus();
    input.select();
  }

  function cancelEditName(id) {
    document.getElementById(`name-edit-${id}`).style.display = 'none';
    document.getElementById(`name-view-${id}`).style.display = 'flex';
  }

  function onNameKey(id, event) {
    if (event.key === 'Enter')  saveProjectName(id);
    if (event.key === 'Escape') cancelEditName(id);
  }

  async function saveProjectName(id) {
    const input = document.getElementById(`name-input-${id}`);
    const name  = input ? input.value.trim() : '';
    try {
      const res = await fetch(`/api/projects/${id}/name`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: name })
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Server error (${res.status}) — restart the server and try again`); }
      if (data.success) {
        const p = state.projects.find(x => x._id === id);
        if (p) p.projectName = name;
        renderProjects();
        showToast('Project name saved', 'success');
      } else {
        showToast(data.error, 'error');
      }
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ─── Quick inline classification ─────────────────────────
  async function quickClassify(id, cls, event) {
    event && event.stopPropagation();
    try {
      const res  = await fetch(`/api/projects/${id}/classification`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification: cls })
      });
      const data = await res.json();
      if (data.success) {
        // Update local state
        const p = state.projects.find(x => x._id === id);
        if (p) p.classification = cls;
        renderProjects();
        refreshStats();
        showToast(`Marked as ${cls}`, 'success');
      } else showToast(data.error, 'error');
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ─── Selection ────────────────────────────────────────────
  function toggleSelect(id, cb) {
    if (cb.checked) state.selectedIds.add(id);
    else state.selectedIds.delete(id);
    updateBulkBar();
    // highlight row
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.classList.toggle('selected', cb.checked);
  }

  function toggleSelectAll(cb) {
    state.projects.forEach(p => { if (cb.checked) state.selectedIds.add(p._id); else state.selectedIds.delete(p._id); });
    updateBulkBar();
    renderProjects();
  }

  function updateBulkBar() {
    const bar = document.getElementById('bulk-bar');
    const n   = state.selectedIds.size;
    bar.classList.toggle('visible', n > 0);
    document.getElementById('bulk-count').textContent = `${n} selected`;
    const sa = document.getElementById('select-all');
    if (sa) sa.checked = state.projects.length > 0 && state.projects.every(p => state.selectedIds.has(p._id));
  }

  function clearSelection() {
    state.selectedIds.clear();
    updateBulkBar();
    renderProjects();
  }

  async function bulkClassify(cls) {
    if (state.selectedIds.size === 0) return;
    try {
      const res  = await fetch('/api/projects/bulk/classification', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...state.selectedIds], classification: cls })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`${state.selectedIds.size} projects marked as ${cls}`, 'success');
        state.selectedIds.clear();
        updateBulkBar();
        loadProjects();
        refreshStats();
      } else showToast(data.error, 'error');
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ─── Pagination ───────────────────────────────────────────
  function renderPagination() {
    const { page, pages, total, limit } = state.pagination;
    const el = document.getElementById('pagination');
    if (total === 0) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    const from = (page - 1) * limit + 1;
    const to   = Math.min(page * limit, total);
    document.getElementById('pag-info').textContent = `${from}–${to} of ${total.toLocaleString()}`;

    let html = `<button class="page-btn" onclick="App.goPage(${page-1})" ${page<=1?'disabled':''}>‹</button>`;
    const start = Math.max(1, page-2), end = Math.min(pages, start+4);
    for (let i = start; i <= end; i++)
      html += `<button class="page-btn ${i===page?'active':''}" onclick="App.goPage(${i})">${i}</button>`;
    html += `<button class="page-btn" onclick="App.goPage(${page+1})" ${page>=pages?'disabled':''}>›</button>`;
    document.getElementById('pag-btns').innerHTML = html;
  }

  function goPage(p) {
    if (p < 1 || p > state.pagination.pages) return;
    state.pagination.page = p;
    loadProjects();
  }

  // ─── Filters ─────────────────────────────────────────────
  function onSearch(val) {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.filters.search = val;
      state.pagination.page = 1;
      loadProjects();
    }, 320);
  }

  function applyFilters() {
    state.filters.classification     = document.getElementById('filter-cls').value;
    state.filters.batchId            = document.getElementById('filter-batch').value;
    state.filters.primaryCommodity   = document.getElementById('filter-primary-commodity').value;
    state.filters.secondaryCommodity = document.getElementById('filter-secondary-commodity').value;
    state.pagination.page = 1;
    loadProjects();
  }

  async function loadBatchFilter() {
    try {
      const res  = await fetch('/api/batches');
      const data = await res.json();
      if (data.success) {
        const sel = document.getElementById('filter-batch');
        const cur = sel.value;
        sel.innerHTML = '<option value="">All Batches</option>' +
          data.data.map(b => `<option value="${b._id}" ${b._id===cur?'selected':''}>${esc(b.name)}</option>`).join('');
      }
    } catch {}
  }

  async function loadCommodityFilter() {
    try {
      const res  = await fetch('/api/projects/commodities');
      const data = await res.json();
      if (!data.success) return;
      const { primary = [], secondary = [] } = data.data;
      const sel1 = document.getElementById('filter-primary-commodity');
      const sel2 = document.getElementById('filter-secondary-commodity');
      const cur1 = sel1.value, cur2 = sel2.value;
      sel1.innerHTML = '<option value="">All Primary Commodities</option>' +
        primary.map(c => `<option value="${esc(c)}" ${c===cur1?'selected':''}>${esc(c)}</option>`).join('');
      sel2.innerHTML = '<option value="">All Secondary Commodities</option>' +
        secondary.map(c => `<option value="${esc(c)}" ${c===cur2?'selected':''}>${esc(c)}</option>`).join('');
    } catch {}
  }

  // ─── Detail Modal ─────────────────────────────────────────
  async function openDetail(id) {
    try {
      const res  = await fetch(`/api/projects/${id}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      state.currentProject = data.data;
      state.pendingCls = data.data.classification;
      const meta = state.metadataMap[data.data.kmlName] || null;
      renderModal(data.data, meta);
      document.getElementById('modal').classList.add('open');
    } catch (e) { showToast(e.message, 'error'); }
  }

  function renderModal(p, meta) {
    document.getElementById('modal-title').textContent = p.projectName || p.kmlName;
    document.getElementById('modal-note').value = p.classificationNote || '';
    updateModalCls(p.classification);

    const tenements = p.tenements || [];
    const holderSet = new Set();
    tenements.forEach(t => (t.holders||[]).forEach(h => h.name && holderSet.add(h.name)));

    // Metadata section
    let metaSection = '';
    if (meta) {
      const comms = [meta.commodity1, meta.commodity2, meta.commodity3].filter(Boolean);
      metaSection = `<div style="margin-bottom:14px;padding:12px;background:var(--gray-light);border-radius:var(--radius);">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
          <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-3);">Metadata</span>
          ${comms.map(c=>`<span class="comm-badge">${esc(c)}</span>`).join('')}
          ${meta.country?`<span style="font-size:12px;color:var(--text-3);">· ${esc(meta.country)}</span>`:''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
          <div><div style="font-size:10.5px;color:var(--text-3);">In-Situ (B)</div><div style="font-weight:700;font-size:15px;">${meta.totalInsituBillion!=null?meta.totalInsituBillion.toFixed(3):'-'}</div></div>
          <div><div style="font-size:10.5px;color:var(--text-3);">EV (B)</div><div style="font-weight:700;font-size:15px;">${meta.totalEVBillion!=null?meta.totalEVBillion.toFixed(3):'-'}</div></div>
          <div><div style="font-size:10.5px;color:var(--text-3);">Tonnages</div><div style="font-weight:700;font-size:15px;">${meta.totalTonnages!=null?fmtNum(meta.totalTonnages,0)+' t':'-'}</div></div>
          ${comms[0]&&meta.totalContainedMetal1?`<div><div style="font-size:10.5px;color:var(--text-3);">${esc(comms[0])} (${metalUnit(comms[0])})</div><div style="font-weight:700;font-size:15px;">${fmtNum(meta.totalContainedMetal1,0)}</div></div>`:''}
          ${comms[1]&&meta.totalContainedMetal2?`<div><div style="font-size:10.5px;color:var(--text-3);">${esc(comms[1])} (${metalUnit(comms[1])})</div><div style="font-weight:700;font-size:15px;">${fmtNum(meta.totalContainedMetal2,0)}</div></div>`:''}
          ${comms[2]&&meta.totalContainedMetal3?`<div><div style="font-size:10.5px;color:var(--text-3);">${esc(comms[2])} (${metalUnit(comms[2])})</div><div style="font-weight:700;font-size:15px;">${fmtNum(meta.totalContainedMetal3,0)}</div></div>`:''}
          ${meta.mineLife?`<div><div style="font-size:10.5px;color:var(--text-3);">Mine Life</div><div style="font-weight:700;font-size:15px;">${meta.mineLife} yr</div></div>`:''}
          ${meta.cumulativeML?`<div><div style="font-size:10.5px;color:var(--text-3);">Cumulative ML</div><div style="font-weight:700;font-size:15px;">${meta.cumulativeML}</div></div>`:''}
          ${(meta.subdivisions||[]).length?`<div><div style="font-size:10.5px;color:var(--text-3);">Subdivisions</div><div style="font-weight:700;font-size:15px;">${meta.subdivisions.length}</div></div>`:''}
        </div>
      </div>`;
    }

    let tenTable = '';
    if (tenements.length > 0) {
      tenTable = `<div style="margin-top:14px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-3);margin-bottom:8px;">
          ${tenements.length} Tenement${tenements.length!==1?'s':''} Intersecting This Area
        </div>
        <div class="sub-table-wrap">
          <table class="sub-table">
            <thead><tr><th>ID</th><th>Status</th><th>Type</th><th>Area</th><th>Holder</th></tr></thead>
            <tbody>${tenements.map(t => `<tr>
              <td style="font-family:var(--font-mono);font-weight:600;">${esc(t.tenementId||'—')}</td>
              <td>${statusBadge(t.tenStatus)}</td>
              <td style="font-size:12px;">${truncate(t.tenType||'—',28)}</td>
              <td style="font-size:12px;">${t.legalArea?`${t.legalArea.toFixed(1)} ${t.areaUnit||''}`:'—'}</td>
              <td style="font-size:12px;">${truncate(t.holders&&t.holders[0]?t.holders[0].name:'—',28)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;
    } else {
      tenTable = `<div style="margin-top:12px;padding:14px;background:var(--gray-light);border-radius:var(--radius);font-size:13px;color:var(--text-3);text-align:center;">
        No intersecting tenements found in TENGRAPH
      </div>`;
    }

    document.getElementById('modal-body').innerHTML = `
      ${metaSection}
      <div class="detail-grid">
        <div class="detail-item">
          <label>KML Name</label>
          <div class="val">${esc(p.kmlName)}</div>
        </div>
        <div class="detail-item">
          <label>Source File</label>
          <div class="val" style="font-size:12px;">${esc(p.sourceFile)}</div>
        </div>
        <div class="detail-item">
          <label>Tenements Found</label>
          <div class="val plain" style="font-size:22px;font-weight:800;">${p.matchedCount||0}</div>
        </div>
        <div class="detail-item">
          <label>Unique Holders</label>
          <div class="val plain" style="font-size:22px;font-weight:800;">${holderSet.size}</div>
        </div>
      </div>
      ${holderSet.size > 0 ? `<div style="margin-top:12px;font-size:12px;color:var(--text-2);">
        <span style="font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-3);">Holders — </span>
        ${[...holderSet].map(h => esc(h)).join(', ')}
      </div>` : ''}
      ${tenTable}
    `;
  }

  function updateModalCls(cls) {
    ['internal','external','unclassified'].forEach(c => {
      const btn = document.getElementById(`mcls-${c}`);
      if (!btn) return;
      btn.classList.remove('active-internal','active-external');
      if (c === cls) {
        if (c === 'internal') btn.classList.add('active-internal');
        else if (c === 'external') btn.classList.add('active-external');
      }
    });
  }

  function setPendingCls(cls) {
    state.pendingCls = cls;
    updateModalCls(cls);
  }

  async function saveClassification() {
    if (!state.currentProject) return;
    const note = document.getElementById('modal-note').value;
    try {
      const res  = await fetch(`/api/projects/${state.currentProject._id}/classification`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification: state.pendingCls, note })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Marked as ${state.pendingCls}`, 'success');
        closeModal();
        loadProjects();
        refreshStats();
      } else showToast(data.error, 'error');
    } catch (e) { showToast(e.message, 'error'); }
  }

  function closeModal() {
    document.getElementById('modal').classList.remove('open');
    state.currentProject = null;
    state.pendingCls = null;
  }

  // ─── Metadata CSV Upload ──────────────────────────────────
  let selectedCSVFile = null;

  function setupCSVUpload() {
    const zone  = document.getElementById('csv-upload-zone');
    const input = document.getElementById('csv-file-input');
    if (!zone || !input) return;

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f && f.name.endsWith('.csv')) setCSVFile(f);
    });
    input.addEventListener('change', () => {
      if (input.files[0]) setCSVFile(input.files[0]);
    });
  }

  function setCSVFile(f) {
    selectedCSVFile = f;
    const nameEl = document.getElementById('csv-file-name');
    const btn    = document.getElementById('csv-upload-btn');
    if (nameEl) nameEl.textContent = `Selected: ${f.name} (${fmtSize(f.size)})`;
    if (btn) btn.disabled = false;
  }

  async function uploadMetadataCSV() {
    if (!selectedCSVFile) return;
    const btn = document.getElementById('csv-upload-btn');
    btn.disabled = true;
    btn.textContent = 'Importing...';
    try {
      const fd = new FormData();
      fd.append('csv', selectedCSVFile);
      const res  = await fetch('/api/metadata/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, 'success');
        selectedCSVFile = null;
        document.getElementById('csv-file-name').textContent = '';
        document.getElementById('csv-file-input').value = '';
        await loadMetadata();
        if (state.view === 'projects') renderProjects();
        if (state.view === 'dashboard') loadDashboard();
      } else {
        showToast(data.error, 'error');
      }
    } catch (e) { showToast(e.message, 'error'); }
    finally {
      btn.disabled = false;
      btn.textContent = 'Import Metadata';
    }
  }

  // ─── Upload ───────────────────────────────────────────────
  let selectedFiles = [];

  function setupUpload() {
    const zone  = document.getElementById('upload-zone');
    const input = document.getElementById('file-input');

    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('dragover');
      addFiles([...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.kml')));
    });
    input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  }

  function addFiles(files) {
    for (const f of files)
      if (!selectedFiles.find(x => x.name === f.name && x.size === f.size)) selectedFiles.push(f);
    renderFileList();
  }

  function renderFileList() {
    const btn = document.getElementById('upload-btn');
    btn.disabled = selectedFiles.length === 0;
    document.getElementById('upload-count').textContent =
      selectedFiles.length > 0 ? `${selectedFiles.length} file(s)` : '';
    document.getElementById('file-list').innerHTML = selectedFiles.map((f, i) => `
      <div class="file-item">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2" style="flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="file-item-name">${esc(f.name)}</span>
        <span class="file-item-size">${fmtSize(f.size)}</span>
        <button class="file-remove" onclick="App.removeFile(${i})">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`).join('');
  }

  function removeFile(i) { selectedFiles.splice(i, 1); renderFileList(); }
  function clearFiles() { selectedFiles = []; renderFileList(); }

  async function startUpload() {
    if (selectedFiles.length === 0) return;
    const batchName = document.getElementById('batch-name').value.trim() ||
      `Upload ${new Date().toLocaleDateString('en-AU')}`;
    const fd = new FormData();
    fd.append('batchName', batchName);
    selectedFiles.forEach(f => fd.append('kmlFiles', f));

    const card    = document.getElementById('progress-card');
    const bar     = document.getElementById('prog-bar');
    const status  = document.getElementById('prog-status');
    const title   = document.getElementById('prog-title');
    const btn     = document.getElementById('upload-btn');

    card.style.display = 'block';
    btn.disabled = true;
    title.textContent  = 'Uploading files...';
    status.textContent = `Sending ${selectedFiles.length} KML file(s)...`;

    let pct = 0;
    const iv = setInterval(() => { pct = Math.min(pct + 3, 65); bar.style.width = pct + '%'; }, 120);

    try {
      const res  = await fetch('/api/batches/upload', { method: 'POST', body: fd });
      const data = await res.json();
      clearInterval(iv);
      if (!data.success) throw new Error(data.error);

      title.textContent  = 'Querying TENGRAPH...';
      status.textContent = 'Running spatial queries — this may take a minute';
      bar.style.width    = '75%';

      clearFiles();
      document.getElementById('batch-name').value = '';
      pollBatch(data.data.batchId, bar, status, title, btn, card);
    } catch (e) {
      clearInterval(iv);
      card.style.display = 'none';
      btn.disabled = false;
      showToast(`Upload failed: ${e.message}`, 'error');
    }
  }

  async function pollBatch(id, bar, status, title, btn, card) {
    let attempts = 0;
    const run = async () => {
      attempts++;
      try {
        const res  = await fetch(`/api/batches/${id}`);
        const data = await res.json();
        if (data.success) {
          const b = data.data.batch;
          if (b.status === 'completed') {
            bar.style.width   = '100%';
            title.textContent = 'Complete!';
            status.textContent = `${b.totalTenements} KML projects processed, ${b.matchedCount} with TENGRAPH matches`;
            showToast(`Batch done — ${b.totalTenements} projects`, 'success');
            btn.disabled = false;
            refreshStats();
            setTimeout(() => { card.style.display = 'none'; }, 5000);
            return;
          }
          if (b.status === 'failed') {
            title.textContent = 'Failed';
            status.textContent = b.error || 'Unknown error';
            btn.disabled = false;
            return;
          }
        }
      } catch {}
      if (attempts < 90) setTimeout(run, 2000);
      else { btn.disabled = false; status.textContent = 'Still processing — check Batches tab'; }
    };
    setTimeout(run, 2000);
  }

  // ─── Batches ─────────────────────────────────────────────
  async function loadBatches() {
    const el = document.getElementById('batch-list');
    el.innerHTML = '<div style="color:var(--text-3);font-size:13px;">Loading...</div>';
    try {
      const res  = await fetch('/api/batches');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      if (data.data.length === 0) {
        el.innerHTML = `<div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <h3>No batches yet</h3><p>Upload KML files to create a batch</p></div>`;
        return;
      }
      el.innerHTML = data.data.map(b => batchItemHTML(b)).join('');
      el.querySelectorAll('.delete-batch-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteBatch(btn.dataset.id, btn.dataset.name));
      });
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red);font-size:13px;">Error: ${e.message}</div>`;
    }
  }

  function batchItemHTML(b) {
    const scls = b.status === 'completed' ? 'completed' : b.status === 'failed' ? 'failed' : 'processing';
    const icon = b.status === 'completed'
      ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'
      : b.status === 'failed'
      ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
      : '<div class="spinner" style="width:17px;height:17px;"></div>';

    return `<div class="batch-item">
      <div class="batch-icon ${scls}">${icon}</div>
      <div class="batch-info" onclick="App.viewBatch('${b._id}')" style="cursor:pointer;">
        <div class="batch-name">${esc(b.name)}</div>
        <div class="batch-meta">${fmtDateTime(b.createdAt)} · ${b.totalFiles||0} file(s) · ${b.status}</div>
      </div>
      <div class="batch-stats">
        <div class="batch-stat"><span class="num">${b.totalTenements||0}</span><span class="lbl">Projects</span></div>
        <div class="batch-stat"><span class="num" style="color:var(--blue)">${b.internalCount||0}</span><span class="lbl">Internal</span></div>
        <div class="batch-stat"><span class="num" style="color:var(--orange)">${b.externalCount||0}</span><span class="lbl">External</span></div>
      </div>
      <button class="btn btn-danger btn-sm delete-batch-btn" data-id="${b._id}" data-name="${esc(b.name)}">Delete</button>
    </div>`;
  }

  function viewBatch(id) {
    state.filters.batchId = id;
    navigate('projects');
    setTimeout(() => { document.getElementById('filter-batch').value = id; }, 200);
  }

  async function deleteBatch(id, name) {
    if (!confirm(`Delete batch "${name}" and all its KML projects? This cannot be undone.`)) return;
    try {
      const res  = await fetch(`/api/batches/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) { showToast('Batch deleted', 'success'); loadBatches(); refreshStats(); }
      else showToast(data.error, 'error');
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ─── Map ─────────────────────────────────────────────────
  function initMap() {
    if (!state.mapReady) {
      state.mapInstance = L.map('map', { center: [-25, 122], zoom: 5, attributionControl: false });
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(state.mapInstance);
      state.mapReady = true;
    }
    loadMapData();
  }

  async function loadMapData() {
    const cls = document.getElementById('map-cls').value;
    const params = new URLSearchParams({ limit: 500, ...(cls && { classification: cls }) });
    try {
      const res  = await fetch(`/api/projects?${params}`);
      const data = await res.json();
      if (!data.success) return;

      state.mapLayers.forEach(l => state.mapInstance.removeLayer(l));
      state.mapLayers = [];

      const projects = data.data.filter(p => p.polygon && p.polygon.length >= 3);
      document.getElementById('map-info').textContent = `${projects.length} projects shown`;

      for (const p of projects) {
        const leaflet = p.polygon.map(([lon, lat]) => [lat, lon]);
        const fill = p.classification === 'internal' ? '#2563eb'
                   : p.classification === 'external' ? '#ea580c' : '#94a3b8';
        const tenCount = p.matchedCount || 0;
        const live     = (p.tenements||[]).filter(t=>t.tenStatus==='LIVE').length;
        const pending  = (p.tenements||[]).filter(t=>t.tenStatus==='PENDING').length;

        const poly = L.polygon(leaflet, { color: fill, weight: 2, fillColor: fill, fillOpacity: 0.3 });
        poly.bindPopup(`
          <div style="font-family:system-ui;min-width:200px;">
            <div style="font-weight:700;font-size:14px;margin-bottom:6px;">${esc(p.kmlName)}</div>
            <div style="font-size:12px;color:#64748b;margin-bottom:8px;">${esc(p.sourceFile)}</div>
            <table style="font-size:12px;width:100%;border-collapse:collapse;">
              <tr><td style="color:#94a3b8;padding:2px 8px 2px 0">Tenements</td><td><strong>${tenCount}</strong></td></tr>
              <tr><td style="color:#94a3b8;padding:2px 8px 2px 0">Live</td><td>${live}</td></tr>
              <tr><td style="color:#94a3b8;padding:2px 8px 2px 0">Pending</td><td>${pending}</td></tr>
              <tr><td style="color:#94a3b8;padding:2px 8px 2px 0">Classification</td><td><strong style="color:${fill}">${p.classification}</strong></td></tr>
            </table>
            <button onclick="App.openDetail('${p._id}')" style="margin-top:8px;width:100%;padding:5px 0;background:var(--blue,#2563eb);color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600;">
              View &amp; Classify
            </button>
          </div>`);
        poly.bindTooltip(p.kmlName);
        poly.addTo(state.mapInstance);
        state.mapLayers.push(poly);
      }
    } catch (e) { console.error('Map error', e); }
  }

  function fitMapBounds() {
    if (state.mapLayers.length === 0) return;
    state.mapInstance.fitBounds(L.featureGroup(state.mapLayers).getBounds().pad(0.1));
  }

  // ─── Changes ─────────────────────────────────────────────
  let changesState = { sessions: [], selectedSessionId: null, allChanges: [], filteredChanges: [] };

  async function loadSessions() {
    const el = document.getElementById('sessions-list');
    el.innerHTML = '<div style="padding:16px;color:var(--text-3);font-size:13px;">Loading...</div>';
    try {
      const res  = await fetch('/api/changes/sessions');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      changesState.sessions = data.data;
      renderSessions();
    } catch (e) {
      el.innerHTML = `<div style="padding:16px;color:var(--red);font-size:13px;">Error: ${e.message}</div>`;
    }
  }

  function renderSessions() {
    const el = document.getElementById('sessions-list');
    if (changesState.sessions.length === 0) {
      el.innerHTML = '<div style="padding:16px;color:var(--text-3);font-size:13px;">No sessions yet. Run a re-check to get started.</div>';
      return;
    }
    el.innerHTML = changesState.sessions.map(s => {
      const active   = changesState.selectedSessionId === s._id ? 'active' : '';
      const dotColor = s.status === 'completed' ? (s.changesFound > 0 ? 'var(--orange)' : 'var(--green)') : s.status === 'failed' ? 'var(--red)' : 'var(--text-3)';
      const badge    = s.status === 'completed'
        ? `<span class="change-badge ${s.changesFound > 0 ? 'has-changes' : 'no-changes'}">${s.changesFound > 0 ? s.changesFound + ' changes' : 'No changes'}</span>`
        : `<span style="font-size:11px;color:var(--text-3);">${s.status}</span>`;

      return `<div class="session-item ${active}" onclick="App.selectSession('${s._id}')">
        <div class="session-dot" style="background:${dotColor};"></div>
        <div style="flex:1;min-width:0;">
          <div class="session-name">${esc(s.name || 'Check session')}</div>
          <div class="session-meta">${fmtDateTime(s.startedAt)} · ${s.projectsChecked} projects checked</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${badge}
          <button onclick="event.stopPropagation();App.deleteSession('${s._id}')" title="Delete"
            style="background:none;border:none;cursor:pointer;color:var(--text-3);padding:3px;display:flex;align-items:center;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
  }

  async function selectSession(id) {
    changesState.selectedSessionId = id;
    renderSessions();

    const el = document.getElementById('changes-list');
    el.innerHTML = '<div style="padding:16px;color:var(--text-3);font-size:13px;">Loading changes...</div>';

    try {
      const res  = await fetch(`/api/changes/sessions/${id}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      changesState.allChanges = data.data.changes;
      const s = data.data.session;
      document.getElementById('changes-panel-title').textContent =
        `${s.changesFound} change${s.changesFound !== 1 ? 's' : ''} — ${s.name}`;

      document.getElementById('change-type-filter').value = '';
      changesState.filteredChanges = changesState.allChanges;
      renderChanges();
    } catch (e) {
      el.innerHTML = `<div style="padding:16px;color:var(--red);font-size:13px;">Error: ${e.message}</div>`;
    }
  }

  function filterChanges() {
    const type = document.getElementById('change-type-filter').value;
    changesState.filteredChanges = type
      ? changesState.allChanges.filter(c => c.changeType === type)
      : changesState.allChanges;
    renderChanges();
  }

  function renderChanges() {
    const el = document.getElementById('changes-list');
    const changes = changesState.filteredChanges;

    if (changes.length === 0) {
      el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px;">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 8px;display:block;opacity:0.3"><polyline points="20 6 9 17 4 12"/></svg>
        No changes ${changesState.allChanges.length > 0 ? 'matching filter' : 'detected in this session'}
      </div>`;
      return;
    }

    const typeLabels = {
      status_change:    'Status Change',
      new_tenement:     'New Tenement',
      tenement_removed: 'Tenement Removed',
      holder_change:    'Holder Change',
      license_change:   'Licence Change',
      area_change:      'Area Change',
      end_date_change:  'End Date Changed'
    };

    el.innerHTML = changes.map(c => `
      <div class="change-item">
        <div class="change-header">
          <span class="change-type-badge ct-${c.changeType}">${typeLabels[c.changeType] || c.changeType}</span>
          <span class="change-tenement-id">${esc(c.tenementId || '—')}</span>
        </div>
        <div class="change-project-name">${esc(c.projectName || c.kmlName)}</div>
        <div class="change-arrow">
          <span style="font-size:11px;color:var(--text-3);font-weight:600;">${esc(c.field || '')}:</span>
          <span class="change-old">${esc(c.oldValue || '—')}</span>
          <span class="change-arrow-icon">→</span>
          <span class="change-new">${esc(c.newValue || '—')}</span>
        </div>
      </div>`).join('');
  }

  async function startRecheck() {
    const btn      = document.getElementById('recheck-btn');
    const progress = document.getElementById('recheck-progress');
    const status   = document.getElementById('recheck-status');

    btn.disabled       = true;
    progress.style.display = 'block';
    status.textContent = 'Starting re-check...';

    try {
      const res  = await fetch('/api/changes/recheck', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const text = await res.text();
      if (!text) throw new Error('No response from server — is the server running?');
      const data = JSON.parse(text);
      if (!data.success) throw new Error(data.error || `Server error ${res.status}`);

      status.textContent = 'Querying TENGRAPH for all projects...';
      pollRecheck(data.data.sessionId, btn, progress, status);
    } catch (e) {
      btn.disabled = false;
      progress.style.display = 'none';
      showToast(e.message, 'error');
    }
  }

  async function pollRecheck(sessionId, btn, progress, status) {
    let attempts = 0;
    const run = async () => {
      attempts++;
      try {
        const res  = await fetch(`/api/changes/sessions/${sessionId}`);
        const data = await res.json();
        if (data.success) {
          const s = data.data.session;
          status.textContent = `Checked ${s.projectsChecked} project(s)...`;
          if (s.status === 'completed') {
            btn.disabled = false;
            progress.style.display = 'none';
            const msg = s.changesFound > 0
              ? `Re-check done — ${s.changesFound} change(s) detected`
              : 'Re-check done — no changes detected';
            showToast(msg, s.changesFound > 0 ? 'warning' : 'success');
            loadSessions();
            // auto-select the new session
            changesState.selectedSessionId = null;
            setTimeout(() => selectSession(sessionId), 300);
            return;
          }
          if (s.status === 'failed') {
            btn.disabled = false;
            progress.style.display = 'none';
            showToast(s.error || 'Re-check failed', 'error');
            return;
          }
        }
      } catch {}
      if (attempts < 120) setTimeout(run, 2000);
      else { btn.disabled = false; progress.style.display = 'none'; }
    };
    setTimeout(run, 2000);
  }

  async function deleteSession(id) {
    try {
      const res  = await fetch(`/api/changes/sessions/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        if (changesState.selectedSessionId === id) {
          changesState.selectedSessionId = null;
          changesState.allChanges = [];
          changesState.filteredChanges = [];
          renderChanges();
          document.getElementById('changes-panel-title').textContent = 'Select a session';
        }
        showToast('Session deleted', 'success');
        loadSessions();
      } else showToast(data.error, 'error');
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ─── Stats Refresh ────────────────────────────────────────
  async function refreshStats() {
    try {
      const res = await fetch('/api/projects/stats');
      const d   = await res.json();
      if (d.success) {
        document.getElementById('sidebar-count').textContent = d.data.total;
        if (state.view === 'dashboard') loadDashboard();
      }
    } catch {}
  }

  // ─── CSV Export ───────────────────────────────────────────
  async function exportCSV() {
    const params = new URLSearchParams({
      limit: 5000,
      ...(state.filters.search         && { search:         state.filters.search }),
      ...(state.filters.classification  && { classification:  state.filters.classification }),
      ...(state.filters.batchId         && { batchId:         state.filters.batchId })
    });
    try {
      const res  = await fetch(`/api/projects?${params}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      const headers = ['KML Name','Source File','Tenements Found','Live','Pending','Classification','Note','Tenement IDs'];
      const rows = data.data.map(p => {
        const live    = (p.tenements||[]).filter(t=>t.tenStatus==='LIVE').length;
        const pending = (p.tenements||[]).filter(t=>t.tenStatus==='PENDING').length;
        const ids = (p.tenements||[]).map(t=>t.tenementId).filter(Boolean).join('; ');
        return [p.kmlName, p.sourceFile, p.matchedCount||0, live, pending, p.classification, p.classificationNote||'', ids];
      });

      const csv = [headers,...rows].map(r=>r.map(v=>{ let s = String(v); if (/^[=+\-@]/.test(s)) s = '\t' + s; return `"${s.replace(/"/g,'""')}"`; }).join(',')).join('\n');
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([csv],{type:'text/csv'})),
        download: `kml_projects_${new Date().toISOString().split('T')[0]}.csv`
      });
      a.click();
      showToast(`Exported ${data.data.length} projects`, 'success');
    } catch (e) { showToast(e.message, 'error'); }
  }

  // ─── Toast ────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    const icons = {
      success: `<svg width="15" height="15" fill="none" stroke="var(--green)" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`,
      error:   `<svg width="15" height="15" fill="none" stroke="var(--red)"   stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
      info:    `<svg width="15" height="15" fill="none" stroke="var(--blue)"  stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `${icons[type]||''}<span>${esc(msg)}</span>`;
    document.getElementById('toast-container').appendChild(t);
    setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity 0.3s'; setTimeout(()=>t.remove(),300); }, 3500);
  }

  // ─── Helpers ─────────────────────────────────────────────
  const esc = s => s==null?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const truncate = (s, n) => s && s.length > n ? s.slice(0,n)+'…' : (s||'—');
  const setText  = (id, v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
  const statusColor = s => s==='LIVE'?'#16a34a':s==='PENDING'?'#b45309':'#dc2626';
  function fmtNum(n, decimals = 2) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-AU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  const PRECIOUS_METALS = new Set(['gold', 'silver', 'platinum', 'palladium', 'rhodium']);
  function isPrecious(name) { return name && PRECIOUS_METALS.has(name.toLowerCase()); }
  function metalUnit(name) { return isPrecious(name) ? 'oz' : 't'; }

  function fmtDate(d, sentinel=false) {
    if (!d) return '—';
    try {
      const dt = new Date(d);
      if (isNaN(dt)) return '—';
      if (sentinel && dt.getFullYear() > 2900) return 'Ongoing';
      return dt.toLocaleDateString('en-AU',{day:'2-digit',month:'2-digit',year:'numeric'});
    } catch { return '—'; }
  }

  function fmtDateTime(d) {
    if (!d) return '';
    try { return new Date(d).toLocaleString('en-AU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
    catch { return ''; }
  }

  function fmtSize(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
    return `${(b/1048576).toFixed(1)} MB`;
  }

  // ─── Expiration ───────────────────────────────────────────
  const intelState = { page: 1, limit: 50 };

  async function loadIntelligence() {
    const tbody = document.getElementById('intel-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading-cell"><div style="display:flex;align-items:center;justify-content:center;gap:8px;"><div class="spinner"></div>Loading...</div></td></tr>';

    const params = new URLSearchParams({
      page:  intelState.page,
      limit: intelState.limit,
      ...(document.getElementById('intel-expiry').value && { expiryWithin: document.getElementById('intel-expiry').value }),
      ...(document.getElementById('intel-status').value && { tenStatus:    document.getElementById('intel-status').value })
    });

    try {
      const res  = await fetch(`/api/intelligence?${params}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      document.getElementById('intel-sub').textContent = `${data.pagination.total.toLocaleString()} tenements — sorted by expiry date`;
      renderIntelligence(data.data);
      renderIntelPagination(data.pagination);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--red);font-size:13px;">${esc(e.message)}</td></tr>`;
    }
  }

  function renderIntelligence(rows) {
    const tbody = document.getElementById('intel-tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-3);font-size:13px;">No tenements found</td></tr>';
      return;
    }

    const now = Date.now();
    tbody.innerHTML = rows.map(row => {
      const t = row.t || {};

      let expiryHtml;
      const endMs = t.endDate ? new Date(t.endDate).getTime() : NaN;
      if (!t.endDate || isNaN(endMs)) {
        expiryHtml = '<span style="color:var(--text-3);">No date</span>';
      } else {
        const days = Math.ceil((endMs - now) / 86400000);
        if (days < 0) {
          expiryHtml = `<span class="badge badge-red">Expired ${fmtDate(t.endDate)}</span>`;
        } else if (days <= 90) {
          expiryHtml = `<span class="badge badge-red">${fmtDate(t.endDate)} <span style="font-weight:400;">(${days}d)</span></span>`;
        } else if (days <= 365) {
          expiryHtml = `<span class="badge badge-yellow">${fmtDate(t.endDate)} <span style="font-weight:400;">(${days}d)</span></span>`;
        } else {
          expiryHtml = `<span style="font-size:12px;">${fmtDate(t.endDate, true)}</span>`;
        }
      }

      const statusColor = t.tenStatus === 'LIVE' ? 'badge-green' : t.tenStatus === 'PENDING' ? 'badge-yellow' : 'badge-gray';
      const statusHtml  = t.tenStatus ? `<span class="badge ${statusColor}">${esc(t.tenStatus)}</span>` : '—';
      const holder      = t.holders && t.holders[0] ? t.holders[0].name : '—';
      const projectName = row.projectName || row.kmlName || '—';
      const projectId   = row.projectId;

      return `<tr style="cursor:pointer;" onclick="App.openDetail('${projectId}')" title="Click to view project details">
        <td>${expiryHtml}</td>
        <td style="font-family:var(--font-mono);font-size:12px;font-weight:600;">${esc(t.tenementId || '—')}</td>
        <td style="font-size:12px;">${esc(t.tenType || '—')}</td>
        <td>${statusHtml}</td>
        <td style="font-size:12px;color:var(--text-2);">${esc(holder)}</td>
        <td style="font-size:12px;color:var(--blue);font-weight:500;">${esc(projectName)}</td>
      </tr>`;
    }).join('');
  }

  function renderIntelPagination(pagination) {
    const wrap = document.getElementById('intel-pagination');
    const info = document.getElementById('intel-pag-info');
    const btns = document.getElementById('intel-pag-btns');
    if (pagination.pages <= 1) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    const start = (pagination.page - 1) * pagination.limit + 1;
    const end   = Math.min(pagination.page * pagination.limit, pagination.total);
    info.textContent = `${start}–${end} of ${pagination.total}`;
    const pages = [];
    for (let p = Math.max(1, pagination.page - 2); p <= Math.min(pagination.pages, pagination.page + 2); p++) pages.push(p);
    btns.innerHTML =
      `<button class="btn btn-sm btn-secondary" ${pagination.page===1?'disabled':''} onclick="App.goIntelPage(${pagination.page-1})">‹</button>` +
      pages.map(p => `<button class="btn btn-sm ${p===pagination.page?'btn-primary':'btn-secondary'}" onclick="App.goIntelPage(${p})">${p}</button>`).join('') +
      `<button class="btn btn-sm btn-secondary" ${pagination.page===pagination.pages?'disabled':''} onclick="App.goIntelPage(${pagination.page+1})">›</button>`;
  }

  function applyIntelFilters() {
    intelState.page = 1;
    loadIntelligence();
  }

  function goIntelPage(n) {
    intelState.page = n;
    loadIntelligence();
  }

  // ─── Price Intelligence ────────────────────────────────────
  // priceState.data holds the full 10-year fetch; range buttons only re-render
  // the chart viewport without refetching, so the forecast never changes.
  const priceState = { symbol: null, viewDays: 365, data: null, chart: null };

  async function loadPriceSymbols() {
    try {
      const res  = await fetch('/api/prices');
      const data = await res.json();
      if (!data.success) return;

      const sel = document.getElementById('price-symbol');
      const sorted = (data.data || []).sort((a, b) => (a.name || a.symbol).localeCompare(b.name || b.symbol));
      sel.innerHTML = '<option value="">Select a commodity...</option>' +
        sorted.map(d =>
          `<option value="${esc(d.symbol)}">${esc(d.name || d.symbol)} (${esc(d.symbol)})</option>`
        ).join('');
    } catch (e) { /* non-fatal */ }
  }

  // Range change: only re-render the chart viewport — no API call, forecast unchanged.
  function setPriceRange(days, btn) {
    priceState.viewDays = days;
    document.querySelectorAll('#price-range-btns .btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (priceState.data) _renderPriceChart(priceState.data, priceState.viewDays);
  }

  // Always fetch full 10-year history so the forecast model always uses all data.
  async function loadPriceData() {
    const symbol = document.getElementById('price-symbol').value;
    if (!symbol) return;
    priceState.symbol = symbol;
    priceState.data   = null;

    document.getElementById('price-empty').style.display   = 'none';
    document.getElementById('price-data').style.display    = 'none';
    document.getElementById('price-error').style.display   = 'none';
    document.getElementById('price-loading').style.display = 'block';

    try {
      const res  = await fetch(`/api/prices/${encodeURIComponent(symbol)}?days=3650&forecast=365`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      priceState.data = data.data;
      document.getElementById('price-loading').style.display = 'none';
      document.getElementById('price-data').style.display    = 'block';

      _renderPriceKpis(data.data);
      _renderPriceChart(data.data, priceState.viewDays);
      _renderForecastTable(data.data);
    } catch (e) {
      document.getElementById('price-loading').style.display = 'none';
      document.getElementById('price-error').style.display   = 'block';
      document.getElementById('price-error').textContent     = `Error: ${esc(e.message)}`;
    }
  }

  function _renderPriceKpis(d) {
    const { stats, name, unit, currency, model } = d;

    document.getElementById('ps-current').textContent = _fmtPrice(stats.latest, unit, currency);
    document.getElementById('ps-unit').textContent    = `${currency} / ${unit}`;
    document.getElementById('ps-unit2').textContent   = `${currency} / ${unit}`;
    document.getElementById('ps-unit3').textContent   = `${currency} / ${unit}`;
    document.getElementById('ps-low').textContent     = _fmtPrice(stats.min52w, unit, currency);
    document.getElementById('ps-high').textContent    = _fmtPrice(stats.max52w, unit, currency);

    document.getElementById('price-chart-title').textContent =
      `${name} (${d.symbol}) — History & Forecast`;
    document.getElementById('price-sub').textContent =
      `${(d.timeseries||[]).length} data points · ${currency} / ${unit}`;

    if (model) {
      document.getElementById('price-model-info').textContent =
        `RMSE ${_fmtPrice(model.rmse, unit, currency)}`;
    }

    function _pct(id, val) {
      const el = document.getElementById(id);
      if (val == null) { el.textContent = '—'; el.style.color = 'var(--text-3)'; return; }
      const up = val >= 0;
      el.textContent = `${up ? '+' : ''}${val.toFixed(2)}%`;
      el.style.color = up ? 'var(--green)' : 'var(--red)';
    }
    _pct('ps-30d', stats.change30d);
    _pct('ps-90d', stats.change90d);
    _pct('ps-1y',  stats.change365d);
  }

  // viewDays controls the historical window shown; forecast is always appended in full.
  function _renderPriceChart(d, viewDays) {
    if (priceState.chart) { priceState.chart.destroy(); priceState.chart = null; }

    const ctx = document.getElementById('price-chart').getContext('2d');

    // Slice history to the viewport window (client-side, no refetch)
    const cutoff      = new Date(Date.now() - viewDays * 86400000);
    const visible     = d.timeseries.filter(p => new Date(p.date) >= cutoff);

    const histLabels  = visible.map(p => p.date.slice(0, 10));
    const histPrices  = visible.map(p => p.close);
    const fcstLabels  = d.forecast.map(p => p.date.slice(0, 10));
    const fcstVals    = d.forecast.map(p => p.value);
    const histLen     = histLabels.length;

    const allLabels   = [...histLabels, ...fcstLabels];
    const histData    = [...histPrices, ...new Array(fcstLabels.length).fill(null)];
    // Connect the forecast line to the last visible historical point
    const fcstData    = [...new Array(histLen - 1).fill(null), histPrices[histLen - 1], ...fcstVals];

    priceState.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels:   allLabels,
        datasets: [
          {
            label:       'Price',
            data:        histData,
            borderColor: '#3F7ADC',
            borderWidth: 1.5,
            pointRadius: 0,
            tension:     0,
            fill:        false,
            spanGaps:    false
          },
          {
            label:       'Forecast',
            data:        fcstData,
            borderColor: '#ea580c',
            borderDash:  [5, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            tension:     0,
            fill:        false,
            spanGaps:    false
          }
        ]
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        interaction:         { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            labels:  { boxWidth: 12, font: { size: 11 } }
          },
          tooltip: {
            callbacks: {
              label: ctx => {
                if (ctx.raw == null) return null;
                return ` ${ctx.dataset.label}: ${_fmtPrice(ctx.raw, d.unit, d.currency)}`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 12, font: { size: 10 }, color: '#6b7280' },
            grid:  { color: 'rgba(0,0,0,0.04)' }
          },
          y: {
            ticks: {
              font:     { size: 10 },
              color:    '#6b7280',
              callback: v => _fmtPrice(v, d.unit, d.currency)
            },
            grid: { color: 'rgba(0,0,0,0.06)' }
          }
        }
      }
    });
  }

  function _renderForecastTable(d) {
    const horizons = [7, 14, 30, 60, 90, 120, 180];
    const current  = d.stats.latest;

    const rows = horizons.map(h => {
      const pt = d.forecast[h - 1];
      if (!pt) return '';
      const chg   = ((pt.value - current) / current) * 100;
      const color = chg >= 0 ? 'var(--green)' : 'var(--red)';
      const arrow = chg >= 0 ? '↑' : '↓';
      return `<tr>
        <td style="font-weight:600;font-size:13px;">${h}d</td>
        <td style="font-size:12px;color:var(--text-2);">${pt.date.slice(0,10)}</td>
        <td style="font-weight:600;">${_fmtPrice(pt.value, d.unit, d.currency)}</td>
        <td style="color:${color};font-weight:600;">${arrow} ${Math.abs(chg).toFixed(2)}%</td>
        <td style="font-size:11.5px;color:var(--text-3);">${_fmtPrice(pt.lower, d.unit, d.currency)} – ${_fmtPrice(pt.upper, d.unit, d.currency)}</td>
      </tr>`;
    }).join('');

    document.getElementById('price-forecast-table').innerHTML = `
      <table>
        <thead><tr>
          <th>Horizon</th><th>Target Date</th>
          <th>Forecast Price</th><th>vs Current</th><th>95% CI Range</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function _fmtPrice(v, unit, currency) {
    if (v == null || isNaN(v)) return '—';
    const sym = (currency === 'CNY') ? '¥' : '$';
    if (v >= 10000)  return `${sym}${Math.round(v).toLocaleString()}`;
    if (v >= 100)    return `${sym}${v.toFixed(2)}`;
    if (v >= 1)      return `${sym}${v.toFixed(3)}`;
    return `${sym}${v.toFixed(4)}`;
  }

  // ─── Flora & Fauna ─────────────────────────────────────────
  const floraState = {
    map: null, drawLayer: null, ndviLayer: null, kmlLayer: null, bboxLayer: null,
    chart: null, data: null, drawing: false,
    selectedProject: null, _searchTimer: null
  };

  // Initialise the Leaflet map and draw controls once; subsequent calls are no-ops.
  function _floraInit() {
    if (floraState.map) {
      // Already initialised — just invalidate size in case the container was resized
      floraState.map.invalidateSize();
      return;
    }

    floraState.map = L.map('flora-map', { center: [-25, 122], zoom: 5, attributionControl: false });

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri', maxZoom: 19
    }).addTo(floraState.map);

    // Leaflet.draw setup
    floraState.drawLayer = new L.FeatureGroup().addTo(floraState.map);
    const drawCtrl = new L.Control.Draw({
      draw: {
        polygon:      { shapeOptions: { color: '#01582f', weight: 2, fillOpacity: 0.08 } },
        rectangle:    { shapeOptions: { color: '#01582f', weight: 2, fillOpacity: 0.08 } },
        circle:       false, marker: false, polyline: false, circlemarker: false
      },
      edit: { featureGroup: floraState.drawLayer, remove: false }
    });
    floraState.map.addControl(drawCtrl);

    floraState.map.on('draw:drawstart', () => { floraState.drawing = true; });
    floraState.map.on('draw:drawstop',  () => { floraState.drawing = false; });
    floraState.map.on('draw:created',   e  => {
      floraState.drawLayer.clearLayers();
      floraState.drawLayer.addLayer(e.layer);
      const geom = e.layer.toGeoJSON().geometry;
      _floraQueryPolygon(geom);
      _floraLoadClippedNDVI(geom);
    });

    // Click → point query (not during drawing)
    floraState.map.on('click', e => {
      if (floraState.drawing) return;
      _floraQueryPoint(e.latlng.lng, e.latlng.lat);
    });

    // NDVI layer loads on demand (when polygon drawn or point clicked)

    // Close project dropdown when clicking outside
    document.addEventListener('click', e => {
      if (!e.target.closest('#flora-project-input') && !e.target.closest('#flora-project-dropdown')) {
        document.getElementById('flora-project-dropdown').style.display = 'none';
      }
    });
  }

  function _floraLoadClippedNDVI(geometry) {
    fetch('/api/flora/map', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geometry })
    })
      .then(r => r.json())
      .then(d => {
        if (!d.success) return;
        if (floraState.ndviLayer) floraState.map.removeLayer(floraState.ndviLayer);
        floraState.ndviLayer = L.tileLayer(d.data.tileUrl, {
          opacity: 0.85,
          attribution: ''
        }).addTo(floraState.map);
        document.getElementById('flora-legend').style.display = 'block';
      })
      .catch(() => { /* clipped NDVI unavailable */ });
  }

  // ── Project selector helpers ────────────────────────────────────────────────

  /** Compute a GeoJSON Polygon bbox scaled `scale` times around the project polygon. */
  function _floraBboxGeom(polygon, scale) {
    // polygon is [[lon, lat], ...]
    const lons = polygon.map(p => p[0]);
    const lats = polygon.map(p => p[1]);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const cLon = (minLon + maxLon) / 2, cLat = (minLat + maxLat) / 2;
    const hw = (maxLon - minLon) / 2 * scale;
    const hh = (maxLat - minLat) / 2 * scale;
    const w = cLon - hw, e = cLon + hw, s = cLat - hh, n = cLat + hh;
    return {
      type: 'Polygon',
      coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]]
    };
  }

  /** Debounced project search — populates the dropdown. Empty query loads all. */
  function floraProjectSearch(query) {
    clearTimeout(floraState._searchTimer);
    const delay = (query && query.trim().length > 0) ? 250 : 0;
    floraState._searchTimer = setTimeout(async () => {
      const dd = document.getElementById('flora-project-dropdown');
      try {
        const q    = query && query.trim().length > 0 ? `&search=${encodeURIComponent(query.trim())}` : '';
        const r    = await fetch(`/api/projects?limit=50${q}`);
        const d    = await r.json();
        if (!d.success || !d.data.length) { dd.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:var(--text-3);">No projects found</div>'; dd.style.display = 'block'; return; }
        dd.innerHTML = d.data.map(p => {
          const name = esc(p.projectName || p.kmlName);
          const kml  = esc(p.kmlName);
          const id   = esc(p._id);
          return `<div data-id="${id}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:12px;"
                    onmousedown="App.floraSelectProject('${id}')"
                    onmouseover="this.style.background='#f3f4f6'"
                    onmouseout="this.style.background='#fff'">
                    <div style="font-weight:600;color:var(--text-1);">${name}</div>
                    <div style="color:var(--text-3);font-size:11px;">${kml}</div>
                  </div>`;
        }).join('');
        dd.style.display = 'block';
      } catch { dd.style.display = 'none'; }
    }, delay);
  }

  /** Called when user picks a project from dropdown. */
  async function floraSelectProject(id) {
    const dd = document.getElementById('flora-project-dropdown');
    dd.style.display = 'none';
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(id)}`);
      const d = await r.json();
      if (!d.success) return;
      const project = d.data;
      floraState.selectedProject = project;
      const label = project.projectName || project.kmlName;
      document.getElementById('flora-project-input').value = label;
      document.getElementById('flora-bbox-picker').style.display = 'flex';
      document.getElementById('flora-hint').style.display = 'none';
      // Default to 1× immediately
      _floraLoadProject(project, 1);
    } catch { /* ignore */ }
  }

  /** Called by 1×/2×/3× buttons. */
  function floraBboxScale(scale) {
    if (!floraState.selectedProject) return;
    _floraLoadProject(floraState.selectedProject, scale);
  }

  /** Clear selected project and reset to manual draw mode. */
  function floraClearProject() {
    floraState.selectedProject = null;
    document.getElementById('flora-project-input').value = '';
    document.getElementById('flora-bbox-picker').style.display = 'none';
    document.getElementById('flora-hint').style.display = '';
    if (floraState.kmlLayer)  { floraState.map.removeLayer(floraState.kmlLayer);  floraState.kmlLayer  = null; }
    if (floraState.bboxLayer) { floraState.map.removeLayer(floraState.bboxLayer); floraState.bboxLayer = null; }
    if (floraState.ndviLayer) { floraState.map.removeLayer(floraState.ndviLayer); floraState.ndviLayer = null; }
    floraHideChart();
    document.getElementById('flora-legend').style.display = 'none';
  }

  /** Draw KML polygon + scaled bbox, load NDVI tiles + time series. */
  function _floraLoadProject(project, scale) {
    if (!floraState.map) return;
    const polygon = project.polygon; // [[lon, lat], ...]
    if (!polygon || polygon.length < 3) return;

    // Remove previous project layers
    if (floraState.kmlLayer)  { floraState.map.removeLayer(floraState.kmlLayer);  floraState.kmlLayer  = null; }
    if (floraState.bboxLayer) { floraState.map.removeLayer(floraState.bboxLayer); floraState.bboxLayer = null; }
    if (floraState.drawLayer) floraState.drawLayer.clearLayers();

    // Draw original KML polygon (green solid outline)
    const leafletPoly = polygon.map(([lon, lat]) => [lat, lon]);
    floraState.kmlLayer = L.polygon(leafletPoly, {
      color: '#01582f', weight: 2, fillColor: '#01582f', fillOpacity: 0.12, dashArray: null
    }).addTo(floraState.map);

    // Compute scaled bounding box
    const bboxGeom = _floraBboxGeom(polygon, scale);
    const [[w,s],[e,_s],[_e,n]] = bboxGeom.coordinates[0];
    floraState.bboxLayer = L.rectangle([[s, w],[n, e]], {
      color: '#2563eb', weight: 2, fill: false, dashArray: '6 4'
    }).addTo(floraState.map);

    // Fit map to bbox
    floraState.map.fitBounds([[s, w],[n, e]], { padding: [30, 30] });

    // Query NDVI for bbox
    _floraLoadClippedNDVI(bboxGeom);
    _floraQueryPolygon(bboxGeom);
  }

  function _floraShowLoading(title) {
    document.getElementById('flora-chart-title').textContent = title;
    document.getElementById('flora-chart-stats').textContent = '';
    document.getElementById('flora-chart-loading').style.display = 'flex';
    document.getElementById('flora-chart-loading').innerHTML =
      '<div class="spinner"></div> Querying satellite data… this may take 15–30 s';
    document.getElementById('flora-chart-wrap').style.display  = 'none';
    document.getElementById('flora-csv-btn').style.display     = 'none';
    document.getElementById('flora-chart-panel').style.display = 'block';
    if (floraState.chart) { floraState.chart.destroy(); floraState.chart = null; }
    floraState.data = null;
  }

  function floraHideChart() {
    document.getElementById('flora-chart-panel').style.display = 'none';
    if (floraState.chart) { floraState.chart.destroy(); floraState.chart = null; }
    floraState.data = null;
  }

  async function _floraQueryPoint(lon, lat) {
    _floraShowLoading(`NDVI at (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
    try {
      const res  = await fetch('/api/flora/point', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lon, lat })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      floraState.data = data.data;
      _floraRenderChart(data.data);
    } catch (e) {
      document.getElementById('flora-chart-loading').innerHTML =
        `<span style="color:var(--red)">Error: ${esc(e.message)}</span>`;
    }
  }

  async function _floraQueryPolygon(geojson) {
    _floraShowLoading('NDVI Mean ± Std Dev — drawn area');
    try {
      const res  = await fetch('/api/flora/polygon', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry: geojson })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      floraState.data = data.data;
      _floraRenderChart(data.data);
    } catch (e) {
      document.getElementById('flora-chart-loading').innerHTML =
        `<span style="color:var(--red)">Error: ${esc(e.message)}</span>`;
    }
  }

  function _floraRenderChart(rows) {
    document.getElementById('flora-chart-loading').style.display = 'none';
    document.getElementById('flora-chart-wrap').style.display    = 'block';
    document.getElementById('flora-csv-btn').style.display       = '';

    const labels = rows.map(r => r.date);
    const means  = rows.map(r => r.mean);
    const upper  = rows.map(r => r.stdDev != null ? +((r.mean + r.stdDev).toFixed(4)) : r.mean);
    const lower  = rows.map(r => r.stdDev != null ? +((r.mean - r.stdDev).toFixed(4)) : r.mean);

    const validMeans   = means.filter(v => v != null);
    const overallMean  = validMeans.reduce((s, v) => s + v, 0) / validMeans.length;
    const stdTime      = Math.sqrt(validMeans.reduce((s, v) => s + (v - overallMean) ** 2, 0) / validMeans.length);
    document.getElementById('flora-chart-stats').textContent =
      `Mean NDVI: ${overallMean.toFixed(4)} · Std Dev (time): ${stdTime.toFixed(4)} · ${rows.length} observations`;

    const ctx = document.getElementById('flora-chart').getContext('2d');
    floraState.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Mean NDVI', data: means, borderColor: '#01582f', borderWidth: 1.5, pointRadius: 0, tension: 0, fill: false },
          { label: '+1 Std Dev', data: upper, borderColor: '#44b365', borderWidth: 1, borderDash: [4, 3], pointRadius: 0, tension: 0, fill: false },
          { label: '−1 Std Dev', data: lower, borderColor: '#44b365', borderWidth: 1, borderDash: [4, 3], pointRadius: 0, tension: 0, fill: false }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, labels: { boxWidth: 12, font: { size: 10 } } }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 12, font: { size: 9 }, color: '#6b7280' }, grid: { color: 'rgba(0,0,0,0.04)' } },
          y: { min: 0, max: 1, ticks: { font: { size: 10 }, color: '#6b7280', callback: v => v.toFixed(2) }, grid: { color: 'rgba(0,0,0,0.06)' } }
        }
      }
    });
  }

  function floraExportCSV() {
    if (!floraState.data) return;
    const lines = ['Date,Mean NDVI,+1 Std Dev,-1 Std Dev'];
    for (const r of floraState.data) {
      const u = r.stdDev != null ? (r.mean + r.stdDev).toFixed(4) : r.mean.toFixed(4);
      const l = r.stdDev != null ? (r.mean - r.stdDev).toFixed(4) : r.mean.toFixed(4);
      lines.push(`${r.date},${r.mean.toFixed(4)},${u},${l}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a    = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: 'ndvi_timeseries.csv'
    });
    a.click();
  }

  function floraUploadKML(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const dom  = new DOMParser().parseFromString(e.target.result, 'text/xml');
        const fc   = toGeoJSON.kml(dom);
        const feat = fc.features.find(f => f.geometry &&
          (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));
        if (!feat) { showToast('No polygon found in KML', 'error'); return; }

        // Strip altitude (3rd coordinate) recursively
        const geom = JSON.parse(JSON.stringify(feat.geometry));
        function stripAlt(c) {
          return typeof c[0] === 'number' ? c.slice(0, 2) : c.map(stripAlt);
        }
        geom.coordinates = stripAlt(geom.coordinates);

        floraState.drawLayer.clearLayers();
        const layer = L.geoJSON(geom, { style: { color: '#01582f', weight: 2, fillOpacity: 0.08 } });
        layer.addTo(floraState.drawLayer);
        floraState.map.fitBounds(layer.getBounds());

        _floraQueryPolygon(geom);
      } catch (err) {
        showToast('KML parse error: ' + err.message, 'error');
      }
      input.value = '';
    };
    reader.readAsText(file);
  }

  // ─── Drill Programs ───────────────────────────────────────
  if (typeof proj4 !== 'undefined')
    proj4.defs('EPSG:32750', '+proj=utm +zone=50 +south +datum=WGS84 +units=m +no_defs');

  const drillState = { leafletMap: null, leafletLayers: [], currentProg: null };

  async function drillLoadList() {
    try {
      const res  = await fetch('/api/drillprograms');
      const data = await res.json();
      const tbody = document.getElementById('drill-list-tbody');
      if (!data.success) throw new Error(data.error);

      // populate project dropdown in upload form
      try {
        const pr = await fetch('/api/projects?limit=200');
        const pd = await pr.json();
        const sel = document.getElementById('drill-import-project');
        if (pd.success) pd.data.forEach(p => {
          const o = document.createElement('option');
          o.value = p._id;
          o.textContent = p.projectName || p.kmlName;
          sel.appendChild(o);
        });
      } catch {}

      if (!data.data.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text-3);font-size:13px;">
          No drill programs yet — import a CSV to get started.</td></tr>`;
        document.getElementById('drill-list-sub').textContent = '0 programs';
        return;
      }

      document.getElementById('drill-list-sub').textContent = `${data.data.length} program${data.data.length!==1?'s':''}`;

      tbody.innerHTML = data.data.map(p => {
        const dd  = p.holes.filter(h => h.type === 'DD').length;
        const rc  = p.holes.filter(h => h.type === 'RC').length;
        const tot = p.holes.reduce((s, h) => s + h.targetDepth, 0);
        const dt  = new Date(p.createdAt).toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' });
        return `<tr>
          <td style="padding:10px 14px;font-weight:600;color:var(--text-1);">${p.name}</td>
          <td style="padding:10px 14px;font-size:12.5px;color:var(--text-2);">${p.projectId ? 'linked' : '<span style="color:var(--text-3);">—</span>'}</td>
          <td style="padding:10px 14px;text-align:center;"><span style="font-size:12px;font-weight:700;color:#3b82f6;">${dd}</span></td>
          <td style="padding:10px 14px;text-align:center;"><span style="font-size:12px;font-weight:700;color:#f97316;">${rc}</span></td>
          <td style="padding:10px 14px;text-align:right;font-size:12.5px;color:var(--text-2);">${tot.toLocaleString()} m</td>
          <td style="padding:10px 14px;font-size:12px;color:var(--text-3);">${dt}</td>
          <td style="padding:10px 14px;text-align:center;">
            <button onclick="App.drillOpenDetail('${p._id}')" style="display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:5px;border:1px solid var(--border);background:var(--gray-light);color:var(--text-2);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              Details
            </button>
          </td>
        </tr>`;
      }).join('');
    } catch (e) { showToast('Could not load drill programs: ' + e.message, 'error'); }
  }

  async function drillOpenDetail(id) {
    try {
      const res  = await fetch(`/api/drillprograms/${id}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const prog = data.data;
      drillState.currentProg = prog;

      document.getElementById('drill-list-state').style.display   = 'none';
      document.getElementById('drill-detail-state').style.display = '';

      document.getElementById('drill-detail-title').textContent = prog.name;

      const dd  = prog.holes.filter(h => h.type === 'DD');
      const rc  = prog.holes.filter(h => h.type === 'RC');
      const tot = prog.holes.reduce((s, h) => s + h.targetDepth, 0);
      document.getElementById('drill-detail-sub').textContent  = '';
      document.getElementById('drill-s-dd').textContent        = dd.length;
      document.getElementById('drill-s-rc').textContent        = rc.length;
      document.getElementById('drill-s-total').textContent     = prog.holes.length;
      document.getElementById('drill-s-metres').textContent    = tot.toLocaleString() + ' m';

      document.getElementById('drill-holes-tbody').innerHTML = _drillHolesRows(prog);
      document.getElementById('drill-table-sub').textContent = `${dd.length} DD + ${rc.length} RC`;

      _drillInitMap(prog);
    } catch (e) { showToast('Error loading drill program: ' + e.message, 'error'); }
  }

  function drillBack() {
    document.getElementById('drill-detail-state').style.display = 'none';
    document.getElementById('drill-list-state').style.display   = '';
  }

  function drillShowUpload() {
    document.getElementById('drill-upload-form').style.display = '';
    document.getElementById('drill-import-name').focus();
  }
  function drillHideUpload() {
    document.getElementById('drill-upload-form').style.display = 'none';
    document.getElementById('drill-csv-input').value = '';
    document.getElementById('drill-csv-name').textContent = '';
    document.getElementById('drill-import-btn').disabled = true;
  }
  function drillCsvPicked(input) {
    const f = input.files[0];
    document.getElementById('drill-csv-name').textContent = f ? f.name : '';
    document.getElementById('drill-import-btn').disabled = !f;
  }

  async function drillImport() {
    const name = document.getElementById('drill-import-name').value.trim();
    const file = document.getElementById('drill-csv-input').files[0];
    if (!name)  { showToast('Enter a program name', 'error'); return; }
    if (!file)  { showToast('Select a CSV file', 'error'); return; }

    const btn = document.getElementById('drill-import-btn');
    btn.disabled = true; btn.textContent = 'Importing…';

    try {
      const fd = new FormData();
      fd.append('name', name);
      fd.append('csv', file);
      const projectId = document.getElementById('drill-import-project').value;
      if (projectId) fd.append('projectId', projectId);

      const res  = await fetch('/api/drillprograms', { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      showToast(`Imported ${data.data.holes.length} holes`, 'success');
      drillHideUpload();
      drillLoadList();
    } catch (e) {
      showToast('Import failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Import';
    }
  }

  async function drillDelete(id, name) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/drillprograms/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      showToast(`"${name}" deleted`);
      drillLoadList();
    } catch (e) { showToast('Delete failed: ' + e.message, 'error'); }
  }

  const DRILL_STATUS_COLORS = {
    'Planned':  { bg: 'rgba(107,114,128,0.12)', color: '#6b7280' },
    'Active':   { bg: 'rgba(59,130,246,0.12)',  color: '#3b82f6' },
    'Complete': { bg: 'rgba(34,197,94,0.12)',   color: '#22c55e' },
    'On Hold':  { bg: 'rgba(249,115,22,0.12)',  color: '#f97316' },
  };

  function _drillHolesRows(prog) {
    return prog.holes.map(h => {
      const st    = h.status || 'Planned';
      const sc    = DRILL_STATUS_COLORS[st] || DRILL_STATUS_COLORS['Planned'];
      const drilled = h.metresDrilled || 0;
      const pct   = h.targetDepth > 0 ? Math.min(100, (drilled / h.targetDepth) * 100) : 0;
      const typeColor = h.type === 'DD' ? '#3b82f6' : '#f97316';
      const typeBg    = h.type === 'DD' ? 'rgba(59,130,246,0.15)' : 'rgba(249,115,22,0.15)';
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:7px 14px;"><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11.5px;font-weight:700;background:${typeBg};color:${typeColor};">${h.type}</span></td>
        <td style="padding:7px 14px;font-size:13px;font-weight:600;color:var(--text-1);">${h.name}</td>
        <td style="padding:7px 14px;">
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11.5px;font-weight:600;background:${sc.bg};color:${sc.color};">${st}</span>
        </td>
        <td style="padding:7px 14px;text-align:right;">
          <div style="font-size:12.5px;color:var(--text-2);">${drilled} m</div>
          <div style="margin-top:3px;height:3px;border-radius:2px;background:var(--border);width:70px;margin-left:auto;">
            <div style="height:3px;border-radius:2px;background:${sc.color};width:${pct}%;"></div>
          </div>
        </td>
        <td style="padding:7px 14px;font-size:12.5px;text-align:right;color:var(--text-2);">${h.targetDepth} m</td>
        <td style="padding:7px 14px;font-size:12.5px;text-align:right;color:var(--text-2);">${h.azimuth}°</td>
        <td style="padding:7px 14px;font-size:12.5px;text-align:right;color:var(--text-2);">−${h.dip}°</td>
        <td style="padding:7px 14px;text-align:center;">
          <button data-prog="${esc(prog._id)}" data-hole="${esc(h.name)}" class="drill-edit-hole-btn" style="display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:5px;border:1px solid var(--border);background:var(--gray-light);color:var(--text-2);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            Edit
          </button>
        </td>
      </tr>`;
    }).join('');
  }

  const DRILL_STATUS_BORDER = {
    'Planned':  '#6b7280', 'Active': '#3b82f6', 'Complete': '#22c55e', 'On Hold': '#f97316'
  };
  const DRILL_STATUS_BG = {
    'Planned':  'rgba(107,114,128,0.1)', 'Active': 'rgba(59,130,246,0.1)',
    'Complete': 'rgba(34,197,94,0.1)',   'On Hold': 'rgba(249,115,22,0.1)'
  };

  function drillSetStatus(btn) {
    const status = btn.dataset.status;
    document.getElementById('hmodal-status').value = status;
    document.querySelectorAll('#hmodal-status-btns button').forEach(b => {
      const active = b.dataset.status === status;
      b.style.borderColor  = active ? DRILL_STATUS_BORDER[status] : 'transparent';
      b.style.background   = active ? DRILL_STATUS_BG[status] : 'var(--gray-light)';
      b.style.color        = active ? DRILL_STATUS_BORDER[status] : 'var(--text-2)';
    });
  }

  function drillOpenHole(progId, holeName) {
    const prog = drillState.currentProg;
    if (!prog) return;
    const h = prog.holes.find(x => x.name === holeName);
    if (!h) return;
    document.getElementById('hmodal-title').textContent = h.name;
    document.getElementById('hmodal-sub').textContent   = `${h.type} · Az ${h.azimuth}° · Dip −${h.dip}° · Target ${h.targetDepth} m`;
    document.getElementById('hmodal-prog-id').value   = progId;
    document.getElementById('hmodal-hole-name').value = holeName;
    document.getElementById('hmodal-metres').value    = h.metresDrilled || 0;
    document.getElementById('hmodal-metres').max      = h.targetDepth;
    document.getElementById('hmodal-target-label').textContent = `(target: ${h.targetDepth} m)`;
    document.getElementById('hmodal-notes').value     = h.notes || '';
    document.getElementById('hmodal').style.display   = 'flex';
    // set status button group
    const btn = document.querySelector(`#hmodal-status-btns button[data-status="${h.status || 'Planned'}"]`);
    if (btn) drillSetStatus(btn);
  }

  function drillCloseHole() {
    document.getElementById('hmodal').style.display = 'none';
  }

  async function drillSaveHole() {
    const progId       = document.getElementById('hmodal-prog-id').value;
    const holeName     = document.getElementById('hmodal-hole-name').value;
    const status       = document.getElementById('hmodal-status').value;
    const metresDrilled = parseFloat(document.getElementById('hmodal-metres').value) || 0;
    const notes        = document.getElementById('hmodal-notes').value;

    const btn = document.getElementById('hmodal-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      const res  = await fetch(`/api/drillprograms/${progId}/holes/${encodeURIComponent(holeName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, metresDrilled, notes })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      drillState.currentProg = data.data;
      document.getElementById('drill-holes-tbody').innerHTML = _drillHolesRows(data.data);
      drillCloseHole();
      showToast('Hole updated', 'success');
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }

  function _drillInitMap(prog) {
    if (!window.proj4) { showToast('proj4 not loaded', 'error'); return; }

    // init map once
    if (!drillState.leafletMap) {
      const map = L.map('drill-map', { preferCanvas: true, attributionControl: false });
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri',
        maxZoom: 19
      }).addTo(map);
      drillState.leafletMap = map;
    }

    const map = drillState.leafletMap;

    // clear old layers
    drillState.leafletLayers.forEach(l => map.removeLayer(l));
    drillState.leafletLayers = [];

    const toLatLng = (e, n) => {
      const [lon, lat] = proj4('EPSG:32750', 'WGS84', [e, n]);
      return [lat, lon];
    };

    // ── Drill hole collars + horizontal trace projections ──
    const allLatLngs = [];

    prog.holes.forEach(h => {
      const az    = h.azimuth  * Math.PI / 180;
      const dip   = h.dip      * Math.PI / 180;
      const depth = h.targetDepth;
      const hDist = depth * Math.cos(dip);  // horizontal projection of the trace

      const collarLL = toLatLng(h.easting, h.northing);
      const toeE     = h.easting  + Math.sin(az) * hDist;
      const toeN     = h.northing + Math.cos(az) * hDist;
      const toeLL    = toLatLng(toeE, toeN);

      allLatLngs.push(collarLL);
      const color = h.type === 'DD' ? '#3b82f6' : '#f97316';

      // dashed trace line (horizontal projection)
      const traceLine = L.polyline([collarLL, toeLL], {
        color, weight: 1.8,
        dashArray: h.type === 'DD' ? '6 4' : '4 3',
        opacity: 0.75
      }).addTo(map);
      drillState.leafletLayers.push(traceLine);

      // collar marker
      const marker = L.circleMarker(collarLL, {
        radius: h.type === 'DD' ? 7 : 6,
        fillColor: color,
        color: '#fff',
        weight: 1.5,
        fillOpacity: 1
      }).addTo(map);

      marker.bindPopup(`
        <div style="font-size:13px;line-height:1.7;min-width:160px;">
          <strong style="font-size:14px;">${h.name}</strong><br>
          <span style="display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:700;
            background:${h.type==='DD'?'rgba(59,130,246,0.15)':'rgba(249,115,22,0.15)'};
            color:${color};margin-bottom:4px;">${h.type}</span><br>
          Azimuth: <strong>${h.azimuth}°</strong><br>
          Dip: <strong>−${h.dip}°</strong><br>
          Target depth: <strong>${h.targetDepth} m</strong><br>
          Horiz. projection: <strong>${hDist.toFixed(0)} m</strong>
        </div>`, { maxWidth: 220 });

      drillState.leafletLayers.push(marker);
    });

    if (allLatLngs.length) {
      map.fitBounds(window.L.latLngBounds(allLatLngs), { padding: [60, 60] });
    }

    setTimeout(() => map.invalidateSize(), 120);
  }

  // ─── Change Password Modal ────────────────────────────────
  function openCpModal() {
    ['cp-current','cp-new','cp-confirm'].forEach(id => { document.getElementById(id).value = ''; });
    const msg = document.getElementById('cpmodal-msg');
    msg.style.display = 'none';
    document.getElementById('cpmodal').style.display = 'flex';
    document.getElementById('cp-current').focus();
  }

  function closeCpModal() {
    document.getElementById('cpmodal').style.display = 'none';
  }

  async function savePassword() {
    const current = document.getElementById('cp-current').value;
    const newpw   = document.getElementById('cp-new').value;
    const confirm = document.getElementById('cp-confirm').value;
    const msg     = document.getElementById('cpmodal-msg');

    function showMsg(text, type) {
      msg.textContent       = text;
      msg.style.display     = '';
      msg.style.background  = type === 'error' ? 'rgba(248,81,73,.1)'           : 'rgba(63,185,80,.1)';
      msg.style.border      = type === 'error' ? '1px solid rgba(248,81,73,.3)' : '1px solid rgba(63,185,80,.3)';
      msg.style.color       = type === 'error' ? '#f85149'                      : '#3fb950';
    }

    if (!current || !newpw || !confirm) return showMsg('All fields are required.', 'error');
    if (newpw !== confirm) return showMsg('New passwords do not match.', 'error');

    const btn = document.getElementById('cp-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res  = await fetch('/api/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: newpw })
      });
      const data = await res.json();
      if (!data.success) return showMsg(data.error, 'error');
      showMsg('Password updated. Logging out…', 'success');
      setTimeout(() => { window.location.href = '/login'; }, 1800);
    } catch (_) {
      showMsg('Network error. Please try again.', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Update Password';
    }
  }

  // ─── User Management (admin) ───────────────────────────────
  async function usersLoad() {
    const tbody = document.getElementById('users-tbody');
    try {
      const res  = await fetch('/api/auth/users');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      if (!data.data.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-3);">No users yet.</td></tr>`;
        return;
      }

      const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      tbody.innerHTML = data.data.map(u => {
        const isMe = authUser && u._id === authUser.id;
        const lastLogin = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'numeric'}) : '—';
        const created   = new Date(u.createdAt).toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'numeric'});
        const roleBg    = u.role === 'admin' ? 'rgba(249,115,22,0.12)' : 'rgba(59,130,246,0.12)';
        const roleColor = u.role === 'admin' ? '#f97316' : '#3b82f6';
        return `<tr>
          <td style="padding:10px 14px;font-weight:600;color:var(--text-1);">${esc(u.username)}${isMe ? ' <span style="font-size:11px;color:var(--text-3);">(you)</span>' : ''}</td>
          <td style="padding:10px 14px;color:var(--text-2);">${esc(u.displayName || '—')}</td>
          <td style="padding:10px 14px;">
            <select onchange="App.usersChangeRole('${esc(u._id)}',this.value)" style="background:${roleBg};color:${roleColor};border:none;border-radius:5px;padding:3px 8px;font-size:12px;font-weight:600;cursor:pointer;">
              <option value="user"  ${u.role==='user'  ? 'selected':''}>User</option>
              <option value="admin" ${u.role==='admin' ? 'selected':''}>Admin</option>
            </select>
          </td>
          <td style="padding:10px 14px;font-size:12px;color:var(--text-3);">${lastLogin}</td>
          <td style="padding:10px 14px;font-size:12px;color:var(--text-3);">${created}</td>
          <td style="padding:10px 14px;display:flex;gap:6px;">
            <button onclick="App.usersResetPassword('${esc(u._id)}','${esc(u.username)}')" style="padding:4px 8px;border-radius:5px;border:1px solid var(--border);background:var(--gray-light);color:var(--text-2);font-size:11.5px;font-weight:600;cursor:pointer;">Reset PW</button>
            ${!isMe ? `<button onclick="App.usersDelete('${esc(u._id)}','${esc(u.username)}')" style="padding:4px 8px;border-radius:5px;border:1px solid rgba(248,81,73,.3);background:rgba(248,81,73,.08);color:#f85149;font-size:11.5px;font-weight:600;cursor:pointer;">Delete</button>` : ''}
          </td>
        </tr>`;
      }).join('');
    } catch (e) { showToast('Could not load users: ' + e.message, 'error'); }
  }

  async function usersChangeRole(id, role) {
    try {
      const res  = await fetch(`/api/auth/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      showToast('Role updated', 'success');
      usersLoad();
    } catch (e) { showToast('Failed: ' + e.message, 'error'); usersLoad(); }
  }

  async function usersResetPassword(id, username) {
    const pw = prompt(`Set new password for "${username}":\n(min 10 chars, upper+lower+digit+special)`);
    if (!pw) return;
    try {
      const res  = await fetch(`/api/auth/users/${id}/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: pw }) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      showToast(`Password reset for "${username}". They must log in again.`, 'success');
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
  }

  async function usersDelete(id, username) {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    try {
      const res  = await fetch(`/api/auth/users/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      showToast(`User "${username}" deleted`);
      usersLoad();
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
  }

  function usersShowAdd() {
    document.getElementById('user-add-form').style.display = '';
    document.getElementById('new-username').focus();
  }
  function usersHideAdd() {
    document.getElementById('user-add-form').style.display = 'none';
    ['new-username','new-password','new-displayname'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('new-role').value = 'user';
  }

  async function usersCreate() {
    const username    = document.getElementById('new-username').value.trim();
    const password    = document.getElementById('new-password').value;
    const displayName = document.getElementById('new-displayname').value.trim();
    const role        = document.getElementById('new-role').value;
    if (!username || !password) return showToast('Username and password required', 'error');

    const btn = document.getElementById('user-create-btn');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const res  = await fetch('/api/auth/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role, displayName }) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      showToast(`User "${username}" created`, 'success');
      usersHideAdd();
      usersLoad();
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Create User'; }
  }

  // ─── Init ─────────────────────────────────────────────────
  async function init() {
    // Bootstrap auth — check if logged in, else redirect
    try {
      const res  = await _origFetch('/api/auth/me', { credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // Try silent refresh
        const ref = await _origFetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
        const rd  = await ref.json();
        if (!rd.success) { window.location.href = '/login'; return; }
        authUser   = rd.user;
        pageAccess = rd.pageAccess || {};
      } else {
        authUser   = data.user;
        pageAccess = data.pageAccess || {};
      }
    } catch (_) { window.location.href = '/login'; return; }

    if (authUser.mustChangePassword) { window.location.href = '/change-password'; return; }

    // Update sidebar user info
    document.getElementById('sidebar-username').textContent = authUser.displayName || authUser.username;
    document.getElementById('sidebar-role').textContent     = authUser.role === 'admin' ? 'Administrator' : 'User';

    // Hide nav items the current role cannot access
    document.querySelectorAll('[data-role]').forEach(el => {
      const required = el.dataset.role;
      if (required === 'admin' && authUser.role !== 'admin') {
        el.style.display = 'none';
      }
    });

    // ── Static button wiring (replaces inline onclick= attributes) ──
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };

    on('modal-close-btn',      closeModal);
    on('modal-cancel-btn',     closeModal);
    on('modal-save-btn',       saveClassification);
    on('mcls-internal',        () => setPendingCls('internal'));
    on('mcls-external',        () => setPendingCls('external'));
    on('mcls-unclassified',    () => setPendingCls('unclassified'));
    on('tmodal-close-btn',     closeTenementModal);
    on('tmodal-close-btn2',    closeTenementModal);
    on('cpmodal-close-btn',    closeCpModal);
    on('cpmodal-cancel-btn',   closeCpModal);
    on('cp-save-btn',          savePassword);
    on('hmodal-close-btn',     drillCloseHole);
    on('hmodal-cancel-btn',    drillCloseHole);
    on('hmodal-save-btn',      drillSaveHole);
    on('drill-back-btn',       drillBack);
    on('drill-show-upload-btn',drillShowUpload);
    on('drill-hide-upload-btn',drillHideUpload);
    on('drill-import-btn',     drillImport);
    on('refresh-stats-btn',    refreshStats);
    on('nav-to-upload-btn',    () => navigate('upload'));
    on('upload-btn',           startUpload);
    on('clear-files-btn',      clearFiles);
    on('csv-upload-btn',       uploadMetadataCSV);
    on('export-csv-btn',       exportCSV);
    on('bulk-internal-btn',    () => bulkClassify('internal'));
    on('bulk-external-btn',    () => bulkClassify('external'));
    on('clear-selection-btn',  clearSelection);
    on('recheck-btn',          startRecheck);
    on('fit-bounds-btn',       fitMapBounds);
    on('flora-scale-1',        () => floraBboxScale(1));
    on('flora-scale-2',        () => floraBboxScale(2));
    on('flora-scale-3',        () => floraBboxScale(3));
    on('flora-clear-btn',      floraClearProject);
    on('flora-csv-btn',        floraExportCSV);
    on('flora-hide-chart-btn', floraHideChart);
    on('dash-view-batches-btn',() => navigate('batches'));

    // Overlay click-outside to close
    document.getElementById('cpmodal').addEventListener('click', e => { if (e.target === e.currentTarget) closeCpModal(); });
    document.getElementById('hmodal').addEventListener('click',  e => { if (e.target === e.currentTarget) drillCloseHole(); });

    // Status picker event delegation
    document.getElementById('hmodal-status-btns').addEventListener('click', e => {
      const btn = e.target.closest('[data-status]');
      if (btn) drillSetStatus(btn);
    });

    // Price range buttons
    document.querySelectorAll('[data-days]').forEach(btn => {
      btn.addEventListener('click', () => setPriceRange(parseInt(btn.dataset.days), btn));
    });

    // Nav click handlers
    document.querySelectorAll('.nav-item[data-view]').forEach(el =>
      el.addEventListener('click', e => { e.preventDefault(); navigate(el.dataset.view); })
    );

    // Change password
    document.getElementById('change-pw-btn').addEventListener('click', openCpModal);

    // Logout
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await _origFetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      window.location.href = '/login';
    });

    // Users page buttons
    document.getElementById('user-add-btn').addEventListener('click', usersShowAdd);
    document.getElementById('user-cancel-btn').addEventListener('click', usersHideAdd);
    document.getElementById('user-create-btn').addEventListener('click', usersCreate);

    // Delegate drill hole edit buttons (avoids inline onclick with user data)
    document.addEventListener('click', e => {
      const btn = e.target.closest('.drill-edit-hole-btn');
      if (btn) drillOpenHole(btn.dataset.prog, btn.dataset.hole);
    });

    document.getElementById('modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });
    document.getElementById('tmodal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeTenementModal();
    });

    setupUpload();
    setupCSVUpload();
    loadDashboard();
    refreshStats();
  }

  return {
    navigate, refreshStats, loadDashboard,
    loadProjects, loadBatches,
    toggleExpand, quickClassify,
    toggleSelect, toggleSelectAll, clearSelection, bulkClassify,
    openDetail, closeModal, setPendingCls, saveClassification,
    showTenementDetail, closeTenementModal,
    startEditName, cancelEditName, saveProjectName, onNameKey,
    startUpload, clearFiles, removeFile, addFiles,
    uploadMetadataCSV,
    exportCSV, onSearch, applyFilters,
    goPage, viewBatch, deleteBatch,
    loadMapData, fitMapBounds,
    loadSessions, selectSession, filterChanges, startRecheck, deleteSession,
    applyIntelFilters, goIntelPage,
    loadPriceSymbols, loadPriceData, setPriceRange,
    floraHideChart, floraExportCSV, floraUploadKML,
    floraProjectSearch, floraSelectProject, floraBboxScale, floraClearProject,
    drillOpenDetail, drillBack, drillShowUpload, drillHideUpload, drillCsvPicked, drillImport, drillDelete,
    drillOpenHole, drillCloseHole, drillSaveHole, drillSetStatus,
    usersChangeRole, usersResetPassword, usersDelete,
    openCpModal, closeCpModal, savePassword,
    showToast, init
  };
})();

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
