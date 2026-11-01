'use strict';
// FlightScope Event Engine — zero dependencies, Node 18+.  Run: node server.js
// Env: PORT, OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET (optional OAuth2), POLL_SECONDS (can only slow polling down)
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 3000, CID = process.env.OPENSKY_CLIENT_ID, CSEC = process.env.OPENSKY_CLIENT_SECRET;
const AUTH = Boolean(CID && CSEC);
// Provider-compliant polling: never faster than the daily credit budget allows (anon ≈400/day, registered ≈4000/day — verify in OpenSky docs).
const MIN_MS = Math.max((+process.env.POLL_SECONDS || 0) * 1000, Math.ceil(86400000 / (AUTH ? 4000 : 400) * 1.1));
const ADMIN = process.env.ADMIN_TOKEN, MAX_WATCHES = +process.env.MAX_WATCHES || 20; // public-deploy safety
const isAdmin = q => ADMIN ? q.headers.authorization === 'Bearer ' + ADMIN : /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(q.socket.remoteAddress); // no token set => localhost only
const MAX_R = +process.env.MAX_RADIUS_KM || 500; // max radius (km)
const D = Math.PI / 180;
// OpenSky bills by bbox area (as I recall: <25 sq° =1 credit, <100 =2, <400 =3, larger =4 — verify in docs); poll slower as area grows
const credits = (lat, r) => { const b = r * 1.5, a = (2 * b / 111) * (2 * b / (111 * Math.max(0.1, Math.cos(lat * Math.PI / 180)))); return a <= 25 ? 1 : a <= 100 ? 2 : a <= 400 ? 3 : 4; };
const hav = (a, b, c, d) => { const x = Math.sin((c - a) * D / 2) ** 2 + Math.cos(a * D) * Math.cos(c * D) * Math.sin((d - b) * D / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
const brg = (a, b, c, d) => (Math.atan2(Math.sin((d - b) * D) * Math.cos(c * D), Math.cos(a * D) * Math.sin(c * D) - Math.sin(a * D) * Math.cos(c * D) * Math.cos((d - b) * D)) / D + 360) % 360;
const dest = (la, lo, km, b) => { const d = km / 6371, t = b * D, p = la * D, la2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(t)); return [la2 / D, (lo * D + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(la2))) / D]; };
const adiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// Starter airport list (elevation in metres) — VERIFY and extend via airports.json: [{icao,name,lat,lon,elev}]
let AIRPORTS = [{ icao: 'VAPO', name: 'Pune', lat: 18.5822, lon: 73.9197, elev: 560 }, { icao: 'VABB', name: 'Mumbai', lat: 19.0887, lon: 72.8679, elev: 11 }];
const AP_FILE = path.join(__dirname, 'airports.json'); // once this file exists it is the full list (edited via /api/airports)
try { AIRPORTS = JSON.parse(fs.readFileSync(AP_FILE)); } catch {}
const saveAp = () => fs.writeFile(AP_FILE, JSON.stringify(AIRPORTS, null, 1), () => {});
const csv = l => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
// Looks up coordinates/elevation by ICAO in the public OurAirports dataset (column layout assumed: ident=1, name=3, lat=4, lon=5, elev_ft=6)
async function lookupAp(icao) {
  const r = await fetch('https://davidmegginson.github.io/ourairports-data/airports.csv', { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('airport dataset HTTP ' + r.status);
  for (const l of (await r.text()).split('\n')) if (l.includes(',' + icao + ',')) { const c = csv(l); if (c[1] === icao && isFinite(+c[4]) && isFinite(+c[5])) return { icao, name: c[3], lat: +c[4], lon: +c[5], elev: Math.round((+c[6] || 0) * 0.3048) }; }
  return null;
}
const nearAp = a => { let b = null; for (const p of AIRPORTS) { const d = hav(a.lat, a.lon, p.lat, p.lon); if (d <= 8 && (!b || d < b.dist)) b = { ...p, dist: d }; } return b; };
const CD = { overhead: 600e3, airspace_entry: 600e3, takeoff: 1800e3, landing: 1800e3, trajectory: 120e3 }; // per-aircraft dedupe windows

let tok = { v: null, exp: 0 };
async function token() {
  if (!CID && !CSEC) return null;
  if (!AUTH) { const e = new Error('Both OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET are required for authenticated requests'); e.phase = 'authentication'; e.code = 'ERR_OPENSKY_CREDENTIALS'; throw e; }
  if (tok.v && Date.now() < tok.exp) return tok.v;
  try {
    const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CID, client_secret: CSEC }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) { const e = new Error('OpenSky auth ' + r.status); e.status = r.status; throw e; }
    const j = await r.json(); tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 30) * 1000 }; return tok.v;
  } catch (e) { e.phase = 'authentication'; throw e; }
}
async function fetchStates(w) {
  const box = w.r * 1.5, dLa = box / 111, dLo = box / (111 * Math.cos(w.lat * D));
  const u = `https://opensky-network.org/api/states/all?lamin=${Math.max(-90, w.lat - dLa)}&lamax=${Math.min(90, w.lat + dLa)}&lomin=${w.lon - dLo}&lomax=${w.lon + dLo}`;
  const t = await token();
  try {
    const r = await fetch(u, { headers: t ? { authorization: 'Bearer ' + t } : {}, signal: AbortSignal.timeout(15000) });
    if (r.status === 429) { const e = new Error('OpenSky rate limit reached'); e.rate = 1; e.retry = +r.headers.get('x-rate-limit-retry-after-seconds') || 600; throw e; }
    if (!r.ok) { const e = new Error('OpenSky HTTP ' + r.status); e.status = r.status; throw e; }
    w.rem = r.headers.get('x-rate-limit-remaining');
    const j = await r.json();
    return (j.states || []).map(s => ({ id: s[0], call: (s[1] || '').trim() || null, t: s[3] || s[4], lon: s[5], lat: s[6], alt: s[7] ?? s[13], gnd: !!s[8], spd: s[9], hdg: s[10], vr: s[11] })).filter(a => a.lat != null && a.lon != null);
  } catch (e) { e.phase = 'aircraft_states'; throw e; }
}
// ADS-B community providers (readsb v2 format, no API credits; radius max 250 nm): adsb.lol, airplanes.live. Verify each provider's terms of use before public deployment.
const FAST_MS = Math.max((+process.env.POLL_SECONDS || 0) * 1000, 5000);
async function fetchAdsb(w, which) {
  const base = which === 'airplaneslive' ? 'https://api.airplanes.live/v2' : 'https://api.adsb.lol/v2', nm = Math.min(250, Math.ceil(w.r * 1.5 / 1.852));
  try {
    const r = await fetch(`${base}/point/${w.lat}/${w.lon}/${nm}`, { signal: AbortSignal.timeout(15000) });
    if (r.status === 429) { const e = new Error('ADS-B API rate limit'); e.rate = 1; e.retry = 30; throw e; }
    if (!r.ok) { const e = new Error('ADS-B API HTTP ' + r.status); e.status = r.status; throw e; }
    const j = await r.json(), now = j.now > 1e11 ? j.now / 1000 : (j.now || Date.now() / 1000), num = v => typeof v === 'number' ? v : null;
    return (j.ac || []).map(a => ({ id: a.hex, call: (a.flight || '').trim() || null, t: now - (a.seen_pos ?? a.seen ?? 0), lat: a.lat, lon: a.lon,
      alt: a.alt_baro === 'ground' ? 0 : num(a.alt_baro) != null ? a.alt_baro * 0.3048 : num(a.alt_geom) != null ? a.alt_geom * 0.3048 : null, gnd: a.alt_baro === 'ground',
      spd: num(a.gs) != null ? a.gs * 0.514444 : null, hdg: num(a.track), vr: num(a.baro_rate) != null ? a.baro_rate * 0.00508 : num(a.geom_rate) != null ? a.geom_rate * 0.00508 : null }))
      .filter(a => a.id && typeof a.lat === 'number' && typeof a.lon === 'number');
  } catch (e) { e.phase = 'aircraft_states'; throw e; }
}
// PROVIDER=auto (default): OpenSky first; if it is unreachable (network failure / 5xx) use adsb.lol for 15 min, then retry OpenSky. Or force: opensky | adsblol | airplaneslive
let openskyDownUntil = 0;
async function getStates(w) {
  const want = (process.env.PROVIDER || 'auto').toLowerCase();
  if (want === 'opensky' || (want === 'auto' && Date.now() > openskyDownUntil)) {
    try { return { s: await fetchStates(w), prov: 'OpenSky' }; }
    catch (e) {
      if (want === 'opensky' || e.rate || (e.status && e.status < 500)) throw e; // real HTTP answers (auth, rate limit) are not outages
      openskyDownUntil = Date.now() + 15 * 60e3; logProviderError(e); console.error('OpenSky unreachable — using adsb.lol for 15 min');
    }
  }
  const which = want === 'airplaneslive' ? 'airplaneslive' : 'adsblol';
  return { s: await fetchAdsb(w, which), prov: which === 'airplaneslive' ? 'airplanes.live' : 'adsb.lol' };
}

