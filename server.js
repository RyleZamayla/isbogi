/*
 * ISBOGI pilot server
 * Zero dependencies — needs Node.js 18 or newer.
 *
 *   node server.js            → http://localhost:3000  (commuter app)
 *                               http://localhost:3000/admin.html  (facilitator panel)
 *
 * Environment variables (optional):
 *   PORT=3000        port to listen on
 *   ADMIN_PIN=123456 PIN for the facilitator panel (random if not set; printed at start)
 *
 * All transit data is SIMULATED. Nothing here reads real GPS.
 * Routes come from data/config.json (route 955 is from the thesis; S1–S3 are sample routes).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const https = require('https');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.jsonl');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
let CONFIG = null;   // data/config.json; reloadable from the facilitator panel

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = String(process.env.ADMIN_PIN || crypto.randomInt(100000, 999999));

/* ------------------------------------------------------------------ */
/* Time helpers (Asia/Manila is UTC+8 all year, no daylight saving)   */
/* ------------------------------------------------------------------ */
const MIN = 60 * 1000;
const TZ_OFFSET = 8 * 60 * MIN;
const dayStart = (ms) => Math.floor((ms + TZ_OFFSET) / (1440 * MIN)) * 1440 * MIN - TZ_OFFSET;
const minuteOfDay = (ms) => (ms - dayStart(ms)) / MIN;
const hhmmToMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

let CAPACITY = 14;

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */
/** Schematic (x, y) for the offline fallback map, from real lat/lng so every route gets a true-shaped sketch. */
function schematic(stops) {
  const lats = stops.map((s) => s.lat), lngs = stops.map((s) => s.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const w = (maxLng - minLng) * kx || 1e-6, h = (maxLat - minLat) || 1e-6;
  const scale = Math.min(290 / w, 240 / h);
  const offX = 40 + (290 - w * scale) / 2, offY = 300 - (240 - h * scale) / 2;
  return stops.map((s) => ({ ...s, x: Math.round(offX + (s.lng - minLng) * kx * scale), y: Math.round(offY - (s.lat - minLat) * scale) }));
}

let ROUTES = [];
let ALL_STOPS = {};
let TERMINAL_IDS = [];
const routeByCode = (code) => ROUTES.find((r) => r.code === code);
const stopName = (id) => (ALL_STOPS[id] || {}).name || id;

/** Build the in-memory routes from a config object. Called at start and after the panel saves changes. */
function applyConfig(cfg) {
  CONFIG = cfg;
  CAPACITY = cfg.fleet.capacity;
  ROUTES = cfg.routes.map((rc) => {
    const stops = schematic(rc.stops);
    const svc = rc.service;
    return {
      code: rc.code, name: rc.name, sample: !!rc.sample, color: rc.color || '#1446A0',
      stops, routeKm: stops[stops.length - 1].km, path: rc.path || [],
      svc, firstMin: hhmmToMin(svc.firstDeparture), lastMin: hhmmToMin(svc.lastDeparture),
      headway: svc.headwayMin * MIN, speedKmPerMs: svc.avgSpeedKmh / 3600000,
      origin: { out: stops[0].id, in: stops[stops.length - 1].id },
      perDir: rc.fleet.unitsPerDirection, prefix: rc.fleet.platePrefix,
      lastDepart: { out: null, in: null },
    };
  });
  ALL_STOPS = {};
  for (const r of ROUTES) for (const s of r.stops) if (!ALL_STOPS[s.id]) ALL_STOPS[s.id] = s;
  TERMINAL_IDS = [...new Set(ROUTES.flatMap((r) => r.stops.filter((s) => s.terminal).map((s) => s.id)))];
}
applyConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));

/** Next scheduled departure slot at or after `fromMs`, or null if service is over for that day. */
function nextSlotAt(R, fromMs) {
  const start = dayStart(fromMs);
  const m = (fromMs - start) / MIN;
  const k = Math.max(0, Math.ceil((m - R.firstMin) / R.svc.headwayMin - 1e-9));
  const slotMin = R.firstMin + k * R.svc.headwayMin;
  if (slotMin > R.lastMin) return null;
  return start + slotMin * MIN;
}
function lastSlotOfDay(R, ms) {
  const k = Math.floor((R.lastMin - R.firstMin) / R.svc.headwayMin);
  return dayStart(ms) + (R.firstMin + k * R.svc.headwayMin) * MIN;
}
function firstSlotNextService(R, ms) {
  const m = minuteOfDay(ms);
  const base = m <= R.lastMin ? dayStart(ms) : dayStart(ms) + 1440 * MIN;
  return base + R.firstMin * MIN;
}

/** Stop position in a unit's own direction of travel (km from its origin terminal). */
const stopProgress = (R, stop, dir) => (dir === 'out' ? stop.km : R.routeKm - stop.km);

/* ------------------------------------------------------------------ */
/* Seeded random numbers so every reset plays out the same way        */
/* ------------------------------------------------------------------ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(955);
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

/* ------------------------------------------------------------------ */
/* Simulation state                                                   */
/* ------------------------------------------------------------------ */
const sim = {
  now: Date.now(),
  speed: 1,
  units: [],          // every van on every route; ids are unique across routes
  notices: [],
  log: [],
  crowd: {},
  blackoutUntil: 0,
  scenario: 'live',
  version: 0,
};
let noticeSeq = 1;
const unitsOf = (R) => sim.units.filter((u) => u.route === R.code);

