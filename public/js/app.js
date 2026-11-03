/* ISBOGI commuter app — vanilla JS, no build step.
 * CTML rules used throughout: status = colour + icon + word (signaling); no decoration on live screens
 * (coherence); countdown sits beside the van and seats it describes (spatial contiguity).
 * The board is stop-centred: pick where you wait, see every route and direction that serves that stop. */
(function () {
  'use strict';

  /* ---------------- Preferences (per device) ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('isbogi:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('isbogi:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const S = {
    data: null,            // last /api/state payload
    fetchedAt: 0,          // client clock when data arrived
    offline: false,
    lang: store.get('lang', 'en'),
    stopId: store.get('stopId', null),
    route: store.get('route', 'all'),   // route filter: 'all' or a route code
    lowData: store.get('lowData', false),
    textLarge: store.get('textLarge', false),
    welcomed: store.get('welcomed', false),
    paths: store.get('routePaths', null), // road geometry per route code, fetched once
    loc: null,             // {lat, lng}: kept in memory only, never saved or sent
    locMsg: null,          // {cls, text}
    connOpen: false,
    read: store.get('read', {}),               // notices this device has marked as read (key = id:time)
    cleared: store.get('clearedEarlier', {}),  // resolved notices hidden on this device
    alertFilter: 'all',                        // 'all' | 'unread' | 'mine'
    alertRoute: 'all',                         // story row: 'all' or a route code
    showEarlier: false,
  };

  const root = document.getElementById('root');
  const overlay = document.getElementById('overlay');

  /* ---------------- Helpers ---------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function t(key, vars) {
    const dict = window.I18N[S.lang] || window.I18N.en;
    let s = dict[key] ?? window.I18N.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(v);
    return s;
  }
  const timeFmt = () => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
  const fmtTime = (ms) => (ms ? timeFmt().format(new Date(ms)) : '—');
  /** Current simulated time, advanced locally between polls. */
  function simNow() {
    if (!S.data) return Date.now();
    return S.data.simNow + (Date.now() - S.fetchedAt) * (S.data.speed || 1);
  }

  /* Routes and stops. A "stop" is a place; several routes can share one (same id). */
  const routes = () => (S.data ? S.data.routes : []);
  const routeOf = (code) => routes().find((r) => r.code === code);
  const stopsOf = (R, dir) => (dir === 'out' ? R.stops : R.stops.slice().reverse());
  const originOf = (R, dir) => stopsOf(R, dir)[0];
  const destOf = (R, dir) => stopsOf(R, dir).slice(-1)[0];
  const progressOf = (R, stop, dir) => (dir === 'out' ? stop.km : R.lengthKm - stop.km);
  const placeName = (s) => s.name.replace(' Municipal', '');
  const shortName = (s) => placeName(s).split(' ')[0];
  const toDest = (R, dir) => t('toDest', { dest: shortName(destOf(R, dir)) });
  function allStops() {
    const seen = new Map();
    for (const R of routes()) for (const s of R.stops) if (!seen.has(s.id)) seen.set(s.id, s);
    return [...seen.values()];
  }
  const stopById = (id) => allStops().find((s) => s.id === id);
  const routesAt = (stopId) => routes().filter((R) => R.stops.some((s) => s.id === stopId));
  /** Routes the board shows for a stop, after the route filter. */
  function visibleAt(stopId) {
    const here = routesAt(stopId);
    return S.route === 'all' || !here.some((r) => r.code === S.route) ? here : here.filter((r) => r.code === S.route);
  }
  /** Routes the map shows, after the route filter. */
  function mapRoutes() {
    const sel = routes().filter((r) => r.code === S.route);
    return S.route === 'all' || !sel.length ? routes() : sel;
  }
  const routeChip = (R) => `<span class="rchip" style="--rc:${esc(R.color)}"><i></i>${esc(R.code)}</span>`;
  const sampleTag = () => ''; // test routes look like any other route; the persistent "simulated data" bar and the About screen say it is a pilot

  function ensureStop() {
    if (!S.data) return;
    if (!stopById(S.stopId)) { S.stopId = allStops()[0].id; store.set('stopId', S.stopId); }
    if (S.route !== 'all' && !routeOf(S.route)) { S.route = 'all'; store.set('route', 'all'); }
  }

  /* ---------------- Icons (inline, no network) ---------------- */
  const I = {
    van: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="11" rx="3"/><path d="M2 11h20M8 6v5M16 6v5"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
    clock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z"/><path d="M12 7v6M12 17h.01"/></svg>',
    warn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v4M12 18h.01"/></svg>',
    info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg>',
    seat: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v9h10M7 13l-1 7M17 13v7M7 9h9"/></svg>',
    person: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="7" r="4"/><path d="M4 21a8 8 0 0116 0z"/></svg>',
    signal: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4L2 22"/></svg>',
    left: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    board: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h6M7 13h10M7 17h8"/></svg>',
    map: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>',
    bell: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0112 0c0 6 3 7 3 7H3s3-1 3-7M10 20a2 2 0 004 0"/></svg>',
    more: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    game: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3M16 12h.01M18 14h.01"/></svg>',
    fare: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2" fill="currentColor"/></svg>',
    pin: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.2 7-11.5A7 7 0 005 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    bag: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="7" width="14" height="13" rx="3"/><path d="M9 7V5a3 3 0 016 0v2M5 12h14"/></svg>',
    chat: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    gear: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
    about: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg>',
    share: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v13"/></svg>',
    locate: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    chev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  };
  const logo = '<svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#fff"/><rect x="12" y="18" width="40" height="26" rx="6" fill="#1446A0"/><rect x="16" y="22" width="14" height="9" rx="2" fill="#fff"/><rect x="34" y="22" width="14" height="9" rx="2" fill="#fff"/><circle cx="21" cy="46" r="5" fill="#F5C518" stroke="#1446A0" stroke-width="2"/><circle cx="43" cy="46" r="5" fill="#F5C518" stroke="#1446A0" stroke-width="2"/></svg>';

  /* ---------------- Status vocabulary (one legend for the whole app) ---------------- */
  const STATUS = {
    on_time: { cls: 'good', key: 'statusOnTime', icon: I.check },
    delayed: { cls: 'caution', key: 'statusDelayed', icon: I.clock },
    stopped: { cls: 'stop', key: 'statusStopped', icon: I.stop },
    boarding: { cls: 'info', key: 'statusBoarding', icon: I.van },
    boarding_now: { cls: 'good', key: 'statusBoardingNow', icon: I.van },
    scheduled: { cls: 'neutral', key: 'statusScheduled', icon: I.clock },
  };
  const statusBadge = (u) => { const s = STATUS[u.status] || STATUS.on_time; return `<span class="badge ${s.cls}">${s.icon}${esc(t(s.key))}</span>`; };
  const SEAT_CLS = { many: 'good', few: 'caution', full: 'stop' };
  function seatBadge(u) {
    const txt = u.free <= 0 ? t('full') : u.free === 1 ? t('seatFree') : t('seatsFree', { n: u.free });
    return `<span class="badge ${SEAT_CLS[u.seatStatus]}">${u.free <= 0 ? I.stop : I.seat}${esc(txt)}</span>`;
  }
  const SEV_ICON = { stop: I.warn, caution: I.warn, good: I.check, info: I.info };

  /* ---------------- Countdown text ---------------- */
  function countdownHTML(target, unit, big) {
    if (unit && unit.status === 'stopped') return { cls: 'unknown', html: esc(t('etaUnknown')) };
    if (!target) return { cls: 'unknown', html: '—' };
    const ms = target - simNow();
    if (ms <= 30 * 1000) return { cls: 'now', html: esc(unit && unit.state === 'boarding' ? t('boardingNow') : t('now')) };
    if (big) {
      const total = Math.max(0, Math.round(ms / 1000));
      const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
      return { cls: '', html: h ? `${h}<span class="unit">h</span> ${m}<span class="unit">m</span>` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` };
    }
    const mins = Math.ceil(ms / 60000);
    if (mins >= 60) return { cls: '', html: `${Math.floor(mins / 60)}<span class="unit">h</span> ${mins % 60}<span class="unit">m</span>` };
    return { cls: '', html: `${mins}<span class="unit">${esc(t('min'))}</span>` };
  }

  /* ---------------- Arrivals at a stop, across every route and direction ---------------- */
  function arrivals(stopId, routeList) {
    const out = [];
    for (const R of routeList || routesAt(stopId)) {
      const stop = R.stops.find((s) => s.id === stopId);
      if (!stop) continue;
      const speed = (R.service.avgSpeedKmh || 38) / 3600000;
      for (const dir of ['out', 'in']) {
        if (destOf(R, dir).id === stopId) continue; // vans end their trip here; nobody boards
        const sp = progressOf(R, stop, dir);
        for (const u of S.data.units) {
          if (u.route !== R.code || u.dir !== dir || u.state === 'layover') continue;
          const has = u.eta && u.eta[stopId];
          if (!(has || (u.status === 'stopped' && u.p < sp))) continue;
          out.push({ u, R, dir, stop, target: has ? u.eta[stopId] : null, sortKey: has ? u.eta[stopId] : simNow() + (sp - u.p) / speed });
        }
      }
    }
    return out.sort((a, b) => a.sortKey - b.sortKey);
  }

  /* ---------------- Notices ---------------- */
  function noticeText(n) {
    if (n.type === 'custom') return S.lang === 'ceb' ? n.ceb || n.en : n.en || n.ceb;
    const u = S.data.units.find((x) => x.id === n.unitId);
    const R = routeOf(n.route);
    const dir = R && n.dir ? `${R.code} · ${toDest(R, n.dir)}` : '';
    const vars = { plate: n.unitId, dir, reason: t('reason_' + (n.reason || 'traffic')), n: n.minutes || (u && u.holdMinutes) || '' };
    return t('notice_' + n.type, vars);
  }
  const activeNotices = () => (S.data ? S.data.notices.filter((n) => n.active && n.severity !== 'good') : []);
  const SEV_RANK = { stop: 3, caution: 2, info: 1, good: 0 };
  const SEV_VAR = { stop: 'var(--stop)', caution: 'var(--caution)', good: 'var(--good)', info: 'var(--primary)' };
  /* Read state is per device. The key includes the time, so a notice id reused after a simulation reset is not seen as read. */
  const nkey = (n) => n.id + ':' + n.at;
  const isRead = (n) => !!S.read[nkey(n)];
  const unreadActive = () => activeNotices().filter((n) => !isRead(n));
  const toggleRead = (k) => { if (S.read[k]) { delete S.read[k]; store.set('read', S.read); } else markRead([k]); };
  function markRead(keys) {
    for (const k of keys) S.read[k] = 1;
    if (S.data) { const live = new Set(S.data.notices.map(nkey)); for (const k of Object.keys(S.read)) if (!live.has(k)) delete S.read[k]; }
    store.set('read', S.read);
  }
  function ago(ms) {
    const m = Math.max(0, Math.round((simNow() - ms) / 60000));
    return m < 1 ? t('justNow') : m < 60 ? t('minutesAgo', { n: m }) : t('hoursAgo', { n: Math.floor(m / 60) });
  }

  /* ---------------- Data loading ---------------- */
  let themeKey = '';
  /** Colour overrides set from the facilitator panel; only touches the page when they change. */
  function applyTheme(theme) {
    const key = JSON.stringify(theme || null);
    if (key === themeKey || !window.ISBOGI_THEME) return;
    themeKey = key;
    window.ISBOGI_THEME.apply(theme);
  }
  let pollTimer = null;
  async function poll() {
    clearTimeout(pollTimer);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch('/api/state', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      S.data = data; S.fetchedAt = Date.now(); S.offline = false;
      applyTheme(data.theme);
      try { localStorage.setItem('isbogi:lastState', JSON.stringify({ data, fetchedAt: S.fetchedAt })); } catch { /* full */ }
    } catch {
      S.offline = true;
      if (!S.data) {
        const cached = store.get('lastState', null);
        if (cached && cached.data && cached.data.routes) { S.data = cached.data; S.fetchedAt = cached.fetchedAt; applyTheme(cached.data.theme); }
      }
    }
    ensureStop();
    renderLive();
    pollTimer = setTimeout(poll, S.lowData ? 20000 : 5000);
  }

  /* ---------------- Routing (hash based so the phone's back button works) ---------------- */
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    return { view: parts[0] || 'board', arg: parts[1] || null };
  }
  const go = (hash) => { location.hash = hash; };
  const LIVE = ['board', 'trip', 'map', 'alerts'];

  /* ---------------- Shell ---------------- */
  function shell(inner) {
    const r = route();
    const count = unreadActive().length;
    const nav = [
      ['board', I.board, t('navBoard')], ['map', I.map, t('navMap')], ['alerts', I.bell, t('navAlerts')], ['more', I.more, t('navMore')],
    ].map(([v, ic, label]) => {
      const cur = r.view === v || (v === 'board' && r.view === 'trip');
      return `<button data-go="#/${v}" ${cur ? 'aria-current="page"' : ''}>${ic}<span>${esc(label)}</span>${v === 'alerts' && count ? `<span class="count" aria-label="${count}">${count}</span>` : ''}</button>`;
    }).join('');
    const fab = S.data && S.data.features && S.data.features.arcade && r.view === 'board'
      ? `<button class="fab" data-action="trivia">${I.game}${esc(t('play'))}</button>` : '';
    const mapMode = r.view === 'map' && liveMapReady();
    return `
      <div class="app ${fab ? 'has-fab' : ''} ${mapMode ? 'map-mode' : ''}">
        <header class="topbar">
          <div class="brand">${logo}<div><span class="brand-name">ISBOGI</span><small>${esc(t('routeLine', { n: S.data ? S.data.routes.length : '' }))}</small></div></div>
          <div class="lang-toggle" role="group" aria-label="${esc(t('language'))}">
            <button data-lang="en" aria-pressed="${S.lang === 'en'}">EN</button>
            <button data-lang="ceb" aria-pressed="${S.lang === 'ceb'}">BIS</button>
          </div>
        </header>
        <div class="simbar"><span class="sb-l" role="note"><i></i>${esc(t('pilotBadge'))}</span><span class="fresh" id="fresh" aria-live="off"><span class="dot"></span><span class="txt"></span></span></div>
        <main id="main">${inner}</main>
        ${fab}
        <nav class="bottomnav" aria-label="Main">${nav}</nav>
      </div>`;
  }

  function offlineBanner() {
    if (!S.offline) return '';
    return `<div class="banner neutral" role="status"><span class="icon">${I.signal}</span><div><div class="b-title">${esc(t('offlineTitle'))}</div><p class="small">${esc(t('offlineBody'))}</p></div><button class="btn ghost" data-action="retry">${esc(t('retry'))}</button></div>`;
  }
  const freshChip = () => ''; // the "updated" indicator lives in the header strip (see shell)
  function updateFresh() {
    const el = document.getElementById('fresh');
    if (!el || !S.fetchedAt) return;
    const secs = Math.max(0, Math.round((Date.now() - S.fetchedAt) / 1000));
    const ago = secs < 5 ? t('justNow') : secs < 90 ? t('secondsAgo', { n: secs }) : t('minutesAgo', { n: Math.round(secs / 60) });
    const stale = secs > 30;
    el.classList.toggle('stale', stale);
    el.querySelector('.txt').textContent = t('updatedAgo', { s: ago }) + (stale ? ' · ' + t('staleWarn') : '');
  }

  /* ---------------- Location (stays in memory on this phone) ---------------- */
  function distKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function locate() {
    overlay.innerHTML = '';
    if (!navigator.geolocation || !window.isSecureContext) {
      S.locMsg = { cls: 'caution', text: t(window.isSecureContext ? 'locDenied' : 'locInsecure') };
      render(); return;
    }
    S.locMsg = { cls: 'info', text: t('locating') };
    render();
    navigator.geolocation.getCurrentPosition((pos) => {
      S.loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const near = allStops().map((s) => ({ s, km: distKm(S.loc, s) })).sort((a, b) => a.km - b.km)[0];
      const km = near.km.toFixed(1);
      if (near.km > 10) {
        S.locMsg = { cls: 'caution', text: t('farAway', { km }) };
      } else {
        S.stopId = near.s.id; store.set('stopId', S.stopId);
        S.locMsg = { cls: 'good', text: t('nearestIs', { stop: near.s.name, km }) };
        if (M && route().view === 'map') M.map.flyTo([S.loc.lat, S.loc.lng], 13);
      }
      render();
    }, () => {
      S.locMsg = { cls: 'caution', text: t('locDenied') };
      render();
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }
  const locNote = () => (S.locMsg ? `<div class="banner ${S.locMsg.cls}" role="status"><span class="icon">${S.locMsg.cls === 'good' ? I.check : S.locMsg.cls === 'info' ? I.info : I.warn}</span><div><p class="small">${esc(S.locMsg.text)}</p></div></div>` : '');

  /** Other operators' routes mapped near the chosen stop (OpenStreetMap, unverified). */
  function connectionsCard() {
    const list = (S.data.connections || {})[S.stopId] || [];
    if (!list.length) return '';
    const items = list.map((c) => `<li><div><b>${esc(c.name)}</b><div class="small muted">${esc(c.mode)}${c.operator ? ' · ' + esc(c.operator) : ''}${c.ref ? ' · ' + esc(c.ref) : ''}</div></div><span class="badge neutral">${esc(t('unverified'))}</span></li>`).join('');
    return `<details class="acc conn" ${S.connOpen ? 'open' : ''} style="margin-top:12px"><summary>${esc(t('otherOperators'))}<span class="badge ${list.length ? 'info' : 'neutral'}" style="margin-left:8px">${list.length}</span></summary>
      <div class="conn-body"><p class="small muted" style="padding:0 0 8px">${esc(t('otherRoutesNote'))}</p>${list.length ? `<ul class="conn-list">${items}</ul>` : `<p class="small" style="padding:0">${esc(t('noOtherRoutes'))}</p>`}</div></details>`;
  }

  /* ---------------- Views ---------------- */
  /** Route filter chips. `list` is the routes to offer; "All" is always first. */
  function routeChips(list) {
    const chip = (code, label, color) => `<button data-route="${esc(code)}" aria-pressed="${S.route === code}" ${color ? `style="--rc:${esc(color)}"` : ''}>${color ? '<i class="dot"></i>' : ''}${esc(label)}</button>`;
    return `<div class="route-chips" role="group" aria-label="${esc(t('routeFilter'))}">${chip('all', t('allRoutes'))}${list.map((R) => chip(R.code, R.code, R.color)).join('')}</div>`;
  }

  function routeStrip(R, dir) {
    const list = stopsOf(R, dir);
    const W = 340, x0 = 22, x1 = W - 22, y = 40;
    const L = R.lengthKm;
    const X = (prog) => x0 + (prog / L) * (x1 - x0);
    const stopsSvg = list.map((s, i) => {
      const x = X(progressOf(R, s, dir));
      const mine = s.id === S.stopId;
      const ly = y + (i % 2 ? 44 : 27); // alternate label rows so close stops don't overlap
      const anchor = i === 0 ? 'start' : i === list.length - 1 ? 'end' : 'middle';
      const lx = i === 0 ? x - 8 : i === list.length - 1 ? x + 8 : x;
      return `<g>${i % 2 ? `<line x1="${x}" y1="${y + 8}" x2="${x}" y2="${ly - 10}" stroke="var(--line)"/>` : ''}<circle cx="${x}" cy="${y}" r="${mine ? 8 : 5.5}" fill="${mine ? R.color : '#fff'}" stroke="${R.color}" stroke-width="3"/>
        <text x="${lx}" y="${ly}" text-anchor="${anchor}" font-size="12.5" font-weight="${mine ? 800 : 600}" fill="${mine ? R.color : 'var(--ink-muted)'}">${esc(shortName(s))}</text></g>`;
    }).join('');
    const vans = S.data.units.filter((u) => u.route === R.code && u.dir === dir && (u.state === 'enroute' || u.state === 'boarding')).map((u) => {
      const x = X(u.state === 'boarding' ? 0 : u.p);
      const fill = u.status === 'stopped' ? 'var(--stop)' : `var(--${SEAT_CLS[u.seatStatus]})`;
      return `<g data-trip="${esc(u.id)}" style="cursor:pointer"><title>${esc(u.plate)}</title>
        <rect x="${x - 14}" y="${y - 31}" width="28" height="19" rx="5" fill="${fill}"/>
        <path d="M${x - 5} ${y - 12}l5 6 5-6z" fill="${fill}"/>
        <text x="${x}" y="${y - 17.5}" text-anchor="middle" font-size="11.5" font-weight="800" fill="#fff">${esc(u.plate.slice(-2))}</text></g>`;
    }).join('');
    return `<div class="card route-strip" aria-label="${esc(t('route'))}">
      <div class="strip-head">${routeChip(R)}<b>${esc(R.name)}</b>${sampleTag(R)}</div>
      <svg viewBox="0 0 ${W} 96" role="img" aria-label="${esc(R.code + ' ' + toDest(R, dir))}">
        <line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${R.color}" stroke-width="4" stroke-linecap="round"/>
        ${stopsSvg}${vans}
      </svg></div>`;
  }

  function serviceBanner() {
    const pairs = [];
    for (const R of visibleAt(S.stopId)) for (const dir of ['out', 'in']) if (destOf(R, dir).id !== S.stopId) pairs.push({ R, svc: R.service[dir] });
    if (!pairs.length) return '';
    if (pairs.every((p) => p.svc.serviceOver)) {
      const resumes = Math.min(...pairs.map((p) => p.svc.resumesAt));
      return `<div class="banner info"><span class="icon">${I.info}</span><div><p>${esc(t('serviceOver', { time: fmtTime(resumes) }))}</p></div></div>`;
    }
    const soon = pairs.find((p) => p.svc.lastTripSoon);
    if (soon) return `<div class="banner caution"><span class="icon">${I.clock}</span><div><p><b>${esc(soon.R.code + ' · ' + t('lastTripSoon', { time: fmtTime(soon.svc.lastDepartureAt) }))}</b></p></div></div>`;
    return '';
  }

  function alertBanner() {
    const here = new Set(routesAt(S.stopId).map((r) => r.code));
    const list = unreadActive().filter((n) => !n.route || here.has(n.route)).sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
    if (!list.length) return '';
    const n = list[0];
    return `<div class="banner ${n.severity}" role="alert"><span class="icon">${SEV_ICON[n.severity]}</span><div><p><b>${esc(noticeText(n))}</b></p>
      ${list.length > 1 ? `<p class="small">${esc(t('moreAlerts', { n: list.length - 1 }))}</p>` : ''}</div>
      <div class="banner-acts"><button class="btn ghost" data-read="${esc(nkey(n))}" aria-label="${esc(t('markRead'))}" title="${esc(t('markRead'))}">${I.check}</button>
        <button class="btn ghost" data-go="#/alerts" aria-label="${esc(t('navAlerts'))}">${I.chev}</button></div></div>`;
  }

  /** One segment per seat, free seats at the right; the seat count is always written beside it. */
  function seatMeter(u) {
    let h = '';
    for (let i = 0; i < u.seatMap.length; i++) h += `<i class="${i < u.occupied ? '' : 'free'}"></i>`;
    return `<div class="meter ${SEAT_CLS[u.seatStatus]}" aria-hidden="true">${h}</div>`;
  }

  const whenText = (a) => (a.u.status === 'stopped' ? t('etaUnknown')
    : a.stop.id === originOf(a.R, a.dir).id ? t('departsAt', { time: fmtTime(a.target) }) : t('arrives', { time: fmtTime(a.target) }));

  function nextCard(a) {
    const { u, R, dir, target } = a;
    const stopped = u.status === 'stopped';
    const cd = stopped ? { cls: 'unknown', html: '?' } : countdownHTML(target, u, false);
    return `<button class="next-card ${stopped ? 'stopped' : u.status === 'delayed' ? 'delayed' : ''}" data-trip="${esc(u.id)}">
      <div class="top"><div><div class="eyebrow">${esc(t('nextVan'))}</div>
        <div class="countdown ${cd.cls}" ${stopped ? '' : `data-target="${target || ''}" data-unit="${esc(u.id)}"`}>${cd.html}</div>
        <div class="sub">${esc(whenText(a))}</div></div>
        <span class="plate">${I.van}${esc(u.plate)}</span></div>
      <div class="dest">${routeChip(R)}<b>${esc(toDest(R, dir))}</b>${sampleTag(R)}</div>
      <div class="badges">${statusBadge(u)}${seatBadge(u)}</div>
      ${seatMeter(u)}
      <div class="meter-note"><span>${esc(t('seatsSummary', { free: u.free, cap: S.data.capacity }))}</span><span class="go">${esc(t('details'))}${I.chev}</span></div></button>`;
  }

  function tripRow(a) {
    const { u, R, dir, target } = a;
    const cd = u.status === 'stopped' ? { cls: 'unknown', html: '?' } : countdownHTML(target, u, false);
    return `<button class="trip ${u.status === 'stopped' ? 'stopped' : u.status === 'delayed' ? 'delayed' : ''}" data-trip="${esc(u.id)}">
      <div><div class="countdown ${cd.cls}" ${u.status === 'stopped' ? '' : `data-target="${target || ''}" data-unit="${esc(u.id)}"`}>${cd.html}</div><div class="sub">${esc(whenText(a))}</div></div>
      <div class="mid"><div class="plate">${routeChip(R)}<span>${esc(toDest(R, dir))}</span></div><div class="badges">${statusBadge(u)}${seatBadge(u)}</div>${seatMeter(u)}</div><span class="chev-end">${I.chev}</span></button>`;
  }

  function viewBoard() {
    if (!S.data) return `<div class="sk" style="height:68px"></div><div class="sk" style="height:200px;margin-top:16px"></div><div class="sk" style="height:88px;margin-top:12px"></div>`;
    const stop = stopById(S.stopId);
    const here = routesAt(S.stopId);
    const list = arrivals(S.stopId, visibleAt(S.stopId)).slice(0, 6);
    const rows = list.slice(1).map(tripRow).join('');
    const strip = list.length ? routeStrip(list[0].R, list[0].dir) : '';
    return `
      ${offlineBanner()}
      <div class="stop-row"><button class="stop-pick" data-action="pickStop"><span>${I.person}</span><span><span class="label">${esc(t('waitingAt'))}</span><span class="value">${esc(stop.name)}</span></span><span class="chev">${esc(t('change'))}</span></button>
        <button class="locate-btn" data-action="locate" aria-label="${esc(t('locate'))}" title="${esc(t('locate'))}">${I.locate}</button></div>
      ${locNote()}
      ${here.length > 1 ? routeChips(here) : `<div class="here-note"><b>${esc(t('routesHere', { n: here.length }))}</b> ${here.map(routeChip).join('')}</div>`}
      ${alertBanner()}
      ${serviceBanner()}
      ${list.length ? nextCard(list[0]) : `<div class="card empty" style="margin-top:16px">${esc(t('noTrips'))}</div>`}
      ${rows ? `<h2>${esc(t('later'))}</h2>${rows}` : ''}
      ${strip}
      ${connectionsCard()}
      ${freshChip()}`;
  }

  /* Van cabin: front row is the driver only (no front passenger seat); then rows of
   * [seat][seat] | aisle | [seat]. The last row fills from the left if capacity is not a multiple of 3. */
  function seatGrid(u) {
    const n = u.seatMap.length;
    const seat = (i) => i < n
      ? `<div class="seat ${u.seatMap[i] ? 'taken' : 'vacant'}" aria-label="${i + 1}: ${esc(u.seatMap[i] ? t('seatTaken') : t('seatVacant'))}">${u.seatMap[i] ? I.person : i + 1}</div>`
      : '<div class="seat-gap"></div>';
    const aisle = '<div class="aisle" aria-hidden="true"></div>';
    let cells = `<div class="seat driver">${esc(t('driver'))}</div><div class="seat-gap"></div>${aisle}<div class="seat-gap door" aria-hidden="true"></div>`;
    for (let i = 0; i < n; i += 3) cells += `${seat(i)}${seat(i + 1)}${aisle}${seat(i + 2)}`;
    return `<div class="seat-grid" role="img" aria-label="${esc(t('seatsSummary', { free: u.free, cap: S.data.capacity }))}">${cells}</div>
      <div class="legend"><span><i class="sw vacant"></i>${esc(t('seatVacant'))}</span><span><i class="sw taken"></i>${esc(t('seatTaken'))}</span></div>`;
  }

  function routeTimeline(R, u) {
    const list = stopsOf(R, u.dir);
    let html = '';
    let vanPlaced = u.state !== 'enroute';
    for (const s of list) {
      const sp = progressOf(R, s, u.dir);
      if (!vanPlaced && sp > u.p + 1e-6) {
        html += `<li class="van"><span class="vanpin">${I.van}</span><span class="vanlabel">${esc(u.plate)}</span><span></span></li>`;
        vanPlaced = true;
      }
      const passed = u.state === 'enroute' && sp <= u.p + 1e-6;
      const eta = u.eta && u.eta[s.id];
      const mine = s.id === S.stopId;
      html += `<li class="${passed ? 'passed' : ''} ${mine ? 'mine' : ''}"><span class="node"></span>
        <span class="nm">${esc(s.name)}${mine ? `<span class="you">${esc(t('you'))}</span>` : ''}</span>
        <span class="tm">${passed ? esc(t('passed')) : eta ? esc(fmtTime(eta)) : ''}</span></li>`;
    }
    return `<ol class="timeline" style="--rc:${esc(R.color)}">${html}</ol>`;
  }

  function viewTrip(id) {
    if (!S.data) return '';
    const u = S.data.units.find((x) => x.id === id);
    const R = u && routeOf(u.route);
    if (!u || !R) return `<button class="back" data-go="#/board">${I.left}${esc(t('back'))}</button><div class="card empty">—</div>`;
    // Your stop if this van still reaches it, otherwise the end of its trip.
    let stop = R.stops.find((s) => s.id === S.stopId);
    let target = stop && u.eta && u.eta[stop.id];
    const stillAhead = stop && (target || (u.status === 'stopped' && progressOf(R, stop, u.dir) > u.p));
    if (!stillAhead) { stop = destOf(R, u.dir); target = u.eta && u.eta[stop.id]; }
    const isOrigin = stop.id === originOf(R, u.dir).id;
    const cd = countdownHTML(target, u, true);
    let advice = '';
    if (u.status === 'stopped' || u.status === 'delayed') {
      const nxt = arrivals(stop.id, [R]).find((x) => x.u.id !== u.id && x.dir === u.dir && x.u.status !== 'stopped' && x.target);
      const msg = u.status === 'stopped' ? t('stoppedAdvice') : t('delayedAdvice', { n: u.holdMinutes, reason: t('reason_' + (u.holdReason || 'traffic')) });
      const nextMsg = nxt ? t('nextUnitAdvice', { plate: nxt.u.plate, min: Math.max(1, Math.ceil((nxt.target - simNow()) / 60000)) }) : t('noNextUnit');
      advice = `<div class="banner ${u.status === 'stopped' ? 'stop' : 'caution'}" role="alert"><span class="icon">${I.warn}</span><div><p><b>${esc(msg)}</b></p><p>${esc(nextMsg)}</p>
        ${nxt ? `<button class="btn ghost" style="margin-top:8px" data-trip="${esc(nxt.u.id)}">${I.van}${esc(nxt.u.plate)}</button>` : ''}</div></div>`;
    }
    return `
      ${offlineBanner()}
      <button class="back" data-go="#/board">${I.left}${esc(t('back'))}</button>
      <div class="card hero">
        <div class="plate">${I.van} ${esc(u.plate)}</div>
        <div class="dest" style="justify-content:center;margin-top:6px">${routeChip(R)}<b>${esc(toDest(R, u.dir))}</b>${sampleTag(R)}</div>
        <div style="margin-top:10px">${statusBadge(u)}</div>
        <div class="big ${cd.cls}" data-target="${target || ''}" data-unit="${esc(u.id)}" data-big="1">${cd.html}</div>
        <div class="what">${esc(isOrigin ? t('leavesFrom', { stop: stop.name }) : t('arrivesAtYourStop', { stop: stop.name }))}${target && u.status !== 'stopped' ? ' · ' + esc(fmtTime(target)) : ''}</div>
      </div>
      ${advice}
      <div class="card" style="margin-top:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2 style="margin:0">${esc(t('seats'))}</h2>${seatBadge(u)}</div>
        <p class="small muted" style="margin:4px 0 0">${esc(t('seatsSummary', { free: u.free, cap: S.data.capacity }))}</p>
        ${seatGrid(u)}
      </div>
      <div class="card"><h2 style="margin:0">${esc(R.name)}</h2>${routeTimeline(R, u)}</div>
      ${freshChip()}`;
  }

  function viewMap() {
    if (!S.data) return '';
    if (liveMapReady()) return viewLiveMap();
    return viewMapSchematic();
  }

  /** Fallback when map tiles or road paths are unavailable: a list (low-data) or a sketch of one route. */
  function viewMapSchematic() {
    const shown = mapRoutes();
    const chips = routeChips(routes());
    if (S.lowData) {
      const rows = S.data.units.filter((u) => shown.some((R) => R.code === u.route) && (u.state === 'enroute' || u.state === 'boarding')).map((u) => {
        const R = routeOf(u.route);
        const list = stopsOf(R, u.dir);
        const ahead = list.find((s) => progressOf(R, s, u.dir) > u.p + 1e-6) || list[list.length - 1];
        return `<button class="trip" data-trip="${esc(u.id)}" style="grid-template-columns:1fr auto"><div><div class="plate">${routeChip(R)}<span>${esc(u.plate)}</span></div><div class="sub">${esc(toDest(R, u.dir))} → ${esc(ahead.name)}</div></div><div class="right">${statusBadge(u)}<div style="margin-top:4px">${seatBadge(u)}</div></div></button>`;
      }).join('');
      return `${offlineBanner()}${chips}<div class="banner info"><span class="icon">${I.info}</span><div><p><b>${esc(t('mapLowData'))}</b></p><p class="small">${esc(t('showList'))}</p></div></div><div style="margin-top:12px">${rows}</div>${freshChip()}`;
    }
    const R = shown[0];
    const all = R.stops;
    const pt = (km) => {
      for (let i = 0; i < all.length - 1; i++) {
        const a = all[i], b = all[i + 1];
        if (km <= b.km) { const f = (km - a.km) / (b.km - a.km || 1); return [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f]; }
      }
      return [all[all.length - 1].x, all[all.length - 1].y];
    };
    const road = all.map((s) => `${s.x},${s.y}`).join(' ');
    const stopSvg = all.map((s) => {
      const mine = s.id === S.stopId;
      const left = s.x > 250; // labels near the right edge go on the left of the marker
      const anchor = left ? 'end' : 'start';
      const dx = left ? -16 : 14, dy = s === all[0] ? 26 : 5;
      return `<g><circle cx="${s.x}" cy="${s.y}" r="${s.terminal ? 9 : 6}" fill="${mine ? R.color : '#fff'}" stroke="${R.color}" stroke-width="3"/>
        <text x="${s.x + (s === all[0] ? -10 : dx)}" y="${s.y + dy}" text-anchor="${s === all[0] ? 'start' : anchor}" font-size="13.5" font-weight="${mine || s.terminal ? 700 : 600}" fill="var(--ink)">${esc(placeName(s))}</text></g>`;
    }).join('');
    const vans = S.data.units.filter((u) => u.route === R.code && (u.state === 'enroute' || u.state === 'boarding')).map((u) => {
      const [x, y] = pt(u.absKm);
      const fill = u.status === 'stopped' ? 'var(--stop)' : `var(--${SEAT_CLS[u.seatStatus]})`;
      return `<g data-trip="${esc(u.id)}" style="cursor:pointer"><title>${esc(u.plate)}</title><circle cx="${x}" cy="${y}" r="15" fill="${fill}" stroke="#fff" stroke-width="3"/>
        <text x="${x}" y="${y + 4}" text-anchor="middle" font-size="12" font-weight="800" fill="#fff">${u.status === 'stopped' ? '!' : esc(u.plate.slice(-2))}</text></g>`;
    }).join('');
    return `
      ${offlineBanner()}
      ${chips}
      <div class="card map-wrap" style="margin-top:12px;padding:8px">
        <svg viewBox="0 0 380 340" role="img" aria-label="${esc(t('mapTitle'))}">
          <polyline points="${road}" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
          <polyline points="${road}" fill="none" stroke="#9AA8BD" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
          ${stopSvg}${vans}
        </svg>
      </div>
      <p class="small" style="margin:10px 2px 0">${routeChip(R)} <b>${esc(R.name)}</b> ${sampleTag(R)}</p>
      <div class="map-legend"><b>${esc(t('legend'))}:</b>
        <span><i class="sw" style="background:var(--good);border-color:var(--good)"></i>${esc(t('seatsMany'))}</span>
        <span><i class="sw" style="background:var(--caution);border-color:var(--caution)"></i>${esc(t('seatsFew'))}</span>
        <span><i class="sw" style="background:var(--stop);border-color:var(--stop)"></i>${esc(t('seatsFull'))} / ${esc(t('statusStopped'))}</span></div>
      <p class="small muted">${esc(t('mapNote'))}</p>
      ${freshChip()}`;
  }

  /* ---------------- Live map (Leaflet + OpenStreetMap tiles) ----------------
   * One map instance is kept for the whole session: render() rewrites the page every poll, so the map's
   * DOM node is moved into a fresh slot each time instead of being rebuilt. */
  let M = null;
  const pathCumByRoute = {};
  const vanClass = (u) => (u.status === 'stopped' ? 'stop' : SEAT_CLS[u.seatStatus]);

  /** Lat/lng of a point `km` along route R, placed between stops along the real road path. */
  function pathPoint(R, km) {
    const path = S.paths[R.code], all = R.stops;
    let cum = pathCumByRoute[R.code];
    if (!cum || cum.length !== path.length) {
      cum = [0];
      for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], (path[i][1] - path[i - 1][1]) * 0.99));
      pathCumByRoute[R.code] = cum;
    }
    let a = all[0], b = all[1];
    for (let i = 0; i < all.length - 1; i++) { a = all[i]; b = all[i + 1]; if (km <= b.km) break; }
    const f = Math.min(1, Math.max(0, (km - a.km) / (b.km - a.km || 1)));
    // Guard against a road path that is older than the stop list (right after the facilitator edits a route).
    const last = path.length - 1;
    const ai = Math.max(0, Math.min(a.pathIdx, last - 1)), bi = Math.min(Math.max(b.pathIdx, ai + 1), last);
    const target = cum[ai] + f * (cum[bi] - cum[ai]);
    let i = ai;
    while (i < bi - 1 && cum[i + 1] < target) i++;
    i = Math.min(i, last - 1);
    const seg = cum[i + 1] - cum[i] || 1;
    const g = Math.min(1, Math.max(0, (target - cum[i]) / seg));
    return [path[i][0] + (path[i + 1][0] - path[i][0]) * g, path[i][1] + (path[i + 1][1] - path[i][1]) * g];
  }

  const liveMapReady = () => !!(S.data && !S.lowData && window.L && S.paths && routes().every((R) => S.paths[R.code] && S.paths[R.code].length > 1));

  function viewLiveMap() {
    return `<div class="map-bleed">
      <div id="mapSlot" class="map-slot" role="region" aria-label="${esc(t('mapTitle'))}"></div>
      <div class="map-float top">${routeChips(routes())}${offlineBanner()}
        <p class="banner caution" id="mapTileNote" hidden><span class="icon">${I.warn}</span><span class="small">${esc(t('mapTilesFail'))}</span></p></div>
      <button class="map-float locate-fab" data-action="locate" aria-label="${esc(t('locate'))}" title="${esc(t('locate'))}">${I.locate}</button>
      <div class="map-float bottom">
        <div class="map-legend"><b>${esc(t('legend'))}:</b>
          <span><i class="sw" style="background:var(--good);border-color:var(--good)"></i>${esc(t('seatsMany'))}</span>
          <span><i class="sw" style="background:var(--caution);border-color:var(--caution)"></i>${esc(t('seatsFew'))}</span>
          <span><i class="sw" style="background:var(--stop);border-color:var(--stop)"></i>${esc(t('seatsFull'))} / ${esc(t('statusStopped'))}</span>
          <span><i class="sw" style="background:#fff;border-color:var(--neutral);border-style:dashed"></i>${esc(t('mapUnverified'))}</span></div>
        ${freshChip()}</div></div>`;
  }

  function fitMap() {
    const pts = mapRoutes().flatMap((R) => S.paths[R.code]);
    M.map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [48, 110], paddingBottomRight: [48, 210] });
    M.refit = false;
  }

  function mountMap() {
    const slot = document.getElementById('mapSlot');
    if (!slot || !S.data || !S.paths || !window.L) return;
    if (!M) {
      const el = document.createElement('div');
      el.className = 'live-map';
      const map = L.map(el, { zoomControl: false, attributionControl: false, tap: true, zoomSnap: 0.25 });
      L.control.attribution({ prefix: false, position: 'bottomleft' }).addTo(map);
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      M = { el, map, fails: 0, fitted: false, refit: false, stops: L.layerGroup().addTo(map), vans: {}, lines: {} };
      map.on('zoomend', () => el.classList.toggle('z-low', map.getZoom() < 12));
      const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      }).addTo(map);
      tiles.on('tileerror', () => { M.fails++; syncTileNote(); });
      tiles.on('tileload', () => { M.fails = 0; syncTileNote(); });
      for (const R of routes()) {
        const casing = L.polyline(S.paths[R.code], { color: '#fff', weight: 10, opacity: .95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map);
        const line = L.polyline(S.paths[R.code], { color: R.color, weight: 5, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map);
        M.lines[R.code] = { casing, line };
      }
    }
    slot.appendChild(M.el);
    M.map.invalidateSize();
    if (!M.fitted || M.refit) { fitMap(); M.fitted = true; }
    if (!M.places) {
      // unverified terminals from OpenStreetMap: dashed grey, name on tap; drawn once the map has a view
      M.places = L.layerGroup().addTo(M.map);
      (S.data.places || []).forEach((p) => L.circleMarker([p.lat, p.lng], { radius: 6, color: '#5F6B7A', weight: 2, dashArray: '3 3', fillColor: '#fff', fillOpacity: 1 })
        .bindPopup(`<b>${esc(p.name)}</b><br>${esc(t('mapUnverified'))}`).addTo(M.places));
    }
    M.el.classList.toggle('z-low', M.map.getZoom() < 12);
    const shown = new Set(mapRoutes().map((r) => r.code));
    for (const [code, l] of Object.entries(M.lines)) {
      const on = shown.has(code);
      l.casing.setStyle({ opacity: on ? 0.95 : 0.15 });
      l.line.setStyle({ opacity: on ? 1 : 0.2 });
      if (on) l.line.bringToFront();
    }
    drawMapStops();
    drawMapVans();
    syncTileNote();
  }
  function syncTileNote() {
    const n = document.getElementById('mapTileNote');
    if (n && M) n.hidden = M.fails < 6;
  }
  function drawMapStops() {
    M.stops.clearLayers();
    if (S.loc) {
      if (!M.me) M.me = L.circleMarker([S.loc.lat, S.loc.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#1D6FF2', fillOpacity: 1 }).bindTooltip(esc(t('youAreHere'))).addTo(M.map);
      else M.me.setLatLng([S.loc.lat, S.loc.lng]);
    } else if (M.me) { M.me.remove(); M.me = null; }
    const seen = new Set();
    for (const R of mapRoutes()) {
      R.stops.forEach((s, i) => {
        if (seen.has(s.id)) return;
        seen.add(s.id);
        const mine = s.id === S.stopId;
        const shared = routesAt(s.id).length > 1;
        const major = s.terminal || mine; // always labelled; other stops are named once zoomed in, so labels never pile up
        const dir = i === 0 ? 'bottom' : i === R.stops.length - 1 ? 'top' : 'right';
        L.circleMarker([s.lat, s.lng], { radius: s.terminal ? 10 : shared ? 8 : 7, color: shared ? '#14213D' : R.color, weight: 3, fillColor: mine ? '#14213D' : '#fff', fillOpacity: 1, interactive: false })
          .bindTooltip(esc(placeName(s)), { permanent: true, direction: dir, offset: dir === 'right' ? [10, 0] : dir === 'top' ? [0, -12] : [0, 12], className: 'stop-tip' + (mine ? ' mine' : '') + (major ? '' : ' minor') })
          .addTo(M.stops);
      });
    }
  }
  function drawMapVans() {
    const shown = new Set(mapRoutes().map((r) => r.code));
    const live = S.data.units.filter((u) => shown.has(u.route) && (u.state === 'enroute' || u.state === 'boarding'));
    const keep = new Set(live.map((u) => u.id));
    for (const id of Object.keys(M.vans)) if (!keep.has(id)) { M.vans[id].remove(); delete M.vans[id]; }
    live.forEach((u) => {
      const R = routeOf(u.route);
      const icon = L.divIcon({ className: 'van-icon', iconSize: [38, 38], iconAnchor: [19, 19],
        html: `<div class="van-pin ${vanClass(u)}" style="--rc:${esc(R.color)}" data-trip="${esc(u.id)}" title="${esc(u.plate)}">${u.status === 'stopped' ? '!' : esc(u.plate.slice(-2))}</div>` });
      const pos = pathPoint(R, u.absKm);
      if (M.vans[u.id]) { M.vans[u.id].setLatLng(pos); M.vans[u.id].setIcon(icon); }
      else M.vans[u.id] = L.marker(pos, { icon, zIndexOffset: 1000, keyboard: false }).addTo(M.map);
    });
  }
  async function loadPaths() {
    try {
      const res = await fetch('/api/route');
      if (!res.ok) return;
      const { paths } = await res.json();
      if (paths && Object.keys(paths).length) { S.paths = paths; store.set('routePaths', paths); if (route().view === 'map') render(); }
    } catch { /* offline: cached or schematic map is used */ }
  }

  function viewAlerts() {
    if (!S.data) return '';
    const here = new Set(routesAt(S.stopId).map((r) => r.code));
    const f = S.alertFilter;
    const mine = (n) => !n.route || here.has(n.route);
    const sorter = (a, b) => ((b.severity === 'stop') - (a.severity === 'stop')) || (b.at - a.at); // important posts pinned on top, then newest first
    const active = S.data.notices.filter((n) => n.active);
    const unread = active.filter((n) => !isRead(n));
    const inRoute = (n) => S.alertRoute === 'all' || !n.route || n.route === S.alertRoute;
    const shown = active.filter((n) => inRoute(n) && (f === 'unread' ? !isRead(n) : f === 'mine' ? mine(n) : true)).sort(sorter);
    const hasNew = (code) => active.some((n) => !isRead(n) && (!n.route || n.route === code));
    const stories = `<div class="stories" role="group" aria-label="${esc(t('routeFilter'))}"><button class="story" data-ar="all" aria-pressed="${S.alertRoute === 'all'}"><span class="ring ${unread.length ? 'new' : ''}" style="--rc:var(--primary)"><span class="av" style="background:var(--ink)">${I.bell}</span></span><small>${esc(t('filterAll'))}</small></button>${routes().map((R) => `<button class="story" data-ar="${esc(R.code)}" aria-pressed="${S.alertRoute === R.code}"><span class="ring ${hasNew(R.code) ? 'new' : ''}" style="--rc:${esc(R.color)}"><span class="av" style="background:${esc(R.color)}">${esc(R.code)}</span></span><small>${esc(shortName(destOf(R, 'out')))}</small></button>`).join('')}</div>`;
    const earlier = S.data.notices.filter((n) => !n.active && !S.cleared[nkey(n)]).slice(0, 12);
    /* Posts: a social-style feed. Author header, status label, body, optional van preview, footer actions. */
    const postLabel = (n) => (n.type === 'breakdown' ? ['stop', 'postStopped', I.stop] : n.type === 'delay' ? ['caution', 'postDelayed', I.clock] : n.type === 'resolved' ? ['good', 'postResolved', I.check]
      : n.severity === 'stop' ? ['stop', 'postImportant', I.warn] : n.severity === 'caution' ? ['caution', 'postHeadsUp', I.warn] : n.severity === 'good' ? ['good', 'postResolved', I.check] : ['info', 'postNotice', I.info]);
    const canShare = typeof navigator !== 'undefined' && !!navigator.share;
    const post = (n) => {
      const R = routeOf(n.route), u = n.unitId && S.data.units.find((x) => x.id === n.unitId);
      const system = n.type !== 'custom', key = nkey(n), isNew = n.active && !isRead(n);
      const [cls, lab, ico] = postLabel(n);
      const text = noticeText(n);
      const big = !system && !u && text.length <= 90;
      const preview = u && n.active ? `<button class="plink-card" data-trip="${esc(u.id)}"><span class="pl-ic">${I.van}</span><span class="pl-t"><b>${esc(u.plate)} ${routeChip(routeOf(u.route))}</b><span>${esc(toDest(routeOf(u.route), u.dir))}</span></span><span class="pl-s">${statusBadge(u)}</span><span class="pl-go">${I.chev}</span></button>` : '';
      return `<article class="post ${n.active ? '' : 'done'} ${isNew ? 'unread' : ''}" style="--sc:${SEV_VAR[n.severity] || SEV_VAR.info}">
        ${n.active && n.severity === 'stop' ? `<div class="pinline">${I.pin}${esc(t('pinned'))}</div>` : ''}
        <header class="phead"><span class="pav ${system ? 'sys' : 'ops'}">${system ? I.signal : I.van}</span>
          <div class="pmeta"><b>${esc(system ? t('authorLive') : t('authorOps'))}${system ? '' : `<span class="vfy" title="${esc(t('official'))}" aria-label="${esc(t('official'))}">${I.check}</span>`}</b><span>${esc(ago(n.at))} · ${esc(fmtTime(n.at))}${R ? ' ' + routeChip(R) : ''}</span></div>
          ${isNew ? `<span class="udot" role="img" aria-label="${esc(t('newTag'))}"></span>` : ''}</header>
        <div class="pbody"><span class="badge ${cls}">${ico}${esc(t(lab))}</span>
          ${big ? `<div class="postbox"><p>${esc(text)}</p></div>` : `<p class="ptext">${esc(text)}</p>`}${preview}</div>
        <footer class="pfoot">
          ${n.active ? `<button class="pact ${isRead(n) ? 'on' : ''}" data-read="${esc(key)}" aria-pressed="${isRead(n)}">${I.check}${esc(isRead(n) ? t('readDone') : t('markRead'))}</button>` : ''}
          ${canShare ? `<button class="pact" data-share="${esc(key)}">${I.share}${esc(t('share'))}</button>` : ''}
        </footer></article>`;
    };
    const card = post;
    const chip = (k, label) => `<button data-af="${k}" aria-pressed="${f === k}">${esc(label)}</button>`;
    const hours = routes().map((R) => `<div class="hours-row"><div>${routeChip(R)} <b>${esc(R.name)}</b></div><div class="small muted">${esc(t('firstLast', { first: R.service.firstDeparture, last: R.service.lastDeparture, h: R.service.headwayMin }))}</div></div>`).join('');
    return `
      ${offlineBanner()}
      <h1>${esc(t('alertsTitle'))}</h1>
      <div class="alert-head"><span class="alert-sum">${esc(t('alertsSummary', { a: active.length, u: unread.length }))}</span>
        ${unread.length ? `<button class="btn ghost" data-action="readAll">${I.check}${esc(t('markAllRead'))}</button>` : ''}</div>
      ${stories}
      <div class="route-chips" role="group" aria-label="${esc(t('alertFilter'))}">${chip('all', t('filterAll'))}${chip('unread', `${t('filterUnread')}${unread.length ? ' (' + unread.length + ')' : ''}`)}${chip('mine', t('filterMine'))}</div>
      <h2>${esc(t('active'))}</h2>
      ${shown.length ? `<div class="postfeed">${shown.map(card).join('')}</div>` : `<div class="card empty">${I.check} ${esc(f === 'unread' && active.length ? t('caughtUp') : t('noAlerts'))}</div>`}
      ${earlier.length ? `<div class="alert-head" style="margin-top:22px"><h2 style="margin:0">${esc(t('earlier'))}</h2><div class="btns"><button class="btn ghost" data-action="toggleEarlier">${esc(S.showEarlier ? t('hideEarlier') : t('showEarlier', { n: earlier.length }))}</button>${S.showEarlier ? `<button class="btn ghost" data-action="clearEarlier">${esc(t('clearEarlier'))}</button>` : ''}</div></div>${S.showEarlier ? `<div class="postfeed">${earlier.map(card).join('')}</div>` : ''}` : ''}
      <h2>${esc(t('serviceHours'))}</h2>
      <div class="card">${hours}</div>`;
  }

  function viewMore(sub) {
    const back = `<button class="back" data-go="#/more">${I.left}${esc(t('back'))}</button>`;
    if (!sub) {
      const items = [
        ...(S.data && S.data.features.fares ? [['fares', t('fares'), I.fare]] : []),
        ['terminals', t('terminals'), I.pin], ['rules', t('rules'), I.bag], ['feedback', t('feedback'), I.chat], ['settings', t('settings'), I.gear], ['about', t('about'), I.about],
      ];
      return `<h1>${esc(t('moreTitle'))}</h1><ul class="menu" style="margin-top:16px">${items.map(([k, l, ic]) => `<li><button data-go="#/more/${k}"><span class="mi">${ic}</span>${esc(l)}<span class="chev">${I.chev}</span></button></li>`).join('')}</ul>`;
    }
    if (sub === 'fares') return back + viewFares();
    if (sub === 'terminals') return back + viewTerminals();
    if (sub === 'rules') return back + viewRules();
    if (sub === 'feedback') return back + viewFeedback();
    if (sub === 'settings') return back + viewSettings();
    if (sub === 'about') return back + viewAbout();
    return back;
  }

  /* The sample fare table only covers the first route (955), the one in the thesis. */
  const fareRoute = () => routes()[0];
  function viewFares() {
    if (!S.data || !S.data.fares) return '';
    const R = fareRoute();
    const opts = (sel) => R.stops.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    return `<h1>${esc(t('fares'))}</h1>
      <div class="banner caution"><span class="icon">${I.warn}</span><div><p><b>${esc(t('fareSample', { route: R.code }))}</b></p></div></div>
      <div class="card" style="margin-top:12px">
        <label class="field"><span>${esc(t('fareFrom'))}</span><select id="fareFrom">${opts(R.stops[0].id)}</select></label>
        <label class="field"><span>${esc(t('fareTo'))}</span><select id="fareTo">${opts(R.stops.slice(-1)[0].id)}</select></label>
        <label class="check"><input type="checkbox" id="fareDisc"> ${esc(t('fareDiscount'))}</label>
        <div class="fare-result" id="fareOut" aria-live="polite"></div>
      </div>`;
  }
  function updateFare() {
    const out = document.getElementById('fareOut');
    if (!out) return;
    const f = S.data.fares, R = fareRoute();
    const a = R.stops.find((s) => s.id === document.getElementById('fareFrom').value), b = R.stops.find((s) => s.id === document.getElementById('fareTo').value);
    const km = Math.abs(a.km - b.km);
    if (!km) { out.innerHTML = `<p class="muted">${esc(t('fareSame'))}</p>`; return; }
    let fare = km <= f.baseKm ? f.baseFare : f.baseFare + (km - f.baseKm) * f.perKm;
    if (document.getElementById('fareDisc').checked) fare *= 1 - f.discountPct / 100;
    fare = Math.round(fare * 4) / 4;
    out.innerHTML = `<div class="muted">${esc(t('fareResult'))} · ${esc(t('fareDistance', { km }))}</div><div class="amt">₱${fare.toFixed(2)}</div>`;
  }

  function viewTerminals() {
    if (!S.data) return '';
    const CROWD = { low: 'good', moderate: 'caution', long: 'stop' };
    const cards = S.data.terminals.map((term) => {
      const s = stopById(term.stopId);
      if (!s) return '';
      const c = S.data.crowd[term.stopId] || { level: 'low' };
      const next = arrivals(s.id).find((x) => x.target);
      const nextText = next ? `${next.u.plate} · ${next.R.code} ${toDest(next.R, next.dir)} · ${fmtTime(next.target)}` : '—';
      const rs = routesAt(s.id);
      return `<div class="card">
        <h2 style="margin:0">${esc(s.name)}</h2><p class="muted small" style="margin:2px 0 6px">${esc(s.area)}</p>
        <div class="here-note" style="margin:0 0 6px">${rs.map(routeChip).join('')}</div>
        <div class="switch-row"><span>${esc(t('crowd'))}</span><span class="badge ${CROWD[c.level]}">${I.person}${esc(t('crowd_' + c.level))}</span></div>
        <div class="switch-row"><span>${esc(t('nextDeparture'))}</span><b style="text-align:right">${esc(nextText)}</b></div>
        <div class="switch-row"><span>${esc(t('hours'))}</span><b>${esc(term.hours)}</b></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
          <a class="btn ghost" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name + ', ' + s.area)}" target="_blank" rel="noopener">${I.map}${esc(t('openMap'))}</a>
          ${term.contact ? `<a class="btn ghost" href="tel:${esc(term.contact.replace(/[^+0-9]/g, ''))}">${esc(t('call'))} · ${esc(term.contact)}</a>` : `<button class="btn ghost" disabled title="${esc(t('contactTbc'))}">${esc(t('contactTbc'))}</button>`}
        </div></div>`;
    }).join('');
    const places = (S.data.places || []).map((p) => `<div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><b>${esc(p.name)}</b><span class="badge neutral">${esc(t('mapUnverified'))}</span></div>
        <p class="muted small" style="margin:4px 0 12px">${esc(p.source)}</p>
        <a class="btn ghost" href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener">${I.map}${esc(t('openMap'))}</a></div>`).join('');
    return `<h1>${esc(t('terminals'))}</h1><div class="stack" style="margin-top:12px">${cards}</div>
      ${places ? `<h2>${esc(t('unverifiedTerminals'))}</h2><div class="banner caution" style="margin-top:0"><span class="icon">${I.warn}</span><div><p>${esc(t('unverifiedNote'))}</p></div></div><div class="stack" style="margin-top:12px">${places}</div>` : ''}`;
  }

  function viewRules() {
    const acc = ['bag', 'cargo', 'pet', 'rights'].map((k) => `<details class="acc"><summary>${esc(t('rule_' + k + '_t'))}</summary><p>${esc(t('rule_' + k + '_b'))}</p></details>`).join('');
    return `<h1>${esc(t('rules'))}</h1><div class="banner caution"><span class="icon">${I.warn}</span><div><p>${esc(t('rulesSample'))}</p></div></div><div style="margin-top:12px">${acc}</div>`;
  }

  let fb = { kind: 'trip', rating: 0 };
  function viewFeedback() {
    const units = S.data ? S.data.units.map((u) => u.plate) : [];
    return `<h1>${esc(t('feedback'))}</h1>
      <form class="card" id="fbForm" style="margin-top:12px" novalidate>
        <fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:6px">${esc(t('fbKind'))}</legend>
          <div class="segmented" style="box-shadow:none;background:var(--surface-2)">
            ${['trip', 'lost', 'idea'].map((k) => `<button type="button" data-fbkind="${k}" aria-pressed="${fb.kind === k}">${esc(t(k === 'trip' ? 'fbTrip' : k === 'lost' ? 'fbLost' : 'fbIdea'))}</button>`).join('')}
          </div></fieldset>
        <div id="fbTripOnly" ${fb.kind === 'trip' ? '' : 'hidden'}>
          <div class="field" style="margin-top:14px;font-weight:600">${esc(t('fbRating'))}</div>
          <div class="stars" role="group" aria-label="${esc(t('fbRating'))}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-pressed="${fb.rating >= n}" aria-label="${n}">★</button>`).join('')}</div>
        </div>
        <label class="field"><span>${esc(t('fbUnit'))}</span><select id="fbUnit"><option value="">${esc(t('fbUnknown'))}</option>${units.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>
        <label class="field"><span>${esc(t('fbText'))}</span><textarea id="fbText" maxlength="500"></textarea></label>
        <p class="small muted">${esc(t('fbPrivacy'))}</p>
        <button class="btn block" type="submit">${esc(t('fbSend'))}</button>
        <p id="fbMsg" class="small" role="status" style="margin-bottom:0"></p>
      </form>`;
  }

  function viewSettings() {
    return `<h1>${esc(t('settings'))}</h1>
      <div class="card" style="margin-top:12px">
        <div class="switch-row"><span>${esc(t('language'))}</span>
          <div class="segmented" style="box-shadow:none;background:var(--surface-2)"><button data-lang="en" aria-pressed="${S.lang === 'en'}">English</button><button data-lang="ceb" aria-pressed="${S.lang === 'ceb'}">Bisaya</button></div></div>
        <label class="switch-row check" style="margin:0"><span>${esc(t('lowData'))}<br><span class="small muted" style="font-weight:400">${esc(t('lowDataHelp'))}</span></span><input type="checkbox" id="setLow" ${S.lowData ? 'checked' : ''}></label>
        <div class="switch-row"><span>${esc(t('textSize'))}</span>
          <div class="segmented" style="box-shadow:none;background:var(--surface-2)"><button data-text="normal" aria-pressed="${!S.textLarge}">${esc(t('normal'))}</button><button data-text="large" aria-pressed="${S.textLarge}">${esc(t('large'))}</button></div></div>
      </div>
      <button class="btn ghost block" style="margin-top:16px" data-action="welcome">${esc(t('showWelcome'))}</button>`;
  }

  function viewAbout() {
    return `<h1>${esc(t('about'))}</h1><div class="card stack" style="margin-top:12px">
      <p style="margin:0">${esc(t('aboutBody1'))}</p>
      <div class="banner caution" style="margin:12px 0 0"><span class="icon">${I.info}</span><div><p><b>${esc(t('aboutBody2'))}</b></p></div></div>
      <div class="banner info" style="margin:12px 0 0"><span class="icon">${I.info}</span><div><p>${esc(t('aboutRoutes'))}</p></div></div>
      <p>${esc(t('aboutBody3'))}</p>
      </div>`;
  }

  function viewWelcome() {
    return `<div class="welcome">
      <div>${logo.replace('width="30" height="30"', 'width="64" height="64"')}</div>
      <span class="pill" style="margin-top:16px;align-self:flex-start">${esc(t('pilotBadge'))}</span>
      <h1>${esc(t('welcomeTitle'))}</h1>
      <p style="font-weight:700;margin-bottom:0">${esc(t('chooseLanguage'))}</p>
      <div class="lang-choice"><button data-lang="en" aria-pressed="${S.lang === 'en'}">English</button><button data-lang="ceb" aria-pressed="${S.lang === 'ceb'}">Bisaya</button></div>
      <button class="btn block" data-action="start">${esc(t('start'))}</button>
      <p class="small" style="margin-top:16px">${esc(t('simulatedNote'))}</p></div>`;
  }

  /* ---------------- Overlays ---------------- */
  function openStopSheet() {
    const opts = allStops().map((s) => `<button class="opt" data-stop="${s.id}" aria-pressed="${s.id === S.stopId}">${s.terminal ? I.van : I.person}<span>${esc(s.name)}<small>${esc(s.area)}</small></span><span class="opt-routes">${routesAt(s.id).map(routeChip).join('')}</span></button>`).join('');
    overlay.innerHTML = `<div class="scrim" data-close="1"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(t('whereWaiting'))}"><div class="grab"></div><h2>${esc(t('whereWaiting'))}</h2><button class="btn ghost block" data-action="locate" style="margin-bottom:8px">${I.locate}${esc(t('locate'))}</button>${opts}</div></div>`;
    overlay.querySelector('.opt[aria-pressed="true"]')?.focus();
  }

  const QUIZ = [1, 2, 3, 4, 5].map((n) => ({ q: 'q' + n, opts: ['a', 'b', 'c'].map((x) => 'q' + n + x), answer: 0 }));
  let quiz = null;
  function openTrivia() {
    quiz = { i: 0, score: 0, picked: null, order: QUIZ.map(() => [0, 1, 2].sort(() => Math.random() - 0.5)) };
    renderTrivia();
  }
  function renderTrivia() {
    if (!quiz) { overlay.innerHTML = ''; return; }
    let body;
    if (quiz.i >= QUIZ.length) {
      body = `<h2>${esc(t('score', { n: quiz.score, t: QUIZ.length }))}</h2><button class="btn block" style="margin-top:16px" data-action="trivia">${esc(t('again'))}</button>`;
    } else {
      const q = QUIZ[quiz.i];
      body = `<p class="small muted" style="margin:0">${quiz.i + 1} / ${QUIZ.length}</p><h2 style="margin-top:4px">${esc(t(q.q))}</h2>` +
        quiz.order[quiz.i].map((oi) => {
          let cls = '';
          if (quiz.picked !== null) { if (oi === q.answer) cls = 'right'; else if (oi === quiz.picked) cls = 'wrong'; }
          return `<button class="quiz-opt ${cls}" data-quiz="${oi}" ${quiz.picked !== null ? 'disabled' : ''}>${esc(t(q.opts[oi]))}</button>`;
        }).join('') +
        (quiz.picked !== null ? `<button class="btn block" style="margin-top:16px" data-action="quizNext">${esc(t('next'))}</button>` : '');
    }
    overlay.innerHTML = `<div class="scrim modal" data-close="1"><div class="box" role="dialog" aria-modal="true" aria-label="${esc(t('trivia'))}">
      <div style="display:flex;align-items:center;justify-content:space-between"><b>${I.game} ${esc(t('trivia'))}</b><button class="btn ghost" data-action="closeOverlay">${esc(t('close'))}</button></div>${body}</div></div>`;
  }

  /* ---------------- Render ---------------- */
  function render() {
    document.documentElement.lang = S.lang === 'ceb' ? 'ceb' : 'en';
    document.documentElement.classList.toggle('text-large', S.textLarge);
    if (!S.welcomed) { root.innerHTML = viewWelcome(); return; }
    const r = route();
    let inner;
    if (r.view === 'trip') inner = viewTrip(r.arg);
    else if (r.view === 'map') inner = viewMap();
    else if (r.view === 'alerts') inner = viewAlerts();
    else if (r.view === 'more') inner = viewMore(r.arg);
    else inner = viewBoard();
    root.innerHTML = shell(inner);
    root.dataset.hasData = S.data ? '1' : '0';
    if (r.view === 'more' && r.arg === 'fares') updateFare();
    if (r.view === 'map' && liveMapReady()) mountMap();
    updateFresh();
  }
  /** Re-render only screens that show live data, so forms are not wiped mid-typing. */
  function renderLive() {
    if (!S.welcomed) return;
    const r = route();
    if (LIVE.includes(r.view)) {
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
    } else if (!root.querySelector('.app') || root.dataset.hasData !== '1') {
      render();
    } else {
      // keep the nav alert count current
      const nav = root.querySelector('.bottomnav');
      if (nav) { const tmp = document.createElement('div'); tmp.innerHTML = shell(''); nav.replaceWith(tmp.querySelector('.bottomnav')); }
    }
  }

  function tick() {
    document.querySelectorAll('[data-target]').forEach((el) => {
      const target = Number(el.dataset.target) || null;
      const u = S.data && S.data.units.find((x) => x.id === el.dataset.unit);
      const cd = countdownHTML(target, u, !!el.dataset.big);
      el.innerHTML = cd.html;
      el.classList.toggle('now', cd.cls === 'now');
      el.classList.toggle('unknown', cd.cls === 'unknown');
    });
    updateFresh();
  }

  /* ---------------- Events ---------------- */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-go],[data-lang],[data-route],[data-trip],[data-action],[data-stop],[data-close],[data-quiz],[data-fbkind],[data-star],[data-text],[data-read],[data-af],[data-ar],[data-share]');
    if (!el) return;
    if (el.dataset.close && e.target !== el) return; // clicks inside a sheet
    const d = el.dataset;
    if (d.go) { overlay.innerHTML = ''; go(d.go); return; }
    if (d.lang) { S.lang = d.lang; store.set('lang', S.lang); render(); if (quiz) renderTrivia(); return; }
    if (d.read) { toggleRead(d.read); render(); return; }
    if (d.ar) { S.alertRoute = d.ar; render(); return; }
    if (d.share) { const n = S.data.notices.find((x) => nkey(x) === d.share); if (n && navigator.share) navigator.share({ title: 'ISBOGI', text: `${n.type === 'custom' ? t('authorOps') : t('authorLive')}: ${noticeText(n)}` }).catch(() => {}); return; }
    if (d.af) { S.alertFilter = d.af; render(); return; }
    if (d.route) { S.route = d.route; store.set('route', S.route); if (M) M.refit = true; render(); return; }
    if (d.trip) { overlay.innerHTML = ''; go('#/trip/' + d.trip); return; }
    if (d.stop) { S.stopId = d.stop; store.set('stopId', S.stopId); overlay.innerHTML = ''; render(); return; }
    if (d.close) { overlay.innerHTML = ''; quiz = null; return; }
    if (d.quiz !== undefined) { quiz.picked = Number(d.quiz); if (quiz.picked === QUIZ[quiz.i].answer) quiz.score++; renderTrivia(); return; }
    if (d.fbkind) { fb.kind = d.fbkind; root.querySelectorAll('[data-fbkind]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.fbkind === fb.kind)); document.getElementById('fbTripOnly').hidden = fb.kind !== 'trip'; return; }
    if (d.star) { fb.rating = Number(d.star); root.querySelectorAll('[data-star]').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.star) <= fb.rating)); return; }
    if (d.text) { S.textLarge = d.text === 'large'; store.set('textLarge', S.textLarge); render(); return; }
    switch (d.action) {
      case 'readAll': markRead(activeNotices().concat(S.data.notices.filter((n) => n.active)).map(nkey)); render(); break;
      case 'toggleEarlier': S.showEarlier = !S.showEarlier; render(); break;
      case 'clearEarlier': S.data.notices.filter((n) => !n.active).forEach((n) => { S.cleared[nkey(n)] = 1; }); store.set('clearedEarlier', S.cleared); S.showEarlier = false; render(); break;
      case 'pickStop': openStopSheet(); break;
      case 'locate': locate(); break;
      case 'retry': poll(); break;
      case 'trivia': openTrivia(); break;
      case 'quizNext': quiz.i++; quiz.picked = null; renderTrivia(); break;
      case 'closeOverlay': overlay.innerHTML = ''; quiz = null; break;
      case 'start': S.welcomed = true; store.set('welcomed', true); go('#/board'); render(); break;
      case 'welcome': S.welcomed = false; store.set('welcomed', false); render(); break;
    }
  });

  document.addEventListener('change', (e) => {
    if (['fareFrom', 'fareTo', 'fareDisc'].includes(e.target.id)) updateFare();
    if (e.target.id === 'setLow') { S.lowData = e.target.checked; store.set('lowData', S.lowData); poll(); }
  });

  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'fbForm') return;
    e.preventDefault();
    const msg = document.getElementById('fbMsg');
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: fb.kind, rating: fb.rating, unit: document.getElementById('fbUnit').value || null, text: document.getElementById('fbText').value, lang: S.lang }),
      });
      if (!res.ok) throw new Error();
      msg.textContent = t('fbThanks'); msg.style.color = 'var(--good)';
      e.target.reset(); fb = { kind: fb.kind, rating: 0 };
      root.querySelectorAll('[data-star]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    } catch {
      msg.textContent = t('fbError'); msg.style.color = 'var(--stop)';
    } finally { btn.disabled = false; }
  });

  document.addEventListener('toggle', (e) => { if (e.target.classList && e.target.classList.contains('conn')) S.connOpen = e.target.open; }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.innerHTML) { overlay.innerHTML = ''; quiz = null; } });
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  window.addEventListener('online', poll);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  /* ---------------- Boot ---------------- */
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { localStorage.removeItem('isbogi:routePath'); localStorage.removeItem('isbogi:dir'); } catch { /* ignore */ }
  render();
  poll();
  loadPaths();
  setInterval(tick, 1000);
})();