// SIMULATED provider (clearly flagged everywhere): synthetic aircraft crossing the radius
function simStates(w) {
  const now = Date.now(), dt = (now - (w.simT || now)) / 1000; w.simT = now; w.simA = w.simA || [];
  while (w.simA.length < 4) { const b = Math.random() * 360, p = dest(w.lat, w.lon, w.r * 1.4, b); w.simA.push({ id: 'sim' + Math.random().toString(16).slice(2, 8), call: 'SIM' + (100 + Math.floor(Math.random() * 900)), lat: p[0], lon: p[1], hdg: (b + 180 + Math.random() * 40 - 20 + 360) % 360, spd: 140 + Math.random() * 100, alt: 2000 + Math.random() * 9000, vr: 0, gnd: false }); }
  w.simA = w.simA.filter(a => { [a.lat, a.lon] = dest(a.lat, a.lon, a.spd * dt / 1000, a.hdg); if (Math.random() < 0.05) a.hdg = (a.hdg + 45) % 360; a.t = now / 1000; return hav(w.lat, w.lon, a.lat, a.lon) < w.r * 1.6; });
  return w.simA.map(a => ({ ...a }));
}

// Origin/destination: OpenSky live data has none. Best-effort callsign→route lookup (community adsbdb.com). NOT confirmed for this specific flight.
const routeCache = new Map(), inflight = new Map(); // callsign -> {t, r}
function routeFor(cs) {
  const c = routeCache.get(cs); if (c && Date.now() - c.t < (c.r ? 6 : 1) * 3600e3) return Promise.resolve(c.r);
  if (inflight.has(cs)) return inflight.get(cs);
  const p = (async () => {
    try {
      const res = await fetch('https://api.adsbdb.com/v0/callsign/' + encodeURIComponent(cs), { signal: AbortSignal.timeout(8000) });
      let r = null;
      if (res.ok) { const fr = (await res.json()).response?.flightroute; const m = a => ({ icao: a.icao_code, iata: a.iata_code, name: a.name, city: a.municipality }); if (fr?.origin && fr?.destination) r = { origin: m(fr.origin), destination: m(fr.destination), flight: fr.callsign_iata || null, airline: fr.airline?.name || null, source: 'adsbdb.com callsign database' }; }
      console.log('route', cs, res.status, r ? r.origin.icao + '->' + r.destination.icao : 'none');
      if (res.ok || res.status === 404) routeCache.set(cs, { t: Date.now(), r }); // don't cache transient failures
      return r;
    } catch (err) { console.log('route', cs, 'failed:', err.message); return null; } finally { inflight.delete(cs); }
  })();
  inflight.set(cs, p); return p;
}