function makeSeatMap(occupied) {
  const map = new Array(CAPACITY).fill(false);
  const order = [...map.keys()].sort(() => rand() - 0.5);
  for (let i = 0; i < Math.min(occupied, CAPACITY); i++) map[order[i]] = true;
  return map;
}
const occupiedOf = (u) => u.seatMap.filter(Boolean).length;
function boardOne(u) {
  const free = u.seatMap.map((t, i) => (t ? -1 : i)).filter((i) => i >= 0);
  if (!free.length) return false;
  u.seatMap[free[randInt(0, free.length - 1)]] = true;
  return true;
}
function alightOne(u) {
  const taken = u.seatMap.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
  if (!taken.length) return false;
  u.seatMap[taken[randInt(0, taken.length - 1)]] = false;
  return true;
}

function log(msg) {
  sim.log.unshift({ at: sim.now, msg });
  sim.log.length = Math.min(sim.log.length, 60);
}

function addNotice(n) {
  const notice = { id: noticeSeq++, at: sim.now, active: true, route: null, ...n };
  sim.notices.unshift(notice);
  sim.notices.length = Math.min(sim.notices.length, 30);
  return notice;
}
function closeNoticesFor(unitId) {
  sim.notices.forEach((n) => { if (n.unitId === unitId && n.active) n.active = false; });
}

/** Build every route's fleet: per direction one boarding, one queued, the rest on the road. */
function initFleet() {
  rand = mulberry32(955);
  sim.units = [];
  sim.crowd = {};
  const plateCount = {};
  for (const R of ROUTES) {
    const fractions = R.perDir >= 6 ? [0.13, 0.4, 0.67, 0.89] : [0.3, 0.65];
    const roadPositions = fractions.map((f) => Math.round(f * R.routeKm * 10) / 10);
    for (const dir of ['out', 'in']) {
      for (let k = 0; k < R.perDir; k++) {
        plateCount[R.prefix] = (plateCount[R.prefix] || 0) + 1; // routes sharing a prefix share one running fleet number
        const plate = `${R.prefix}-${String(plateCount[R.prefix]).padStart(2, '0')}`;
        const u = {
          id: plate, plate, route: R.code, dir, state: 'queued', p: 0,
          seatMap: makeSeatMap(0), departAt: null, queuedAt: sim.now - (10 - k) * MIN,
          holdUntil: 0, holdReason: null, holdMinutes: 0,
          breakdown: false, breakdownReason: null, layoverUntil: 0, pace: 1,
        };
        if (k === 0) { u.state = 'boarding'; u.seatMap = makeSeatMap(randInt(3, 7)); }
        else if (k >= 2 && k - 2 < roadPositions.length) {
          u.state = 'enroute';
          u.p = roadPositions[k - 2];
          u.seatMap = makeSeatMap(randInt(6, 13));
        }
        sim.units.push(u);
      }
    }
    R.lastDepart = { out: null, in: null };
  }
  realignBoarding();
  for (const id of TERMINAL_IDS) sim.crowd[id] = 12;
}

function realignBoarding() {
  for (const R of ROUTES) {
    for (const dir of ['out', 'in']) {
      const b = unitsOf(R).find((u) => u.dir === dir && u.state === 'boarding');
      if (!b) continue;
      const slot = nextSlotAt(R, sim.now);
      if (slot === null) {
        b.state = 'queued'; b.departAt = null; b.queuedAt = sim.now - 60 * MIN;
      } else {
        b.departAt = slot;
      }
      R.lastDepart[dir] = slot === null ? null : slot - R.headway;
    }
  }
}

function hourFactor(ms) {
  const h = minuteOfDay(ms) / 60;
  return (h >= 6 && h < 8.5) || (h >= 16 && h < 18.5) ? 1.6 : 1;
}

