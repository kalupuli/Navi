/* Einsatznavigation, Verkehrslage
 * Quellen: TomTom Traffic Incidents v5 (mit API-Schlüssel, alle Straßen)
 *          Autobahn GmbH, verkehr.autobahn.de (ohne Schlüssel, nur Autobahnen)
 * Aufgaben: Meldungen laden, auf die Route abbilden, Verzögerung bestimmen,
 *           Staus markieren und ab einem Grenzwert eine Umfahrung berechnen.
 */
'use strict';

const TT_INCIDENTS = 'https://api.tomtom.com/traffic/services/5/incidentDetails';
const TT_FLOW = 'https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png';
const AB_API = 'https://verkehr.autobahn.de/o/autobahn';
const TT_FIELDS = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},from,to,length,delay,roadNumbers}}}';

const TRAFFIC = {
  incidents: new Map(),   /* id -> Meldung */
  cache: new Map(),       /* Abfrageschlüssel -> Zeitpunkt */
  layer: L.layerGroup(),
  flow: null,
  timer: 0,
  lastReroute: 0,
  lastLoad: 0
};
map.createPane('flow').style.zIndex = 300;
map.createPane('traffic').style.zIndex = 425;
TRAFFIC.layer.addTo(map);

const trafficOn = () => !!(settings.traffic && settings.traffic.enabled);
const ttKey = () => (settings.traffic.key || '').trim();
const fmtMin = s => s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`;

/* Effektive Fahrzeit: Fahrzeit plus Verzögerung, Sperrung wird stark bestraft */
function effTime(r) {
  if (!r) return Infinity;
  const t = r.traffic;
  return r.time + (t ? t.delay : 0) + (t && t.closed ? 3600 : 0);
}
function shownTime(r) { return r.time + (r.traffic ? r.traffic.delay : 0); }

/* ---------- Laden ---------- */

function bboxesOf(shape) {
  /* Abschnitte von höchstens 60 km, jeweils mit 1,5 km Rand (TomTom erlaubt 10.000 km² je Abfrage) */
  const out = [];
  let start = 0, acc = 0;
  const push = (a, b) => {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (let i = a; i <= b; i++) {
      const [la, lo] = shape[i];
      minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la); minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo);
    }
    const pLat = 0.0135, pLon = 0.0135 / Math.cos(toRad((minLat + maxLat) / 2));
    out.push([minLon - pLon, minLat - pLat, maxLon + pLon, maxLat + pLat]);
  };
  for (let i = 1; i < shape.length; i++) {
    acc += haversine(shape[i - 1], shape[i]);
    if (acc > 60000) { push(start, i); start = i; acc = 0; }
  }
  push(start, shape.length - 1);
  return out;
}

function autobahnsOf(route) {
  const set = new Set();
  for (const m of route.maneuvers || []) for (const n of m.street_names || []) {
    const k = String(n).match(/^A\s?(\d{1,3})$/);
    if (k) set.add('A' + k[1]);
  }
  return [...set].slice(0, 6);
}

function fresh(key, maxAge) {
  const t = TRAFFIC.cache.get(key);
  return t && Date.now() - t < maxAge;
}

function ttKind(cat) {
  if (cat === 6) return 'jam';
  if (cat === 8) return 'closure';
  if (cat === 1 || cat === 14) return 'accident';
  if (cat === 7) return 'lane';
  if (cat === 9) return 'works';
  return 'other';
}
const MAG_DELAY = { 1: 60, 2: 180, 3: 480 };

async function loadTomTom(bbox) {
  const key = `tt:${bbox.map(v => v.toFixed(2)).join(',')}`;
  if (fresh(key, 90000)) return 0;
  const url = `${TT_INCIDENTS}?key=${encodeURIComponent(ttKey())}&bbox=${bbox.map(v => v.toFixed(5)).join(',')}` +
    `&fields=${encodeURIComponent(TT_FIELDS)}&language=de-DE&timeValidityFilter=present`;
  const res = await fetchT(url, {}, 9000);
  if (res.status === 403 || res.status === 401) throw new Error('TomTom-Schlüssel ungültig oder ohne Freigabe für Traffic');
  if (!res.ok) throw new Error('TomTom HTTP ' + res.status);
  const data = await res.json();
  let n = 0;
  for (const f of data.incidents || []) {
    const p = f.properties || {};
    const g = f.geometry || {};
    const coords = g.type === 'LineString' ? g.coordinates : g.type === 'Point' ? [g.coordinates] : [];
    if (!coords.length) continue;
    const kind = ttKind(p.iconCategory);
    let delay = 0;
    if (kind === 'closure') delay = Infinity;
    else if (kind === 'jam' || kind === 'accident' || kind === 'lane') delay = p.delay > 0 ? p.delay : (MAG_DELAY[p.magnitudeOfDelay] || 0);
    const text = (p.events || []).map(e => e.description).filter(Boolean).join(', ');
    TRAFFIC.incidents.set('tt:' + p.id, {
      id: 'tt:' + p.id, source: 'TomTom', kind, delay, mag: p.magnitudeOfDelay || 0,
      pts: coords.map(c => [c[1], c[0]]), line: g.type === 'LineString',
      title: [ (p.roadNumbers || []).join(', '), text ].filter(Boolean).join(': ') || 'Verkehrsmeldung',
      sub: [p.from, p.to].filter(Boolean).join(' → '), t: Date.now()
    });
    n++;
  }
  TRAFFIC.cache.set(key, Date.now());
  return n;
}

const AB_JAM = new Set(['STATIONARY_TRAFFIC', 'QUEUING_TRAFFIC', 'SLOW_TRAFFIC', 'HEAVY_TRAFFIC']);
async function loadAutobahn(road) {
  const key = `ab:${road}`;
  if (fresh(key, 120000)) return 0;
  let n = 0;
  for (const svc of ['warning', 'closure']) {
    const res = await fetchT(`${AB_API}/${road}/services/${svc}`, {}, 9000);
    if (!res.ok) throw new Error(`Autobahn GmbH ${road} HTTP ${res.status}`);
    const data = await res.json();
    for (const w of data[svc] || []) {
      if (w.future === true || w.future === 'true') continue;
      const blocked = w.isBlocked === true || w.isBlocked === 'true';
      let kind = 'other';
      if (svc === 'warning') kind = blocked ? 'closure' : AB_JAM.has(w.abnormalTrafficType) ? 'jam' : 'other';
      else kind = blocked ? 'closure' : 'lane';
      if (kind === 'other') continue;
      const g = w.geometry || {};
      let pts = g.type === 'LineString' ? g.coordinates.map(c => [+c[1], +c[0]]) : [];
      if (!pts.length && w.coordinate) pts = [[+w.coordinate.lat, +w.coordinate.long]];
      if (!pts.length) continue;
      const dmin = parseFloat(w.delayTimeValue);
      const delay = kind === 'closure' ? Infinity : kind === 'jam' ? (dmin > 0 ? dmin * 60 : 120) : 0;
      const id = `ab:${w.identifier || road + pts[0].join(',')}`;
      TRAFFIC.incidents.set(id, {
        id, source: 'Autobahn GmbH', kind, delay, mag: kind === 'jam' ? (dmin >= 10 ? 3 : dmin >= 3 ? 2 : 1) : 4,
        pts, line: pts.length > 1, title: `${(w.title || road).trim()}${w.subtitle ? ', ' + w.subtitle.trim() : ''}`,
        sub: (w.description || []).filter(s => s && /Reisezeitverlust|Stillstand|Sperrung|gesperrt|Stau|Geschwindigkeit/i.test(s)).slice(0, 3).join(' · '),
        t: Date.now()
      });
      n++;
    }
  }
  TRAFFIC.cache.set(key, Date.now());
  return n;
}

/* Lädt Meldungen für die angegebenen Routen. Fehler werden protokolliert, nie geworfen. */
async function loadTraffic(routes) {
  const jobs = [];
  const boxes = [], roads = new Set();
  for (const r of routes) {
    if (!r) continue;
    if (ttKey()) boxes.push(...bboxesOf(r.shape));
    if (settings.traffic.autobahn) autobahnsOf(r).forEach(a => roads.add(a));
  }
  for (const b of boxes.slice(0, 8)) jobs.push(loadTomTom(b).then(n => ['TomTom', n]).catch(e => ['TomTom', e]));
  for (const a of roads) jobs.push(loadAutobahn(a).then(n => [`Autobahn GmbH ${a}`, n]).catch(e => [`Autobahn GmbH ${a}`, e]));
  if (!jobs.length) {
    if (!ttKey() && !roads.size) dlog('Verkehrslage: keine Quelle verfügbar (kein TomTom-Schlüssel, keine Autobahn auf der Route)');
    return;
  }
  const res = await Promise.all(jobs);
  const sum = new Map();
  for (const [src, v] of res) {
    if (v instanceof Error) dlog(`Verkehrslage ${src}: nicht abrufbar (${v.message === 'Failed to fetch' || v.message === 'Load failed' ? 'Netz oder Freigabe' : v.message})`);
    else sum.set(src, (sum.get(src) || 0) + v);
  }
  if (sum.size) dlog(`Verkehrslage: ${[...sum].map(([s, n]) => n ? `${s} ${n} Meldungen geladen` : `${s} aktuell`).join(', ')}, insgesamt ${TRAFFIC.incidents.size} Meldungen im Speicher`);
  /* Veraltete Meldungen verwerfen */
  for (const [id, inc] of TRAFFIC.incidents) if (Date.now() - inc.t > 10 * 60000) TRAFFIC.incidents.delete(id);
  TRAFFIC.lastLoad = Date.now();
}

/* ---------- Abgleich mit der Route ---------- */

function routeGrid(route) {
  if (route._grid) return route._grid;
  const CELL = 60, grid = new Map();
  for (let i = 0; i < route.xy.length - 1; i++) {
    const a = route.xy[i], b = route.xy[i + 1];
    const x0 = Math.floor((Math.min(a[0], b[0]) - 30) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + 30) / CELL);
    const y0 = Math.floor((Math.min(a[1], b[1]) - 30) / CELL), y1 = Math.floor((Math.max(a[1], b[1]) + 30) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = x + ':' + y;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  }
  route._grid = { CELL, grid };
  return route._grid;
}

function nearestOnRoute(route, P, brg) {
  const { CELL, grid } = routeGrid(route);
  const cand = grid.get(Math.floor(P[0] / CELL) + ':' + Math.floor(P[1] / CELL));
  if (!cand) return null;
  let best = null;
  for (const i of cand) {
    const a = route.xy[i], b = route.xy[i + 1];
    const s = segDist(P, a, b);
    if (s.d > 25) continue;
    if (brg != null && angDiff(brg, planarBearing(a, b)) > 50) continue;
    if (!best || s.d < best.d) best = { d: s.d, i, along: route.cum[i] + s.t * (route.cum[i + 1] - route.cum[i]) };
  }
  return best;
}

/* Bildet alle geladenen Meldungen auf die Route ab und ermittelt die Verzögerung */
function annotateTraffic(route) {
  if (!route) return null;
  const hits = [];
  for (const inc of TRAFFIC.incidents.values()) {
    if (inc.kind === 'works' || inc.kind === 'other') continue;
    const P = inc.pts.map(p => proj(p, route.lat0));
    const samples = [];
    if (inc.line) {
      for (let k = 0; k < P.length - 1; k++) {
        const a = P[k], b = P[k + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 0.5) continue;
        const brg = planarBearing(a, b);
        const n = Math.max(1, Math.ceil(L / 40));
        for (let s = 0; s < n; s++) samples.push({ p: lerp(a, b, s / n), brg });
      }
      if (P.length > 1) samples.push({ p: P[P.length - 1], brg: planarBearing(P[P.length - 2], P[P.length - 1]) });
    } else samples.push({ p: P[0], brg: null });
    if (!samples.length) continue;
    /* Grobe Vorprüfung über den Abstand zur Route */
    let matched = 0, at0 = Infinity, at1 = -Infinity;
    for (const s of samples) {
      const m = nearestOnRoute(route, s.p, s.brg);
      if (!m) continue;
      matched++;
      at0 = Math.min(at0, m.along); at1 = Math.max(at1, m.along);
    }
    const share = matched / samples.length;
    const ok = inc.line ? (matched >= 2 && share >= 0.4) : matched >= 1 && (inc.kind === 'closure' || inc.kind === 'accident');
    if (!ok) continue;
    const delay = Number.isFinite(inc.delay) ? inc.delay * Math.min(1, share / 0.8) : 0;
    hits.push({ inc, at0, at1: Math.max(at1, at0 + 1), delay, closed: inc.kind === 'closure' });
  }
  /* Doppelte Meldungen beider Quellen zum selben Stau nur einmal zählen */
  hits.sort((a, b) => a.at0 - b.at0);
  const merged = [];
  for (const h of hits) {
    const o = merged.find(m => m.inc.source !== h.inc.source && h.at0 < m.at1 && h.at1 > m.at0 && m.inc.kind === h.inc.kind);
    if (o) { o.delay = Math.max(o.delay, h.delay); o.at0 = Math.min(o.at0, h.at0); o.at1 = Math.max(o.at1, h.at1); o.closed = o.closed || h.closed; }
    else merged.push({ ...h });
  }
  route.traffic = {
    hits: merged,
    delay: merged.reduce((s, h) => s + h.delay, 0),
    closed: merged.some(h => h.closed),
    t: Date.now()
  };
  return route.traffic;
}

function remainingDelay(route, along) {
  const t = route && route.traffic;
  if (!t) return 0;
  let d = 0;
  for (const h of t.hits) {
    if (h.at1 <= along || !h.delay) continue;
    d += h.at0 >= along ? h.delay : h.delay * (h.at1 - along) / Math.max(1, h.at1 - h.at0);
  }
  return d;
}

function pointAtAlong(route, s) {
  let i = 0;
  while (i < route.cum.length - 2 && route.cum[i + 1] < s) i++;
  const L = route.cum[i + 1] - route.cum[i];
  return lerp(route.shape[i], route.shape[i + 1], L ? Math.max(0, Math.min(1, (s - route.cum[i]) / L)) : 0);
}

/* Sperrflächen auf den gestauten Abschnitten der Route, damit der Routingserver sie meidet */
function jamRings(route) {
  const rings = [];
  const thr = Math.max(60, settings.traffic.threshold * 60 * 0.25);
  for (const h of route.traffic.hits) {
    if (!h.closed && h.delay < thr) continue;
    const len = h.at1 - h.at0;
    const fr = len > 300 ? [0.2, 0.5, 0.8] : [0.5];
    for (const f of fr) rings.push(squareRing(pointAtAlong(route, h.at0 + len * f), 3));
  }
  return rings;
}

/* ---------- Ablauf innerhalb der Routenberechnung ---------- */

/* Prüft die reguläre Route auf Staus. Liefert die Umfahrung, falls sie trotz Umweg schneller ist. */
async function trafficStage(from, normal, token) {
  setStatus('Prüfe Verkehrslage');
  await loadTraffic([normal]);
  if (token !== routeToken) return null;
  annotateTraffic(normal);
  drawTraffic();
  const t = normal.traffic;
  dlog(`Verkehr auf regulärer Route: ${t.hits.length} Meldungen, Verzögerung ${fmtDur(t.delay)}${t.closed ? ', Sperrung' : ''}`);
  const thr = settings.traffic.threshold * 60;
  if (!t.closed && t.delay < thr) return { route: normal, jam: null, rings: [] };
  const rings = jamRings(normal);
  if (!rings.length) return { route: normal, jam: null, rings: [] };
  dlog(`Grenzwert ${fmtDur(thr)} überschritten, suche Umfahrung (${rings.length} Ausschlussflächen)`);
  setStatus('Stau auf der Route, suche Umfahrung');
  let alt;
  try { alt = await valhalla(from, dest, { contra: false, extraRings: rings }); } catch (e) {
    dlog(`Umfahrung nicht berechenbar: ${e.message}`);
    return { route: normal, jam: null, rings: [] };
  }
  if (token !== routeToken) return null;
  await loadTraffic([alt]);
  if (token !== routeToken) return null;
  annotateTraffic(alt);
  dlog(`Umfahrung: ${fmtDur(alt.time)} + ${fmtDur(alt.traffic.delay)} Verkehr, regulär ${fmtDur(normal.time)} + ${t.closed ? 'Sperrung' : fmtDur(t.delay)}`);
  if (effTime(alt) + 15 < effTime(normal)) return { route: alt, jam: normal, rings };
  dlog('Umfahrung bringt keinen Vorteil, reguläre Route bleibt');
  return { route: normal, jam: null, rings: [] };
}

/* ---------- Darstellung ---------- */

function jamColor(inc) {
  if (inc.kind === 'closure') return '#111827';
  if (inc.mag >= 3 || inc.delay >= 600) return '#991b1b';
  if (inc.mag === 2 || inc.delay >= 180) return '#dc2626';
  return '#f59e0b';
}
const KIND_TEXT = { jam: 'Stau', closure: 'Sperrung', accident: 'Unfall', lane: 'Fahrstreifen gesperrt' };

function drawTraffic() {
  TRAFFIC.layer.clearLayers();
  if (!trafficOn()) return;
  for (const inc of TRAFFIC.incidents.values()) {
    if (!KIND_TEXT[inc.kind]) continue;
    const col = jamColor(inc);
    const pop = () => {
      const d = document.createElement('div');
      d.className = 'tr-pop';
      d.innerHTML = `<b>${esc(KIND_TEXT[inc.kind])}${Number.isFinite(inc.delay) && inc.delay > 0 ? `, +${esc(fmtMin(inc.delay))}` : ''}</b>
        <span>${esc(inc.title)}</span>${inc.sub ? `<span>${esc(inc.sub)}</span>` : ''}<small>Quelle: ${esc(inc.source)}</small>`;
      return d;
    };
    if (inc.line) {
      L.polyline(inc.pts, { pane: 'traffic', color: '#ffffff', weight: 9, opacity: .75, interactive: false }).addTo(TRAFFIC.layer);
      L.polyline(inc.pts, { pane: 'traffic', color: col, weight: 5, opacity: .95, dashArray: inc.kind === 'closure' ? '6 6' : null })
        .bindPopup(pop, { className: 'ctx-pop' }).addTo(TRAFFIC.layer);
    } else {
      L.circleMarker(inc.pts[0], { pane: 'traffic', radius: 7, color: '#fff', weight: 2, fillColor: col, fillOpacity: 1 })
        .bindPopup(pop, { className: 'ctx-pop' }).addTo(TRAFFIC.layer);
    }
  }
  /* Verzögerung an den Staus der gewählten Route beschriften */
  const r = nav.route;
  if (r && r.traffic) for (const h of r.traffic.hits) {
    const txt = h.closed ? 'Sperrung' : h.delay >= 30 ? `+${fmtMin(h.delay)}` : null;
    if (!txt) continue;
    L.marker(pointAtAlong(r, h.at0), { keyboard: false, interactive: false, zIndexOffset: 600,
      icon: L.divIcon({ className: '', iconSize: [0, 0], iconAnchor: [0, 0], html: `<div class="jam-label${h.closed ? ' closed' : ''}">${esc(txt)}</div>` }) }).addTo(TRAFFIC.layer);
  }
}

function applyFlowLayer() {
  const want = trafficOn() && settings.traffic.flow && ttKey();
  if (TRAFFIC.flow) { map.removeLayer(TRAFFIC.flow); TRAFFIC.flow = null; }
  if (!want) return;
  TRAFFIC.flow = L.tileLayer(`${TT_FLOW}?key=${encodeURIComponent(ttKey())}&tileSize=256`, {
    pane: 'flow', opacity: 0.75, maxZoom: 22, attribution: 'Verkehr © TomTom'
  }).addTo(map);
}

/* Banner-Hinweis und Ansage vor einem Stau */
function trafficBanner(route, along) {
  const box = $('trafficWarn');
  const t = route && route.traffic;
  const next = t && t.hits.find(h => h.at1 > along && (h.closed || h.delay >= 30));
  if (!next || next.at0 - along > 3000) { box.hidden = true; return; }
  const inside = next.at0 <= along;
  const what = next.closed ? 'Sperrung' : `Stau, +${fmtMin(next.delay)}`;
  $('trafficWarnText').textContent = inside ? `${what}, noch ${fmtDist(next.at1 - along)}` : `${what} in ${fmtDist(next.at0 - along)}`;
  box.hidden = false;
  const key = 'jam' + Math.round(next.at0);
  if (!inside && next.at0 - along < 2000 && !nav.announced.has(key)) {
    nav.announced.add(key);
    say(next.closed ? `Achtung, Sperrung in ${spokenDist(next.at0 - along)}.` : `Achtung, Stau in ${spokenDist(next.at0 - along)}.`);
  }
}

/* ---------- Laufende Aktualisierung während der Fahrt ---------- */

function startTrafficTimer() {
  clearInterval(TRAFFIC.timer);
  if (!trafficOn()) return;
  TRAFFIC.timer = setInterval(trafficTick, Math.max(1, settings.traffic.interval || 2) * 60000);
}
function stopTrafficTimer() { clearInterval(TRAFFIC.timer); TRAFFIC.timer = 0; }

async function trafficTick() {
  if (!nav.active || !trafficOn() || !nav.route || nav.arrived) return;
  const o = nav.options || {};
  const routes = [nav.route, o.legal, o.contra, o.jam].filter((r, i, a) => r && a.indexOf(r) === i);
  await loadTraffic([nav.route]);
  routes.forEach(annotateTraffic);
  drawTraffic(); renderChoice(); renderBadges();
  const r = nav.route;
  const rem = remainingDelay(r, nav.along);
  const thr = settings.traffic.threshold * 60;
  const blocked = r.traffic.hits.some(h => h.closed && h.at1 > nav.along);
  if (nav.pref !== 'jam' && (blocked || rem >= thr) && Date.now() - TRAFFIC.lastReroute > 120000) {
    TRAFFIC.lastReroute = Date.now();
    computeRoute('traffic');
  }
}

/* ---------- Einstellungen ---------- */

function fillTrafficSettings() {
  const t = settings.traffic;
  $('optTraffic').checked = !!t.enabled;
  $('optJam').value = t.threshold;
  $('optFlow').checked = !!t.flow;
  $('optAutobahnApi').checked = !!t.autobahn;
  $('optTomtom').value = t.key || '';
}
function trafficChanged(reroute) {
  save('settings', settings);
  applyFlowLayer();
  drawTraffic();
  if (nav.active) startTrafficTimer();
  if (reroute && dest && nav.active) computeRoute('settings');
}
$('optTraffic').addEventListener('change', e => { settings.traffic.enabled = e.target.checked; if (!e.target.checked) { TRAFFIC.layer.clearLayers(); stopTrafficTimer(); } trafficChanged(true); });
$('optJam').addEventListener('change', e => {
  const v = parseFloat(String(e.target.value).replace(',', '.'));
  settings.traffic.threshold = Number.isFinite(v) ? Math.min(60, Math.max(0.5, v)) : 3;
  e.target.value = settings.traffic.threshold;
  trafficChanged(true);
});
$('optFlow').addEventListener('change', e => { settings.traffic.flow = e.target.checked; trafficChanged(false); });
$('optAutobahnApi').addEventListener('change', e => { settings.traffic.autobahn = e.target.checked; trafficChanged(true); });
$('optTomtom').addEventListener('change', e => { settings.traffic.key = e.target.value.trim(); TRAFFIC.cache.clear(); trafficChanged(true); });

fillTrafficSettings();
applyFlowLayer();