// Airline name from the 3-letter ICAO prefix of the callsign (ABY123 -> Air Arabia). Built-in table first, then adsbdb.com for unknown prefixes.
const AIRLINES = { ABY: 'Air Arabia', QFA: 'Qantas', AIC: 'Air India', IGO: 'IndiGo', AXB: 'Air India Express', SEJ: 'SpiceJet', AKJ: 'Akasa Air', VTI: 'Vistara', UAE: 'Emirates', ETD: 'Etihad Airways', QTR: 'Qatar Airways', FDB: 'flydubai', GFA: 'Gulf Air', OMA: 'Oman Air', SVA: 'Saudia', KAC: 'Kuwait Airways', SIA: 'Singapore Airlines', CPA: 'Cathay Pacific', BAW: 'British Airways', VIR: 'Virgin Atlantic', DLH: 'Lufthansa', AFR: 'Air France', KLM: 'KLM', THY: 'Turkish Airlines', RYR: 'Ryanair', EZY: 'easyJet', UAL: 'United', DAL: 'Delta', AAL: 'American Airlines', ACA: 'Air Canada', ANA: 'All Nippon Airways', JAL: 'Japan Airlines', THA: 'Thai Airways', MAS: 'Malaysia Airlines', AIQ: 'Thai AirAsia', AXM: 'AirAsia', SQC: 'Singapore Airlines Cargo' };
const airlineCache = new Map();
const prefixOf = cs => (/^([A-Z]{3})\d/.exec(cs || '') || [])[1] || null;
async function airlineFor(pf) {
  const c = airlineCache.get(pf); if (c && Date.now() - c.t < 24 * 3600e3) return c.n;
  try {
    const res = await fetch('https://api.adsbdb.com/v0/airline/' + pf, { signal: AbortSignal.timeout(8000) });
    let n = null;
    if (res.ok) { const j = (await res.json()).response, a = Array.isArray(j) ? j[0] : j; n = a?.name || null; }
    console.log('airline', pf, res.status, n || 'none');
    if (res.ok || res.status === 404) airlineCache.set(pf, { t: Date.now(), n });
    return n;
  } catch (err) { console.log('airline', pf, 'failed:', err.message); return null; }
}