/** Advance the simulation by dt milliseconds of simulated time. */
function step(dt) {
  sim.now += dt;
  const dtSec = dt / 1000;

  for (const R of ROUTES) {
    const mine = unitsOf(R);
    for (const dir of ['out', 'in']) {
      let boarding = mine.find((u) => u.dir === dir && u.state === 'boarding');
      if (!boarding) {
        const queue = mine.filter((u) => u.dir === dir && u.state === 'queued').sort((a, b) => a.queuedAt - b.queuedAt);
        const last = R.lastDepart[dir] && R.lastDepart[dir] <= sim.now ? R.lastDepart[dir] : null; // ignore after a backwards clock jump
        const from = Math.max(sim.now, last ? last + R.headway : 0);
        const slot = nextSlotAt(R, from);
        if (queue.length && slot !== null) {
          boarding = queue[0];
          boarding.state = 'boarding';
          boarding.departAt = slot;
        }
      }
      if (boarding) {
        if (boarding.departAt !== null && sim.now >= boarding.departAt) {
          boarding.state = 'enroute';
          boarding.p = 0;
          R.lastDepart[dir] = boarding.departAt;
          const term = R.origin[dir];
          sim.crowd[term] = Math.max(0, (sim.crowd[term] || 0) - occupiedOf(boarding));
          log(`${boarding.plate} left ${stopName(term)} with ${occupiedOf(boarding)}/${CAPACITY} seated`);
        } else {
          const rate = (hourFactor(sim.now) / 75) * dtSec;
          let n = Math.floor(rate) + (rand() < rate % 1 ? 1 : 0);
          while (n-- > 0) boardOne(boarding);
        }
      }
    }

    for (const u of mine) {
      if (u.state === 'layover' && sim.now >= u.layoverUntil) {
        u.state = 'queued';
        u.queuedAt = sim.now;
      }
      if (u.state !== 'enroute') continue;
      if (u.breakdown || u.holdUntil > sim.now) continue;
      if (u.holdUntil && u.holdUntil <= sim.now) {
        u.holdUntil = 0;
        if (u.holdReason) {
          closeNoticesFor(u.id);
          addNotice({ type: 'resolved', severity: 'good', unitId: u.id, route: R.code, dir: u.dir, reason: u.holdReason });
          log(`${u.plate} moving again`);
        }
        u.holdReason = null; u.holdMinutes = 0;
      }
      u.pace += (rand() - 0.5) * 0.02;
      u.pace = Math.min(1.12, Math.max(0.9, u.pace));
      const before = u.p;
      u.p += R.speedKmPerMs * dt * u.pace;
      for (const s of R.stops) {
        if (s.terminal) continue;
        const sp = stopProgress(R, s, u.dir);
        if (before < sp && u.p >= sp) {
          let off = randInt(0, Math.min(3, occupiedOf(u)));
          while (off-- > 0) alightOne(u);
          let on = randInt(0, 3);
          while (on-- > 0) boardOne(u);
        }
      }
      if (u.p >= R.routeKm) {
        const dest = u.dir === 'out' ? R.origin.in : R.origin.out;
        log(`${u.plate} arrived at ${stopName(dest)}`);
        u.state = 'layover';
        u.layoverUntil = sim.now + R.svc.layoverMin * MIN;
        u.dir = u.dir === 'out' ? 'in' : 'out';
        u.p = 0;
        u.seatMap = makeSeatMap(0);
        u.pace = 1;
      }
    }
  }

  for (const id of Object.keys(sim.crowd)) {
    const target = 12 * hourFactor(sim.now) * 1.4;
    sim.crowd[id] += (target - sim.crowd[id]) * 0.004 * dtSec + (rand() - 0.5) * 0.2 * Math.sqrt(dtSec);
    sim.crowd[id] = Math.max(0, sim.crowd[id]);
  }
  sim.version++;
}

/* ------------------------------------------------------------------ */
/* Derived, client-facing state                                       */
/* ------------------------------------------------------------------ */
function etasFor(R, u, queueIndex, boardingDepart) {
  const eta = {};
  let t0 = null;
  let startP = 0;
  if (u.state === 'enroute') {
    if (u.breakdown) return { eta: null, departAt: null };
    t0 = sim.now + Math.max(0, u.holdUntil - sim.now);
    startP = u.p;
  } else if (u.state === 'boarding') {
    t0 = u.departAt;
  } else if (u.state === 'queued') {
    const base = boardingDepart || nextSlotAt(R, sim.now);
    if (base === null) return { eta: null, departAt: null };
    const est = base + (queueIndex + (boardingDepart ? 1 : 0)) * R.headway;
    if (minuteOfDay(est) > R.lastMin || dayStart(est) !== dayStart(base)) return { eta: null, departAt: null };
    t0 = est;
  } else {
    return { eta: null, departAt: null };
  }
  if (t0 === null) return { eta: null, departAt: null };
  for (const s of R.stops) {
    const sp = stopProgress(R, s, u.dir);
    if (sp + 1e-6 < startP) continue;
    if (sp === 0 && u.state === 'enroute') continue;
    eta[s.id] = Math.round(t0 + (sp - startP) / R.speedKmPerMs);
  }
  return { eta, departAt: u.state === 'enroute' ? null : t0 };
}

function unitStatus(u) {
  if (u.breakdown) return 'stopped';
  if (u.holdUntil > sim.now) return 'delayed';
  if (u.state === 'boarding' && u.departAt && u.departAt - sim.now <= 3 * MIN) return 'boarding_now';
  if (u.state === 'boarding') return 'boarding';
  if (u.state === 'queued') return 'scheduled';
  if (u.state === 'layover') return 'layover';
  return 'on_time';
}

function seatStatus(free) {
  if (free <= 0) return 'full';
  if (free <= 4) return 'few';
  return 'many';
}

function crowdLevel(n) {
  if (n < 10) return 'low';
  if (n < 22) return 'moderate';
  return 'long';
}

