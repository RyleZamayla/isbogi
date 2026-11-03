/* ISBOGI facilitator panel.
 * Session: drive the simulated fleet during a test. Map & routes: edit routes, stops, schedules and fleets on a map.
 * Design: colour tokens with contrast checks and a live phone preview. Content: terminals, fares, features, data.
 * Edits live in a working copy (S.cfg); nothing changes for respondents until "Save". */
(function () {
  'use strict';
  const root = document.getElementById('root');
  const toastEl = document.getElementById('toast');
  const T = window.ISBOGI_THEME;
  let pin = sessionStorage.getItem('isbogi:pin') || '';

  const S = {
    data: null, fetchedAt: 0, feedback: [],
    tab: sessionStorage.getItem('isbogi:admintab') || 'session',
    cfg: null, cfgOrig: null, paths: null,
    selRoute: 0, selStop: null, mode: null, stale: new Set(),
    reason: null, busy: false, scenOpen: false,
    selUnit: null, follow: false, ff: { route: 'all', status: 'all', q: '' }, search: { results: [], msg: '' }, prev: '#/board',
  };
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const r5 = (n) => Math.round(n * 1e5) / 1e5;
  const r1 = (n) => Math.round(n * 10) / 10;
  const fmt = (ms, sec) => (ms ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) }).format(new Date(ms)) : '—');
  const simNow = () => (S.data ? S.data.simNow + (Date.now() - S.fetchedAt) * S.data.speed : Date.now());
  const newId = (p) => p + Date.now().toString(36).slice(-7);

  function toast(msg, kind) {
    const d = document.createElement('div');
    if (kind === 'err') d.className = 'err';
    d.textContent = msg;
    toastEl.appendChild(d);
    setTimeout(() => d.remove(), kind === 'err' ? 8000 : 3500);
  }
  async function api(path, body, method) {
    const res = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'x-admin-pin': pin }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
    return json;
  }

  /* ---------------- Icons ---------------- */
  const ic = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    gear: ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>'),
    session: ic('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
    map: ic('<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>'),
    design: ic('<path d="M12 3a9 9 0 100 18c1.5 0 2-1 1.5-2-.6-1.2.2-2.5 1.6-2.5H17a4 4 0 004-4A9 9 0 0012 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>'),
    content: ic('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
    feedback: ic('<path d="M4 5h16v11H9l-5 4z"/>'),
  };
  const logo = '<svg width="34" height="34" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#fff"/><rect x="12" y="18" width="40" height="26" rx="6" fill="#1446A0"/><rect x="16" y="22" width="14" height="9" rx="2" fill="#fff"/><rect x="34" y="22" width="14" height="9" rx="2" fill="#fff"/><circle cx="21" cy="46" r="5" fill="#F5C518" stroke="#1446A0" stroke-width="2"/><circle cx="43" cy="46" r="5" fill="#F5C518" stroke="#1446A0" stroke-width="2"/></svg>';
  const TABS = [['session', 'Session', 'Session control'], ['map', 'Map & routes', 'Map & routes'], ['design', 'Design', 'Design'], ['content', 'Content & data', 'Content & data'], ['feedback', 'Feedback', 'Feedback']];

  /* ---------------- Login / boot ---------------- */
  function renderLogin(msg) {
    root.innerHTML = `<div class="login-wrap"><form class="card login" id="login"><div style="display:flex;align-items:center;gap:12px">${logo}<div><h1 style="font-size:1.3rem">Facilitator panel</h1><span class="muted small">ISBOGI pilot</span></div></div>
      <p class="muted small" style="margin:14px 0 0">Enter the PIN from the terminal.</p>
      <label>PIN<input type="text" id="pin" inputmode="numeric" autocomplete="off" autofocus></label>
      <button class="btn">Open panel</button><p class="small" style="color:var(--stop);margin:10px 0 0">${esc(msg || '')}</p></form></div>`;
  }
  async function loadState() { S.data = await api('/api/state'); S.fetchedAt = Date.now(); }
  async function loadPaths() { S.paths = (await api('/api/route')).paths; }
  async function loadConfig() {
    const { config } = await api('/api/admin/config');
    config.routes.forEach((r) => { delete r.pathPoints; });
    S.cfg = config; S.cfgOrig = clone(config); S.stale.clear();
    if (S.selRoute >= config.routes.length) S.selRoute = 0;
    T.apply(S.cfg.theme);
  }
  async function loadFeedback() { try { S.feedback = await api('/api/admin/feedback'); if (S.tab === 'feedback') show('feedback'); } catch { /* ignore */ } }
  async function start() {
    try {
      await loadState(); await Promise.all([loadConfig(), loadPaths()]);
      renderFrame(); loadFeedback();
    } catch (e) {
      if (/PIN/.test(e.message)) logout('Wrong PIN'); else { root.innerHTML = `<div class="login-wrap"><div class="card login"><h1 style="font-size:1.2rem">Cannot reach the server</h1><p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Retry</button></div></div>`; }
    }
  }
  function logout(msg) { pin = ''; sessionStorage.removeItem('isbogi:pin'); renderLogin(msg); }

  /* ---------------- Frame ---------------- */
  function renderFrame() {
    root.innerHTML = `<div class="adm">
      <aside class="side"><div class="brandrow">${logo}<div><b>ISBOGI</b><small>Facilitator panel</small></div></div>
        <nav>${TABS.map(([k, l]) => `<button data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>${ICON[k === 'map' ? 'map' : k]}${esc(l)}</button>`).join('')}</nav>
        <div class="foot"><a class="btn small" href="/" target="_blank" rel="noopener">Open commuter app</a><button class="btn small" data-act="logout">Sign out</button></div></aside>
      <div class="mainc"><header class="bar" id="bar"></header><main class="view" id="view"></main><div id="savebar"></div></div></div>
      <button class="gear-fab" id="fab" data-act="toggleScen" aria-label="Test controls" aria-haspopup="dialog" aria-expanded="false" title="Test controls: clock, speed, signal, scenarios">${ICON.gear}</button>
      <div class="scenpanel" id="scenpanel" role="dialog" aria-label="Test controls" hidden></div>`;
    updateBar(); show(S.tab); updateSavebar(); renderScenPanel();
  }
  function updateBar() {
    const bar = $('#bar');
    if (!bar || !S.data) return;
    const d = S.data;
    const title = TABS.find((x) => x[0] === S.tab)[2];
    bar.innerHTML = `<span class="title">${esc(title)}</span>
      ${d.admin && d.admin.blackoutUntil ? '<span class="chip bad"><i></i>Signal loss active</span>' : ''}
      <span class="chip live" id="liveChip"><i></i><span>Live</span></span>`;
    renderScenPanel();
  }
  /** Everything that configures a test run lives behind the gear button, out of sight of respondents. */
  const nonDefault = () => !!S.data && (S.data.scenario !== 'live' || S.data.speed !== 1 || !!(S.data.admin && S.data.admin.blackoutUntil));
  function scenPanelHTML() {
    const d = S.data;
    return `<div class="sp-head"><h2>Test controls</h2><button class="sbtn" data-act="closeScen" aria-label="Close">✕</button></div>
      <div class="sp-sec"><div class="sp-title">Simulated clock</div>
        <div class="sp-clock"><div class="clock" id="clock">${fmt(simNow(), true)}</div>
          <form id="clockForm" class="btns"><input type="text" id="clockIn" placeholder="HH:MM" style="width:92px" aria-label="Set clock to"><button class="btn small">Set</button></form></div>
        <div class="speed" role="group" aria-label="Speed" style="margin-top:10px">${[1, 2, 5, 10, 30].map((x) => `<button data-speed="${x}" aria-pressed="${d.speed === x}">${x}×</button>`).join('')}</div></div>
      <div class="sp-sec"><div class="sp-title">Signal</div>
        <div class="btns"><button class="sbtn warn" data-blackout="90">Signal loss 90 s</button><button class="sbtn ok" data-blackout="0">Restore signal</button><span class="small muted" id="sigState"></span></div></div>
      <div class="sp-sec"><div class="sp-title">Test scenarios</div>
        <p class="small muted" style="margin:0 0 10px">Current: <b id="curScen">${esc(d.scenario)}</b> · runs on route ${esc(d.routes[0].code)}</p>
        <div class="scen col">${SCEN.map(([k, name, desc]) => `<button data-scen="${k}" class="${d.scenario === k ? 'current' : ''}"><b>${k} · ${name}</b><span>${desc}</span></button>`).join('')}</div></div>
      <button class="btn small danger" data-act="reset" style="margin-top:4px;width:100%">Reset to live (scenario, clock, speed, signal)</button>`;
  }
  /** Build the panel once when opened; afterwards only update what changed, so a half-typed clock time survives live refreshes. */
  function renderScenPanel() {
    const el = $('#scenpanel'), fab = $('#fab');
    if (!el || !fab) return;
    fab.classList.toggle('on', nonDefault());
    fab.setAttribute('aria-label', nonDefault() ? 'Test controls (a scenario, speed or signal change is active)' : 'Test controls');
    el.hidden = !S.scenOpen;
    fab.setAttribute('aria-expanded', String(S.scenOpen));
    if (!S.scenOpen || !S.data) { el.dataset.ready = ''; return; }
    if (el.dataset.ready !== '1') { el.innerHTML = scenPanelHTML(); el.dataset.ready = '1'; }
    const d = S.data;
    el.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === d.speed)));
    el.querySelectorAll('[data-scen]').forEach((b) => b.classList.toggle('current', b.dataset.scen === d.scenario));
    const cs = $('#curScen', el); if (cs) cs.textContent = d.scenario;
    const sg = $('#sigState', el); if (sg) sg.textContent = d.admin && d.admin.blackoutUntil ? 'Signal loss is active' : '';
  }
  function show(tab) {
    S.tab = tab; sessionStorage.setItem('isbogi:admintab', tab);
    document.querySelectorAll('.side nav button').forEach((b) => (b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    updateBar();
    ({ session: renderSession, map: renderMapTab, design: renderDesign, content: renderContent, feedback: renderFeedback })[tab]();
  }

  /* ---------------- Session ---------------- */
  const SCEN = [
    ['T1', 'Next van', 'Agora 7:07 AM, van leaves in 8 min, 4 seats left'],
    ['T2', 'Roadside wait', 'Villanueva, next van ~12 min away'],
    ['T3', 'Breakdown', 'Van approaching Villanueva stops (engine)'],
    ['T4', 'Full van', 'Agora 7:26 AM, boarding van is full'],
    ['T5', 'Signal loss', 'Commuter app gets no data for 90 s'],
    ['T6', 'Last trip', '6:40 PM, last departures of the day'],
  ];
  const REASONS = ['traffic', 'weather', 'engine', 'flat_tire', 'accident', 'road_works'];
  const STATUS_CLS = { on_time: 'good', delayed: 'caution', stopped: 'stop', boarding: 'info', boarding_now: 'good', scheduled: 'neutral', layover: 'neutral' };
  const routeOf = (code) => S.data.routes.find((r) => r.code === code);
  const stopsDir = (R, dir) => (dir === 'out' ? R.stops : R.stops.slice().reverse());
  const destName = (u) => { const l = stopsDir(routeOf(u.route), u.dir); return l[l.length - 1].name.replace(' Municipal', ''); };
  function nextStopName(u) {
    const R = routeOf(u.route), list = stopsDir(R, u.dir);
    if (u.state === 'boarding' || u.state === 'queued') return `at ${list[0].name}`;
    if (u.state === 'layover') return `layover at ${list[0].name}`;
    const prog = (s) => (u.dir === 'out' ? s.km : R.lengthKm - s.km);
    const nx = list.find((s) => prog(s) > u.p + 1e-6);
    return nx ? `→ ${nx.name} (${(prog(nx) - u.p).toFixed(1)} km)` : '';
  }
  /* ---------------- Session control: KPIs, live map, fleet, feed ---------------- */
  const chipA = (R) => `<span class="rchip" style="--rc:${esc(R.color)}"><i></i>${esc(R.code)}</span>`;
  const STAT = { on_time: ['good', 'On time'], delayed: ['caution', 'Delayed'], stopped: ['stop', 'Stopped'], boarding: ['info', 'Boarding'], boarding_now: ['good', 'Boarding now'], scheduled: ['neutral', 'Scheduled'], layover: ['neutral', 'Layover'] };
  const STAT_COL = { good: 'var(--good)', caution: 'var(--caution)', stop: 'var(--stop)', info: 'var(--primary)', neutral: 'var(--neutral)' };
  const attention = (u) => u.status === 'stopped' || u.status === 'delayed';
  const statusMatch = (u, st) => st === 'all' || (st === 'attention' && attention(u)) || (st === 'road' && u.state === 'enroute') || (st === 'boarding' && u.state === 'boarding') || (st === 'waiting' && (u.state === 'queued' || u.state === 'layover'));
  function visibleUnits() {
    const f = S.ff, q = f.q.trim().toLowerCase(), order = S.data.routes.map((r) => r.code);
    return S.data.units.filter((u) => (f.route === 'all' || u.route === f.route) && (!q || u.plate.toLowerCase().includes(q)) && statusMatch(u, f.status))
      .sort((a, b) => (attention(b) - attention(a)) || (order.indexOf(a.route) - order.indexOf(b.route)) || (a.dir === b.dir ? b.p - a.p : a.dir === 'out' ? -1 : 1));
  }
  let SM = null;

  function renderSession() {
    $('#view').innerHTML = `<h1>Session control</h1>
      <div id="alertstrip"></div><div class="kpis" id="kpis"></div>
      <div class="card toolbar" id="toolbar"></div>
      <div class="sgrid"><div class="scol">
          <div class="card mapcard"><div id="smap" class="smap"></div>
            <div class="maplegend"><span><i style="background:var(--good)"></i>On time</span><span><i style="background:var(--caution)"></i>Delayed</span><span><i style="background:var(--stop)"></i>Stopped</span><span><i style="background:var(--primary)"></i>Boarding</span></div>
            <button class="btn small mapfit" data-act="sessFit">Show all</button></div>
          <div id="unitcard"></div></div>
        <div class="scol">
          <div class="card"><div class="head-row"><h2>Fleet</h2><span class="small muted" id="fleetCount"></span></div><div id="fleetlist" class="flist"></div></div>
          <div class="card"><div class="head-row"><h2>Live feed</h2><span class="chip live"><i></i>Live</span></div><div id="feed" class="feed"></div></div>
          <div class="card"><h2>Post a notice</h2>
            <form id="noticeForm"><label class="f" style="margin-top:12px"><span>English</span><input type="text" id="nEn" maxlength="200"></label>
              <label class="f" style="margin-top:10px"><span>Bisaya</span><input type="text" id="nCeb" maxlength="200"></label>
              <div class="btns" style="margin-top:12px">
                <select id="nSev" style="width:auto"><option value="info">Info</option><option value="caution">Caution</option><option value="stop">Stop</option></select>
                <select id="nRoute" style="width:auto;max-width:210px"><option value="">All routes</option>${S.data.routes.map((R) => `<option value="${esc(R.code)}">${esc(R.code)} · ${esc(R.name)}</option>`).join('')}</select>
                <button class="btn small">Post</button></div></form>
            <div class="sect-title">Active notices</div><div id="noticelist"></div></div></div></div>`;
    initSessionMap(); renderToolbar(); updateSession();
  }
  function renderToolbar() {
    const el = $('#toolbar');
    if (!el) return;
    el.innerHTML = `<div class="route-chips" role="group" aria-label="Filter by route"><button data-fr="all" aria-pressed="${S.ff.route === 'all'}">All routes</button>${S.data.routes.map((R) => `<button data-fr="${esc(R.code)}" aria-pressed="${S.ff.route === R.code}" style="--rc:${esc(R.color)}"><i class="dot"></i>${esc(R.code)}</button>`).join('')}</div>
      <select id="fStatus" aria-label="Filter by status" style="width:auto"><option value="all">All vans</option><option value="attention">Needs attention</option><option value="road">On the road</option><option value="boarding">Boarding</option><option value="waiting">Waiting at terminal</option></select>
      <input type="search" id="fQ" placeholder="Find a van, e.g. DS-04" value="${esc(S.ff.q)}" style="max-width:220px" aria-label="Find a van">`;
    $('#fStatus').value = S.ff.status;
  }
  /** Refresh every live part of the page. Static parts (filters, notice form) are left alone so typing is never lost. */
  function updateSession() {
    if (S.tab !== 'session' || !S.data || !$('#kpis')) return;
    renderAlerts(); renderKpis(); renderFleetList(); renderFeed(); renderNotices(); drawSessionVans();
    const a = document.activeElement;
    if (!(a && $('#unitcard').contains(a) && ['INPUT', 'SELECT'].includes(a.tagName))) renderUnitCard();
  }
  function renderKpis() {
    const us = S.data.units, road = us.filter((u) => u.state === 'enroute');
    const onTime = road.filter((u) => u.status === 'on_time').length;
    const occ = road.length ? Math.round(road.reduce((n, u) => n + u.occupied, 0) / (road.length * S.data.capacity) * 100) : 0;
    const k = [
      ['On the road', road.length, `of ${us.length} vans`, 'var(--primary)'],
      ['On time', onTime, road.length ? `${Math.round(onTime / road.length * 100)}% of vans on the road` : 'no vans on the road', 'var(--good)'],
      ['Delayed', us.filter((u) => u.status === 'delayed').length, 'running late', 'var(--caution)'],
      ['Stopped', us.filter((u) => u.status === 'stopped').length, 'broken down', 'var(--stop)'],
      ['Boarding', us.filter((u) => u.state === 'boarding').length, 'at terminals', 'var(--primary)'],
      ['Seats taken', occ + '%', 'average on the road', 'var(--neutral)'],
      ['Notices', S.data.notices.filter((n) => n.active).length, 'active', 'var(--neutral)'],
    ];
    $('#kpis').innerHTML = k.map(([l, v, sub, c]) => `<div class="kpi" style="--kc:${c}"><small><i></i>${esc(l)}</small><b>${esc(v)}</b><span>${esc(sub)}</span></div>`).join('');
  }
  function renderAlerts() {
    const bad = S.data.units.filter(attention).sort((a, b) => (b.status === 'stopped') - (a.status === 'stopped'));
    const row = (u) => {
      const R = routeOf(u.route), stopped = u.status === 'stopped';
      const why = stopped ? (u.breakdownReason || 'stopped') : `+${u.holdMinutes} min · ${u.holdReason || 'delay'}`;
      return `<div class="banner ${stopped ? 'stop' : 'caution'}"><span class="icon">!</span><div><p><b>${esc(u.plate)} ${stopped ? 'is stopped' : 'is delayed'}</b> (${esc(why.replace('_', ' '))}) · ${esc(R.code)} to ${esc(destName(u))}</p></div><button class="btn small" data-pick-unit="${esc(u.id)}">Locate</button></div>`;
    };
    $('#alertstrip').innerHTML = bad.length ? `<div class="alerts">${bad.slice(0, 3).map(row).join('')}${bad.length > 3 ? `<p class="small muted" style="margin:0">+${bad.length - 3} more. Use “Needs attention” in the filter.</p>` : ''}</div>` : '';
  }
  function renderFleetList() {
    const list = visibleUnits();
    $('#fleetCount').textContent = `${list.length} of ${S.data.units.length} vans`;
    $('#fleetlist').innerHTML = list.map((u) => {
      const R = routeOf(u.route), [cls, label] = STAT[u.status] || STAT.scheduled;
      return `<button class="frow ${S.selUnit === u.id ? 'sel' : ''}" data-pick-unit="${esc(u.id)}" data-fly="1" style="--sc:${STAT_COL[cls]}"><i class="sdot"></i>
        <div class="fmain"><div><b>${esc(u.plate)}</b> ${chipA(R)} <span class="small muted">to ${esc(destName(u))}</span></div><div class="fsub">${esc(nextStopName(u))}</div></div>
        <div class="fright"><span class="badge ${cls}">${esc(label)}</span><span class="fseats">${u.occupied}/${S.data.capacity} seats</span></div></button>`;
    }).join('') || '<p class="small muted" style="margin:0">No vans match these filters.</p>';
  }
  function renderUnitCard() {
    const el = $('#unitcard');
    if (!el) return;
    const u = S.selUnit && S.data.units.find((x) => x.id === S.selUnit);
    if (!u) { el.innerHTML = '<div class="card hintcard"><b>No van selected</b><span>Select a van on the map or in the list.</span></div>'; return; }
    const R = routeOf(u.route), [cls, label] = STAT[u.status] || STAT.scheduled, road = u.state === 'enroute';
    const nextEta = u.eta ? Object.values(u.eta).filter(Boolean).sort((a, b) => a - b)[0] : null;
    el.innerHTML = `<div class="card ucard"><div class="head-row"><div class="uhead"><span class="uplate">${esc(u.plate)}</span>${chipA(R)}<span class="small muted">to ${esc(destName(u))}</span><span class="badge ${cls}">${esc(label)}</span></div>
        <div class="btns"><button class="btn small ${S.follow ? 'dark' : ''}" data-act="follow" aria-pressed="${S.follow}">${S.follow ? 'Following' : 'Follow on map'}</button><a class="btn small" href="/#/trip/${encodeURIComponent(u.id)}" target="_blank" rel="noopener">Open in app</a><button class="sbtn" data-act="clearSel" aria-label="Clear selection">✕</button></div></div>
      <div class="ugrid">
        <div class="ustat"><small>Where</small><b>${esc(nextStopName(u))}</b></div>
        <div class="ustat"><small>${u.departAt ? 'Departs' : 'Next stop at'}</small><b>${esc(fmt(u.departAt || nextEta))}</b></div>
        <div class="ustat"><small>Route</small><b>${esc(R.name)}</b></div>
        <div class="ustat"><small>Seats taken</small><div class="seatrow"><input class="seat-in" type="number" min="0" max="${S.data.capacity}" value="${u.occupied}" data-seats="${esc(u.id)}" aria-label="Seats taken on ${esc(u.plate)}"><span>/ ${S.data.capacity}</span></div>
          <div class="meter ${u.seatStatus === 'many' ? 'good' : u.seatStatus === 'few' ? 'caution' : 'stop'}" aria-hidden="true">${u.seatMap.map((t) => `<i class="${t ? '' : 'free'}"></i>`).join('')}</div></div></div>
      ${u.holdReason ? `<p class="small muted" style="margin:0 0 12px">Held: ${esc(u.holdReason.replace('_', ' '))} (+${u.holdMinutes} min)</p>` : ''}${u.breakdownReason ? `<p class="small muted" style="margin:0 0 12px">Stopped: ${esc(u.breakdownReason.replace('_', ' '))}</p>` : ''}
      <div class="btns">
        ${road ? `<button class="sbtn warn" data-act="delay" data-unit="${esc(u.id)}" data-min="5">+5 min</button><button class="sbtn warn" data-act="delay" data-unit="${esc(u.id)}" data-min="10">+10 min</button>` : ''}
        ${road && u.status !== 'stopped' ? `<button class="sbtn danger" data-act="breakdown" data-unit="${esc(u.id)}">Breakdown</button>` : ''}
        ${u.status === 'stopped' || u.status === 'delayed' ? `<button class="sbtn ok" data-act="resolve" data-unit="${esc(u.id)}">Resolve</button>` : ''}
        ${u.state === 'boarding' ? `<button class="sbtn" data-act="departNow" data-unit="${esc(u.id)}">Depart now</button>` : ''}
        <button class="sbtn danger" data-act="full" data-unit="${esc(u.id)}">Make full</button>
        <label class="small" style="margin-left:auto;display:flex;align-items:center;gap:8px">Reason <select id="reason" style="width:auto;min-height:34px"><option value="">Automatic</option>${REASONS.map((r2) => `<option value="${r2}" ${r2 === S.reason ? 'selected' : ''}>${r2.replace('_', ' ')}</option>`).join('')}</select></label></div></div>`;
  }
  function renderFeed() {
    const log = (S.data.admin && S.data.admin.log) || [];
    $('#feed').innerHTML = log.slice(0, 40).map((l) => `<div class="li"><span class="ftime">${esc(fmt(l.at))}</span><span>${esc(l.msg).replace(/\b(DS-\d{2})\b/g, '<button class="plink" data-pick-unit="$1" data-fly="1">$1</button>')}</span></div>`).join('') || '<p class="small muted" style="margin:0">Nothing yet.</p>';
  }
  function renderNotices() {
    const act2 = S.data.notices.filter((n) => n.active);
    $('#noticelist').innerHTML = act2.map((n) => `<div class="li"><span class="badge ${esc(n.severity)}">${esc(n.severity)}</span><span style="flex:1">${esc(n.en || `${n.type} · ${n.unitId}`)}${n.route ? ` <span class="muted small">(${esc(n.route)})</span>` : ''}</span><button class="sbtn" data-clear="${n.id}">Clear</button></div>`).join('') || '<p class="small muted" style="margin:0">None.</p>';
  }
  function pickUnit(id, fly) {
    S.selUnit = id;
    const u = S.data.units.find((x) => x.id === id);
    if (u && (S.ff.route !== 'all' && S.ff.route !== u.route)) { S.ff.route = 'all'; renderToolbar(); drawSessionBase(); }
    renderFleetList(); renderUnitCard(); drawSessionVans();
    if (fly && SM && u && S.paths && S.paths[u.route] && (u.state === 'enroute' || u.state === 'boarding')) SM.map.flyTo(pathPoint(routeOf(u.route), S.paths[u.route], u.absKm), Math.max(SM.map.getZoom(), 12));
  }
  function initSessionMap() {
    if (!SM) {
      const el = document.createElement('div');
      el.style.cssText = 'width:100%;height:100%';
      const map = L.map(el, { zoomControl: true, attributionControl: false, zoomSnap: 0.25 });
      L.control.attribution({ prefix: false }).addTo(map);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(map);
      SM = { el, map, fitted: false, vans: {} };
    }
    $('#smap').appendChild(SM.el);
    SM.map.invalidateSize();
    if (!SM.fitted) { fitSession(); SM.fitted = true; }
    if (!SM.base) { SM.base = L.layerGroup().addTo(SM.map); }
    drawSessionBase();
  }
  function fitSession() {
    const pts = S.data.routes.flatMap((R) => (S.paths && S.paths[R.code]) || R.stops.map((s) => [s.lat, s.lng]));
    if (pts.length) SM.map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
  }
  function drawSessionBase() {
    if (!SM || !SM.base || !S.paths) return;
    SM.base.clearLayers();
    const seen = new Set();
    S.data.routes.forEach((R) => {
      const on = S.ff.route === 'all' || S.ff.route === R.code;
      const pts = S.paths[R.code] || R.stops.map((s) => [s.lat, s.lng]);
      L.polyline(pts, { color: '#fff', weight: 7, opacity: on ? 0.9 : 0.3, interactive: false }).addTo(SM.base);
      L.polyline(pts, { color: R.color, weight: 4, opacity: on ? 0.95 : 0.25, interactive: false }).addTo(SM.base);
      R.stops.forEach((s) => {
        if (seen.has(s.id) || !on) return; seen.add(s.id);
        const m = L.circleMarker([s.lat, s.lng], { radius: s.terminal ? 6 : 4, color: '#14213D', weight: 2, fillColor: '#fff', fillOpacity: 1, bubblingMouseEvents: false }).bindTooltip(esc(s.name.replace(' Municipal', '')), { direction: 'top', offset: [0, -6] });
        m.addTo(SM.base);
      });
    });
  }
  /** Vans on the map, linked to the fleet list: same filters, same selection, optional follow. */
  function drawSessionVans() {
    if (!SM || S.tab !== 'session' || !S.data || !S.paths) return;
    const vis = new Set(visibleUnits().map((u) => u.id));
    const live = S.data.units.filter((u) => (u.state === 'enroute' || u.state === 'boarding') && vis.has(u.id));
    const keep = new Set(live.map((u) => u.id));
    for (const id of Object.keys(SM.vans)) if (!keep.has(id)) { SM.vans[id].remove(); delete SM.vans[id]; }
    for (const u of live) {
      const R = routeOf(u.route), path = S.paths[u.route];
      if (!R || !path || path.length < 2) continue;
      const pos = pathPoint(R, path, u.absKm), [cls] = STAT[u.status] || STAT.scheduled, sel = S.selUnit === u.id;
      const icon = L.divIcon({ className: 'vp', iconSize: [0, 0], html: `<div class="vpin ${sel ? 'sel' : ''}" style="--vc:${STAT_COL[cls]};--rc:${esc(R.color)}"><i></i>${esc(u.plate)}</div>` });
      if (SM.vans[u.id]) { SM.vans[u.id].setLatLng(pos); SM.vans[u.id].setIcon(icon); }
      else { const m = L.marker(pos, { icon }).addTo(SM.map); m.on('click', () => pickUnit(u.id, false)); SM.vans[u.id] = m; }
      SM.vans[u.id].setZIndexOffset(sel ? 3000 : 500);
      if (S.follow && sel) SM.map.panTo(pos, { animate: false });
    }
  }
  async function act(body) {
    if (S.busy) return;
    S.busy = true;
    try { await api('/api/admin', body); await loadState(); updateBar(); updateSession(); }
    catch (e) { toast(e.message, 'err'); }
    finally { S.busy = false; }
  }

  /* ---------------- Working copy of the config ---------------- */
  const isDirty = () => JSON.stringify(S.cfg) !== JSON.stringify(S.cfgOrig);
  const curRoute = () => S.cfg.routes[S.selRoute];
  const simFp = (c) => JSON.stringify({ cap: c.fleet.capacity, r: c.routes.map((r) => [r.code, r.fleet, r.service, r.stops.map((s) => [s.id, s.km, s.terminal])]) });
  function updateSavebar() {
    const el = $('#savebar');
    if (!el || !S.cfg) return;
    const dirty = isDirty(), stale = [...S.stale];
    document.body.classList.toggle('has-savebar', dirty || stale.length > 0);
    if (!dirty && !stale.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="savebar"><b>${dirty ? 'Unsaved changes' : 'Road lines are out of date'}${stale.length ? ` · road out of date on ${esc(stale.join(', '))}` : ''}</b>
      <button class="btn" data-act="discard">Discard</button><button class="btn" data-act="save">Save</button>
      ${stale.length ? '<button class="btn primary" data-act="saveRebuild">Save &amp; rebuild road</button>' : ''}</div>`;
  }
  async function save(rebuild) {
    if (S.busy) return;
    if (simFp(S.cfg) !== simFp(S.cfgOrig) && !confirm('Saving route, stop, schedule, fleet or seat changes restarts the simulation: vans return to their starting positions and notices are cleared. Continue?')) return;
    S.busy = true;
    try {
      const r = await api('/api/admin/config', { config: S.cfg });
      (r.warnings || []).forEach((w) => toast(w, 'err'));
      if (rebuild) {
        const km = $('#recKm') ? $('#recKm').checked : true;
        for (const code of [...S.stale]) { const rr = await api('/api/admin/reroute', { code, recomputeKm: km }); toast(`Route ${code}: road rebuilt (${rr.km} km, ${rr.points} points)`); }
      }
      await loadConfig(); await loadPaths(); await loadState();
      toast(r.simReset ? 'Saved. The simulation was restarted.' : 'Saved.');
      show(S.tab); updateSavebar();
    } catch (e) { toast(e.message, 'err'); }
    finally { S.busy = false; }
  }
  function discard() {
    S.cfg = clone(S.cfgOrig); S.stale.clear(); S.mode = null; T.apply(S.cfg.theme);
    show(S.tab); updateSavebar();
  }

  /* generic field binding: <input data-b="routes.0.name" data-t="str|num|bool|hex|nullstr"> */
  function setByPath(obj, p, val) { const parts = p.split('.'); let o = obj; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]; o[parts[parts.length - 1]] = val; }
  function readField(el) {
    const t = el.dataset.t;
    if (t === 'bool') return el.checked;
    if (t === 'num') return el.value === '' ? '' : Number(el.value);
    if (t === 'nullstr') return el.value.trim() === '' ? null : el.value;
    return el.value;
  }
  const fld = (label, b, t, val, extra, cls) => `<label class="f ${cls || ''}"><span>${esc(label)}</span><input ${t === 'num' ? 'type="number"' : t === 'time' ? 'type="time"' : 'type="text"'} data-b="${esc(b)}" data-t="${t === 'time' ? 'str' : t}" value="${esc(val ?? '')}" ${extra || ''}></label>`;
  const chk = (label, b, val) => `<label class="f inline"><input type="checkbox" data-b="${esc(b)}" data-t="bool" ${val ? 'checked' : ''}><span>${esc(label)}</span></label>`;
  function onFieldInput(el) {
    const b = el.dataset.b;
    if (!b) return;
    let v = readField(el);
    if (el.dataset.t === 'hex') { if (!T.isHex(v)) return; v = v.toUpperCase(); document.querySelectorAll(`[data-b="${b}"]`).forEach((o) => { if (o !== el) o.value = v; }); }
    if (b.startsWith('theme.') && !S.cfg.theme) S.cfg.theme = {};
    setByPath(S.cfg, b, v);
    const m = b.match(/^routes\.(\d+)\.stops\.\d+\.(lat|lng|id)$/);
    if (m) S.stale.add(S.cfg.routes[+m[1]].code);
    if (b.startsWith('theme.')) { updateRatios(); previewApply(); }
    if (b.startsWith('routes.')) { drawAdminMap(); renderRouteList(); }
    updateSavebar();
  }

  /* ---------------- Map & routes ---------------- */
  let AM = null;
  function renderMapTab() {
    $('#view').innerHTML = `<h1>Map &amp; routes</h1>
      <div class="mapgrid"><div class="mapcol">
        <div class="maptools"><button class="btn small ${S.mode === 'addstop' ? 'dark' : ''}" data-act="addStopMode" id="addBtn">+ Add stop on map</button><button class="btn small" data-act="fitAll">Show all routes</button>
          <input type="text" id="q" placeholder="Search a place, e.g. Gaisano Mall" style="flex:1;min-width:180px"><button class="btn small" data-act="search">Search</button>
          ${S.mode === 'addstop' ? '<span class="maphint">Click the map to place the new stop</span>' : ''}</div>
        <div id="results" class="results" style="margin:0 0 10px"></div>
        <div id="amap" class="amap ${S.mode === 'addstop' ? 'adding' : ''}"></div></div>
        <div><div id="rlist"></div><div id="rform" style="margin-top:16px"></div></div></div>`;
    initAdminMap(); renderRouteList(); renderRForm(); renderResults(); drawAdminMap(); drawAdminVans();
  }
  function initAdminMap() {
    if (!AM) {
      const el = document.createElement('div');
      el.style.cssText = 'width:100%;height:100%';
      const map = L.map(el, { zoomControl: true, attributionControl: false, zoomSnap: 0.25 });
      L.control.attribution({ prefix: false }).addTo(map);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(map);
      AM = { el, map, fitted: false };
      map.on('click', (e) => { if (S.mode === 'addstop') { addStopAt(e.latlng.lat, e.latlng.lng, 'New stop'); S.mode = null; show('map'); } });
    }
    $('#amap').appendChild(AM.el);
    AM.map.invalidateSize();
    if (!AM.fitted) { fitAll(); AM.fitted = true; }
    if (!AM.routes) { AM.routes = L.layerGroup().addTo(AM.map); AM.places = L.layerGroup().addTo(AM.map); AM.stops = L.layerGroup().addTo(AM.map); AM.vans = L.layerGroup().addTo(AM.map); }
  }
  function fitAll() {
    const pts = S.cfg.routes.flatMap((r) => r.stops.map((s) => [s.lat, s.lng]));
    if (pts.length) AM.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }
  function fitRoute() {
    const R = curRoute();
    if (R) AM.map.fitBounds(L.latLngBounds(R.stops.map((s) => [s.lat, s.lng])), { padding: [60, 60] });
  }
  function drawAdminMap() {
    if (!AM || !AM.routes || S.tab !== 'map') return;
    AM.routes.clearLayers(); AM.stops.clearLayers(); AM.places.clearLayers();
    S.cfg.routes.forEach((r, ri) => {
      const sel = ri === S.selRoute;
      const road = S.paths && S.paths[r.code] && S.paths[r.code].length > 1 && !S.stale.has(r.code);
      const pts = road ? S.paths[r.code] : r.stops.map((s) => [s.lat, s.lng]);
      L.polyline(pts, { color: '#fff', weight: sel ? 11 : 8, opacity: sel ? 0.95 : 0.5, interactive: false }).addTo(AM.routes);
      L.polyline(pts, { color: r.color, weight: sel ? 6 : 4, opacity: sel ? 1 : 0.55, dashArray: road ? null : '10 10', lineCap: road ? 'round' : 'butt', bubblingMouseEvents: false }).on('click', () => selectRoute(ri)).addTo(AM.routes);
    });
    const drawn = new Set();
    S.cfg.routes.forEach((r, ri) => {
      if (ri === S.selRoute) return;
      r.stops.forEach((s) => {
        if (drawn.has(s.id)) return; drawn.add(s.id);
        L.circleMarker([s.lat, s.lng], { radius: 5, color: r.color, weight: 2, fillColor: '#fff', fillOpacity: 1, bubblingMouseEvents: false }).bindTooltip(esc(s.name)).on('click', () => selectRoute(ri)).addTo(AM.stops);
      });
    });
    const R = curRoute();
    if (R) R.stops.forEach((s, i) => {
      const icon = L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: `<div class="stop-pin ${S.selStop === i ? 'on' : ''}" style="--rc:${esc(R.color)}">${i + 1}</div>` });
      const m = L.marker([s.lat, s.lng], { icon, draggable: true, zIndexOffset: 500 }).bindTooltip(esc(s.name), { direction: 'top', offset: [0, -14] }).addTo(AM.stops);
      m.on('click', () => selectStop(i));
      m.on('dragend', (e) => { const ll = e.target.getLatLng(); s.lat = r5(ll.lat); s.lng = r5(ll.lng); S.stale.add(R.code); afterStructure(); });
    });
    (S.cfg.unverifiedPlaces || []).forEach((p) => L.circleMarker([p.lat, p.lng], { radius: 6, color: '#5F6B7A', weight: 2, dashArray: '3 3', fillColor: '#fff', fillOpacity: 1, bubblingMouseEvents: false }).bindTooltip(esc(p.name) + ' (unverified)').addTo(AM.places));
  }
  /** Live vans from the running simulation, placed along the saved road lines. */
  function drawAdminVans() {
    if (!AM || !AM.vans || S.tab !== 'map' || !S.data || !S.paths) return;
    AM.vans.clearLayers();
    for (const u of S.data.units) {
      if (u.state !== 'enroute' && u.state !== 'boarding') continue;
      const R = routeOf(u.route), path = S.paths[u.route];
      if (!R || !path || path.length < 2) continue;
      const pos = pathPoint(R, path, u.absKm);
      const col = u.status === 'stopped' ? '#B3261E' : ({ many: '#13784F', few: '#9A5B00', full: '#B3261E' })[u.seatStatus];
      L.circleMarker(pos, { radius: 6, color: '#fff', weight: 2, fillColor: col, fillOpacity: 1, interactive: true }).bindTooltip(esc(u.plate), { className: 'van-tip' }).addTo(AM.vans);
    }
  }
  function pathPoint(R, path, km) {
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], (path[i][1] - path[i - 1][1]) * 0.99));
    const all = R.stops;
    let a = all[0], b = all[1];
    for (let i = 0; i < all.length - 1; i++) { a = all[i]; b = all[i + 1]; if (km <= b.km) break; }
    const f = Math.min(1, Math.max(0, (km - a.km) / (b.km - a.km || 1)));
    const last = path.length - 1;
    const ai = Math.max(0, Math.min(a.pathIdx, last - 1)), bi = Math.min(Math.max(b.pathIdx, ai + 1), last);
    const target = cum[ai] + f * (cum[bi] - cum[ai]);
    let i = ai;
    while (i < bi - 1 && cum[i + 1] < target) i++;
    i = Math.min(i, last - 1);
    const g = Math.min(1, Math.max(0, (target - cum[i]) / (cum[i + 1] - cum[i] || 1)));
    return [path[i][0] + (path[i + 1][0] - path[i][0]) * g, path[i][1] + (path[i + 1][1] - path[i][1]) * g];
  }
  function afterStructure() { renderRForm(); renderRouteList(); drawAdminMap(); updateSavebar(); }
  function selectRoute(ri) { S.selRoute = ri; S.selStop = null; renderRouteList(); renderRForm(); drawAdminMap(); fitRoute(); }
  function selectStop(i) { S.selStop = i; renderRForm(); drawAdminMap(); const row = $(`.srow[data-row="${i}"]`); if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

  function renderRouteList() {
    const el = $('#rlist');
    if (!el) return;
    el.innerHTML = `<div class="card"><div class="head-row"><h2>Routes</h2><button class="btn small dark" data-act="newRoute">+ New route</button></div><div class="rlist">
      ${S.cfg.routes.map((r, i) => `<button class="rcard" style="--rc:${esc(r.color)}" data-sel-route="${i}" aria-pressed="${i === S.selRoute}"><i class="sw"></i>
        <div><b>${esc(r.code)} · ${esc(r.name)}</b><span>${r.stops.length} stops · ${r.stops[r.stops.length - 1].km} km · every ${esc(r.service.headwayMin)} min</span></div>
        ${S.stale.has(r.code) ? '<span class="badge caution">Road out of date</span>' : ''}</button>`).join('')}</div></div>`;
  }
  function renderRForm() {
    const el = $('#rform');
    if (!el) return;
    const R = curRoute(), ri = S.selRoute;
    if (!R) { el.innerHTML = ''; return; }
    const isNew = !S.cfgOrig.routes.some((r) => r.code === R.code);
    const places = [...new Map(S.cfg.routes.flatMap((r) => r.stops).map((s) => [s.id, s])).values()];
    const b = (p) => `routes.${ri}.${p}`;
    el.innerHTML = `<div class="card"><div class="head-row"><h2 style="display:flex;align-items:center;gap:10px"><i style="width:14px;height:14px;border-radius:50%;background:${esc(R.color)}"></i>Route ${esc(R.code)}</h2>
        <button class="btn small danger" data-act="delRoute">Delete route</button></div>
      <div class="fgrid wide">
        ${fld('Code', b('code'), 'str', R.code, isNew ? 'maxlength="6"' : 'readonly title="The code identifies the route; create a new route to use another code"')}
        ${fld('Name', b('name'), 'str', R.name, 'maxlength="60"')}
        <label class="f"><span>Colour</span><div class="colorrow"><input type="color" data-b="${b('color')}" data-t="hex" value="${esc(R.color)}"><input type="text" data-b="${b('color')}" data-t="hex" value="${esc(R.color)}" maxlength="7"></div></label>
        ${chk('Not confirmed with DONSAL (internal)', b('sample'), R.sample)}</div>
      <div class="sect-title">Schedule</div>
      <div class="fgrid">${fld('First departure', b('service.firstDeparture'), 'time', R.service.firstDeparture)}${fld('Last departure', b('service.lastDeparture'), 'time', R.service.lastDeparture)}
        ${fld('Every (min)', b('service.headwayMin'), 'num', R.service.headwayMin, 'min="5" max="120"')}${fld('Layover (min)', b('service.layoverMin'), 'num', R.service.layoverMin, 'min="0" max="60"')}
        ${fld('Avg speed (km/h)', b('service.avgSpeedKmh'), 'num', R.service.avgSpeedKmh, 'min="10" max="120"')}</div>
      <div class="sect-title">Fleet</div>
      <div class="fgrid">${fld('Vans per direction', b('fleet.unitsPerDirection'), 'num', R.fleet.unitsPerDirection, 'min="2" max="10"')}${fld('Plate prefix', b('fleet.platePrefix'), 'str', R.fleet.platePrefix, 'maxlength="4"')}</div>
      <div class="sect-title">Stops</div>
      <div class="stoplist" style="--rc:${esc(R.color)}">${R.stops.map((s, i) => `<div class="srow ${S.selStop === i ? 'sel' : ''}" data-row="${i}">
        <div class="sr1"><span class="idx">${i + 1}</span>
          ${fld('Name', b(`stops.${i}.name`), 'str', s.name, 'title="' + esc(s.name) + '" maxlength="60"', 'grow')}
          ${fld('km', b(`stops.${i}.km`), 'num', s.km, 'step="0.1"' + (i === 0 ? ' readonly' : ''), 'km')}
          ${chk('Terminal', b(`stops.${i}.terminal`), s.terminal)}
          <div class="mini"><button data-act="moveUp" data-i="${i}" aria-label="Move up" title="Move up">↑</button><button data-act="moveDown" data-i="${i}" aria-label="Move down" title="Move down">↓</button><button data-act="delStop" data-i="${i}" aria-label="Remove stop" title="Remove stop">✕</button></div></div>
        <div class="sr2">
          ${fld('Area', b(`stops.${i}.area`), 'str', s.area, 'maxlength="60"', 'grow')}
          ${fld('Place id', b(`stops.${i}.id`), 'str', s.id, 'title="Same id on two routes = the same place, where the routes cross" maxlength="24"')}
          ${fld('Latitude', b(`stops.${i}.lat`), 'num', s.lat, 'step="0.00001"', 'coordf')}
          ${fld('Longitude', b(`stops.${i}.lng`), 'num', s.lng, 'step="0.00001"', 'coordf')}</div></div>`).join('')}</div>
</tbody></table></div>
      <div class="btns" style="margin-top:12px;align-items:center">
        <select id="sharedPick" style="width:auto;max-width:260px"><option value="">Add an existing place…</option>${places.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`).join('')}</select>
        <button class="btn small" data-act="addShared">Add as stop</button></div>
      <label class="f inline" style="margin-top:12px"><input type="checkbox" id="recKm" checked><span>Recompute distances (km) when rebuilding</span></label>
      ${S.stale.has(R.code) ? '<div class="warnline">⚠ Stops were moved or changed, so the road line is out of date. Use “Save &amp; rebuild road”.</div>' : ''}
      ${R.stops.length > 2 && R.stops.some((s, i) => i > 0 && s.km <= R.stops[i - 1].km) ? '<div class="warnline">⚠ Distances must increase along the route.</div>' : ''}</div>`;
  }
  function addStopAt(lat, lng, name, base) {
    const R = curRoute(); if (!R) return;
    const n = R.stops.length, prev = R.stops[n - 2], last = R.stops[n - 1];
    let km = r1(prev.km + (last.km - prev.km) / 2);
    if (km <= prev.km) { km = r1(prev.km + 0.1); last.km = Math.max(last.km, r1(km + 0.1)); }
    R.stops.splice(n - 1, 0, { id: newId('s'), name: String(name).slice(0, 60), area: '', km, terminal: false, lat: r5(lat), lng: r5(lng), pathIdx: 0, ...(base || {}) });
    S.stale.add(R.code); S.selStop = n - 1;
    afterStructure();
  }
  function moveStop(i, d) {
    const R = curRoute(), j = i + d;
    if (j < 0 || j >= R.stops.length) return;
    const kms = R.stops.map((s) => s.km);
    [R.stops[i], R.stops[j]] = [R.stops[j], R.stops[i]];
    R.stops.forEach((s, k) => { s.km = kms[k]; });
    S.selStop = j; S.stale.add(R.code); afterStructure();
  }
  function renderResults() {
    const el = $('#results');
    if (!el) return;
    el.innerHTML = S.search.msg ? `<p class="small muted" style="margin:0">${esc(S.search.msg)}</p>` : S.search.results.map((r, i) => `<button data-act="addResult" data-i="${i}"><b>${esc(r.name)}</b><small>${esc(r.display)}</small></button>`).join('');
  }
  async function doSearch() {
    const q = ($('#q') || {}).value || '';
    if (q.trim().length < 3) { S.search = { results: [], msg: 'Type at least 3 letters.' }; renderResults(); return; }
    S.search = { results: [], msg: 'Searching…' }; renderResults();
    try {
      const { results } = await api('/api/admin/geocode?q=' + encodeURIComponent(q.trim()));
      S.search = { results, msg: results.length ? '' : 'No places found. Try a nearby town or a landmark name.' };
    } catch (e) { S.search = { results: [], msg: e.message }; }
    renderResults();
  }
  function newRoute() {
    const used = new Set(S.cfg.routes.map((r) => r.code));
    let n = 1; while (used.has('N' + n)) n++;
    const c = AM ? AM.map.getCenter() : { lat: 8.5, lng: 124.7 };
    const palette = ['#7C3AED', '#0E7490', '#BE185D', '#C2410C', '#4D7C0F', '#1D4ED8'];
    const code = 'N' + n;
    S.cfg.routes.push({ code, name: 'New route', sample: true, color: palette[(n - 1) % palette.length], fleet: { unitsPerDirection: 4, platePrefix: code },
      service: { firstDeparture: '05:30', lastDeparture: '18:00', headwayMin: 20, layoverMin: 8, avgSpeedKmh: 40 },
      stops: [{ id: newId('a'), name: 'Start', area: '', km: 0, terminal: true, lat: r5(c.lat), lng: r5(c.lng - 0.03), pathIdx: 0 }, { id: newId('b'), name: 'End', area: '', km: 5, terminal: true, lat: r5(c.lat), lng: r5(c.lng + 0.03), pathIdx: 0 }] });
    S.stale.add(code); S.selRoute = S.cfg.routes.length - 1; S.selStop = null;
    afterStructure();
    toast('New route added. Drag the Start and End stops, add stops, then Save.');
  }

  /* ---------------- Design ---------------- */
  const TOKENS = [
    ['primary', 'Primary', 'Buttons, links, active tab, headers', (c) => [T.contrast(c, '#FFFFFF'), 'white text on it']],
    ['accent', 'Accent', 'Start button and highlights on dark backgrounds', (c, t) => [T.contrast(t.ink, c), 'ink text on it']],
    ['ink', 'Ink', 'Main text', (c) => [T.contrast(c, '#FFFFFF'), 'on white']],
    ['inkMuted', 'Muted text', 'Secondary text, timestamps', (c) => [T.contrast(c, '#FFFFFF'), 'on white']],
    ['good', 'Good', 'Many seats, on time', (c) => [T.contrast(c, T.tint(c)), 'on its tint']],
    ['caution', 'Caution', 'Few seats, delayed', (c) => [T.contrast(c, T.tint(c)), 'on its tint']],
    ['stop', 'Stop', 'Full, breakdown, cancelled', (c) => [T.contrast(c, T.tint(c)), 'on its tint']],
    ['neutral', 'Neutral', 'Scheduled, no data', (c) => [T.contrast(c, T.tint(c)), 'on its tint']],
  ];
  function ratioHTML(key) {
    const cur = T.merged(S.cfg.theme);
    const def = TOKENS.find((x) => x[0] === key);
    const [r, what] = def[3](cur[key], cur);
    return `<span class="ratio ${r >= 4.5 ? 'pass' : 'fail'}" id="ratio-${key}" title="${esc(what)}; 4.5:1 or more is readable">${r.toFixed(1)}:1 ${r >= 4.5 ? '✓' : '⚠'}</span>`;
  }
  function updateRatios() { TOKENS.forEach(([k]) => { const el = $('#ratio-' + k); if (el) el.outerHTML = ratioHTML(k); }); }
  function previewApply() {
    T.apply(S.cfg.theme);
    const f = $('#prev');
    try { if (f && f.contentDocument && f.contentDocument.documentElement) T.apply(S.cfg.theme, f.contentDocument); } catch { /* not loaded yet */ }
  }
  function renderDesign() {
    const cur = T.merged(S.cfg.theme);
    try { if (localStorage.getItem('isbogi:welcomed') === null) localStorage.setItem('isbogi:welcomed', 'true'); } catch { /* ignore */ }
    $('#view').innerHTML = `<h1>Design</h1>
      <div class="design"><div class="card"><div class="head-row"><h2>Colour tokens</h2><button class="btn small" data-act="resetTheme">Reset to defaults</button></div>
        <div class="tokens">${TOKENS.map(([k, label, use]) => `<div class="token"><div><b>${esc(label)}</b><span class="use">${esc(use)}</span></div>
          <input type="color" data-b="theme.${k}" data-t="hex" value="${esc(cur[k])}" aria-label="${esc(label)} colour"><input type="text" data-b="theme.${k}" data-t="hex" value="${esc(cur[k])}" maxlength="7" aria-label="${esc(label)} hex">${ratioHTML(k)}</div>`).join('')}</div>
        </div>
        <div><div class="phone-bar">${[['#/board', 'Board'], ['#/map', 'Map'], ['#/alerts', 'Alerts'], ['#/more/terminals', 'Terminals']].map(([h, l]) => `<button data-preview="${h}" aria-pressed="${S.prev === h}">${l}</button>`).join('')}</div>
          <div class="phone"><iframe id="prev" title="Commuter app preview" src="/${S.prev}"></iframe></div></div></div>`;
    const f = $('#prev'); f.addEventListener('load', previewApply);
  }

  /* ---------------- Content & data ---------------- */
  function renderContent() {
    const c = S.cfg;
    const places = [...new Map(c.routes.flatMap((r) => r.stops).map((s) => [s.id, s])).values()];
    const opt = (sel) => places.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    const conn = Object.entries(c.connections).filter(([k]) => k !== '_note');
    $('#view').innerHTML = `<h1>Content &amp; data</h1>
      <div class="card"><h2>Features &amp; seats</h2><div class="fgrid" style="margin-top:12px">${chk('Show the fare checker', 'features.fares', c.features.fares)}${chk('Show “Play while you wait” trivia', 'features.arcade', c.features.arcade)}${fld('Seats per van', 'fleet.capacity', 'num', c.fleet.capacity, 'min="4" max="20"')}</div>
        <p class="small muted" style="margin:10px 0 0">Fares are outside the thesis scope (section 1.5).</p></div>
      <div class="card"><h2>Sample fares</h2><div class="fgrid" style="margin-top:12px">${fld('Base fare (₱)', 'fares.baseFare', 'num', c.fares.baseFare, 'step="0.25"')}${fld('Base distance (km)', 'fares.baseKm', 'num', c.fares.baseKm)}${fld('Per extra km (₱)', 'fares.perKm', 'num', c.fares.perKm, 'step="0.05"')}${fld('Discount (%)', 'fares.discountPct', 'num', c.fares.discountPct)}</div>
        <div class="fgrid wide" style="margin-top:10px">${fld('Note shown to developers', 'fares._note', 'str', c.fares._note, 'maxlength="200"')}</div></div>
      <div class="card"><div class="head-row"><h2>Terminals</h2><button class="btn small" data-act="addTerminal">+ Add terminal</button></div><div class="rows">
        ${c.terminals.map((t, i) => `<div class="rowf"><label class="f"><span>Stop</span><select data-b="terminals.${i}.stopId" data-t="str">${opt(t.stopId)}</select></label>${fld('Hours', `terminals.${i}.hours`, 'str', t.hours, 'maxlength="60"')}${fld('Contact number', `terminals.${i}.contact`, 'nullstr', t.contact, 'maxlength="30" placeholder="Shows a Call button"')}${fld('Notes', `terminals.${i}.notes`, 'str', t.notes, 'maxlength="80"')}<button class="btn small danger x" data-act="delTerminal" data-i="${i}">Remove</button></div>`).join('') || '<p class="small muted">No terminals.</p>'}</div></div>
      <div class="card"><div class="head-row"><h2>Other operators' routes at a stop</h2><div class="btns"><select id="connStop" style="width:auto">${opt('')}</select><button class="btn small" data-act="addConn">+ Add</button></div></div>
        <div class="rows">
        ${conn.map(([sid, list]) => list.map((x, j) => `<div class="rowf"><label class="f"><span>Stop</span><input type="text" value="${esc((places.find((p) => p.id === sid) || {}).name || sid)}" readonly></label>${fld('Route name', `connections.${sid}.${j}.name`, 'str', x.name, 'maxlength="80"', 'grow')}${fld('Mode', `connections.${sid}.${j}.mode`, 'str', x.mode, 'maxlength="30"')}${fld('Operator', `connections.${sid}.${j}.operator`, 'str', x.operator || '', 'maxlength="60"')}${fld('Ref', `connections.${sid}.${j}.ref`, 'str', x.ref || '', 'maxlength="12"')}<button class="btn small danger x" data-act="delConn" data-stop="${esc(sid)}" data-j="${j}">Remove</button></div>`).join('')).join('') || '<p class="small muted">None.</p>'}</div></div>
      <div class="card"><div class="head-row"><h2>Unverified places</h2><button class="btn small" data-act="addPlace">+ Add place</button></div>
        <div class="rows">
        ${c.unverifiedPlaces.map((p, i) => `<div class="rowf">${fld('Name', `unverifiedPlaces.${i}.name`, 'str', p.name, 'maxlength="60"')}${fld('Latitude', `unverifiedPlaces.${i}.lat`, 'num', p.lat, 'step="0.00001"')}${fld('Longitude', `unverifiedPlaces.${i}.lng`, 'num', p.lng, 'step="0.00001"')}${fld('Source', `unverifiedPlaces.${i}.source`, 'str', p.source, 'maxlength="40"')}<button class="btn small danger x" data-act="delPlace" data-i="${i}">Remove</button></div>`).join('') || '<p class="small muted">None.</p>'}</div></div>`;
  }

  /* ---------------- Feedback ---------------- */
  function renderFeedback() {
    const f = S.feedback;
    $('#view').innerHTML = `<h1>Feedback</h1>
      <div class="card"><div class="head-row"><h2>${f.length} ${f.length === 1 ? 'entry' : 'entries'}</h2><div class="btns"><button class="btn small" data-act="loadFeedback">Refresh</button><button class="btn small" data-act="exportCsv" ${f.length ? '' : 'disabled'}>Export CSV</button><button class="btn small" data-act="exportJson" ${f.length ? '' : 'disabled'}>Export JSON</button></div></div>
        ${f.map((x) => `<div class="fbrow"><b>${esc(x.kind)}</b>${x.rating ? ' · ' + '★'.repeat(x.rating) : ''}${x.unit ? ' · ' + esc(x.unit) : ''} <span class="muted small">${esc(new Date(x.at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }))} · ${esc(x.lang)} · ${esc(x.scenario)}</span><div>${esc(x.text)}</div></div>`).join('') || '<p class="muted small">No feedback yet.</p>'}</div>`;
  }
  function download(name, type, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };

  /* ---------------- Events ---------------- */
  root.addEventListener('click', async (e) => {
    if (S.scenOpen && !e.target.closest('#scenpanel') && !e.target.closest('#fab')) { S.scenOpen = false; renderScenPanel(); }
    const el = e.target.closest('[data-tab],[data-speed],[data-scen],[data-blackout],[data-clear],[data-act],[data-sel-route],[data-preview],[data-pick-unit],[data-fr]');
    if (!el) return;
    const d = el.dataset;
    if (d.tab) return show(d.tab);
    if (d.speed) return act({ action: 'speed', speed: Number(d.speed) });
    if (d.scen) { S.scenOpen = false; renderScenPanel(); toast(`Loading scenario ${d.scen}…`); return act({ action: 'scenario', scenario: d.scen }); }
    if (d.blackout !== undefined) return act({ action: 'blackout', seconds: Number(d.blackout) });
    if (d.clear) return act({ action: 'clearNotice', id: Number(d.clear) });
    if (d.selRoute !== undefined) return selectRoute(Number(d.selRoute));
    if (d.pickUnit) return pickUnit(d.pickUnit, true);
    if (d.fr) { S.ff.route = d.fr; renderToolbar(); drawSessionBase(); renderFleetList(); drawSessionVans(); return; }
    if (d.preview) { S.prev = d.preview; document.querySelectorAll('[data-preview]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.preview === S.prev)); try { $('#prev').contentWindow.location.hash = S.prev; } catch { $('#prev').src = '/' + S.prev; } return; }
    const i = Number(d.i);
    switch (d.act) {
      case 'logout': logout(); break;
      case 'follow': S.follow = !S.follow; renderUnitCard(); drawSessionVans(); break;
      case 'clearSel': S.selUnit = null; S.follow = false; renderFleetList(); renderUnitCard(); drawSessionVans(); break;
      case 'sessFit': fitSession(); break;
      case 'reset': S.scenOpen = false; renderScenPanel(); toast('Reset to live.'); act({ action: 'reset' }); break;
      case 'toggleScen': S.scenOpen = !S.scenOpen; renderScenPanel(); break;
      case 'closeScen': S.scenOpen = false; renderScenPanel(); $('#fab').focus(); break;
      case 'delay': act({ action: 'delay', unitId: d.unit, minutes: Number(d.min), reason: S.reason || 'traffic' }); break;
      case 'breakdown': act({ action: 'breakdown', unitId: d.unit, reason: S.reason || 'engine' }); break;
      case 'resolve': act({ action: 'resolve', unitId: d.unit }); break;
      case 'departNow': act({ action: 'departNow', unitId: d.unit }); break;
      case 'full': act({ action: 'setSeats', unitId: d.unit, occupied: S.data.capacity }); break;
      case 'save': save(false); break;
      case 'saveRebuild': save(true); break;
      case 'discard': discard(); break;
      case 'newRoute': newRoute(); break;
      case 'delRoute': { const R = curRoute(); if (S.cfg.routes.length <= 1) return toast('Keep at least one route.', 'err'); if (!confirm(`Delete route ${R.code}? This applies when you save.`)) return; S.cfg.routes.splice(S.selRoute, 1); S.stale.delete(R.code); S.selRoute = 0; S.selStop = null; afterStructure(); break; }
      case 'addStopMode': S.mode = S.mode === 'addstop' ? null : 'addstop'; show('map'); break;
      case 'fitAll': fitAll(); break;
      case 'search': doSearch(); break;
      case 'addResult': { const r = S.search.results[i]; if (r) { addStopAt(r.lat, r.lng, r.name); AM.map.flyTo([r.lat, r.lng], 15); S.search = { results: [], msg: '' }; renderResults(); } break; }
      case 'addShared': { const p = ($('#sharedPick') || {}).value; if (!p) return toast('Choose a place first.', 'err'); const R = curRoute(); if (R.stops.some((s) => s.id === p)) return toast('That place is already a stop on this route.', 'err'); const src = S.cfg.routes.flatMap((r) => r.stops).find((s) => s.id === p); addStopAt(src.lat, src.lng, src.name, { id: src.id, area: src.area, terminal: src.terminal }); break; }
      case 'moveUp': moveStop(i, -1); break;
      case 'moveDown': moveStop(i, 1); break;
      case 'delStop': { const R = curRoute(); if (R.stops.length <= 2) return toast('A route needs at least 2 stops.', 'err'); R.stops.splice(i, 1); R.stops[0].km = 0; S.selStop = null; S.stale.add(R.code); afterStructure(); break; }
      case 'resetTheme': delete S.cfg.theme; T.apply(null); renderDesign(); previewApply(); updateSavebar(); break;
      case 'addTerminal': S.cfg.terminals.push({ stopId: S.cfg.routes[0].stops[0].id, hours: '', contact: null, notes: '' }); renderContent(); updateSavebar(); break;
      case 'delTerminal': S.cfg.terminals.splice(i, 1); renderContent(); updateSavebar(); break;
      case 'addConn': { const sid = ($('#connStop') || {}).value; if (!sid) return; (S.cfg.connections[sid] = S.cfg.connections[sid] || []).push({ name: 'New route', mode: '', source: 'OpenStreetMap' }); renderContent(); updateSavebar(); break; }
      case 'delConn': { const l = S.cfg.connections[d.stop]; l.splice(Number(d.j), 1); if (!l.length) delete S.cfg.connections[d.stop]; renderContent(); updateSavebar(); break; }
      case 'addPlace': { const s0 = S.cfg.routes[0].stops[0]; S.cfg.unverifiedPlaces.push({ id: newId('p'), name: 'New place', lat: s0.lat, lng: s0.lng, source: 'OpenStreetMap' }); renderContent(); updateSavebar(); break; }
      case 'delPlace': S.cfg.unverifiedPlaces.splice(i, 1); renderContent(); updateSavebar(); break;
      case 'loadFeedback': loadFeedback(); break;
      case 'exportJson': download('isbogi-feedback.json', 'application/json', JSON.stringify(S.feedback, null, 2)); break;
      case 'exportCsv': download('isbogi-feedback.csv', 'text/csv', ['at,kind,rating,unit,lang,scenario,text'].concat(S.feedback.map((x) => [x.at, x.kind, x.rating, x.unit, x.lang, x.scenario, x.text].map(csvCell).join(','))).join('\n')); break;
      default: break;
    }
  });
  root.addEventListener('input', (e) => {
    if (e.target.id === 'fQ') { S.ff.q = e.target.value; renderFleetList(); drawSessionVans(); return; }
    if (e.target.dataset && e.target.dataset.b) onFieldInput(e.target);
  });
  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'reason') S.reason = el.value || null;
    if (el.id === 'fStatus') { S.ff.status = el.value; renderFleetList(); drawSessionVans(); return; }
    if (el.dataset && el.dataset.seats) { act({ action: 'setSeats', unitId: el.dataset.seats, occupied: Number(el.value) }); el.blur(); }
    if (el.dataset && el.dataset.b && el.dataset.t !== 'hex') onFieldInput(el);
  });
  root.addEventListener('focusin', (e) => {
    const tr = e.target.closest && e.target.closest('.srow[data-row]');
    if (!tr) return;
    const i = Number(tr.dataset.row);
    if (S.selStop !== i) { S.selStop = i; document.querySelectorAll('.srow[data-row]').forEach((r) => r.classList.toggle('sel', Number(r.dataset.row) === i)); drawAdminMap(); }
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'q') { e.preventDefault(); doSearch(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.scenOpen) { S.scenOpen = false; renderScenPanel(); const f = $('#fab'); if (f) f.focus(); } });
  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = e.target.id;
    if (id === 'login') {
      pin = $('#pin').value.trim();
      try { await api('/api/admin/check', {}); sessionStorage.setItem('isbogi:pin', pin); start(); } catch { renderLogin('Wrong PIN'); }
    }
    if (id === 'clockForm') { const v = $('#clockIn').value.trim(); document.activeElement.blur(); toast(`Clock set to ${v}`); act({ action: 'clock', time: v }); $('#clockIn').value = ''; }
    if (id === 'noticeForm') {
      const body = { action: 'notice', en: $('#nEn').value, ceb: $('#nCeb').value, severity: $('#nSev').value, route: $('#nRoute').value || null };
      document.activeElement.blur(); act(body); $('#nEn').value = ''; $('#nCeb').value = '';
    }
  });

  /* ---------------- Live updates ---------------- */
  setInterval(async () => {
    if (!pin || !S.cfg || S.busy) return;
    try {
      await loadState(); updateBar();
      if (S.tab === 'session') updateSession();
      else if (S.tab === 'map') drawAdminVans();
    } catch { /* server restarting */ }
  }, 2000);
  setInterval(() => {
    const c = $('#clock'); if (c && S.data) c.textContent = fmt(simNow(), true);
    const lc = $('#liveChip');
    if (lc && S.fetchedAt) { const stale = Date.now() - S.fetchedAt > 6000; lc.classList.toggle('warn', stale); lc.lastChild.textContent = stale ? 'Reconnecting…' : 'Live'; }
  }, 1000);

  window.addEventListener('beforeunload', (e) => { if (S.cfg && (isDirty() || S.stale.size)) { e.preventDefault(); e.returnValue = ''; } });
  if (pin) start(); else renderLogin();
})();