const watches = new Map();
function logProviderError(e) {
  const cause = e.cause;
  console.error('OpenSky provider failure', JSON.stringify({
    phase: e.phase || 'unknown', message: e.message, name: e.name, code: e.code || cause?.code || null,
    status: e.status || null,
    cause: cause ? { name: cause.name, code: cause.code, message: cause.message, syscall: cause.syscall, hostname: cause.hostname, address: cause.address, port: cause.port, stack: cause.stack } : null,
    stack: e.stack
  }));
}
class Watch {
  constructor(k, lat, lon, r, sim) { Object.assign(this, { k, lat, lon, r, sim, clients: new Set(), ac: new Map(), ev: [], seq: 0, epoch: Date.now().toString(36), seen: new Map(), status: { state: 'starting' }, pollMs: sim ? 3000 : MIN_MS * credits(lat, r), rem: null, dead: false }); this.poll(); }
  send(res, name, data, id) { res.write((id ? `id: ${id}\n` : '') + `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); }
  bc(name, data, id) { for (const c of this.clients) this.send(c, name, data, id); }
  async poll() {
    const live = Math.max(1, [...watches.values()].filter(w => !w.sim).length); // provider budget is shared by all live watches
    let wait = 3000;
    try {
      let s, prov = 'SIMULATED';
      if (this.sim) s = simStates(this);
      else { const g = await getStates(this); s = g.s; prov = g.prov; wait = prov === 'OpenSky' ? this.pollMs * live : Math.max(FAST_MS, 1100 * live); }
      this.effMs = wait; this.now = Date.now(); this.process(s);
      this.status = { state: 'ok', at: this.now, provider: prov, credits: prov === 'OpenSky' ? this.rem : null };
    } catch (e) {
      logProviderError(e); wait = e.retry ? e.retry * 1000 : 30000; this.effMs = wait;
      this.status = { state: e.rate ? 'rate_limited' : 'error', phase: e.phase || 'unknown', msg: e.message, at: Date.now() };
    }
    this.bc('snapshot', this.snap());
    if (!this.dead) this.timer = setTimeout(() => this.poll(), wait);
  }
  process(S) {
    const now = this.now, ids = new Set();
    for (const a of S) {
      if (now / 1000 - a.t > 90) continue; // stale position: ignore rather than guess
      ids.add(a.id); a.d = hav(this.lat, this.lon, a.lat, a.lon); a.brg = brg(this.lat, this.lon, a.lat, a.lon); a.in = a.d <= this.r;
      const p = this.ac.get(a.id); this.detect(p, a);
      a.seenAt = now; a.trail = ((p && p.trail) || []).concat([[a.lat, a.lon]]).slice(-20); this.ac.set(a.id, a);
    }
    for (const [id, p] of this.ac) if (!ids.has(id) && now - p.seenAt > Math.max(120e3, 3 * (this.effMs || this.pollMs))) {
      const ap = nearAp(p);
      if (!p.gnd && ap && p.alt != null && p.alt - ap.elev < 400 && (p.vr || 0) < -1) this.emit('landing', p, { airport: ap.icao, conf: 'low', basis: 'last seen descending below 400 m near airport, then signal lost' });
      this.ac.delete(id);
    }
    for (const [k, t] of this.seen) if (now - t > 3600e3) this.seen.delete(k);
  }
  detect(p, a) {
    const ap = nearAp(a);
    if (!p) { if (a.in) this.emit('overhead', a, { basis: 'first seen inside radius' }); return; }
    if (a.in && !p.in) this.emit('airspace_entry', a, { basis: 'crossed into radius' });
    if (ap) {
      const pg = p.alt != null ? p.alt - ap.elev : null, g = a.alt != null ? a.alt - ap.elev : null, x = { airport: ap.icao };
      if (p.gnd && !a.gnd) this.emit('takeoff', a, { ...x, conf: 'medium', basis: 'on-ground flag cleared within 8 km of airport' });
      else if (!a.gnd && pg != null && pg < 300 && (a.vr || 0) > 3 && (a.spd || 0) > 50) this.emit('takeoff', a, { ...x, conf: 'low', basis: 'low-level climb near airport' });
      if (!p.gnd && a.gnd) this.emit('landing', a, { ...x, conf: 'medium', basis: 'airborne→on-ground flag within 8 km of airport' });
      else if (!a.gnd && g != null && g < 150 && (a.vr || 0) < -1 && (a.spd || 0) < 90) this.emit('landing', a, { ...x, conf: 'low', basis: 'very low and descending on approach' });
    }
    if (a.in) {
      if (p.hdg != null && a.hdg != null && adiff(p.hdg, a.hdg) >= 30) this.emit('trajectory', a, { basis: `heading changed ${Math.round(adiff(p.hdg, a.hdg))}°` });
      else if (p.vr != null && a.vr != null && Math.abs(p.vr) > 4 && Math.abs(a.vr) > 4 && Math.sign(p.vr) !== Math.sign(a.vr)) this.emit('trajectory', a, { basis: 'vertical trend reversed' });
    }
  }
  emit(type, a, x = {}) {
    const key = type + a.id; if (this.now - (this.seen.get(key) || 0) < CD[type]) return; this.seen.set(key, this.now);
    const seq = ++this.seq, ev = { id: `${this.epoch}-${seq}`, seq, type, t: this.now, icao24: a.id, callsign: a.call, dist: a.d, brg: a.brg, alt: a.alt, spd: a.spd, hdg: a.hdg, vr: a.vr, inferred: type === 'takeoff' || type === 'landing', confirmed: false, simulated: this.sim, ...x };
    const cr = !this.sim && a.call && routeCache.get(a.call); if (cr && cr.r) ev.route = cr.r;
    const pf = this.sim ? null : prefixOf(a.call); ev.airline = (ev.route && ev.route.airline) || (pf && (AIRLINES[pf] || (airlineCache.get(pf) || {}).n)) || null;
    this.ev.push(ev); if (this.ev.length > 300) this.ev.shift(); this.bc('event', ev, ev.id);
    if (!this.sim && a.call && (!ev.route || !ev.airline)) Promise.all([routeFor(a.call), pf && !ev.airline ? airlineFor(pf) : null]).then(([r, al]) => { ev.route = r; ev.airline = (r && r.airline) || al || ev.airline; this.bc('route', { id: ev.id, route: r, airline: ev.airline }); }); // late update, shown in feed
  }
  snap() {
    const h = Date.now() - 3600e3, e = this.ev.filter(x => x.t > h), c = t => e.filter(x => x.type === t).length;
    const ac = [...this.ac.values()].map(a => ({ id: a.id, call: a.call, lat: a.lat, lon: a.lon, alt: a.alt, spd: a.spd, hdg: a.hdg, gnd: a.gnd, d: a.d, in: a.in, trail: a.trail }));
    return { center: [this.lat, this.lon], r: this.r, sim: this.sim, status: this.status, pollMs: this.effMs || this.pollMs, ac, airports: AIRPORTS.filter(p => hav(this.lat, this.lon, p.lat, p.lon) < this.r * 3), stats: { overhead: ac.filter(a => a.in).length, tracked: ac.length, hour: e.length, dep: c('takeoff'), arr: c('landing') } };
  }
}

http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/healthz') { s.writeHead(200); return s.end('ok'); }
  if (u.pathname === '/api/stream') {
    const lat = +u.searchParams.get('lat'), lon = +u.searchParams.get('lon'), sim = u.searchParams.get('sim') === '1';
    const r = Math.min(MAX_R, Math.max(1, +u.searchParams.get('radius') || 10));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { s.writeHead(400); return s.end('bad lat/lon'); }
    const la = +lat.toFixed(3), lo = +lon.toFixed(3), k = [la, lo, r, sim].join();
    let w = watches.get(k);
    if (!w) { if (watches.size >= MAX_WATCHES) { s.writeHead(503, { 'retry-after': '60' }); return s.end('server busy'); } watches.set(k, w = new Watch(k, la, lo, r, sim)); }
    clearTimeout(w.killT);
    s.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    s.write('retry: 3000\n\n');
    const [ep, n] = String(q.headers['last-event-id'] || '').split('-');
    for (const e of ep === w.epoch ? w.ev.filter(e => e.seq > +n) : w.ev.slice(-50)) w.send(s, 'event', e, e.id); // reconnect replay
    w.send(s, 'snapshot', w.snap()); w.clients.add(s);
    const hb = setInterval(() => s.write(': ping\n\n'), 15000);
    q.on('close', () => { clearInterval(hb); w.clients.delete(s); if (!w.clients.size) w.killT = setTimeout(() => { w.dead = true; clearTimeout(w.timer); watches.delete(w.k); }, 60000); });
    return;
  }
  if (u.pathname === '/api/route') { // diagnostic: curl 'localhost:3000/api/route?callsign=QFA1'
    const cs = (u.searchParams.get('callsign') || '').toUpperCase().trim();
    if (!isAdmin(q)) { s.writeHead(403); return s.end('admin only'); }
    if (!/^[A-Z0-9]{3,8}$/.test(cs)) { s.writeHead(400); return s.end('bad callsign'); }
    routeCache.delete(cs); routeFor(cs).then(r => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify(r)); }); return;
  }
  if (u.pathname === '/api/airports') {
    const json = (c, o) => { s.writeHead(c, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
    const changed = () => { saveAp(); for (const w of watches.values()) w.bc('snapshot', w.snap()); json(200, AIRPORTS); }; // takes effect immediately
    if (q.method === 'GET') return json(200, AIRPORTS);
    if (!isAdmin(q)) return json(403, { error: ADMIN ? 'admin token required' : 'set ADMIN_TOKEN to edit airports remotely' });
    if (q.method === 'DELETE') { const i = (u.searchParams.get('icao') || '').toUpperCase(); AIRPORTS = AIRPORTS.filter(p => p.icao !== i); return changed(); }
    if (q.method === 'POST') {
      let b = ''; q.on('data', d => { if ((b += d).length > 5e3) q.destroy(); });
      q.on('end', async () => {
        try {
          const j = JSON.parse(b), icao = String(j.icao || '').trim().toUpperCase(), num = v => (v === '' || v == null) ? null : +v;
          if (!/^[A-Z0-9]{3,4}$/.test(icao)) return json(400, { error: 'ICAO code must be 3–4 letters/digits' });
          let p = { icao, name: String(j.name || '').trim() || icao, lat: num(j.lat), lon: num(j.lon), elev: num(j.elev) ?? 0 };
          if (p.lat == null || p.lon == null) {
            const f = await lookupAp(icao);
            if (!f) return json(404, { error: `No airport found for ${icao} — enter lat, lon and elevation (m) manually` });
            p = { ...f, name: String(j.name || '').trim() || f.name, elev: num(j.elev) ?? f.elev };
          }
          if (!isFinite(p.lat) || !isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180 || !isFinite(p.elev)) return json(400, { error: 'invalid lat/lon/elevation' });
          AIRPORTS = AIRPORTS.filter(x => x.icao !== icao).concat(p); changed();
        } catch (e) { json(400, { error: e.message }); }
      });
      return;
    }
  }
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => { if (e) { s.writeHead(404); return s.end('not found'); } s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); s.end(d); });
}).listen(PORT, () => console.log(`FlightScope Event Engine on :${PORT} — OpenSky ${AUTH ? 'authenticated' : 'anonymous'}, min poll ${MIN_MS / 1000}s`));