function publicState() {
  const units = [];
  const routes = ROUTES.map((R) => {
    const mine = unitsOf(R);
    const boardingDepart = {};
    const queueIdx = {};
    for (const dir of ['out', 'in']) {
      const b = mine.find((u) => u.dir === dir && u.state === 'boarding');
      boardingDepart[dir] = b ? b.departAt : null;
      mine.filter((u) => u.dir === dir && u.state === 'queued').sort((a, b2) => a.queuedAt - b2.queuedAt)
        .forEach((u, i) => { queueIdx[u.id] = i; });
    }
    for (const u of mine) {
      const occupied = occupiedOf(u);
      const free = CAPACITY - occupied;
      const { eta, departAt } = etasFor(R, u, queueIdx[u.id] || 0, boardingDepart[u.dir]);
      units.push({
        id: u.id, plate: u.plate, route: R.code, dir: u.dir, state: u.state,
        p: +u.p.toFixed(3),
        absKm: +(u.dir === 'out' ? u.p : R.routeKm - u.p).toFixed(3),
        seatMap: u.seatMap, occupied, free, seatStatus: seatStatus(free),
        status: unitStatus(u), departAt, eta,
        holdUntil: u.holdUntil > sim.now ? u.holdUntil : null,
        holdReason: u.holdUntil > sim.now ? u.holdReason : null,
        holdMinutes: u.holdUntil > sim.now ? u.holdMinutes : 0,
        breakdownReason: u.breakdown ? u.breakdownReason : null,
      });
    }
    const service = {};
    for (const dir of ['out', 'in']) {
      const lastSlot = lastSlotOfDay(R, sim.now);
      const over = nextSlotAt(R, sim.now) === null && !mine.some((u) => u.dir === dir && u.state === 'boarding');
      service[dir] = {
        lastDepartureAt: lastSlot,
        serviceOver: over,
        resumesAt: over ? firstSlotNextService(R, sim.now) : null,
        lastTripSoon: !over && lastSlot - sim.now <= 60 * MIN && lastSlot >= sim.now,
      };
    }
    return {
      code: R.code, name: R.name, sample: R.sample, color: R.color, lengthKm: R.routeKm, stops: R.stops,
      service: { ...service, headwayMin: R.svc.headwayMin, firstDeparture: R.svc.firstDeparture, lastDeparture: R.svc.lastDeparture, avgSpeedKmh: R.svc.avgSpeedKmh },
    };
  });
  const crowd = {};
  for (const [id, n] of Object.entries(sim.crowd)) crowd[id] = { count: Math.round(n), level: crowdLevel(n) };
  return {
    simNow: sim.now,
    serverNow: Date.now(),
    speed: sim.speed,
    version: sim.version,
    scenario: sim.scenario,
    capacity: CAPACITY,
    routes,
    units,
    notices: sim.notices.slice(0, 20),
    crowd,
    theme: CONFIG.theme || null,
    terminals: CONFIG.terminals,
    places: CONFIG.unverifiedPlaces || [],
    connections: CONFIG.connections || {},
    features: CONFIG.features,
    fares: CONFIG.features.fares ? CONFIG.fares : null,
  };
}

/* ------------------------------------------------------------------ */
/* Facilitator actions and scenarios                                  */
/* ------------------------------------------------------------------ */
function setClock(hhmm) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) throw new Error('Time must be HH:MM');
  sim.now = dayStart(sim.now) + hhmmToMin(hhmm) * MIN;
  for (const R of ROUTES) R.lastDepart = { out: null, in: null };
  realignBoarding();
  log(`Clock set to ${hhmm}`);
}

function findUnit(id) {
  const u = sim.units.find((x) => x.id === id);
  if (!u) throw new Error(`No unit ${id}`);
  return u;
}

/** The en-route unit on route R in `dir` that will reach `stopId` next. */
function nextUnitTo(R, dir, stopId) {
  const sp = stopProgress(R, R.stops.find((s) => s.id === stopId), dir);
  return unitsOf(R)
    .filter((u) => u.dir === dir && u.state === 'enroute' && u.p < sp)
    .sort((a, b) => b.p - a.p)[0];
}

function resetSim() {
  sim.speed = 1;
  sim.notices = [];
  sim.log = [];
  sim.blackoutUntil = 0;
  sim.now = Date.now();
  noticeSeq = 1;
  initFleet();
  sim.scenario = 'live';
  log('Simulation reset');
}

// Scenarios T1–T6 run on the first route (955), as in the test plan.
const SCENARIOS = {
  T1() { resetSim(); setClock('07:07'); const b = unitsOf(ROUTES[0]).find((u) => u.dir === 'out' && u.state === 'boarding'); b.seatMap = makeSeatMap(10); },
  T2() { resetSim(); setClock('07:20'); },
  T3() {
    resetSim(); setClock('07:20');
    const u = nextUnitTo(ROUTES[0], 'out', 'villanueva');
    if (u) doAction({ action: 'breakdown', unitId: u.id, reason: 'engine' });
  },
  T4() {
    resetSim(); setClock('07:26');
    const b = unitsOf(ROUTES[0]).find((u) => u.dir === 'out' && u.state === 'boarding');
    b.seatMap = makeSeatMap(CAPACITY);
  },
  T5() { sim.blackoutUntil = Date.now() + 90 * 1000; log('Signal loss for 90 s'); },
  T6() { resetSim(); setClock('18:40'); },
};

function doAction(body) {
  const a = body.action;
  switch (a) {
    case 'delay': {
      const u = findUnit(body.unitId);
      const minutes = Math.max(1, Math.min(120, Number(body.minutes) || 10));
      if (u.state !== 'enroute') throw new Error('Only a unit on the road can be delayed');
      u.holdUntil = Math.max(u.holdUntil, sim.now) + minutes * MIN;
      u.holdMinutes += minutes;
      u.holdReason = body.reason || 'traffic';
      closeNoticesFor(u.id);
      addNotice({ type: 'delay', severity: 'caution', unitId: u.id, route: u.route, dir: u.dir, reason: u.holdReason, minutes: u.holdMinutes });
      log(`${u.plate} delayed ${minutes} min (${u.holdReason})`);
      break;
    }
    case 'breakdown': {
      const u = findUnit(body.unitId);
      if (u.state !== 'enroute') throw new Error('Only a unit on the road can break down');
      u.breakdown = true;
      u.breakdownReason = body.reason || 'engine';
      closeNoticesFor(u.id);
      addNotice({ type: 'breakdown', severity: 'stop', unitId: u.id, route: u.route, dir: u.dir, reason: u.breakdownReason });
      log(`${u.plate} stopped (${u.breakdownReason})`);
      break;
    }
    case 'resolve': {
      const u = findUnit(body.unitId);
      const had = u.breakdown || u.holdUntil > sim.now;
      u.breakdown = false; u.breakdownReason = null; u.holdUntil = 0; u.holdReason = null; u.holdMinutes = 0;
      closeNoticesFor(u.id);
      if (had) addNotice({ type: 'resolved', severity: 'good', unitId: u.id, route: u.route, dir: u.dir });
      log(`${u.plate} back to normal`);
      break;
    }
    case 'setSeats': {
      const u = findUnit(body.unitId);
      const n = Math.max(0, Math.min(CAPACITY, Number(body.occupied)));
      u.seatMap = makeSeatMap(n);
      log(`${u.plate} seats set to ${n}/${CAPACITY}`);
      break;
    }
    case 'departNow': {
      const u = findUnit(body.unitId);
      if (u.state !== 'boarding') throw new Error('Unit is not boarding');
      u.departAt = sim.now;
      break;
    }
    case 'notice': {
      const en = String(body.en || '').slice(0, 200).trim();
      const ceb = String(body.ceb || '').slice(0, 200).trim();
      if (!en && !ceb) throw new Error('Notice text is empty');
      const route = body.route && routeByCode(String(body.route)) ? String(body.route) : null;
      addNotice({ type: 'custom', severity: ['info', 'caution', 'stop', 'good'].includes(body.severity) ? body.severity : 'info', en, ceb: ceb || en, route });
      log('Notice posted');
      break;
    }
    case 'clearNotice': {
      const n = sim.notices.find((x) => x.id === Number(body.id));
      if (n) n.active = false;
      break;
    }
    case 'clock': setClock(String(body.time)); break;
    case 'speed': {
      const s = Number(body.speed);
      if (![1, 2, 5, 10, 30].includes(s)) throw new Error('Speed must be 1, 2, 5, 10 or 30');
      sim.speed = s; log(`Speed ${s}×`); break;
    }
    case 'blackout': {
      const secs = Math.max(0, Math.min(600, Number(body.seconds) || 0));
      sim.blackoutUntil = secs ? Date.now() + secs * 1000 : 0;
      log(secs ? `Signal loss for ${secs} s` : 'Signal restored');
      break;
    }
    case 'scenario': {
      const fn = SCENARIOS[body.scenario];
      if (!fn) throw new Error('Unknown scenario');
      fn();
      sim.scenario = body.scenario;
      log(`Scenario ${body.scenario} loaded`);
      break;
    }
    case 'reset': resetSim(); break;
    default: throw new Error('Unknown action');
  }
  sim.version++;
}

/* ------------------------------------------------------------------ */
/* Config editing (facilitator panel)                                 */
/* ------------------------------------------------------------------ */
const THEME_KEYS = ['primary', 'accent', 'ink', 'inkMuted', 'good', 'caution', 'stop', 'neutral'];

/** Validate and copy only the known fields of a config sent by the panel. Throws a plain-language Error. */
function sanitizeConfig(input, current) {
  const bad = (m) => { throw new Error(m); };
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max, name, optional) => {
    if (v == null || v === '') { if (optional) return ''; bad(`${name} is required`); }
    if (typeof v !== 'string' || v.trim().length > max) bad(`${name} must be text up to ${max} characters`);
    return v.trim();
  };
  const num = (v, lo, hi, name) => { const n = Number(v); if (v === '' || v == null || !Number.isFinite(n) || n < lo || n > hi) bad(`${name} must be a number from ${lo} to ${hi}`); return n; };
  const int = (v, lo, hi, name) => Math.round(num(v, lo, hi, name));
  const hex = (v, name) => { if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) bad(`${name} must be a colour like #1446A0`); return v.toUpperCase(); };
  const hhmm = (v, name) => { if (typeof v !== 'string' || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) bad(`${name} must be a time like 05:30`); return v.padStart(5, '0'); };
  const slug = (v, name) => { if (typeof v !== 'string' || !/^[a-z0-9-]{1,24}$/.test(v)) bad(`${name} must be 1–24 lowercase letters, digits or dashes`); return v; };

  if (!isObj(input)) bad('Config is missing');
  if (!Array.isArray(input.routes) || input.routes.length < 1 || input.routes.length > 8) bad('Keep between 1 and 8 routes');
  const codes = new Set();
  const routes = input.routes.map((r, ri) => {
    if (!isObj(r)) bad(`Route ${ri + 1} is invalid`);
    if (typeof r.code !== 'string' || !/^[A-Za-z0-9-]{1,6}$/.test(r.code)) bad(`Route ${ri + 1}: code must be 1–6 letters, digits or dashes`);
    if (codes.has(r.code)) bad(`Route code ${r.code} is used twice`);
    codes.add(r.code);
    const tag = `Route ${r.code}`;
    if (!isObj(r.service) || !isObj(r.fleet)) bad(`${tag}: schedule and fleet are required`);
    const first = hhmm(r.service.firstDeparture, `${tag} first departure`), last = hhmm(r.service.lastDeparture, `${tag} last departure`);
    if (first >= last) bad(`${tag}: last departure must be after the first`);
    if (!Array.isArray(r.stops) || r.stops.length < 2 || r.stops.length > 20) bad(`${tag}: needs 2 to 20 stops`);
    const ids = new Set();
    let prevKm = -1;
    const stops = r.stops.map((s, si) => {
      if (!isObj(s)) bad(`${tag}: stop ${si + 1} is invalid`);
      const id = slug(s.id, `${tag} stop ${si + 1} id`);
      if (ids.has(id)) bad(`${tag}: stop id ${id} is used twice`);
      ids.add(id);
      const km = si === 0 ? 0 : num(s.km, 0, 500, `${tag} stop ${si + 1} distance`);
      if (km <= prevKm) bad(`${tag}: distances must increase along the route (check stop ${si + 1})`);
      prevKm = km;
      return {
        id, name: str(s.name, 60, `${tag} stop ${si + 1} name`), area: str(s.area, 60, `${tag} stop ${si + 1} area`, true),
        km: Math.round(km * 10) / 10, terminal: !!s.terminal,
        lat: num(s.lat, -90, 90, `${tag} stop ${si + 1} latitude`), lng: num(s.lng, -180, 180, `${tag} stop ${si + 1} longitude`),
        pathIdx: Number.isInteger(s.pathIdx) ? s.pathIdx : 0,
      };
    });
    const old = (current && current.routes.find((x) => x.code === r.code)) || null;
    let rpath = old ? old.path : [];
    if (Array.isArray(r.path)) {
      if (r.path.length > 3000 || !r.path.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) bad(`${tag}: road path is invalid`);
      rpath = r.path;
    }
    return {
      code: r.code, name: str(r.name, 60, `${tag} name`), sample: !!r.sample, color: hex(r.color, `${tag} colour`),
      fleet: { unitsPerDirection: int(r.fleet.unitsPerDirection, 2, 10, `${tag} vans per direction`), platePrefix: str(String(r.fleet.platePrefix || '').toUpperCase(), 4, `${tag} plate prefix`) },
      service: { firstDeparture: first, lastDeparture: last, headwayMin: int(r.service.headwayMin, 5, 120, `${tag} headway`), layoverMin: int(r.service.layoverMin, 0, 60, `${tag} layover`), avgSpeedKmh: int(r.service.avgSpeedKmh, 10, 120, `${tag} average speed`) },
      stops, path: rpath,
    };
  });
  for (const r of routes) if (!/^[A-Z0-9]{1,4}$/.test(r.fleet.platePrefix)) bad(`Route ${r.code}: plate prefix must be 1–4 letters or digits`);
  const stopIds = new Set(routes.flatMap((r) => r.stops.map((s) => s.id)));

  if (!isObj(input.fleet)) bad('Seat capacity is missing');
  const fleet = { capacity: int(input.fleet.capacity, 4, 20, 'Seat capacity') };

  const terminals = (Array.isArray(input.terminals) ? input.terminals : []).slice(0, 20).map((t, i) => {
    if (!isObj(t) || !stopIds.has(t.stopId)) bad(`Terminal ${i + 1}: choose a stop that exists on a route`);
    const contact = t.contact == null || t.contact === '' ? null : str(String(t.contact), 30, `Terminal ${i + 1} contact`);
    if (contact && !/^[+0-9() -]+$/.test(contact)) bad(`Terminal ${i + 1}: contact can only have digits, spaces, + ( ) -`);
    return { stopId: t.stopId, hours: str(t.hours, 60, `Terminal ${i + 1} hours`, true), contact, notes: str(t.notes, 80, `Terminal ${i + 1} notes`, true) };
  });

  const connections = { _note: (input.connections && typeof input.connections._note === 'string') ? input.connections._note.slice(0, 300) : '' };
  if (isObj(input.connections)) for (const [sid, list] of Object.entries(input.connections)) {
    if (sid === '_note') continue;
    if (!stopIds.has(sid) || !Array.isArray(list)) bad(`Other-operator routes: "${sid}" is not a stop on any route`);
    connections[sid] = list.slice(0, 12).map((c, i) => {
      if (!isObj(c)) bad(`Other-operator route ${i + 1} is invalid`);
      const o = { name: str(c.name, 80, 'Other-operator route name'), mode: str(c.mode, 30, 'Other-operator mode', true), source: str(c.source, 40, 'Other-operator source', true) };
      if (c.operator) o.operator = str(c.operator, 60, 'Other-operator operator', true);
      if (c.ref) o.ref = str(c.ref, 12, 'Other-operator ref', true);
      return o;
    });
  }

  const pids = new Set();
  const unverifiedPlaces = (Array.isArray(input.unverifiedPlaces) ? input.unverifiedPlaces : []).slice(0, 20).map((p, i) => {
    if (!isObj(p)) bad(`Unverified place ${i + 1} is invalid`);
    const id = slug(p.id, `Unverified place ${i + 1} id`);
    if (pids.has(id)) bad(`Unverified place id ${id} is used twice`);
    pids.add(id);
    return { id, name: str(p.name, 60, `Unverified place ${i + 1} name`), lat: num(p.lat, -90, 90, `Unverified place ${i + 1} latitude`), lng: num(p.lng, -180, 180, `Unverified place ${i + 1} longitude`), source: str(p.source, 40, `Unverified place ${i + 1} source`, true) };
  });

  const features = { fares: !!(input.features && input.features.fares), arcade: !!(input.features && input.features.arcade) };
  const f = input.fares || {};
  const fares = {
    _note: str(f._note, 200, 'Fare note', true), currency: 'PHP',
    baseKm: num(f.baseKm, 0, 100, 'Fare base distance'), baseFare: num(f.baseFare, 0, 1000, 'Base fare'),
    perKm: num(f.perKm, 0, 100, 'Fare per km'), discountPct: num(f.discountPct, 0, 100, 'Discount %'),
  };

  const theme = {};
  if (isObj(input.theme)) for (const k of THEME_KEYS) if (input.theme[k] != null) theme[k] = hex(input.theme[k], `Theme ${k}`);

  return {
    _note: typeof input._note === 'string' ? input._note.slice(0, 1200) : (current ? current._note : ''),
    routes, fleet, terminals, connections, unverifiedPlaces, features, fares,
    ...(Object.keys(theme).length ? { theme } : {}),
  };
}

/** The parts of the config that change the simulated fleet; if they differ, the simulation restarts. */
function simFingerprint(cfg) {
  return JSON.stringify({
    cap: cfg.fleet.capacity,
    routes: cfg.routes.map((r) => ({ c: r.code, f: r.fleet, s: r.service, st: r.stops.map((s) => [s.id, s.km, s.terminal]) })),
  });
}

/** Nearest road-path vertex for each stop, never going backwards along the route. */
function snapPathIdx(route) {
  const pts = route.path || [];
  if (pts.length < 2) { route.stops.forEach((s) => { s.pathIdx = 0; }); return; }
  let from = 0;
  route.stops.forEach((s, i) => {
    let best = from, bd = Infinity;
    for (let j = from; j < pts.length; j++) {
      const d = (pts[j][0] - s.lat) ** 2 + (pts[j][1] - s.lng) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    if (i === route.stops.length - 1) best = Math.max(best, from);
    s.pathIdx = best; from = best;
  });
}

function saveConfigFile(cfg) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(CONFIG_FILE, path.join(BACKUP_DIR, `config-${stamp}.json`));
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^config-.*\.json$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 10))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
  const text = JSON.stringify(cfg, null, 2).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]') + '\n';
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, CONFIG_FILE);
}

function httpsJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'isbogi-thesis-pilot/0.1 (research)', Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(new Error('Response too large')); });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('The map service sent an unreadable answer')); } });
    });
    req.on('timeout', () => req.destroy(new Error('The map service took too long')));
    req.on('error', (e) => reject(new Error(`Could not reach the map service (${e.message}). Check the internet connection.`)));
  });
}

function douglasPeucker(pts, eps) {
  if (pts.length < 3) return pts;
  const [x1, y1] = pts[0], [x2, y2] = pts[pts.length - 1];
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1e-12;
  let md = 0, mi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / L;
    if (d > md) { md = d; mi = i; }
  }
  if (md > eps) return douglasPeucker(pts.slice(0, mi + 1), eps).slice(0, -1).concat(douglasPeucker(pts.slice(mi), eps));
  return [pts[0], pts[pts.length - 1]];
}

/** Ask OSRM (OpenStreetMap data) for the road through a route's stops and store the simplified path. */
async function rerouteRoute(code, recomputeKm) {
  const R = CONFIG.routes.find((r) => r.code === code);
  if (!R) throw new Error(`No route ${code}`);
  const coords = R.stops.map((s) => `${s.lng},${s.lat}`).join(';');
  const d = await httpsJson(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
  if (d.code !== 'Ok' || !d.routes || !d.routes[0]) throw new Error(`The map service found no road through these stops (${d.code || 'no answer'}). Check that every stop is on or near a road.`);
  const full = d.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  let from = 0;
  const idx = R.stops.map((s) => {
    let best = from, bd = Infinity;
    for (let j = from; j < full.length; j++) { const e = (full[j][0] - s.lat) ** 2 + (full[j][1] - s.lng) ** 2; if (e < bd) { bd = e; best = j; } }
    from = best; return best;
  });
  const out = [];
  for (let i = 0; i < idx.length - 1; i++) {
    const seg = douglasPeucker(full.slice(idx[i], idx[i + 1] + 1), 0.0001);
    out.push(...(i ? seg.slice(1) : seg));
  }
  R.path = out.map(([la, lo]) => [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5]);
  if (recomputeKm) {
    let tot = 0;
    d.routes[0].legs.forEach((leg, i) => { tot += leg.distance / 1000; R.stops[i + 1].km = Math.round(tot * 10) / 10; });
    R.stops[0].km = 0;
  }
  snapPathIdx(R);
  return { km: R.stops[R.stops.length - 1].km, points: R.path.length };
}

let lastGeocodeAt = 0;
async function geocode(q) {
  const wait = 1100 - (Date.now() - lastGeocodeAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeAt = Date.now();
  const d = await httpsJson(`https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=ph&q=${encodeURIComponent(q)}`);
  return (Array.isArray(d) ? d : []).map((r) => ({ name: String(r.display_name || '').split(',')[0], display: String(r.display_name || '').slice(0, 140), lat: Number(r.lat), lng: Number(r.lon) }));
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

function send(req, res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...extra };
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  if (/gzip/.test(req.headers['accept-encoding'] || '') && buf.length > 1024 && /text|json|javascript|svg/.test(type)) {
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
}

function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

const isAdmin = (req) => req.headers['x-admin-pin'] === ADMIN_PIN;
let lastFeedbackAt = 0;

async function handleApi(req, res, url) {
  if (url.pathname === '/api/state' && req.method === 'GET') {
    if (sim.blackoutUntil > Date.now() && !isAdmin(req)) return send(req, res, 503, { error: 'signal_lost' });
    const state = publicState();
    if (isAdmin(req)) state.admin = { blackoutUntil: sim.blackoutUntil > Date.now() ? sim.blackoutUntil : null, log: sim.log };
    return send(req, res, 200, state);
  }
  if (url.pathname === '/api/route' && req.method === 'GET') {
    const paths = {};
    for (const R of ROUTES) paths[R.code] = R.path;
    return send(req, res, 200, { paths }, undefined, { 'Cache-Control': 'public, max-age=3600' });
  }
  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    if (Date.now() - lastFeedbackAt < 1500) return send(req, res, 429, { error: 'Too many submissions, try again' });
    const b = await readBody(req);
    const kind = ['trip', 'lost', 'idea'].includes(b.kind) ? b.kind : null;
    if (!kind) return send(req, res, 400, { error: 'kind is required' });
    const entry = {
      at: new Date().toISOString(), kind,
      rating: kind === 'trip' ? Math.max(1, Math.min(5, Number(b.rating) || 0)) || null : null,
      unit: typeof b.unit === 'string' ? b.unit.slice(0, 10) : null,
      text: String(b.text || '').slice(0, 500),
      lang: b.lang === 'ceb' ? 'ceb' : 'en',
      scenario: sim.scenario,
    };
    fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
    lastFeedbackAt = Date.now();
    return send(req, res, 201, { ok: true });
  }
  if (url.pathname === '/api/admin/check' && req.method === 'POST') {
    return isAdmin(req) ? send(req, res, 200, { ok: true }) : send(req, res, 401, { error: 'Wrong PIN' });
  }
  if (url.pathname === '/api/admin/feedback' && req.method === 'GET') {
    if (!isAdmin(req)) return send(req, res, 401, { error: 'Wrong PIN' });
    const rows = fs.existsSync(FEEDBACK_FILE)
      ? fs.readFileSync(FEEDBACK_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).reverse()
      : [];
    return send(req, res, 200, rows);
  }
  if (url.pathname === '/api/admin/config' && req.method === 'GET') {
    if (!isAdmin(req)) return send(req, res, 401, { error: 'Wrong PIN' });
    const config = { ...CONFIG, routes: CONFIG.routes.map((r) => ({ ...r, path: undefined, pathPoints: (r.path || []).length })) };
    return send(req, res, 200, { config, themeKeys: THEME_KEYS });
  }
  if (url.pathname === '/api/admin/config' && req.method === 'POST') {
    if (!isAdmin(req)) return send(req, res, 401, { error: 'Wrong PIN' });
    const b = await readBody(req, 400000);
    const next = sanitizeConfig(b.config, CONFIG);
    const simChanged = simFingerprint(next) !== simFingerprint(CONFIG);
    next.routes.forEach(snapPathIdx);
    const warnings = [];
    for (const r of next.routes) {
      if (!r.path || r.path.length < 2) {
        try {
          const keep = CONFIG; CONFIG = next; // rerouteRoute reads CONFIG
          try { await rerouteRoute(r.code, true); } finally { CONFIG = keep; }
        } catch (e) { warnings.push(`Route ${r.code}: road path not built yet. ${e.message}`); }
      }
    }
    saveConfigFile(next);
    applyConfig(next);
    if (simChanged) resetSim();
    return send(req, res, 200, { ok: true, simReset: simChanged, warnings });
  }
  if (url.pathname === '/api/admin/reroute' && req.method === 'POST') {
    if (!isAdmin(req)) return send(req, res, 401, { error: 'Wrong PIN' });
    const b = await readBody(req);
    const result = await rerouteRoute(String(b.code || ''), !!b.recomputeKm);
    saveConfigFile(CONFIG);
    applyConfig(CONFIG);
    resetSim();
    return send(req, res, 200, { ok: true, ...result });
  }
  if (url.pathname === '/api/admin/geocode' && req.method === 'GET') {
    if (!isAdmin(req)) return send(req, res, 401, { error: 'Wrong PIN' });
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
    if (q.length < 3) return send(req, res, 400, { error: 'Type at least 3 letters' });
    return send(req, res, 200, { results: await geocode(q) });
  }
  if (url.pathname === '/api/admin' && req.method === 'POST') {
    if (!isAdmin(req)) return send(req, res, 401, { error: 'Wrong PIN' });
    const b = await readBody(req);
    doAction(b);
    return send(req, res, 200, { ok: true });
  }
  return send(req, res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(req, res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(req, res, 404, 'Not found', 'text/plain');
    send(req, res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    send(req, res, 400, { error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Start                                                              */
/* ------------------------------------------------------------------ */
resetSim();
let lastTick = Date.now();
setInterval(() => {
  const t = Date.now();
  const realDt = t - lastTick;
  lastTick = t;
  step(realDt * sim.speed);
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n  ISBOGI pilot is running (all transit data is simulated)\n');
  console.log(`  Routes           ${ROUTES.map((r) => r.code + (r.sample ? ' (sample)' : '')).join(', ')}`);
  console.log(`  Commuter app     http://localhost:${PORT}`);
  console.log(`  Facilitator      http://localhost:${PORT}/admin.html`);
  for (const ip of lan) console.log(`  On the same Wi-Fi: http://${ip}:${PORT}`);
  console.log(`\n  Facilitator PIN: ${ADMIN_PIN}\n`);
});

module.exports = { nextSlotAt, minuteOfDay, dayStart, ROUTES };
