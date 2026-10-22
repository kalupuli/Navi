/* Einsatznavigation
 * Karte: Leaflet + OSM / basemap.de
 * Adresssuche: Photon (komoot)
 * Routing: Valhalla (auto / truck, exclude_polygons, ignore_oneways)
 * Einbahnprüfung: Overpass API
 */
'use strict';

/* Service Worker zuerst registrieren, damit der Offline-Start auch dann vorbereitet wird,
   wenn eine Bibliothek beim ersten Aufruf nicht lädt */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service Worker', e));
}

/* ================================================================ Grundwerte */

const DEFAULT_SERVERS = {
  valhalla: 'https://valhalla1.openstreetmap.de/route',
  photon: 'https://photon.komoot.io',
  overpass: 'https://overpass-api.de/api/interpreter'
};
const APP_VERSION = '2026-10-22.9';
const OVERPASS_MIRRORS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/* Diagnoseprotokoll der letzten Routenberechnung */
let diag = [], diagT0 = 0, lastDiag = null;
function dlog(msg) {
  const t = ((performance.now() - diagT0) / 1000).toFixed(1);
  diag.push(`${t.padStart(5)} s  ${msg}`);
  const el = document.getElementById('diagLog');
  if (el && !document.getElementById('diagPanel').hidden) el.textContent = diag.join('\n');
}
function dreset() {
  diag = []; diagT0 = performance.now(); lastDiag = null;
  dlog(`Version ${APP_VERSION}, ${new Date().toLocaleString('de-DE')}`);
}
const r5 = p => `${(+p[0]).toFixed(5)}, ${(+p[1]).toFixed(5)}`;

const PRESETS = [
  { id: 'mtw', name: 'MTW / ELW Hochdach', h: 2.75, w: 2.05, l: 6.0, t: 3.5, a: 2.0 },
  { id: 'rtw', name: 'RTW Kofferaufbau', h: 2.95, w: 2.35, l: 6.9, t: 5.5, a: 3.5 },
  { id: 'hlf20', name: 'HLF 20', h: 3.30, w: 2.55, l: 8.5, t: 16, a: 10 },
  { id: 'tlf4000', name: 'TLF 4000', h: 3.40, w: 2.55, l: 8.6, t: 18, a: 11 },
  { id: 'dlk', name: 'DLK 23-12', h: 3.30, w: 2.50, l: 10.2, t: 16, a: 10 },
  { id: 'wlf', name: 'WLF mit Abrollbehälter', h: 3.70, w: 2.55, l: 10.0, t: 26, a: 11.5 },
  { id: 'custom', name: 'Eigene Werte' }
];

/* Straßenklassen, auf denen Gegenrichtung zulässig sein kann. */
const CLASSES = [
  ['residential', 'Wohnstraße'],
  ['living_street', 'Verkehrsberuhigter Bereich'],
  ['unclassified', 'Gemeindestraße'],
  ['service', 'Zufahrt, Erschließung'],
  ['tertiary', 'Kreis-, Verbindungsstraße'],
  ['secondary', 'Landes-, Hauptverkehrsstraße'],
  ['primary', 'Bundes-, Hauptstraße']
];
const NEVER_CONTRA = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);

const LAYERS = {
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opt: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende' }
  },
  basemap: {
    name: 'basemap.de farbig',
    url: 'https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR/{z}/{y}/{x}.png',
    opt: { maxZoom: 18, attribution: '© GeoBasis-DE / BKG, CC BY 4.0' }
  },
  basemapGrau: {
    name: 'basemap.de grau',
    url: 'https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_grau/default/GLOBAL_WEBMERCATOR/{z}/{y}/{x}.png',
    opt: { maxZoom: 18, attribution: '© GeoBasis-DE / BKG, CC BY 4.0' }
  }
};

const DEFAULTS = {
  vehicle: { type: 'pkw', preset: 'hlf20', height: 3.30, width: 2.55, length: 8.5, weight: 16, axle: 10 },
  contra: { enabled: true, minGain: 20, dual: false, v: 2, classes: ['residential', 'living_street', 'unclassified', 'service', 'tertiary', 'secondary', 'primary'] },
  voice: true,
  night: false,
  radius: 20,
  layer: 'osm',
  servers: { ...DEFAULT_SERVERS },
  traffic: { enabled: true, key: '', threshold: 3, flow: true, autobahn: true, interval: 2 }
};

/* ================================================================ Speicher */

const KEY = 'einsatznavi.v1.';
function load(name, fallback) {
  try {
    const raw = localStorage.getItem(KEY + name);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function save(name, value) {
  try { localStorage.setItem(KEY + name, JSON.stringify(value)); } catch { /* Speicher nicht verfügbar */ }
}
function mergeDeep(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!extra || typeof extra !== 'object') return out;
  for (const k of Object.keys(extra)) {
    const v = extra[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = mergeDeep(base[k], v);
    else out[k] = v;
  }
  return out;
}

const settings = mergeDeep(DEFAULTS, load('settings', {}));
/* Ältere gespeicherte Einstellungen: Haupt- und Bundesstraßen nachträglich freigeben. */
if (settings.contra.v !== 2) {
  settings.contra.classes = [...new Set([...settings.contra.classes, 'secondary', 'primary'])];
  settings.contra.dual = false;
  settings.contra.v = 2;
}
let closures = load('closures', []);
let recents = load('recents', []);

/* ================================================================ Geometrie */

const R_EARTH = 6371008.8;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}
function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
/* Ebene Näherung um eine Bezugsbreite, x nach Osten, y nach Norden, in Metern. */
function proj(p, lat0) { return [toRad(p[1]) * R_EARTH * Math.cos(toRad(lat0)), toRad(p[0]) * R_EARTH]; }
function planarBearing(a, b) { return (toDeg(Math.atan2(b[0] - a[0], b[1] - a[1])) + 360) % 360; }
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx, y = a[1] + t * dy;
  return { d: Math.hypot(p[0] - x, p[1] - y), t };
}
function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

/* Valhalla liefert Polylinien mit 6 Nachkommastellen. */
function decode6(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let res = 0, f = 1, b;
    do { b = str.charCodeAt(i++) - 63; res += (b & 31) * f; f *= 32; } while (b >= 32);
    return (res % 2) ? -(res + 1) / 2 : res / 2;
  };
  while (i < str.length) {
    lat += next(); lon += next();
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}

function simplify(points, tol) {
  if (points.length < 3) return points.slice();
  const lat0 = points[0][0];
  const xy = points.map(p => proj(p, lat0));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let k = s + 1; k < e; k++) {
      const d = segDist(xy[k], xy[s], xy[e]).d;
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, k) => keep[k]);
}

function circleRing(c, r, n = 16) {
  const ring = [];
  const dLat = r / 111320, dLon = r / (111320 * Math.cos(toRad(c[0])));
  for (let k = 0; k <= n; k++) {
    const a = (k % n) / n * 2 * Math.PI;
    ring.push([+(c[1] + dLon * Math.cos(a)).toFixed(7), +(c[0] + dLat * Math.sin(a)).toFixed(7)]);
  }
  return ring;
}
function squareRing(c, h) {
  const dy = h / 111320, dx = h / (111320 * Math.cos(toRad(c[0])));
  const [la, lo] = c;
  return [[lo - dx, la - dy], [lo + dx, la - dy], [lo + dx, la + dy], [lo - dx, la + dy], [lo - dx, la - dy]]
    .map(p => [+p[0].toFixed(7), +p[1].toFixed(7)]);
}

/* ================================================================ Formatierung */

const nf1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
function fmtDist(m) {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${nf1.format(m / 1000)} km`;
}
function fmtDur(s) {
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}:${String(r).padStart(2, '0')} min` : `${m} min`;
}
function spokenDist(m) {
  if (m >= 1000) return `${nf1.format(Math.round(m / 100) / 10).replace(',0', '')} Kilometern`;
  const step = m > 300 ? 100 : 50;
  return `${Math.max(step, Math.round(m / step) * step)} Metern`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* ================================================================ Netz */

async function fetchT(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

/* ================================================================ DOM */

const $ = id => document.getElementById(id);
const ui = {
  searchBar: $('searchBar'), destInput: $('destInput'), clearDest: $('clearDest'), suggestions: $('suggestions'),
  vehicleChip: $('vehicleChip'), vehicleChipText: $('vehicleChipText'), closureChip: $('closureChip'), closureCount: $('closureCount'),
  settingsBtn: $('settingsBtn'),
  navBanner: $('navBanner'), maneuver: document.querySelector('.maneuver'), mnvIcon: $('mnvIcon'), mnvDist: $('mnvDist'),
  mnvInstr: $('mnvInstr'), mnvNext: $('mnvNext'), contraWarn: $('contraWarn'), contraWarnText: $('contraWarnText'),
  closureBar: $('closureBar'), closureHint: $('closureHint'), closureUndo: $('closureUndo'), closureFinish: $('closureFinish'), closureDone: $('closureDone'),
  closureModeBtn: $('closureModeBtn'), layerBtn: $('layerBtn'), centerBtn: $('centerBtn'),
  routeSheet: $('routeSheet'), etaClock: $('etaClock'), remTime: $('remTime'), remDist: $('remDist'),
  routeBadges: $('routeBadges'), routeChoice: $('routeChoice'), routeStatus: $('routeStatus'), overviewBtn: $('overviewBtn'), simBtn: $('simBtn'), stopBtn: $('stopBtn'),
  gpsState: $('gpsState'), toast: $('toast'), scrim: $('scrim'),
  settingsPanel: $('settingsPanel'), closurePanel: $('closurePanel'),
  closureList: $('closureList'), closureEmpty: $('closureEmpty')
};

let toastTimer = null;
function toast(msg, kind = '', ms = 3800) {
  ui.toast.textContent = msg;
  ui.toast.className = 'toast ' + kind;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, ms);
}

/* ================================================================ Karte */

const savedView = load('view', null);
const map = L.map('map', { zoomControl: false, attributionControl: true, tapHold: true })
  .setView(savedView ? savedView.c : [51.16, 10.45], savedView ? savedView.z : 6);
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a> | Routing <a href="https://valhalla.github.io/valhalla/">Valhalla</a> | Suche Photon');
map.createPane('closures').style.zIndex = 405;
map.createPane('alt').style.zIndex = 415;
map.createPane('route').style.zIndex = 420;
map.createPane('contra').style.zIndex = 430;

let baseLayer = null;
function applyLayer() {
  const def = LAYERS[settings.layer] || LAYERS.osm;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(def.url, def.opt).addTo(map);
  document.body.classList.toggle('night', !!settings.night);
}
applyLayer();

let viewTimer = null;
map.on('moveend', () => {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { const c = map.getCenter(); save('view', { c: [c.lat, c.lng], z: map.getZoom() }); }, 800);
});

/* ================================================================ Zustand */

let gpsPos = null;          // letzter echter GPS-Fix
let manualStart = null;     // per Karte gesetzter Startpunkt
let dest = null;            // { lat, lon, label }
let destMarker = null;
let pendingRoute = false;
let routeToken = 0;
let firstFix = true;

const nav = {
  active: false, route: null, idx: 0, along: 0, offCount: 0, lastReroute: 0, follow: true,
  announced: new Set(), sim: null, simPos: null, wake: null, arrived: false,
  options: null,   /* { legal, contra }: beide berechneten Routen */
  pref: 'auto'     /* 'auto' bzw. 'contra' = Gegenrichtung bevorzugt, 'legal' = ohne Gegenrichtung */
};

/* ================================================================ Standort */

const posIcon = L.divIcon({
  className: '', iconSize: [34, 34], iconAnchor: [17, 17],
  html: '<div class="pos-marker"><div class="arrow"><svg viewBox="0 0 34 34"><path d="M17 1 L24 13 L10 13 Z"/></svg></div><div class="dot"></div></div>'
});
const posMarker = L.marker([0, 0], { icon: posIcon, interactive: false, keyboard: false, zIndexOffset: 1000 });
const accCircle = L.circle([0, 0], { radius: 1, interactive: false, stroke: false, fillOpacity: .12 });

function currentPos() {
  if (nav.sim && nav.simPos) return nav.simPos;
  if (manualStart) return { lat: manualStart[0], lon: manualStart[1], acc: 0, heading: null, speed: 0, manual: true };
  return gpsPos;
}
function trackingPos() {
  if (nav.sim && nav.simPos) return nav.simPos;
  if (manualStart) return null;
  return gpsPos;
}

function drawPosition() {
  const p = currentPos();
  if (!p) return;
  const ll = [p.lat, p.lon];
  posMarker.setLatLng(ll);
  if (!map.hasLayer(posMarker)) posMarker.addTo(map);
  accCircle.setLatLng(ll).setRadius(p.acc || 1).setStyle({ fillColor: cssVar('--route') });
  if (!map.hasLayer(accCircle) && p.acc) accCircle.addTo(map);
  const el = posMarker.getElement();
  if (el) {
    const m = el.querySelector('.pos-marker');
    m.classList.toggle('manual', !!p.manual);
    const arrow = el.querySelector('.arrow');
    const hd = displayHeading(p);
    arrow.style.visibility = hd == null ? 'hidden' : 'visible';
    if (hd != null) arrow.style.transform = `rotate(${hd}deg)`;
  }
}

/* Richtung des Positionspfeils: in Fahrt aus GPS, im Stand aus dem Kompass des iPhones */
let compass = null, compassOn = false, compassRaf = 0;
function displayHeading(p) {
  if (p.sim || p.manual) return p.heading;
  if (compass != null && (p.heading == null || (p.speed ?? 0) < 1.5)) return compass;
  return p.heading;
}
function onOrientation(e) {
  let h = e.webkitCompassHeading;
  if (h == null && e.absolute && e.alpha != null) h = 360 - e.alpha;
  if (h == null || Number.isNaN(h)) return;
  const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  compass = (h + screenAngle + 360) % 360;
  if (!compassRaf) compassRaf = requestAnimationFrame(() => { compassRaf = 0; drawPosition(); });
}
async function enableCompass() {
  if (compassOn) return;
  compassOn = true;
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      if (await DeviceOrientationEvent.requestPermission() !== 'granted') return;
    }
    window.addEventListener('deviceorientation', onOrientation, true);
  } catch { compassOn = false; }
}

function setGpsState(state, text) {
  ui.gpsState.dataset.state = state;
  ui.gpsState.textContent = text;
}

function onGps(geo) {
  const c = geo.coords;
  const p = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed ?? null, heading: null, t: geo.timestamp };
  if (c.heading != null && !Number.isNaN(c.heading) && (c.speed ?? 0) > 1) p.heading = c.heading;
  else if (gpsPos) {
    const moved = haversine([gpsPos.lat, gpsPos.lon], [p.lat, p.lon]);
    if (moved > 6) {
      const a = proj([gpsPos.lat, gpsPos.lon], p.lat), b = proj([p.lat, p.lon], p.lat);
      p.heading = planarBearing(a, b);
    } else p.heading = gpsPos.heading;
    if (p.speed == null && gpsPos.t) p.speed = moved / Math.max(1, (p.t - gpsPos.t) / 1000);
  }
  gpsPos = p;
  setGpsState('ok', `GPS ± ${Math.round(c.accuracy)} m`);
  if (nav.sim) return;
  drawPosition();
  if (firstFix && !nav.active && !manualStart) {
    firstFix = false;
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
  }
  if (pendingRoute && dest) computeRoute('new');
  else if (nav.active) navUpdate();
}

function onGpsError(err) {
  if (err.code === 1) {
    setGpsState('err', 'GPS nicht freigegeben');
    toast(window.isSecureContext
      ? 'Standortfreigabe verweigert. Startpunkt per langem Druck auf die Karte setzen.'
      : 'Standort benötigt HTTPS oder localhost. Seite über einen Webserver öffnen.', 'err', 6000);
  } else {
    setGpsState('wait', 'GPS-Signal schwach');
  }
}

function startGps() {
  if (!('geolocation' in navigator)) { setGpsState('err', 'Kein GPS verfügbar'); return; }
  navigator.geolocation.watchPosition(onGps, onGpsError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}

/* ================================================================ Suche */

let searchCtrl = null, searchTimer = null, suggestionItems = [], selIdx = -1;

function parseCoords(q) {
  const m = q.trim().match(/^(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, sub: 'Koordinate' };
}

function photonLabel(f) {
  const p = f.properties || {};
  const street = p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : '';
  const place = [p.postcode, p.city || p.town || p.village || p.county].filter(Boolean).join(' ');
  let main = p.name || street || place || 'Unbenannter Ort';
  if (p.name && p.housenumber && !p.street) main = `${p.name} ${p.housenumber}`;
  const sub = [p.name && street && p.name !== p.street ? street : '', p.district || p.locality || '', place]
    .filter(Boolean).filter((v, k, a) => a.indexOf(v) === k && v !== main).join(', ');
  return { main, sub };
}

async function photonSearch(q) {
  if (searchCtrl) searchCtrl.abort();
  searchCtrl = new AbortController();
  const p = currentPos();
  const c = p ? [p.lat, p.lon] : [map.getCenter().lat, map.getCenter().lng];
  const url = `${settings.servers.photon.replace(/\/$/, '')}/api/?q=${encodeURIComponent(q)}&lang=de&limit=7&lat=${c[0].toFixed(5)}&lon=${c[1].toFixed(5)}`;
  const res = await fetchT(url, { signal: searchCtrl.signal }, 8000);
  if (!res.ok) throw new Error('Adresssuche nicht erreichbar');
  const data = await res.json();
  return (data.features || []).map(f => {
    const { main, sub } = photonLabel(f);
    return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: main, sub };
  });
}

function renderSuggestions(items, head) {
  suggestionItems = items;
  selIdx = items.length ? 0 : -1;
  ui.suggestions.innerHTML = '';
  if (head && items.length) {
    const h = document.createElement('li');
    h.className = 's-head'; h.textContent = head;
    ui.suggestions.appendChild(h);
  }
  items.forEach((it, k) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', k === selIdx ? 'true' : 'false');
    li.innerHTML = `<span class="s-main">${esc(it.label)}</span>${it.sub ? `<span class="s-sub">${esc(it.sub)}</span>` : ''}`;
    if (it.disabled) li.classList.add('s-msg');
    else li.addEventListener('pointerdown', e => { e.preventDefault(); chooseDest(it); });
    ui.suggestions.appendChild(li);
  });
  ui.suggestions.hidden = items.length === 0;
}
function markSel() {
  [...ui.suggestions.querySelectorAll('li[role="option"]')].forEach((li, k) => li.setAttribute('aria-selected', k === selIdx ? 'true' : 'false'));
}
function showRecents() {
  renderSuggestions(recents.slice(0, 6).map(r => ({ ...r })), 'Letzte Ziele');
}

let lastQuery = null;
async function runSearch(q) {
  lastQuery = q;
  const coord = parseCoords(q);
  if (coord) { renderSuggestions([coord]); return [coord]; }
  const sp = parseSpecial(q);
  if (sp) {
    renderSuggestions([{ label: sp.type === 'bab' ? `Suche ${sp.road} km ${fmtKm(sp.km)}` : `Suche Strecke ${sp.nr}${sp.km != null ? ` km ${fmtKm(sp.km)}` : ''}`, sub: 'Kilometrierung wird abgefragt', disabled: true }]);
    try {
      const items = await specialSearch(sp);
      if (ui.destInput.value !== q) return items;
      renderSuggestions(items, sp.type === 'bab' ? 'Fahrtrichtung wählen' : '');
      return items;
    } catch (e) {
      const msg = [{ label: e.message, sub: 'Eingabe prüfen, z. B. „A5 km 487,3“ oder „Strecke 4000 km 12,345“', disabled: true }];
      if (ui.destInput.value === q) renderSuggestions(msg);
      return [];
    }
  }
  if (q.trim().length < 3) { showRecents(); return []; }
  try {
    const items = await photonSearch(q);
    if (ui.destInput.value !== q) return items;
    renderSuggestions(items);
    if (!items.length) renderSuggestions([], '');
    return items;
  } catch (e) {
    if (e.name !== 'AbortError') toast('Adresssuche nicht erreichbar', 'err');
    return [];
  }
}

ui.destInput.addEventListener('input', () => {
  const q = ui.destInput.value;
  ui.clearDest.hidden = !q;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(q), 220);
});
ui.destInput.addEventListener('focus', () => { if (!ui.destInput.value) showRecents(); });
ui.destInput.addEventListener('blur', () => setTimeout(() => { ui.suggestions.hidden = true; }, 150));
ui.destInput.addEventListener('keydown', async e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!suggestionItems.length) return;
    e.preventDefault();
    selIdx = (selIdx + (e.key === 'ArrowDown' ? 1 : -1) + suggestionItems.length) % suggestionItems.length;
    markSel();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    let items = suggestionItems;
    if (!items.length || lastQuery !== ui.destInput.value) items = await runSearch(ui.destInput.value);
    const it = items[Math.max(0, selIdx)];
    if (it && !it.disabled) chooseDest(it); else if (!it) toast('Kein Treffer für diese Eingabe', 'warn');
  } else if (e.key === 'Escape') {
    ui.suggestions.hidden = true;
  }
});
ui.clearDest.addEventListener('click', () => {
  ui.destInput.value = ''; ui.clearDest.hidden = true; ui.destInput.focus(); showRecents();
});

function addRecent(d) {
  recents = [{ lat: d.lat, lon: d.lon, label: d.label, sub: d.sub || '', loc: d.loc || null, kmInfo: d.kmInfo || null },
    ...recents.filter(r => haversine([r.lat, r.lon], [d.lat, d.lon]) > 15)].slice(0, 8);
  save('recents', recents);
}

async function reverseLabel(lat, lon) {
  try {
    const res = await fetchT(`${settings.servers.photon.replace(/\/$/, '')}/reverse?lat=${lat}&lon=${lon}&lang=de`, {}, 6000);
    const data = await res.json();
    const f = (data.features || [])[0];
    return f ? photonLabel(f) : null;
  } catch { return null; }
}

/* ================================================================ Ziel */

const destIcon = L.divIcon({
  className: 'dest-marker', iconSize: [34, 44], iconAnchor: [17, 42],
  html: '<svg viewBox="0 0 34 44"><path d="M17 43C17 43 3 26 3 16a14 14 0 0 1 28 0c0 10-14 27-14 27z"/><circle cx="17" cy="16" r="5" fill="#fff" stroke="none"/></svg>'
});

function chooseDest(d) {
  if (d.action) { ui.suggestions.hidden = true; ui.destInput.blur(); d.action(); return; }
  if (!d.kmInfo || d.kmInfo.kind !== 'rail') railLayer.clearLayers();
  dest = { lat: d.lat, lon: d.lon, label: d.label, sub: d.sub || '', loc: d.loc || null, kmInfo: d.kmInfo || null };
  ui.destInput.value = d.label;
  ui.suggestions.hidden = true;
  ui.destInput.blur();
  addRecent(dest);
  if (destMarker) destMarker.setLatLng([dest.lat, dest.lon]);
  else destMarker = L.marker([dest.lat, dest.lon], { icon: destIcon, keyboard: false }).addTo(map);
  unlockSpeech();
  nav.follow = true;
  nav.arrived = false;
  nav.pref = 'auto';
  enableCompass();
  if (!v3el.box.hidden) { v3el.addr.textContent = dest.label; focus3d(true); }
  onDestChosen();
  computeRoute('new');
}

/* ================================================================ Sperrungen */

const closureLayer = L.layerGroup().addTo(map);
let cmode = null;                 // null | 'point' | 'area'
let ctool = 'point';
let areaPts = [];
let areaDraft = null;

function closureRing(c) {
  return c.kind === 'point' ? circleRing(c.center, c.radius) : [...c.ring.map(p => [p[1], p[0]]), [c.ring[0][1], c.ring[0][0]]];
}

function drawClosures() {
  closureLayer.clearLayers();
  const col = cssVar('--closure');
  const style = { pane: 'closures', color: col, weight: 3, dashArray: '8 6', fillColor: col, fillOpacity: .28 };
  for (const c of closures) {
    const lyr = c.kind === 'point'
      ? L.circle(c.center, { ...style, radius: c.radius })
      : L.polygon(c.ring, style);
    lyr.bindPopup(() => {
      const div = document.createElement('div');
      div.innerHTML = `<div class="ctx-title">${esc(c.label)}</div><button class="btn danger small" type="button">Sperrung aufheben</button>`;
      div.querySelector('button').addEventListener('click', () => { map.closePopup(); removeClosure(c.id); });
      return div;
    }, { className: 'ctx-pop' });
    lyr.addTo(closureLayer);
  }
  ui.closureCount.textContent = closures.length;
  ui.closureChip.classList.toggle('has', closures.length > 0);
  renderClosureList();
}

function renderClosureList() {
  ui.closureList.innerHTML = '';
  ui.closureEmpty.hidden = closures.length > 0;
  for (const c of closures) {
    const li = document.createElement('li');
    const t = new Date(c.created);
    li.innerHTML = `<span class="sw"></span>
      <div class="meta"><input type="text" value="${esc(c.label)}" aria-label="Bezeichnung der Sperrung">
      <small>${c.kind === 'point' ? `Punkt, Radius ${c.radius} m` : `Fläche, ${c.ring.length} Eckpunkte`} · ${t.toLocaleDateString('de-DE')} ${t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</small></div>
      <button class="btn ghost small" type="button" data-act="show">Zeigen</button>
      <button class="btn danger small" type="button" data-act="del">Aufheben</button>`;
    li.querySelector('input').addEventListener('change', e => { c.label = e.target.value.trim() || c.label; persistClosures(false); });
    li.querySelector('[data-act="show"]').addEventListener('click', () => {
      closePanels();
      nav.follow = false; syncFollowUi();
      if (c.kind === 'point') map.setView(c.center, 17); else map.fitBounds(c.ring, { padding: [60, 60] });
    });
    li.querySelector('[data-act="del"]').addEventListener('click', () => removeClosure(c.id));
    ui.closureList.appendChild(li);
  }
}

let closureRerouteTimer = null;
function persistClosures(reroute = true) {
  save('closures', closures);
  drawClosures();
  if (reroute && dest && nav.active) {
    clearTimeout(closureRerouteTimer);
    closureRerouteTimer = setTimeout(() => computeRoute('closure'), 700);
  }
}

function addClosure(c) {
  c.id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  c.created = new Date().toISOString();
  closures.push(c);
  persistClosures();
  const ref = c.kind === 'point' ? c.center : c.ring[0];
  reverseLabel(ref[0], ref[1]).then(l => {
    if (!l) return;
    const name = (l.main && !/^\d/.test(l.main)) ? l.main : l.sub;
    if (name && /^Sperrung \d/.test(c.label)) { c.label = `Sperrung ${name}`; persistClosures(false); }
  });
}
function removeClosure(id) {
  closures = closures.filter(c => c.id !== id);
  persistClosures();
  toast('Sperrung aufgehoben');
}

function setClosureTool(tool) {
  ctool = tool;
  document.querySelectorAll('[data-ctool]').forEach(b => {
    const on = b.dataset.ctool === tool;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  resetArea();
  updateClosureHint();
}
function updateClosureHint() {
  if (ctool === 'point') ui.closureHint.textContent = `Auf die gesperrte Straße tippen (Radius ${settings.radius} m)`;
  else ui.closureHint.textContent = areaPts.length < 3 ? `Eckpunkte setzen: ${areaPts.length} von mindestens 3` : `${areaPts.length} Eckpunkte. Weitere setzen oder Fläche sperren`;
  ui.closureUndo.hidden = ctool !== 'area' || !areaPts.length;
  ui.closureFinish.hidden = ctool !== 'area' || areaPts.length < 3;
}
function resetArea() {
  areaPts = [];
  if (areaDraft) { map.removeLayer(areaDraft); areaDraft = null; }
}
function drawAreaDraft() {
  if (areaDraft) map.removeLayer(areaDraft);
  const col = cssVar('--closure');
  areaDraft = L.layerGroup().addTo(map);
  if (areaPts.length >= 2) L.polygon(areaPts, { pane: 'closures', color: col, weight: 3, fillColor: col, fillOpacity: .15, interactive: false }).addTo(areaDraft);
  areaPts.forEach(p => L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="vertex-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false }).addTo(areaDraft));
}

function enterClosureMode(tool = 'point') {
  closePanels();
  map.closePopup();
  cmode = true;
  ui.closureBar.hidden = false;
  ui.searchBar.hidden = true;
  ui.navBanner.hidden = true;
  nav.follow = false; syncFollowUi();
  setClosureTool(tool);
  map.getContainer().style.cursor = 'crosshair';
}
function exitClosureMode() {
  cmode = null;
  resetArea();
  ui.closureBar.hidden = true;
  map.getContainer().style.cursor = '';
  syncTopUi();
}

map.on('click', e => {
  if (!cmode) return;
  const ll = [e.latlng.lat, e.latlng.lng];
  if (ctool === 'point') {
    addClosure({ kind: 'point', center: ll, radius: +settings.radius || 20, label: `Sperrung ${closures.length + 1}` });
    toast('Sperrung eingetragen. Route wird angepasst.');
  } else {
    areaPts.push(ll);
    drawAreaDraft();
    updateClosureHint();
  }
});
document.querySelectorAll('[data-ctool]').forEach(b => b.addEventListener('click', () => setClosureTool(b.dataset.ctool)));
ui.closureUndo.addEventListener('click', () => { areaPts.pop(); drawAreaDraft(); updateClosureHint(); });
ui.closureFinish.addEventListener('click', () => {
  if (areaPts.length < 3) return;
  addClosure({ kind: 'area', ring: areaPts.slice(), label: `Sperrung ${closures.length + 1}` });
  resetArea(); updateClosureHint();
  toast('Sperrfläche eingetragen. Route wird angepasst.');
});
ui.closureDone.addEventListener('click', () => {
  if (ctool === 'area' && areaPts.length >= 3) ui.closureFinish.click();
  exitClosureMode();
});
ui.closureModeBtn.addEventListener('click', () => { cmode ? exitClosureMode() : enterClosureMode('point'); });

$('closureAdd').addEventListener('click', () => enterClosureMode('point'));
$('closureClear').addEventListener('click', e => {
  const b = e.currentTarget;
  if (!closures.length) return;
  if (b.dataset.confirm !== '1') {
    b.dataset.confirm = '1'; b.textContent = 'Wirklich alle aufheben?'; b.classList.replace('ghost', 'danger');
    setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Alle aufheben'; b.classList.replace('danger', 'ghost'); }, 4000);
    return;
  }
  b.dataset.confirm = ''; b.textContent = 'Alle aufheben'; b.classList.replace('danger', 'ghost');
  closures = []; persistClosures(); toast('Alle Sperrungen aufgehoben');
});
$('closureExport').addEventListener('click', async () => {
  const json = JSON.stringify({ type: 'einsatznavi-sperrungen', version: 1, exported: new Date().toISOString(), closures }, null, 2);
  const name = `sperrungen-${new Date().toISOString().slice(0, 10)}.json`;
  /* iPhone: Teilen-Menü (AirDrop, Nachrichten, Dateien) */
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Sperrungen Einsatznavigation' });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('closureImport').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.closures;
    const valid = (list || []).filter(c => c && (c.kind === 'point' ? Array.isArray(c.center) && c.radius > 0 : c.kind === 'area' && Array.isArray(c.ring) && c.ring.length >= 3));
    const known = new Set(closures.map(c => c.id));
    let n = 0;
    for (const c of valid) {
      if (!c.id || known.has(c.id)) c.id = 'c' + Math.random().toString(36).slice(2, 10);
      c.label = c.label || 'Importierte Sperrung';
      c.created = c.created || new Date().toISOString();
      closures.push(c); n++;
    }
    persistClosures();
    toast(`${n} Sperrungen importiert`);
  } catch { toast('Datei konnte nicht gelesen werden', 'err'); }
});

/* ================================================================ Routing */

function vehicleOptions(contra) {
  const v = settings.vehicle;
  const costing = v.type === 'lkw' ? 'truck' : 'auto';
  const co = { ignore_oneways: !!contra };
  if (costing === 'truck') {
    Object.assign(co, {
      height: +v.height, width: +v.width, length: +v.length,
      weight: +v.weight, axle_load: +v.axle, hazmat: false
    });
  }
  return { costing, co };
}

function routeError(data, status) {
  const code = data && data.error_code;
  let msg = 'Routing fehlgeschlagen';
  if (code === 442 || code === 443) msg = 'Keine befahrbare Route gefunden. Sperrungen oder Fahrzeugmaße prüfen.';
  else if (code === 171 || code === 170) msg = 'Start oder Ziel liegt zu weit von einer befahrbaren Straße entfernt.';
  else if (code === 154 || code === 167) msg = 'Sperrflächen zu groß für den Routingserver.';
  else if (status === 429) msg = 'Routingserver überlastet. Kurz warten.';
  else if (data && data.error) msg = `Routing: ${data.error}`;
  const err = new Error(msg); err.code = code; return err;
}

/* Weitere Endpunkte desselben Valhalla-Servers (locate, trace_attributes, trace_route) */
function vEndpoint(name) {
  const url = settings.servers.valhalla.replace(/\/route\/?$/, '/' + name);
  if (url === settings.servers.valhalla) throw new Error(`Endpunkt ${name} nicht ableitbar`);
  return url;
}

/* POST mit JSON, ersatzweise GET mit ?json= */
async function postJson(url, body, ms = 15000) {
  const json = JSON.stringify(body);
  let res;
  try {
    res = await fetchT(url, { method: 'POST', body: json }, ms);
    if (res.status === 405 || res.status === 404) throw new TypeError('POST abgelehnt');
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Server antwortet nicht (Zeitüberschreitung)');
    const getUrl = `${url}?json=${encodeURIComponent(json)}`;
    if (getUrl.length > 7500) throw new Error('Server nicht erreichbar');
    dlog(`POST an ${url.split('/').pop()} fehlgeschlagen (${e.message || e.name}), versuche GET`);
    try { res = await fetchT(getUrl, {}, ms); } catch (e2) {
      throw new Error(e2.name === 'AbortError' ? 'Server antwortet nicht (Zeitüberschreitung)' : 'Server nicht erreichbar');
    }
  }
  let data = null;
  try { data = await res.json(); } catch { /* keine JSON-Antwort */ }
  return { res, data };
}

/* Ausschlussflächen für gestaute Abschnitte, gelten für alle Berechnungen der laufenden Routensuche */
let activeTrafficRings = [];

async function valhalla(from, to, { contra = false, extraRings = [], extraCo = {}, alternates = 0 } = {}) {
  const { costing, co } = vehicleOptions(contra);
  const loc0 = { lat: +from.lat.toFixed(6), lon: +from.lon.toFixed(6), type: 'break' };
  if (from.heading != null && (from.speed ?? 0) > 2.5) { loc0.heading = Math.round(from.heading); loc0.heading_tolerance = 60; }
  const rings = closures.map(closureRing).concat(activeTrafficRings, extraRings);
  const loc1 = { lat: +to.lat.toFixed(6), lon: +to.lon.toFixed(6), type: 'break', ...(to.loc || {}) };
  const body = {
    locations: [loc0, loc1],
    costing,
    costing_options: { [costing]: { ...co, ...extraCo } },
    language: 'de-DE',
    units: 'kilometers'
  };
  if (alternates) body.alternates = alternates;
  if (rings.length) body.exclude_polygons = rings;
  let r;
  try { r = await postJson(settings.servers.valhalla, body, 15000); } catch (e) {
    throw new Error(e.message.replace('Server', 'Routingserver'));
  }
  const { res, data } = r;
  if (!res.ok || !data || data.error || !data.trip) throw routeError(data, res.status);
  const main = parseTrip(data.trip, contra);
  main.alts = (data.alternates || []).filter(x => x && x.trip).map(x => parseTrip(x.trip, contra));
  return main;
}

function parseTrip(trip, contra) {
  const leg = trip.legs[0];
  const shape = decode6(leg.shape);
  const lat0 = shape[0][0];
  const xy = shape.map(p => proj(p, lat0));
  const cum = [0];
  for (let k = 1; k < shape.length; k++) cum.push(cum[k - 1] + Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]));
  return {
    shape, xy, lat0, cum,
    rawShape: leg.shape,
    total: cum[cum.length - 1],
    time: trip.summary.time,
    maneuvers: leg.maneuvers || [],
    contraAllowed: contra,
    contra: [],
    contraLen: 0,
    gain: 0,
    vehicle: settings.vehicle.type
  };
}

function routeStreets(r) {
  const out = [];
  for (const m of r.maneuvers) for (const n of (m.street_names || [])) if (out[out.length - 1] !== n) out.push(n);
  return out.join(' > ');
}

/* ---------- Einbahnprüfung über den Routingserver ----------
   Der Server berechnet Kandidaten mit aufgehobener Einbahnbeschränkung. Über trace_attributes
   wird je Abschnitt die zulässige Fahrtrichtung abgefragt (traversability). "backward" bedeutet,
   dass der Abschnitt entgegen der Einbahnrichtung befahren wird. */

const TRACE_ATTRS = ['shape', 'edge.names', 'edge.traversability', 'edge.road_class', 'edge.use', 'edge.roundabout',
  'edge.begin_shape_index', 'edge.end_shape_index', 'edge.length', 'edge.way_id', 'edge.speed', 'edge.forward'];

async function edgeAttributes(route) {
  const { costing, co } = vehicleOptions(true);
  const url = vEndpoint('trace_attributes');
  let last;
  for (const match of ['edge_walk', 'map_snap']) {
    try {
      const { res, data } = await postJson(url, {
        encoded_polyline: route.rawShape, shape_match: match,
        costing, costing_options: { [costing]: co },
        filters: { attributes: TRACE_ATTRS, action: 'include' }
      }, 12000);
      if (!res.ok || !data || !Array.isArray(data.edges)) throw new Error(data && data.error ? data.error : 'HTTP ' + res.status);
      return { edges: data.edges, shape: data.shape ? decode6(data.shape) : route.shape, match };
    } catch (e) { last = e; dlog(`  trace_attributes (${match}) fehlgeschlagen: ${e.message}`); }
  }
  throw last;
}

/* Index eines Punkts der Abgleichsgeometrie auf der Routengeometrie */
function indexMapper(route, shape) {
  if (shape.length === route.shape.length && haversine(shape[0], route.shape[0]) < 1 && haversine(shape[shape.length - 1], route.shape[route.shape.length - 1]) < 1) return i => i;
  let from = 0;
  return i => {
    const p = shape[Math.min(i, shape.length - 1)];
    let best = from, bd = Infinity;
    for (let k = from; k < route.shape.length; k++) {
      const d = haversine(p, route.shape[k]);
      if (d < bd) { bd = d; best = k; }
      if (d > bd + 300) break;
    }
    from = best;
    return best;
  };
}

function edgeClass(e) {
  const rc = e.road_class || 'unclassified';
  if (e.use === 'living_street') return 'living_street';
  if (rc === 'service_other') return 'service';
  return rc;
}

/* Fahrtrichtung je Einbahnabschnitt über locate bestimmen. locate liefert jede Fahrspur eines Wegs
   als eigenen Eintrag mit Richtung (heading) und PKW-Freigabe (edge.access.car). Ist in unserer
   Fahrtrichtung keine Spur freigegeben, wohl aber in der Gegenrichtung, wird der Abschnitt
   entgegen der Einbahnrichtung befahren. */
async function classifyDirection(route, cand) {
  for (let i = 0; i < cand.length && i < 150; i += 50) {
    const chunk = cand.slice(i, Math.min(i + 50, 150));
    const locs = chunk.map(it => {
      const k = Math.max(0, Math.min(route.shape.length - 2, Math.floor((it.b + it.en - 1) / 2)));
      it.brg = planarBearing(route.xy[k], route.xy[k + 1]);
      const p = lerp(route.shape[k], route.shape[k + 1], .5);
      return { lat: +p[0].toFixed(6), lon: +p[1].toFixed(6), radius: 5 };
    });
    let data = null;
    try {
      const r = await postJson(vEndpoint('locate'), { locations: locs, costing: 'auto', verbose: true }, 10000);
      if (r.res.ok && Array.isArray(r.data)) data = r.data;
      else throw new Error(r.data && r.data.error ? r.data.error : 'HTTP ' + r.res.status);
    } catch (e) { dlog(`  locate fehlgeschlagen: ${e.message}`); }
    chunk.forEach((it, j) => {
      const edges = (data && data[j] && data[j].edges) || [];
      const same = edges.filter(x => x.edge_info && x.edge_info.way_id === it.e.way_id && x.heading != null);
      if (same.length) {
        const car = x => !!(x.edge && x.edge.access && x.edge.access.car);
        const withUs = same.some(x => car(x) && angDiff(x.heading, it.brg) <= 60);
        const against = same.some(x => car(x) && angDiff(x.heading, it.brg) >= 120);
        it.contra = !withUs && against;
        it.how = 'locate';
        it.detail = withUs ? (against ? 'beide Richtungen frei' : 'Fahrtrichtung frei') : against ? 'nur Gegenrichtung frei' : 'keine Richtung frei';
      } else {
        /* Ersatzregel: traversability bezieht sich auf die Zeichenrichtung des Wegs */
        const t = it.e.traversability, fw = it.e.forward;
        it.contra = (t === 'forward' && fw === false) || (t === 'backward' && fw === true);
        it.how = 'Annahme';
        it.detail = `traversability ${t}, forward ${fw}`;
      }
    });
  }
}

async function analyzeEdges(route) {
  const attr = await edgeAttributes(route);
  const map = indexMapper(route, attr.shape);
  const last = route.shape.length - 1;
  const items = attr.edges.map(e => {
    const b = Math.min(map(e.begin_shape_index ?? 0), last - 1);
    const en = Math.min(last, Math.max(b + 1, map(e.end_shape_index ?? 0)));
    return { e, b, en, contra: false };
  });
  const hasTrav = attr.edges.some(e => e.traversability);
  const cand = items.filter(it => (it.e.length || 0) > 0.001 && (!hasTrav || (it.e.traversability && it.e.traversability !== 'both')));
  dlog(`  ${attr.edges.length} Abschnitte (Abgleich ${attr.match}), davon ${cand.length} mit Einbahnregelung`);
  if (cand.length) await classifyDirection(route, cand);
  /* Zweiter Durchgang: Der Kandidat ist schneller als die reguläre Route, also über alle Abschnitte prüfen */
  if (!cand.some(it => it.contra)) {
    const rest = items.filter(it => !cand.includes(it) && (it.e.length || 0) > 0.001);
    if (rest.length) {
      dlog(`  keine Gegenrichtung unter den markierten Abschnitten, prüfe alle ${rest.length} übrigen Abschnitte`);
      await classifyDirection(route, rest);
      rest.filter(it => it.contra).forEach(it => cand.push(it));
    }
  }
  cand.slice(0, 12).forEach(it => dlog(`    ${(it.e.names && it.e.names[0]) || 'unbenannt'} (${edgeClass(it.e)}, ${Math.round((it.e.length || 0) * 1000)} m): ${it.contra ? 'GEGEN' : 'mit'} Einbahnrichtung, ${it.detail} [${it.how}]`));

  const ranges = [], forbidden = [], rejected = [];
  const seen = new Set();
  let cur = null;
  for (const it of items) {
    const e = it.e;
    if (!it.contra) { if ((e.length || 0) > 0.002) cur = null; continue; }
    const cls = edgeClass(e);
    const name = (e.names && e.names[0]) || '';
    let reason = null;
    if (cls === 'motorway' || cls === 'trunk' || e.roundabout) reason = 'never';
    else if (!contraAllowedOn(cls)) reason = 'class';
    if (!cur) { cur = { i0: it.b, i1: it.en - 1, len: 0, names: new Set(), classes: new Set(), wayIds: new Set(), dual: false, reason: null }; ranges.push(cur); }
    cur.i1 = Math.max(cur.i1, it.en - 1);
    cur.len += (e.length || 0) * 1000;
    if (name) cur.names.add(name);
    cur.classes.add(cls);
    if (e.way_id) cur.wayIds.add(e.way_id);
    if (reason) {
      cur.reason = cur.reason || reason;
      const key = e.way_id || name || it.b;
      if (!seen.has(key)) {
        seen.add(key);
        forbidden.push(lerp(route.shape[it.b], route.shape[it.en], .5));
        rejected.push({ id: e.way_id, name: name || 'unbenannte Straße', highway: cls, reason });
      }
    }
  }
  const out = ranges.map(r => ({ ...r, names: [...r.names], classes: [...r.classes], wayIds: [...r.wayIds] }));
  return { ranges: out, forbidden, rejected, match: attr.match, edges: attr.edges.length };
}

/* Getrennte Richtungsfahrbahn: parallel zum Abschnitt verläuft in 8–30 m Abstand eine
   Fahrbahn gleichen Namens, welche in unserer Fahrtrichtung für PKW freigegeben ist. */
async function markDual(route, ranges) {
  const pts = [], owner = [];
  for (const r of ranges.slice(0, 6)) {
    const k = Math.min(route.shape.length - 2, Math.floor((r.i0 + r.i1) / 2));
    const a = route.xy[k], b = route.xy[k + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
    const m = lerp(route.shape[k], route.shape[k + 1], .5);
    r.bearing = planarBearing(a, b);
    for (const sgn of [-1, 1]) {
      const off = 18 * sgn;
      pts.push({ lat: +(m[0] + ny * off / 111320).toFixed(6), lon: +(m[1] + nx * off / (111320 * Math.cos(toRad(m[0])))).toFixed(6), radius: 12 });
      owner.push(r);
    }
  }
  if (!pts.length) return;
  const { res, data } = await postJson(vEndpoint('locate'), { locations: pts, costing: 'auto', verbose: true }, 10000);
  if (!res.ok || !Array.isArray(data)) throw new Error(data && data.error ? data.error : 'HTTP ' + res.status);
  data.forEach((loc, i) => {
    const r = owner[i];
    for (const e of (loc && loc.edges) || []) {
      const names = (e.edge_info && e.edge_info.names) || [];
      const way = e.edge_info && e.edge_info.way_id;
      const car = e.edge && e.edge.access && e.edge.access.car;
      if (!car || r.wayIds.includes(way) || e.heading == null) continue;
      if (angDiff(e.heading, r.bearing) > 35) continue;
      const same = names.some(n => r.names.includes(n)) || (!names.length && !r.names.length);
      if (same) { r.dual = true; r.dualWith = names[0] || 'Parallelfahrbahn'; }
    }
  });
}

async function valhallaContra(from, to, normal, token) {
  const minGain = settings.contra.minGain;
  const variants = [
    { label: 'Gegenrichtung schnellste', extraCo: {}, alternates: 2 },
    { label: 'Gegenrichtung kürzeste', extraCo: { shortest: true }, alternates: 0 }
  ];
  const first = await Promise.all(variants.map(v =>
    valhalla(from, to, { contra: true, extraCo: v.extraCo, alternates: v.alternates })
      .then(r => ({ v, list: [r, ...(r.alts || [])] }))
      .catch(e => ({ v, error: e }))));
  const queue = [];
  for (const f of first) {
    if (f.error) { dlog(`${f.v.label}: fehlgeschlagen (${f.error.message})`); continue; }
    f.list.forEach((r, k) => queue.push({ route: r, v: f.v, label: f.v.label + (k ? ` Alternative ${k}` : ''), rings: [], depth: 0 }));
  }
  const tried = new Set();
  const rejected = [];
  let best = null;
  for (let n = 0; n < queue.length && n < 10; n++) {
    if (token !== routeToken) return { best: null, rejected };
    const c = queue[n];
    if (tried.has(c.route.rawShape)) continue;
    tried.add(c.route.rawShape);
    if (trafficOn()) annotateTraffic(c.route);
    const gain = normal ? effTime(normal) - effTime(c.route) : Infinity;
    dlog(`${c.label}: ${fmtDur(c.route.time)}, ${fmtDist(c.route.total)}: ${routeStreets(c.route)}`);
    if (gain < minGain) { dlog(gain > 0 ? `  nur ${gain.toFixed(1)} s schneller, Schwelle ${minGain} s` : gain === 0 ? '  gleich schnell wie reguläre Route' : `  ${(-gain).toFixed(1)} s langsamer als reguläre Route`); continue; }
    let an;
    try { an = await analyzeEdges(c.route); } catch (e) { dlog(`  Einbahnprüfung nicht möglich: ${e.message}`); continue; }
    if (!an.ranges.length) { dlog('  kein Abschnitt entgegen der Einbahnrichtung'); continue; }
    const desc = an.ranges.map(r => `${r.names.join('/') || 'unbenannt'} ${fmtDist(r.len)} [${r.classes.join(',')}${r.reason ? ', ' + (r.reason === 'class' ? 'Klasse gesperrt' : REASON_TEXT[r.reason]) : ''}]`).join(', ');
    dlog(`  entgegen Einbahnrichtung: ${desc}`);
    if (!an.forbidden.length && !settings.contra.dual) {
      try {
        await markDual(c.route, an.ranges);
        for (const r of an.ranges) if (r.dual) {
          dlog(`  ${r.names[0] || 'Abschnitt'}: Gegenfahrbahn ${r.dualWith} erkannt`);
          const k = Math.min(c.route.shape.length - 2, Math.floor((r.i0 + r.i1) / 2));
          an.forbidden.push(lerp(c.route.shape[k], c.route.shape[k + 1], .5));
          an.rejected.push({ id: r.wayIds[0], name: r.names[0] || 'unbenannte Straße', highway: r.classes[0], reason: 'dual' });
        }
      } catch (e) { dlog(`  Prüfung auf Richtungsfahrbahn nicht möglich (${e.message}), Abschnitt gilt als einfache Einbahnstraße`); }
    }
    if (an.forbidden.length) {
      rejected.push(...an.rejected);
      if (c.depth < 2) {
        const rings = c.rings.concat(an.forbidden.map(p => squareRing(p, 3)));
        try {
          const r = await valhalla(from, to, { contra: true, extraCo: c.v.extraCo, extraRings: rings });
          queue.push({ route: r, v: c.v, label: `${c.v.label} ohne ${an.rejected.map(x => x.name).join(', ')}`, rings, depth: c.depth + 1 });
        } catch (e) { dlog(`  Neuberechnung ohne gesperrte Abschnitte fehlgeschlagen: ${e.message}`); }
      }
      continue;
    }
    dlog(`  zulässig, Zeitgewinn ${gain.toFixed(1)} s`);
    if (!best || c.route.time < best.route.time) best = { route: c.route, gain, ranges: an.ranges };
  }
  return { best, rejected };
}

/* ---------- Einbahnprüfung über Overpass ---------- */

function onewayDir(t) {
  const o = (t.oneway || '').toLowerCase();
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'yes' || o === '1' || o === 'true') return 1;
  if (o === 'no' || o === 'false' || o === '0' || o === 'reversible' || o === 'alternating') return 0;
  if (t.junction === 'roundabout' || t.junction === 'circular') return 1;
  if (t.highway === 'motorway' || t.highway === 'motorway_link') return 1;
  return 0;
}
function isRoundabout(t) { return t.junction === 'roundabout' || t.junction === 'circular'; }
function baseClass(h) { return (h || '').replace(/_link$/, ''); }
function contraAllowedOn(highway) {
  if (NEVER_CONTRA.has(highway)) return false;
  const allowed = new Set(settings.contra.classes);
  return allowed.has(highway) || allowed.has(baseClass(highway));
}

async function overpass(query) {
  const urls = [settings.servers.overpass];
  if (settings.servers.overpass === DEFAULT_SERVERS.overpass) urls.push(...OVERPASS_MIRRORS);
  let lastErr;
  for (const url of urls) {
    let host = url;
    try { host = new URL(url).host; } catch { /* Adresse unverändert anzeigen */ }
    const t0 = performance.now();
    try {
      const res = await fetchT(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      }, 12000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.remark && /error|timed out|runtime|out of memory/i.test(data.remark)) throw new Error(data.remark.slice(0, 140));
      dlog(`Kartendaten von ${host}: ${(data.elements || []).length} Elemente in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      return data;
    } catch (e) {
      lastErr = e;
      dlog(`Kartendaten von ${host} fehlgeschlagen: ${e.name === 'AbortError' ? 'Zeitüberschreitung (12 s)' : (e.message || e.name)}`);
    }
  }
  throw new Error(lastErr && lastErr.name !== 'AbortError' ? `Kartendaten nicht abrufbar, ${lastErr.message}` : 'Kartendaten nicht abrufbar');
}

/* Ordnet jedem Routenabschnitt die Einbahnrichtung der darunterliegenden OSM-Straße zu.
   Ergebnis: Bereiche gegen die Fahrtrichtung, unzulässige Abschnitte mit Begründung
   und je unzulässiger Straße ein Punkt, an welchem die Route ausgeschlossen wird. */
const CLASS_LABEL = Object.fromEntries(CLASSES);
const REASON_TEXT = {
  never: 'Autobahn, Kraftfahrstraße oder Kreisverkehr',
  dual: 'getrennte Richtungsfahrbahn mit Gegenfahrbahn',
  class: 'Straßenklasse nicht freigegeben'
};

function matchContraflow(route, elements) {
  const { xy, lat0, cum } = route;
  const CELL = 25;
  const grid = new Map();
  const key = (cx, cy) => cx + ':' + cy;
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || !el.tags) continue;
    const dir = onewayDir(el.tags);
    if (!dir) continue;
    const pts = el.geometry.map(g => proj([g.lat, g.lon], lat0));
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const brg = planarBearing(a, b);
      const seg = { a, b, dir, way: el, brg, allowed: dir === 1 ? brg : (brg + 180) % 360 };
      const x0 = Math.floor((Math.min(a[0], b[0]) - 5) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + 5) / CELL);
      const y0 = Math.floor((Math.min(a[1], b[1]) - 5) / CELL), y1 = Math.floor((Math.max(a[1], b[1]) + 5) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const kk = key(cx, cy);
        if (!grid.has(kk)) grid.set(kk, []);
        grid.get(kk).push(seg);
      }
    }
  }
  const near = (m, r) => {
    const out = new Set();
    const n = Math.ceil(r / CELL);
    const cx = Math.floor(m[0] / CELL), cy = Math.floor(m[1] / CELL);
    for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) {
      const c = grid.get(key(cx + dx, cy + dy));
      if (c) c.forEach(s => out.add(s));
    }
    return out;
  };

  /* Getrennte Richtungsfahrbahn: parallel verläuft eine zweite Einbahnfahrbahn gleichen Namens
     (oder gleicher Klasse ohne Namen), welche genau in unserer Fahrtrichtung freigegeben ist. */
  const dualCache = new Map();
  const isDual = (m, brg, way) => {
    if (dualCache.has(way.id)) return dualCache.get(way.id);
    let found = false;
    for (const s of near(m, 60)) {
      if (s.way.id === way.id) continue;
      if (angDiff(brg, s.allowed) > 35) continue;
      const sameName = way.tags.name && s.way.tags.name === way.tags.name;
      const sameRef = way.tags.ref && s.way.tags.ref === way.tags.ref;
      const unnamedPair = !way.tags.name && !s.way.tags.name && baseClass(s.way.tags.highway) === baseClass(way.tags.highway);
      if (!sameName && !sameRef && !unnamedPair) continue;
      const d = segDist(m, s.a, s.b).d;
      if (d >= 3 && d <= 60) { found = true; break; }
    }
    dualCache.set(way.id, found);
    return found;
  };

  const flags = new Array(xy.length - 1).fill(null);
  for (let i = 0; i < xy.length - 1; i++) {
    const a = xy[i], b = xy[i + 1];
    if (cum[i + 1] - cum[i] < 0.5) continue;
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const brg = planarBearing(a, b);
    let best = null;
    for (const s of near(m, 5)) {
      const d = segDist(m, s.a, s.b).d;
      if (d > 5) continue;
      const diff = angDiff(brg, s.brg);
      if (diff > 35 && diff < 145) continue;
      if (!best || d < best.d) best = { d, s, same: diff <= 35 };
    }
    if (!best) continue;
    const against = best.s.dir === 1 ? !best.same : best.same;
    if (!against) continue;
    const w = best.s.way;
    const hw = w.tags.highway;
    let reason = null;
    if (NEVER_CONTRA.has(hw) || isRoundabout(w.tags)) reason = 'never';
    else if (!contraAllowedOn(hw)) reason = 'class';
    const dual = isDual(m, brg, w);
    if (!reason && dual && !settings.contra.dual) reason = 'dual';
    flags[i] = { way: w, reason, dual };
  }

  const ranges = [];
  const forbidden = [];
  const rejected = [];
  const seenWays = new Set();
  let cur = null;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const tiny = cum[i + 1] - cum[i] < 0.5;
    if (f) {
      if (!cur) { cur = { i0: i, i1: i, len: 0, names: new Set(), classes: new Set(), dual: false }; ranges.push(cur); }
      cur.i1 = i;
      cur.len += cum[i + 1] - cum[i];
      if (f.way.tags.name) cur.names.add(f.way.tags.name);
      cur.classes.add(f.way.tags.highway);
      cur.dual = cur.dual || f.dual;
      if (f.reason && !seenWays.has(f.way.id)) {
        seenWays.add(f.way.id);
        forbidden.push(route.shape[i].map((v, k) => (v + route.shape[i + 1][k]) / 2));
        rejected.push({ id: f.way.id, name: f.way.tags.name || f.way.tags.ref || 'unbenannte Straße', highway: f.way.tags.highway, reason: f.reason });
      }
    } else if (!tiny) cur = null;
  }
  return {
    ranges: ranges.map(r => ({ ...r, names: [...r.names], classes: [...r.classes] })),
    forbidden,
    rejected
  };
}

function rejectedText(list) {
  const byName = new Map();
  for (const r of list) if (!byName.has(r.name)) byName.set(r.name, r);
  return [...byName.values()].slice(0, 3).map(r => {
    const why = r.reason === 'class' ? `${CLASS_LABEL[baseClass(r.highway)] || r.highway} nicht freigegeben` : REASON_TEXT[r.reason];
    return `${r.name} (${why})`;
  }).join(', ');
}

/* ---------- Eigenes Wegenetz für die Gegenrichtung ----------
   Der Routingserver liefert mit ignore_oneways nicht verlässlich die schnellste Route.
   Daher wird im Umfeld der regulären Route das OSM-Straßennetz geladen und zweimal
   nach demselben Zeitmodell gerechnet: nur in Fahrtrichtung und mit zulässiger Gegenrichtung. */

const DRIVABLE = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road';
const SPEED = { motorway: 100, motorway_link: 60, trunk: 80, trunk_link: 50, primary: 45, primary_link: 35, secondary: 40, secondary_link: 30, tertiary: 35, tertiary_link: 30, unclassified: 30, residential: 25, living_street: 7, service: 12, road: 20 };
const CONTRA_FACTOR = 1.1;            /* Gegenrichtung wird etwas langsamer angesetzt */
const BLOCKING_BARRIERS = new Set(['bollard', 'block', 'jersey_barrier', 'chain', 'bus_trap', 'sump_buster', 'kerb', 'planter', 'height_restrictor']);
const SLOW_BARRIERS = new Set(['gate', 'lift_gate', 'swing_gate', 'barrier_board', 'toll_booth', 'entrance']);

function num(v) {
  if (v == null) return null;
  const m = String(v).replace(',', '.').match(/^\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
function parseSpeed(v) {
  if (!v) return null;
  if (/living_street|walk/i.test(v)) return 7;
  if (/urban/i.test(v)) return 50;
  if (/rural/i.test(v)) return 100;
  if (/none/i.test(v)) return 130;
  const n = num(v);
  return n ? (/mph/i.test(v) ? n * 1.609 : n) : null;
}

/* Befahrbarkeit eines Wegs: null = befahrbar, sonst Grund */
function wayBlocked(t) {
  const v = settings.vehicle, lkw = v.type === 'lkw';
  const no = x => x === 'no' || x === 'private' || x === 'agricultural' || x === 'forestry';
  if (t.area === 'yes') return 'area';
  const mv = t.motor_vehicle, mc = lkw ? (t.hgv ?? t.goods) : t.motorcar;
  if (mc === 'yes' || mc === 'designated' || mv === 'yes' || mv === 'designated') { /* ausdrücklich frei */ }
  else if (no(mc) || no(mv) || (no(t.access) && !mv && !mc)) return 'access';
  if (t.highway === 'service' && t.service === 'emergency_access') return null;
  if (lkw) {
    if (num(t.maxheight) != null && num(t.maxheight) < +v.height) return 'height';
    if (num(t['maxheight:physical']) != null && num(t['maxheight:physical']) < +v.height) return 'height';
    if (num(t.maxwidth) != null && num(t.maxwidth) < +v.width) return 'width';
    if (num(t.maxlength) != null && num(t.maxlength) < +v.length) return 'length';
    if (num(t.maxweight) != null && num(t.maxweight) < +v.weight) return 'weight';
    if (num(t.maxaxleload) != null && num(t.maxaxleload) < +v.axle) return 'axle';
  } else if (num(t['maxheight:physical']) != null && num(t['maxheight:physical']) < 2.0) return 'height';
  return null;
}
function waySpeed(t) {
  const def = SPEED[t.highway] || 20;
  const lim = parseSpeed(t.maxspeed);
  let v = lim ? Math.min(def, lim * 0.85) : def;
  if (t.highway === 'service' && (t.service === 'driveway' || t.service === 'parking_aisle')) v = Math.min(v, 10);
  if (settings.vehicle.type === 'lkw') v = Math.min(v, 80);
  return Math.max(5, v) / 3.6;
}
function destPenalty(t) {
  const lkw = settings.vehicle.type === 'lkw';
  const vals = [t.access, t.motor_vehicle, lkw ? t.hgv : t.motorcar];
  return vals.includes('destination') || vals.includes('customers') ? 15 : 0;
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

function corridorQuery(baseShape, from, to) {
  let pts, radius;
  if (baseShape) {
    let tol = 15; pts = simplify(baseShape, tol);
    while (pts.length > 400) { tol *= 1.6; pts = simplify(baseShape, tol); }
    const len = baseShape.reduce((s, p, i) => i ? s + haversine(baseShape[i - 1], p) : 0, 0);
    radius = len > 15000 ? 250 : 350;
  } else {
    pts = [[from.lat, from.lon], [to.lat, to.lon]];
    radius = Math.min(1500, Math.max(600, haversine(pts[0], pts[1]) * 0.4));
  }
  const coords = pts.map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(',');
  return `[out:json][timeout:25];way(around:${Math.round(radius)},${coords})["highway"~"^(${DRIVABLE})$"];(._;>;);out body qt;`;
}

function buildGraph(data) {
  const nodeById = new Map();
  const lat0 = (data.elements.find(e => e.type === 'node') || { lat: 50 }).lat;
  const N = { lat: [], lon: [], x: [], y: [], tags: [], adj: [] };
  for (const e of data.elements) {
    if (e.type !== 'node') continue;
    const i = N.lat.length;
    nodeById.set(e.id, i);
    N.lat.push(e.lat); N.lon.push(e.lon);
    const p = proj([e.lat, e.lon], lat0); N.x.push(p[0]); N.y.push(p[1]);
    N.tags.push(e.tags || null); N.adj.push([]);
  }
  const ways = [];
  const segs = [];
  const closurePolys = closures.map(c => c.kind === 'point'
    ? { kind: 'circle', c: proj(c.center, lat0), r: c.radius }
    : { kind: 'poly', pts: c.ring.map(p => proj(p, lat0)) });
  const hitsClosure = (a, b) => closurePolys.some(c => {
    if (c.kind === 'circle') return segDist(c.c, a, b).d <= c.r;
    if (pointInPoly(a, c.pts) || pointInPoly(b, c.pts)) return true;
    for (let k = 0; k < c.pts.length; k++) if (segIntersect(a, b, c.pts[k], c.pts[(k + 1) % c.pts.length])) return true;
    return false;
  });
  const barrierAt = i => {
    const t = N.tags[i]; if (!t || !t.barrier) return 0;
    if (t.motor_vehicle === 'yes' || t.access === 'yes' || t.emergency === 'yes') return 0;
    if (BLOCKING_BARRIERS.has(t.barrier)) return Infinity;
    if (SLOW_BARRIERS.has(t.barrier)) return 30;
    return 0;
  };

  for (const e of data.elements) {
    if (e.type !== 'way' || !e.tags || !e.nodes) continue;
    const t = e.tags;
    if (wayBlocked(t)) continue;
    const dir = onewayDir(t);
    const w = { id: e.id, tags: t, dir, speed: waySpeed(t), pen: destPenalty(t), nodes: e.nodes };
    let reason = null;
    if (dir) {
      if (NEVER_CONTRA.has(t.highway) || isRoundabout(t)) reason = 'never';
      else if (!contraAllowedOn(t.highway)) reason = 'class';
    }
    w.reason = reason;
    w.idx = ways.length; ways.push(w);
    for (let k = 0; k < e.nodes.length - 1; k++) {
      const a = nodeById.get(e.nodes[k]), b = nodeById.get(e.nodes[k + 1]);
      if (a == null || b == null) continue;
      const A = [N.x[a], N.y[a]], B = [N.x[b], N.y[b]];
      if (hitsClosure(A, B)) continue;
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const t0 = len / w.speed + (barrierAt(b) === Infinity ? Infinity : barrierAt(b));
      if (!Number.isFinite(t0) || barrierAt(a) === Infinity) continue;
      const fwd = dir >= 0, bwd = dir <= 0;
      N.adj[a].push({ to: b, len, t: t0, way: w, contra: !fwd });
      N.adj[b].push({ to: a, len, t: t0, way: w, contra: !bwd });
      segs.push({ a, b, way: w });
    }
  }
  /* Getrennte Richtungsfahrbahnen erkennen (Partnerfahrbahn gleichen Namens, Gegenrichtung freigegeben) */
  const els = ways.filter(w => w.dir).map(w => ({
    type: 'way', id: w.id, tags: w.tags,
    geometry: w.nodes.map(id => nodeById.get(id)).filter(i => i != null).map(i => ({ lat: N.lat[i], lon: N.lon[i] }))
  }));
  const dualIds = detectDual(els, lat0);
  for (const w of ways) if (w.dir && !w.reason && dualIds.has(w.id) && !settings.contra.dual) w.reason = 'dual';
  for (const w of ways) w.dual = dualIds.has(w.id);
  return { N, ways, segs, lat0, geomEls: els };
}

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function detectDual(els, lat0) {
  const segs = [];
  for (const el of els) {
    const dir = onewayDir(el.tags);
    const pts = el.geometry.map(g => proj([g.lat, g.lon], lat0));
    for (let k = 0; k < pts.length - 1; k++) {
      const brg = planarBearing(pts[k], pts[k + 1]);
      segs.push({ a: pts[k], b: pts[k + 1], el, allowed: dir === 1 ? brg : (brg + 180) % 360 });
    }
  }
  const out = new Set();
  for (const el of els) {
    if (isRoundabout(el.tags)) continue;
    const own = segs.filter(s => s.el === el);
    if (!own.length) continue;
    const s0 = own[Math.floor(own.length / 2)];
    const m = [(s0.a[0] + s0.b[0]) / 2, (s0.a[1] + s0.b[1]) / 2];
    const forbiddenDir = (s0.allowed + 180) % 360;
    for (const s of segs) {
      if (s.el === el) continue;
      const t = el.tags, u = s.el.tags;
      const pair = (t.name && u.name === t.name) || (t.ref && u.ref === t.ref) || (!t.name && !u.name && baseClass(t.highway) === baseClass(u.highway));
      if (!pair || angDiff(s.allowed, forbiddenDir) > 35) continue;
      const d = segDist(m, s.a, s.b).d;
      if (d >= 3 && d <= 60) { out.add(el.id); break; }
    }
  }
  return out;
}

/* Kürzester Weg nach Fahrzeit mit Abbiegezuschlägen. mode: 'legal' | 'contra' | 'all' */
function shortestPath(G, s, tgt, mode) {
  const { N } = G;
  const n = N.adj.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const prevEdge = new Array(n);
  const done = new Uint8Array(n);
  dist[s] = 0;
  const h = new Heap(); h.push(0, s);
  while (h.size) {
    const u = h.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === tgt) break;
    const p = prev[u];
    const inBrg = p >= 0 ? planarBearing([N.x[p], N.y[p]], [N.x[u], N.y[u]]) : null;
    for (const e of N.adj[u]) {
      if (e.contra) {
        if (mode === 'legal') continue;
        if (e.way.reason === 'never') continue;
        if (mode === 'contra' && e.way.reason) continue;
      }
      let c = e.t * (e.contra ? CONTRA_FACTOR : 1);
      if (inBrg != null) {
        if (e.to === p) { if (N.adj[u].length > 1) continue; c += 30; }
        const turn = angDiff(inBrg, planarBearing([N.x[u], N.y[u]], [N.x[e.to], N.y[e.to]]));
        if (turn > 100) c += 9; else if (turn > 45) c += 5;
        if (prevEdge[u] && prevEdge[u].way !== e.way && e.way.pen && prevEdge[u].way.pen === 0) c += e.way.pen;
      }
      const nd = dist[u] + c;
      if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; prevEdge[e.to] = e; h.push(nd, e.to); }
    }
  }
  if (!Number.isFinite(dist[tgt])) return null;
  const nodes = [], edges = [];
  for (let v = tgt; v !== -1; v = prev[v]) { nodes.push(v); if (prevEdge[v]) edges.push(prevEdge[v]); }
  nodes.reverse(); edges.reverse();
  return { cost: dist[tgt], nodes, edges, contraEdges: edges.filter(e => e.contra) };
}

/* Start und Ziel als Zusatzknoten auf dem nächstgelegenen befahrbaren Abschnitt einhängen. */
function attachPoint(G, p, isStart) {
  const { N, segs, lat0 } = G;
  const P = proj(p, lat0);
  let best = null;
  for (const sg of segs) {
    const r = segDist(P, [N.x[sg.a], N.y[sg.a]], [N.x[sg.b], N.y[sg.b]]);
    if (!best || r.d < best.d) best = { ...r, sg };
  }
  const label = isStart ? 'Start' : 'Ziel';
  if (!best || best.d > 80) { dlog(`${label} ${r5(p)}: keine befahrbare Straße im Umkreis von 80 m geladen`); return null; }
  dlog(`${label} angebunden an ${best.sg.way.tags.name || best.sg.way.tags.highway} (${Math.round(best.d)} m entfernt)`);
  const { sg, t } = best;
  const i = N.adj.length;
  const x = N.x[sg.a] + (N.x[sg.b] - N.x[sg.a]) * t, y = N.y[sg.a] + (N.y[sg.b] - N.y[sg.a]) * t;
  const ll = lerp([N.lat[sg.a], N.lon[sg.a]], [N.lat[sg.b], N.lon[sg.b]], t);
  N.lat.push(ll[0]); N.lon.push(ll[1]); N.x.push(x); N.y.push(y); N.tags.push(null); N.adj.push([]);
  const ab = N.adj[sg.a].find(e => e.to === sg.b && e.way === sg.way);
  const ba = N.adj[sg.b].find(e => e.to === sg.a && e.way === sg.way);
  const part = (e, f) => ({ ...e, len: e.len * f, t: e.t * f });
  if (isStart) {
    if (ab) N.adj[i].push({ ...part(ab, 1 - t), to: sg.b });
    if (ba) N.adj[i].push({ ...part(ba, t), to: sg.a });
  } else {
    if (ab) N.adj[sg.a].push({ ...part(ab, t), to: i });
    if (ba) N.adj[sg.b].push({ ...part(ba, 1 - t), to: i });
  }
  return i;
}

function rejectedFromPath(path) {
  const seen = new Set(), out = [];
  for (const e of path.contraEdges) {
    if (!e.way.reason || seen.has(e.way.id)) continue;
    seen.add(e.way.id);
    out.push({ id: e.way.id, name: e.way.tags.name || e.way.tags.ref || 'unbenannte Straße', highway: e.way.tags.highway, reason: e.way.reason });
  }
  return out;
}

function pathText(p) {
  if (!p) return 'kein Weg gefunden';
  const len = p.edges.reduce((sum, e) => sum + e.len, 0);
  const names = [];
  for (const e of p.edges) {
    const n = (e.way.tags.name || e.way.tags.highway) + (e.contra ? ' [gegen Einbahn]' : '');
    if (names[names.length - 1] !== n) names.push(n);
  }
  return `${fmtDur(p.cost)}, ${fmtDist(len)}: ${names.join(' > ')}`;
}

async function localContra(from, to, normal) {
  const data = await overpass(corridorQuery(normal ? normal.shape : null, from, to));
  const G = buildGraph(data);
  const oneways = G.ways.filter(w => w.dir);
  dlog(`Straßennetz: ${G.ways.length} befahrbare Wege, davon ${oneways.length} Einbahnstraßen`);
  const byName = new Map();
  for (const w of oneways) {
    const n = w.tags.name || w.tags.ref || `(${w.tags.highway} ohne Namen)`;
    const why = w.reason ? (w.reason === 'class' ? 'Klasse gesperrt' : REASON_TEXT[w.reason]) : 'Gegenrichtung zulässig';
    if (!byName.has(n)) byName.set(n, `${n} [${w.tags.highway}, ${why}]`);
  }
  if (byName.size) dlog('Einbahnstraßen: ' + [...byName.values()].slice(0, 25).join(', '));
  const sPt = normal ? normal.shape[0] : [from.lat, from.lon];
  const tPt = normal ? normal.shape[normal.shape.length - 1] : [to.lat, to.lon];
  const s = attachPoint(G, sPt, true);
  const t = attachPoint(G, tPt, false);
  if (s == null || t == null) throw new Error('Start oder Ziel nicht im geladenen Straßennetz');
  const legal = shortestPath(G, s, t, 'legal');
  const contra = shortestPath(G, s, t, 'contra');
  const all = shortestPath(G, s, t, 'all');
  dlog(`Eigene Rechnung in Fahrtrichtung: ${pathText(legal)}`);
  dlog(`Eigene Rechnung mit zulässiger Gegenrichtung: ${pathText(contra)}`);
  if (all && (!contra || Math.abs(all.cost - contra.cost) > 0.5)) dlog(`Ohne jede Einschränkung möglich: ${pathText(all)}`);
  let rejected = [];
  if (!contra || !contra.contraEdges.length || (legal && legal.cost - contra.cost < settings.contra.minGain)) {
    if (all && all.contraEdges.length && (!legal || legal.cost - all.cost >= settings.contra.minGain)) rejected = rejectedFromPath(all);
  }
  lastDiag = { G, legal, contra, all };
  return { G, legal, contra, rejected };
}

/* Fahranweisungen für einen selbst berechneten Weg */
function localTrip(G, path) {
  const { N } = G;
  const shape = path.nodes.map(i => [N.lat[i], N.lon[i]]);
  const nameOf = e => e.way.tags.name || e.way.tags.ref || '';
  const mans = [];
  const push = (type, instr, b, street) => mans.push({
    type, instruction: instr, verbal_pre_transition_instruction: instr,
    verbal_transition_alert_instruction: instr, begin_shape_index: b, end_shape_index: b, time: 0, length: 0, street_names: street ? [street] : []
  });
  const first = path.edges[0];
  push(1, nameOf(first) ? `Fahren Sie auf ${nameOf(first)}.` : 'Losfahren.', 0, nameOf(first));
  for (let k = 1; k < path.edges.length; k++) {
    const e0 = path.edges[k - 1], e1 = path.edges[k];
    const u = path.nodes[k];
    const b0 = planarBearing([N.x[path.nodes[k - 1]], N.y[path.nodes[k - 1]]], [N.x[u], N.y[u]]);
    const b1 = planarBearing([N.x[u], N.y[u]], [N.x[path.nodes[k + 1]], N.y[path.nodes[k + 1]]]);
    let d = ((b1 - b0 + 540) % 360) - 180;
    const named = nameOf(e1), changed = named !== nameOf(e0);
    const branches = N.adj[u].length > 2;
    if (Math.abs(d) < 25 && !(changed && branches && Math.abs(d) >= 12)) continue;
    if (Math.abs(d) < 25 && !changed) continue;
    const right = d > 0, ad = Math.abs(d);
    let type, verb;
    if (ad < 45) { type = right ? 9 : 16; verb = right ? 'Halten Sie sich rechts' : 'Halten Sie sich links'; }
    else if (ad < 135) { type = right ? 10 : 15; verb = right ? 'Biegen Sie rechts ab' : 'Biegen Sie links ab'; }
    else { type = right ? 11 : 14; verb = right ? 'Biegen Sie scharf rechts ab' : 'Biegen Sie scharf links ab'; }
    const contraNote = e1.contra && !e0.contra ? ' Achtung, gegen die Einbahnrichtung.' : '';
    push(type, `${verb}${named ? ' auf ' + named : ''}.${contraNote}`, k, named);
  }
  push(4, 'Sie haben Ihr Ziel erreicht.', shape.length - 1, '');
  /* Zeiten und Längen je Manöver */
  const segT = path.edges.map(e => e.t * (e.contra ? CONTRA_FACTOR : 1));
  for (let m = 0; m < mans.length; m++) {
    const b = mans[m].begin_shape_index, e = m + 1 < mans.length ? mans[m + 1].begin_shape_index : b;
    mans[m].end_shape_index = e;
    let tt = 0, ll = 0;
    for (let k = b; k < e; k++) { tt += segT[k] || 0; ll += path.edges[k] ? path.edges[k].len : 0; }
    mans[m].time = tt; mans[m].length = ll / 1000;
  }
  const lat0 = shape[0][0];
  const xy = shape.map(p => proj(p, lat0));
  const cum = [0];
  for (let k = 1; k < shape.length; k++) cum.push(cum[k - 1] + Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]));
  /* Bereiche gegen die Einbahnrichtung direkt aus dem Weg */
  const ranges = [];
  let cur = null;
  path.edges.forEach((e, k) => {
    if (e.contra) {
      if (!cur) { cur = { i0: k, i1: k, len: 0, names: new Set(), classes: new Set(), dual: false }; ranges.push(cur); }
      cur.i1 = k; cur.len += e.len;
      if (nameOf(e)) cur.names.add(nameOf(e));
      cur.classes.add(e.way.tags.highway); cur.dual = cur.dual || !!e.way.dual;
    } else cur = null;
  });
  return {
    shape, xy, lat0, cum, total: cum[cum.length - 1],
    time: mans.reduce((sum, m) => sum + m.time, 0),
    maneuvers: mans, contraAllowed: true,
    contra: ranges.map(r => ({ ...r, names: [...r.names], classes: [...r.classes] })),
    contraLen: ranges.reduce((sum, r) => sum + r.len, 0),
    gain: 0, vehicle: settings.vehicle.type, local: true
  };
}

/* Eigenen Weg vom Routingserver auf das Netz abbilden lassen, damit Anweisungen in gewohnter Qualität entstehen. */
async function traceTrip(G, path) {
  const { N } = G;
  const { costing, co } = vehicleOptions(true);
  const url = settings.servers.valhalla.replace(/\/route\/?$/, '/trace_route');
  if (url === settings.servers.valhalla) throw new Error('trace_route nicht ableitbar');
  const body = {
    shape: path.nodes.map(i => ({ lat: +N.lat[i].toFixed(6), lon: +N.lon[i].toFixed(6) })),
    costing, costing_options: { [costing]: co },
    shape_match: 'map_snap', language: 'de-DE', units: 'kilometers'
  };
  const res = await fetchT(url, { method: 'POST', body: JSON.stringify(body) }, 12000);
  const data = await res.json();
  if (!res.ok || !data.trip || data.trip.legs.length !== 1) throw new Error('trace_route fehlgeschlagen');
  return parseTrip(data.trip, true);
}

/* ---------- Ablauf der Routenberechnung ---------- */

function routeStart() {
  const p = currentPos();
  return p ? { lat: p.lat, lon: p.lon, heading: p.heading, speed: p.speed } : null;
}

function setStatus(text) {
  ui.routeStatus.textContent = text || '';
  ui.routeStatus.hidden = !text;
  const t = document.getElementById('sheetToggle');
  if (t) t.classList.toggle('has-info', ui.routeSheet.classList.contains('collapsed') && !!text);
}

async function computeRoute(reason = 'new') {
  if (!dest) return;
  const from = routeStart();
  showNavUi();
  if (!from) {
    pendingRoute = true;
    ui.mnvDist.textContent = '';
    ui.mnvInstr.textContent = 'Warte auf GPS-Position';
    setStatus('Ohne GPS: Startpunkt per langem Druck auf die Karte setzen.');
    return;
  }
  pendingRoute = false;
  const token = ++routeToken;
  dreset();
  const v = settings.vehicle, c = settings.contra;
  dlog(`Anlass: ${reason}. Start ${r5([from.lat, from.lon])}${manualStart ? ' (manuell)' : ''}, Ziel ${r5([dest.lat, dest.lon])} ${dest.label || ''}`);
  dlog(`Fahrzeug ${v.type === 'lkw' ? `LKW ${v.height} m, ${v.weight} t` : 'PKW'}. Gegenrichtung ${c.enabled ? 'an' : 'AUS'}, Mindestgewinn ${c.minGain} s, Richtungsfahrbahnen ${c.dual ? 'frei' : 'gesperrt'}, Klassen ${c.classes.join(' ')}`);
  if (closures.length) dlog(`${closures.length} Sperrungen aktiv`);
  nav.lastReroute = Date.now();
  if (!nav.route || reason === 'new') { ui.mnvDist.textContent = ''; ui.mnvInstr.textContent = 'Route wird berechnet'; }
  setStatus(reason === 'reroute' ? 'Neuberechnung ab aktuellem Standort' : reason === 'traffic' ? 'Neuberechnung wegen Verkehrslage' : 'Route wird berechnet');

  const wantContra = !!settings.contra.enabled;
  activeTrafficRings = [];
  nav.trafficMsg = '';
  let normal = await valhalla(from, dest, { contra: false }).catch(e => ({ error: e }));
  if (token !== routeToken) return;
  const hasNormal = !normal.error;
  if (hasNormal) {
    const streets = [...new Set(normal.maneuvers.flatMap(m => m.street_names || []))].join(' > ');
    dlog(`Routingserver regulär: ${fmtDur(normal.time)}, ${fmtDist(normal.total)}: ${streets}`);
  } else dlog(`Routingserver regulär fehlgeschlagen: ${normal.error.message}`);
  nav.options = { legal: hasNormal ? normal : null, contra: null, jam: null };
  if (hasNormal) {
    applyRoute(normal, reason);
    setStatus(wantContra ? 'Prüfe schnelleren Weg gegen Einbahnrichtung' : '');
    if (reason === 'reroute') say('Route neu berechnet.');
  }

  /* Verkehrslage: Staus auf der regulären Route, ab Grenzwert Umfahrung */
  if (hasNormal && trafficOn()) {
    const tr = await trafficStage(from, normal, token);
    if (token !== routeToken) return;
    if (tr && tr.jam) {
      activeTrafficRings = tr.rings;
      normal = tr.route;
      normal.detour = true;
      nav.options = { legal: normal, contra: null, jam: tr.jam };
      const saved = effTime(tr.jam) - effTime(normal);
      const why = tr.jam.traffic.closed ? 'Sperrung auf der Route' : `Stau auf der Route, +${fmtMin(tr.jam.traffic.delay)}`;
      if (nav.pref === 'jam') {
        applyRoute(tr.jam, 'switch');
        nav.trafficMsg = `${why}. Route durch den Stau bleibt gewählt, Umfahrung wäre ${fmtMin(saved)} schneller.`;
        setStatus(nav.trafficMsg);
      } else {
        applyRoute(normal, reason === 'new' ? 'upgrade' : reason);
        nav.trafficMsg = `${why}. Umfahrung gewählt, ${tr.jam.traffic.closed ? 'Sperrung wird umfahren' : fmtMin(saved) + ' schneller'}.`;
        setStatus(nav.trafficMsg);
        toast(`${why}. Umfahrung gewählt.`, 'warn', 6000);
        say(tr.jam.traffic.closed ? 'Sperrung auf der Route. Umfahrung gewählt.' : `Stau auf der Route, plus ${Math.round(tr.jam.traffic.delay / 60)} Minuten. Umfahrung gewählt.`, true);
      }
      dlog(`Ergebnis Verkehr: Umfahrung ${fmtDur(effTime(normal))}, durch Stau ${tr.jam.traffic.closed ? 'gesperrt' : fmtDur(effTime(tr.jam))}`);
    } else {
      renderBadges(); drawTraffic();
      const d = normal.traffic ? normal.traffic.delay : 0;
      setStatus(d >= 60 ? `Verkehr auf der Route +${fmtMin(d)}, unter dem Grenzwert für eine Umfahrung` : wantContra ? 'Prüfe schnelleren Weg gegen Einbahnrichtung' : '');
    }
  }
  if (!wantContra) { if (!hasNormal) routeFailed(normal.error); return; }

  /* Stufe 1: Kandidaten und Prüfung über den Routingserver */
  let vc = { best: null, rejected: [] };
  try { vc = await valhallaContra(from, dest, hasNormal ? normal : null, token); } catch (e) { dlog(`Prüfung über Routingserver fehlgeschlagen: ${e.message}`); }
  if (token !== routeToken) return;
  if (vc.best) {
    vc.best.route.contra = vc.best.ranges;
    vc.best.route.contraLen = vc.best.ranges.reduce((sum, r) => sum + r.len, 0);
    finishContra(vc.best.route, vc.best.gain, hasNormal, reason, 'Routingserver');
    return;
  }

  /* Stufe 2: eigenes Wegenetz aus Overpass, falls der Server keinen zulässigen schnelleren Weg liefert */
  dlog('Kein zulässiger schnellerer Weg über den Routingserver. Rückfall auf eigenes Wegenetz (Overpass).');
  setStatus('Prüfe weitere Wege gegen Einbahnrichtung');
  let lc;
  try { lc = await localContra(from, dest, hasNormal ? normal : null); } catch (e) {
    if (token !== routeToken) return;
    dlog(`Rückfall nicht möglich: ${e.message}`);
    declineContra(hasNormal, normal, vc.rejected, 'Kein schnellerer Weg gegen Einbahnrichtung gefunden', reason);
    return;
  }
  if (token !== routeToken) return;

  const { G, legal, contra } = lc;
  const rejected = vc.rejected.concat(lc.rejected);
  const gain = legal ? legal.cost - (contra ? contra.cost : Infinity) : Infinity;
  if (!contra || !contra.contraEdges.length || gain < settings.contra.minGain) {
    dlog(`Ergebnis: Gegenrichtung nicht übernommen (${!contra ? 'kein Weg' : !contra.contraEdges.length ? 'schnellster Weg nutzt keine Einbahnstraße entgegen' : `Gewinn ${gain.toFixed(1)} s unter Schwelle`})`);
    declineContra(hasNormal, normal, rejected, contra && contra.contraEdges.length && Number.isFinite(gain)
      ? `Gegenrichtung bringt nur ${fmtDur(Math.max(0, gain))} (Schwelle ${settings.contra.minGain} s)`
      : 'Kein schnellerer Weg gegen Einbahnrichtung gefunden', reason);
    return;
  }

  /* Anweisungen: bevorzugt vom Routingserver, sonst selbst erzeugt */
  const own = localTrip(G, contra);
  let cf = own;
  try {
    const traced = await traceTrip(G, contra);
    if (token !== routeToken) return;
    const an = matchContraflow(traced, G.geomEls);
    const tracedLen = an.ranges.reduce((sum, r) => sum + r.len, 0);
    if (an.ranges.length && !an.forbidden.length && Math.abs(traced.total - own.total) < Math.max(60, own.total * 0.1) && tracedLen > own.contraLen * 0.6) {
      traced.contra = an.ranges;
      traced.contraLen = tracedLen;
      cf = traced;
    }
    dlog(`Fahranweisungen ${cf === own ? 'selbst erzeugt (Abgleich mit Routingserver passte nicht)' : 'vom Routingserver'}`);
  } catch (e) { dlog(`Fahranweisungen selbst erzeugt (trace_route: ${e.message || e.name})`); }
  if (token !== routeToken) return;
  if (hasNormal) cf.time = Math.max(30, normal.time - gain);
  finishContra(cf, gain, hasNormal, reason, 'eigenes Wegenetz');
}

function declineContra(hasNormal, normal, rejected, fallback, reason) {
  if (!hasNormal) { routeFailed(normal.error); return; }
  /* Hinweis zur Stauumfahrung nicht überschreiben */
  if (nav.options && nav.options.jam && !rejected.length) { dlog(`Ergebnis Gegenrichtung: ${fallback}`); setStatus(nav.trafficMsg || ''); return; }
  if (rejected.length) {
    const txt = `Gegenrichtung verworfen: ${rejectedText(rejected)}. Freigabe in den Einstellungen.`;
    dlog(`Ergebnis: ${txt}`);
    setStatus(txt);
    if (reason !== 'reroute') toast(txt, 'warn', 6000);
  } else {
    dlog(`Ergebnis: ${fallback}`);
    setStatus(fallback);
  }
}

function finishContra(cf, gain, hasNormal, reason, source) {
  cf.gain = gain;
  if (trafficOn() && !cf.traffic) annotateTraffic(cf);
  nav.options = { legal: hasNormal ? nav.options && nav.options.legal : null, contra: cf, jam: (nav.options && nav.options.jam) || null };
  if (hasNormal && (nav.pref === 'legal' || nav.pref === 'jam')) {
    dlog(`Ergebnis: Gegenrichtung gefunden (${source}), Gewinn ${gain.toFixed(1)} s. Route ohne Gegenrichtung bleibt gewählt.`);
    drawRoute(); renderChoice();
    setStatus(`${nav.pref === 'jam' ? 'Route durch den Stau' : 'Route ohne Gegenrichtung'} gewählt. Gegen Einbahnrichtung wäre ${fmtDur(gain)} schneller.`);
    return;
  }
  dlog(`Ergebnis: Gegenrichtung übernommen (${source}), Gewinn ${gain.toFixed(1)} s, ${fmtDist(cf.contraLen)} gegen Einbahnrichtung`);
  applyRoute(cf, reason === 'new' ? 'upgrade' : reason);
  const names = [...new Set(cf.contra.flatMap(r => r.names))].slice(0, 2).join(', ');
  const dual = cf.contra.some(r => r.dual) ? ', Richtungsfahrbahn' : '';
  setStatus(hasNormal && Number.isFinite(gain)
    ? `${fmtDur(gain)} schneller über ${fmtDist(cf.contraLen)} gegen Einbahnrichtung${names ? ' (' + names + dual + ')' : ''}`
    : `Ziel nur gegen Einbahnrichtung erreichbar${names ? ' (' + names + dual + ')' : ''}`);
  if (reason !== 'reroute') toast(hasNormal && Number.isFinite(gain) ? `Schnellere Route gegen Einbahnrichtung, ${fmtDur(gain)} Vorteil` : 'Route führt gegen Einbahnrichtung', 'warn', 5000);
}

function routeFailed(err) {
  ui.mnvDist.textContent = '';
  ui.mnvInstr.textContent = 'Keine Route';
  ui.mnvIcon.innerHTML = '';
  setStatus(err ? err.message : 'Routing fehlgeschlagen');
  toast(err ? err.message : 'Routing fehlgeschlagen', 'err', 6000);
}

/* ================================================================ Darstellung der Route */

const routeLayer = L.layerGroup().addTo(map);
let lineDone = null, lineRest = null, lineCasing = null;

function applyRoute(route, reason) {
  const prev = nav.route;
  nav.route = route;
  nav.idx = 0;
  nav.along = 0;
  nav.offCount = 0;
  /* Manöverindizes ändern sich mit jeder Route, daher Ansagen neu aufbauen. */
  nav.announced = new Set();
  drawRoute();
  renderBadges();
  renderChoice();
  if (!nav.active) startNav();
  if (reason === 'new') {
    const p = trackingPos();
    if (!p || !nav.follow) fitRoute();
  }
  navUpdate();
}

const ROUTE_KINDS = ['contra', 'legal', 'jam'];
function routeKinds() {
  const o = nav.options;
  return o ? ROUTE_KINDS.filter(k => o[k]) : [];
}
function currentKind() {
  const o = nav.options;
  return o ? ROUTE_KINDS.find(k => o[k] && o[k] === nav.route) : null;
}
function kindTitle(k) {
  const o = nav.options || {};
  if (k === 'contra') return 'Gegen Einbahn';
  if (k === 'jam') return 'Durch Stau';
  return o.jam ? 'Umfahrung' : 'Ohne Gegenrichtung';
}
function kindShort(k) {
  return { contra: 'gegen Einbahn', jam: 'durch Stau', legal: (nav.options && nav.options.jam) ? 'Umfahrung' : 'ohne Gegenrichtung' }[k];
}
function altRoutes() {
  if (routeKinds().length < 2) return [];
  return routeKinds().filter(k => nav.options[k] !== nav.route).map(k => ({ kind: k, route: nav.options[k] }));
}

function drawRoute() {
  routeLayer.clearLayers();
  const r = nav.route;
  if (!r) return;
  const route = cssVar('--route'), contra = cssVar('--contra');
  for (const alt of nav.arrived ? [] : altRoutes()) {
    const a = alt.route;
    L.polyline(a.shape, { pane: 'alt', color: '#0a1424', weight: 11, opacity: .5, interactive: false }).addTo(routeLayer);
    L.polyline(a.shape, { pane: 'alt', color: cssVar('--alt'), weight: 6, opacity: 1, interactive: false }).addTo(routeLayer);
    for (const c of a.contra) L.polyline(a.shape.slice(c.i0, c.i1 + 2), { pane: 'alt', color: contra, weight: 6, opacity: .85, dashArray: '8 8', interactive: false }).addTo(routeLayer);
    const pick = () => { if (!cmode) selectRoute(alt.kind); };
    L.polyline(a.shape, { pane: 'alt', color: '#000', weight: 28, opacity: .001 }).on('click', pick).addTo(routeLayer);
    /* Beschriftung an der Stelle, welche am weitesten von der gewählten Route entfernt liegt */
    let bi = Math.floor(a.shape.length / 2), bd = -1;
    for (let i = 0; i < a.shape.length; i += Math.max(1, Math.floor(a.shape.length / 60))) {
      let dmin = Infinity;
      for (let j = 0; j < r.shape.length; j += Math.max(1, Math.floor(r.shape.length / 120))) dmin = Math.min(dmin, haversine(a.shape[i], r.shape[j]));
      if (dmin > bd) { bd = dmin; bi = i; }
    }
    const label = `${a.traffic && a.traffic.closed ? 'gesperrt' : fmtDur(shownTime(a))} ${kindShort(alt.kind)}`;
    L.marker(a.shape[bi], { keyboard: false, zIndexOffset: 500, icon: L.divIcon({ className: '', iconSize: [0, 0], iconAnchor: [0, 0], html: `<div class="alt-label ${alt.kind}">${esc(label)}</div>` }) })
      .on('click', pick).addTo(routeLayer);
  }
  update3dRoute();
  lineCasing = L.polyline(r.shape, { pane: 'route', color: '#0a1424', weight: 12, opacity: .85, interactive: false }).addTo(routeLayer);
  lineDone = L.polyline([], { pane: 'route', color: '#8794a0', weight: 7, opacity: .9, interactive: false }).addTo(routeLayer);
  lineRest = L.polyline(r.shape, { pane: 'route', color: route, weight: 7, opacity: 1, interactive: false }).addTo(routeLayer);
  for (const c of r.contra) {
    const pts = r.shape.slice(c.i0, c.i1 + 2);
    L.polyline(pts, { pane: 'contra', color: '#1b1400', weight: 14, opacity: .9, interactive: false }).addTo(routeLayer);
    L.polyline(pts, { pane: 'contra', color: contra, weight: 9, opacity: 1, interactive: false }).addTo(routeLayer);
    L.polyline(pts, { pane: 'contra', color: '#1b1400', weight: 2, opacity: .9, dashArray: '2 12', interactive: false }).addTo(routeLayer);
  }
}

function fitRoute() {
  const r = nav.route;
  if (!r) return;
  if (sideW) { map.fitBounds(L.latLngBounds(r.shape), { paddingTopLeft: [30, 30], paddingBottomRight: [sideW + 80, 30] }); return; }
  const top = ui.navBanner.offsetHeight + 20, bottom = ui.routeSheet.offsetHeight + 20;
  map.fitBounds(L.latLngBounds(r.shape), { paddingTopLeft: [30, top], paddingBottomRight: [80, bottom] });
}

function vehicleLabel() {
  const v = settings.vehicle;
  if (v.type !== 'lkw') return 'PKW';
  return `LKW ${nf2.format(v.height)} m · ${nf2.format(v.weight)} t`;
}

function renderBadges() {
  const r = nav.route;
  const b = [];
  b.push(`<span class="badge"><i></i>${esc(vehicleLabel())}</span>`);
  if (r && r.contra.length) b.push(`<span class="badge contra"><i></i>Gegen Einbahn ${fmtDist(r.contraLen)}</span>`);
  if (closures.length) b.push(`<span class="badge closure"><i></i>${closures.length} ${closures.length === 1 ? 'Sperrung' : 'Sperrungen'} berücksichtigt</span>`);
  if (r && r.traffic && (r.traffic.closed || r.traffic.delay >= 60)) b.push(`<span class="badge jam"><i></i>${r.traffic.closed ? 'Sperrung auf Route' : `Stau +${fmtMin(r.traffic.delay)}`}</span>`);
  else if (r && r.detour) b.push(`<span class="badge"><i></i>Stau umfahren</span>`);
  else if (trafficOn() && r && r.traffic) b.push(`<span class="badge"><i></i>Verkehr frei</span>`);
  ui.routeBadges.innerHTML = b.join('');
}

function renderChoice() {
  const o = nav.options;
  const kinds = routeKinds();
  const show = kinds.length >= 2 && !nav.arrived;
  ui.routeChoice.hidden = !show;
  if (!show) { ui.routeChoice.innerHTML = ''; return; }
  const cur = currentKind();
  const sub = k => {
    const r = o[k], t = r.traffic;
    if (k === 'contra') return `${fmtDist(r.total)}, ${fmtDist(r.contraLen)} entgegen`;
    if (k === 'jam') return t && t.closed ? `${fmtDist(r.total)}, Sperrung` : `${fmtDist(r.total)}, Stau +${fmtMin(t ? t.delay : 0)}`;
    if (t && t.delay >= 60) return `${fmtDist(r.total)}, Stau +${fmtMin(t.delay)}`;
    return `${fmtDist(r.total)}, ${o.jam ? 'staufrei' : 'nur in Fahrtrichtung'}`;
  };
  ui.routeChoice.innerHTML = kinds.map(k => {
    const r = o[k];
    const time = r.traffic && r.traffic.closed ? 'gesperrt' : fmtDur(shownTime(r));
    return `<button type="button" role="radio" aria-checked="${k === cur}" data-route="${k}" class="rc ${k}${k === cur ? ' on' : ''}">
      <span class="rc-head"><i class="rc-sw"></i>${kindTitle(k)}</span>
      <span class="rc-time">${time}</span>
      <span class="rc-sub">${sub(k)}</span></button>`;
  }).join('');
}

function selectRoute(kind) {
  const o = nav.options;
  if (!o || !o[kind] || nav.route === o[kind]) return;
  nav.pref = kind;
  if (nav.sim) stopSim();
  nav.arrived = false;
  applyRoute(o[kind], 'switch');
  drawTraffic();
  const best = Math.min(...routeKinds().map(k => effTime(o[k])));
  const diff = effTime(o[kind]) - best;
  setStatus(`Route „${kindTitle(kind)}“ gewählt${diff >= 5 ? `, ${fmtDur(diff)} langsamer als die schnellste` : ', schnellste Variante'}`);
  dlog(`Umschaltung durch Nutzer: ${kindTitle(kind)}`);
  say({ contra: 'Route gegen Einbahnrichtung gewählt.', jam: 'Route durch den Stau gewählt.', legal: o.jam ? 'Umfahrung gewählt.' : 'Route ohne Einbahnstraße gewählt.' }[kind], true);
}
ui.routeChoice.addEventListener('click', e => {
  const b = e.target.closest('[data-route]');
  if (b) selectRoute(b.dataset.route);
});

/* ================================================================ Manöversymbole */

function arrowSvg(a) {
  const r = toRad(a), L1 = 8, hl = 4.6, w = 0.62;
  const ex = 12 + L1 * Math.sin(r), ey = 12 - L1 * Math.cos(r);
  const h1 = [ex - hl * Math.sin(r - w), ey + hl * Math.cos(r - w)];
  const h2 = [ex - hl * Math.sin(r + w), ey + hl * Math.cos(r + w)];
  const f = n => n.toFixed(2);
  return `<svg viewBox="0 0 24 24"><path d="M12 22.5V12L${f(ex)} ${f(ey)}"/><path d="M${f(h1[0])} ${f(h1[1])}L${f(ex)} ${f(ey)}L${f(h2[0])} ${f(h2[1])}"/></svg>`;
}
const SVG_UTURN = '<svg viewBox="0 0 24 24"><path d="M15 22.5V10a4 4 0 0 0-8 0v7"/><path d="M4 14l3 3 3-3"/></svg>';
const SVG_ROUND = '<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="4.5"/><path d="M12 22.5v-8"/><path d="M15.3 6.7l3.5-3.5M15 3h4v4"/></svg>';
const SVG_FLAG = '<svg viewBox="0 0 24 24"><path d="M6 22.5V3"/><path d="M6 4h11l-2.5 4L17 12H6"/></svg>';
const TURN_ANGLE = { 7: 0, 8: 0, 17: 0, 22: 0, 25: 0, 9: 45, 10: 90, 11: 135, 16: -45, 15: -90, 14: -135, 18: 40, 20: 40, 23: 25, 37: 25, 19: -40, 21: -40, 24: -25, 38: -25 };
function maneuverSvg(type) {
  if (type === 4 || type === 5 || type === 6) return SVG_FLAG;
  if (type === 26 || type === 27) return SVG_ROUND;
  if (type === 12) return SVG_UTURN.replace('<svg ', '<svg style="transform:scaleX(-1)" ');
  if (type === 13) return SVG_UTURN;
  return arrowSvg(TURN_ANGLE[type] ?? 0);
}
function cleanInstr(s) { return (s || '').replace(/\.\s*$/, ''); }

/* ================================================================ Navigation */

function showNavUi() {
  document.body.classList.add('has-route');
  v3el.btn.hidden = false;
  ui.routeSheet.hidden = false;
  syncTopUi();
}
function syncTopUi() {
  if (cmode) return;
  const navOn = !!dest;
  ui.searchBar.hidden = navOn;
  ui.navBanner.hidden = !navOn;
}

async function startNav() {
  nav.active = true;
  startTrafficTimer();
  showNavUi();
  try {
    if ('wakeLock' in navigator) nav.wake = await navigator.wakeLock.request('screen');
  } catch { /* nicht verfügbar */ }
}

function stopNav() {
  routeToken++;
  stopSim();
  nav.active = false;
  nav.route = null;
  nav.options = null;
  nav.arrived = false;
  stopTrafficTimer();
  TRAFFIC.layer.clearLayers();
  railLayer.clearLayers();
  wallLayer.clearLayers();
  $('destInfo').hidden = true;
  $('destInfoChip').hidden = true;
  $('trafficWarn').hidden = true;
  close3d();
  setBig(false);
  v3el.btn.hidden = true;
  dest = null;
  pendingRoute = false;
  manualStart = null;
  routeLayer.clearLayers();
  if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
  if (nav.wake) { nav.wake.release().catch(() => {}); nav.wake = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  document.body.classList.remove('has-route');
  ui.routeSheet.hidden = true;
  ui.routeChoice.hidden = true;
  ui.navBanner.hidden = true;
  ui.contraWarn.hidden = true;
  ui.searchBar.hidden = false;
  ui.destInput.value = '';
  ui.clearDest.hidden = true;
  setStatus('');
  drawPosition();
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && nav.active && 'wakeLock' in navigator && (!nav.wake || nav.wake.released)) {
    try { nav.wake = await navigator.wakeLock.request('screen'); } catch { /* ignorieren */ }
  }
});

function locateOnRoute(p) {
  const r = nav.route;
  const P = proj([p.lat, p.lon], r.lat0);
  const n = r.xy.length - 1;
  const scan = (from, to) => {
    let best = { d: Infinity, i: 0, t: 0 };
    for (let i = from; i < to; i++) {
      const s = segDist(P, r.xy[i], r.xy[i + 1]);
      if (s.d < best.d) best = { d: s.d, i, t: s.t };
    }
    return best;
  };
  let best = scan(Math.max(0, nav.idx - 3), Math.min(n, nav.idx + 400));
  if (best.d > 50) {
    const all = scan(0, n);
    if (all.d < best.d - 10) best = all;
  }
  best.along = r.cum[best.i] + best.t * (r.cum[best.i + 1] - r.cum[best.i]);
  best.point = lerp(r.shape[best.i], r.shape[best.i + 1], best.t);
  return best;
}

function navUpdate() {
  const r = nav.route;
  if (!r || nav.arrived) return;
  const p = trackingPos();
  let along = 0, loc = null;
  if (p) {
    loc = locateOnRoute(p);
    const offLimit = Math.max(40, (p.acc || 10) * 1.3);
    if (loc.d > offLimit && !nav.sim) {
      nav.offCount++;
      if (nav.offCount >= 3 && Date.now() - nav.lastReroute > 8000) {
        nav.offCount = 0;
        computeRoute('reroute');
        return;
      }
    } else nav.offCount = 0;
    if (loc.d <= offLimit) { nav.idx = loc.i; nav.along = loc.along; }
    along = nav.along;
    lineRest.setLatLngs([loc.point, ...r.shape.slice(loc.i + 1)]);
    lineDone.setLatLngs([...r.shape.slice(0, loc.i + 1), loc.point]);
  }

  const remaining = Math.max(0, r.total - along);
  if (p && remaining < 25) { arrive(); return; }

  /* nächstes Manöver */
  const mans = r.maneuvers;
  let nextK = -1, curK = 0;
  for (let k = 0; k < mans.length; k++) {
    const pos = r.cum[Math.min(mans[k].begin_shape_index, r.cum.length - 1)];
    if (pos <= along + 1) curK = k;
    if (nextK < 0 && pos > along + 1 && mans[k].type !== 1 && mans[k].type !== 2 && mans[k].type !== 3) nextK = k;
  }
  if (nextK < 0) nextK = mans.length - 1;
  const m = mans[nextK];
  const mDist = r.cum[Math.min(m.begin_shape_index, r.cum.length - 1)] - along;
  ui.mnvIcon.innerHTML = maneuverSvg(m.type);
  ui.mnvDist.textContent = fmtDist(mDist);
  ui.mnvInstr.textContent = cleanInstr(m.instruction);

  const m2 = mans[nextK + 1];
  const gap = m2 ? r.cum[Math.min(m2.begin_shape_index, r.cum.length - 1)] - r.cum[Math.min(m.begin_shape_index, r.cum.length - 1)] : Infinity;
  if (m2 && gap < 200 && mDist < 600) {
    ui.mnvNext.innerHTML = `Dann ${maneuverSvg(m2.type)} <span>${esc(cleanInstr(m2.verbal_succinct_transition_instruction || m2.instruction))}</span>`;
    ui.mnvNext.hidden = false;
  } else ui.mnvNext.hidden = true;

  /* Restzeit */
  let remTime = 0;
  for (let k = curK; k < mans.length; k++) {
    const mm = mans[k];
    const b = r.cum[Math.min(mm.begin_shape_index, r.cum.length - 1)];
    const e = r.cum[Math.min(mm.end_shape_index ?? mm.begin_shape_index, r.cum.length - 1)];
    if (k === curK && e > b) remTime += mm.time * Math.max(0, Math.min(1, (e - along) / (e - b)));
    else if (k > curK) remTime += mm.time;
  }
  if (trafficOn()) { remTime += remainingDelay(r, along); trafficBanner(r, along); }
  const eta = new Date(Date.now() + remTime * 1000);
  ui.etaClock.textContent = eta.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  ui.remTime.textContent = Math.max(1, Math.round(remTime / 60));
  ui.remDist.textContent = nf1.format(remaining / 1000);

  /* Gegenrichtung */
  let inContra = null, nextContra = null;
  for (const c of r.contra) {
    const s = r.cum[c.i0], e = r.cum[c.i1 + 1];
    if (along >= s - 2 && along <= e) { inContra = { c, left: e - along }; break; }
    if (s > along && (!nextContra || s < nextContra.at)) nextContra = { c, at: s, dist: s - along };
  }
  ui.maneuver.classList.toggle('contra', !!inContra);
  if (inContra) {
    ui.contraWarn.hidden = false;
    ui.contraWarnText.textContent = `Gegen Einbahnrichtung, noch ${fmtDist(inContra.left)}`;
  } else if (nextContra && nextContra.dist < 300) {
    ui.contraWarn.hidden = false;
    ui.contraWarnText.textContent = `In ${fmtDist(nextContra.dist)} gegen Einbahnrichtung (${fmtDist(nextContra.c.len)})`;
  } else ui.contraWarn.hidden = true;

  /* Ansagen */
  if (p) {
    const v = Math.max(5, p.speed || 0);
    const far = Math.min(800, Math.max(200, v * 18));
    const near = Math.max(35, v * 6);
    const keyFar = `f${nextK}`, keyNear = `n${nextK}`;
    if (mDist <= near && !nav.announced.has(keyNear)) {
      nav.announced.add(keyNear); nav.announced.add(keyFar);
      say(m.verbal_pre_transition_instruction || m.instruction, true);
    } else if (mDist <= far && mDist > near * 1.8 && !nav.announced.has(keyFar)) {
      nav.announced.add(keyFar);
      const t = m.verbal_transition_alert_instruction || m.verbal_pre_transition_instruction;
      if (t) say(`In ${spokenDist(mDist)} ${lowerFirst(t)}`);
    }
    if (nextContra && nextContra.dist < 160 && !nav.announced.has('contra' + nextContra.c.i0)) {
      nav.announced.add('contra' + nextContra.c.i0);
      say('Achtung. Gleich Einbahnstraße gegen die Fahrtrichtung.');
    }
  }

  if (p && nav.follow) followCamera(p);
}

function followCamera(p) {
  const v = p.speed || 0;
  const zoom = v > 22 ? 15 : v > 11 ? 16 : 17;
  const size = map.getSize();
  const side = sideW;
  const pt = map.project([p.lat, p.lon], zoom).add([side / 2, -size.y * (side ? 0.1 : 0.14)]);
  map.setView(map.unproject(pt, zoom), zoom, { animate: true, duration: 0.8 });
}

function arrive() {
  nav.arrived = true;
  stopSim();
  drawRoute();
  renderChoice();
  ui.mnvIcon.innerHTML = SVG_FLAG;
  ui.mnvDist.textContent = 'Ziel';
  ui.mnvInstr.textContent = dest ? dest.label : 'Ziel erreicht';
  ui.mnvNext.hidden = true;
  ui.contraWarn.hidden = true;
  ui.maneuver.classList.remove('contra');
  ui.remTime.textContent = '0';
  ui.remDist.textContent = '0,0';
  setStatus('Ziel erreicht');
  say('Sie haben das Ziel erreicht.');
  lineRest.setLatLngs([]);
  lineDone.setLatLngs(nav.route.shape);
}

/* ---------- Kamera folgen ---------- */

function syncFollowUi() {
  ui.centerBtn.classList.toggle('following', nav.follow);
  ui.overviewBtn.textContent = nav.follow ? 'Übersicht' : 'Folgen';
}
map.on('dragstart', () => { if (nav.follow) { nav.follow = false; syncFollowUi(); } });
ui.centerBtn.addEventListener('click', () => {
  enableCompass();
  const p = currentPos();
  if (!p) { toast('Noch keine Position verfügbar', 'warn'); return; }
  nav.follow = true; syncFollowUi();
  if (nav.active && trackingPos()) followCamera(p);
  else map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
});
ui.overviewBtn.addEventListener('click', () => {
  if (nav.follow) { nav.follow = false; syncFollowUi(); fitRoute(); }
  else { nav.follow = true; syncFollowUi(); const p = trackingPos(); if (p) followCamera(p); }
});
ui.stopBtn.addEventListener('click', stopNav);

/* ================================================================ Sprachausgabe */

let deVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  deVoice = voices.find(v => /^de(-|_)DE/i.test(v.lang) && /google|anna|petra|helena|katja/i.test(v.name))
    || voices.find(v => /^de/i.test(v.lang)) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked || !('speechSynthesis' in window)) return;
  speechUnlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}
function say(text, urgent = false) {
  if (!settings.voice || !text || !('speechSynthesis' in window)) return;
  if (urgent) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  if (deVoice) u.voice = deVoice;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

/* ================================================================ Simulation */

function stopSim() {
  if (nav.sim) { clearInterval(nav.sim); nav.sim = null; nav.simPos = null; }
  ui.simBtn.textContent = 'Fahrt simulieren';
  ui.simBtn.classList.remove('active');
  drawPosition();
}
function startSim() {
  const r = nav.route;
  if (!r) return;
  unlockSpeech();
  let s = nav.along || 0;
  const speedAt = along => {
    const mans = r.maneuvers;
    for (let k = mans.length - 1; k >= 0; k--) {
      if (r.cum[Math.min(mans[k].begin_shape_index, r.cum.length - 1)] <= along) {
        const v = mans[k].time > 0 ? mans[k].length * 1000 / mans[k].time : 12;
        return Math.min(19, Math.max(6, v));
      }
    }
    return 12;
  };
  ui.simBtn.textContent = 'Simulation stoppen';
  ui.simBtn.classList.add('active');
  nav.follow = true; syncFollowUi();
  const step = () => {
    const route = nav.route;
    if (!route) { stopSim(); return; }
    const v = speedAt(s);
    s = Math.min(route.total, s + v);
    let i = 0;
    while (i < route.cum.length - 2 && route.cum[i + 1] < s) i++;
    const segLen = route.cum[i + 1] - route.cum[i];
    const t = segLen ? (s - route.cum[i]) / segLen : 0;
    const pt = lerp(route.shape[i], route.shape[i + 1], t);
    nav.simPos = { lat: pt[0], lon: pt[1], acc: 5, speed: v, heading: planarBearing(route.xy[i], route.xy[i + 1]), sim: true };
    drawPosition();
    navUpdate();
    if (s >= route.total) stopSim();
  };
  nav.sim = setInterval(step, 1000);
  step();
}
ui.simBtn.addEventListener('click', () => { nav.sim ? stopSim() : startSim(); });

/* ================================================================ Langer Druck auf die Karte */

map.on('contextmenu', e => {
  if (cmode) return;
  const ll = [e.latlng.lat, e.latlng.lng];
  const div = document.createElement('div');
  div.innerHTML = `<div class="ctx-title">${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}</div>
    <button class="btn small" type="button" data-a="dest">Als Ziel</button>
    <button class="btn danger small" type="button" data-a="close">Hier sperren</button>
    <button class="btn ghost small" type="button" data-a="start">${manualStart ? 'Neuer Startpunkt' : 'Als Startpunkt (statt GPS)'}</button>
    ${manualStart ? '<button class="btn ghost small" type="button" data-a="gps">Start wieder über GPS</button>' : ''}`;
  div.addEventListener('click', async ev => {
    const a = ev.target.closest('button')?.dataset.a;
    if (!a) return;
    map.closePopup();
    if (a === 'dest') {
      const d = { lat: ll[0], lon: ll[1], label: 'Punkt auf der Karte', sub: '' };
      chooseDest(d);
      const l = await reverseLabel(ll[0], ll[1]);
      if (l && dest && dest.lat === d.lat) { dest.label = l.main; ui.destInput.value = l.main; v3el.addr.textContent = l.main; addRecent({ ...dest, sub: l.sub }); }
    } else if (a === 'close') {
      addClosure({ kind: 'point', center: ll, radius: +settings.radius || 20, label: `Sperrung ${closures.length + 1}` });
      toast('Sperrung eingetragen');
    } else if (a === 'start') {
      manualStart = ll;
      stopSim();
      drawPosition();
      toast('Startpunkt gesetzt. GPS wird für diese Fahrt nicht verwendet.');
      if (dest) computeRoute('new');
    } else if (a === 'gps') {
      manualStart = null;
      drawPosition();
      if (dest) computeRoute('new');
    }
  });
  L.popup({ className: 'ctx-pop', closeButton: false }).setLatLng(e.latlng).setContent(div).openOn(map);
});

/* ================================================================ 3D-Ansicht des Ziels
   MapLibre GL mit Gebäudehöhen aus OpenStreetMap (OpenFreeMap), Geländehöhen (Terrarium)
   und optionalem Luftbild. Die Bibliothek wird erst beim ersten Öffnen geladen. */

const ML_VER = '4.7.1';
const ML_JS = `https://unpkg.com/maplibre-gl@${ML_VER}/dist/maplibre-gl.js`;
const ML_CSS = `https://unpkg.com/maplibre-gl@${ML_VER}/dist/maplibre-gl.css`;
const STYLE_3D = 'https://tiles.openfreemap.org/styles/liberty';
const AERIAL_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const v3 = { map: null, ready: false, marker: null, big: false, spin: false, raf: 0, air: false, bldLayer: null, hlKey: '', hlTries: 0 };
const v3el = {
  box: $('view3d'), map: $('v3Map'), addr: $('v3Addr'), msg: $('v3Msg'), btn: $('view3dBtn'),
  air: $('v3Air'), spin: $('v3Spin'), center: $('v3Center'), size: $('v3Size'), close: $('v3Close')
};
const destKey = () => dest ? `${dest.lat.toFixed(6)},${dest.lon.toFixed(6)}` : '';

let mlPromise = null;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  if (mlPromise) return mlPromise;
  mlPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = ML_CSS;
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = ML_JS; js.async = true;
    js.onload = () => resolve();
    js.onerror = () => { mlPromise = null; js.remove(); reject(new Error('3D-Bibliothek nicht erreichbar')); };
    document.head.appendChild(js);
  });
  return mlPromise;
}

function v3msg(text) { v3el.msg.textContent = text || ''; v3el.msg.hidden = !text; }

/* Blickrichtung: Richtung der letzten 60 m der Route, also so, wie das Ziel angefahren wird */
function approachBearing() {
  const r = nav.route;
  if (!r || r.shape.length < 2) return 0;
  const n = r.shape.length - 1;
  let k = n;
  while (k > 0 && r.cum[n] - r.cum[k] < 60) k--;
  return planarBearing(r.xy[k], r.xy[n]);
}

function routeGeo3d() {
  const r = nav.route;
  const feats = [];
  if (r) {
    const ll = p => [p[1], p[0]];
    feats.push({ type: 'Feature', properties: { contra: false }, geometry: { type: 'LineString', coordinates: r.shape.map(ll) } });
    for (const c of r.contra) feats.push({ type: 'Feature', properties: { contra: true }, geometry: { type: 'LineString', coordinates: r.shape.slice(c.i0, c.i1 + 2).map(ll) } });
  }
  return { type: 'FeatureCollection', features: feats };
}

function setup3dLayers() {
  const m = v3.map;
  const style = m.getStyle();
  const firstSymbol = (style.layers.find(l => l.type === 'symbol') || {}).id;
  const vecSrc = Object.keys(style.sources).find(k => style.sources[k].type === 'vector');
  let ext = style.layers.find(l => l.type === 'fill-extrusion');
  if (!ext && vecSrc) {
    m.addLayer({
      id: 'gebaeude-3d', type: 'fill-extrusion', source: vecSrc, 'source-layer': 'building', minzoom: 14,
      paint: {
        'fill-extrusion-color': '#d8d1c4',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.9
      }
    }, firstSymbol);
    ext = { id: 'gebaeude-3d' };
  }
  v3.bldLayer = ext ? ext.id : null;
  const firstBuilding = (style.layers.find(l => l['source-layer'] === 'building') || ext || {}).id;

  m.addSource('luftbild', { type: 'raster', tiles: [AERIAL_TILES], tileSize: 256, maxzoom: 19, attribution: 'Luftbild © Esri, Maxar, Earthstar Geographics' });
  m.addLayer({ id: 'luftbild', type: 'raster', source: 'luftbild', layout: { visibility: 'none' } }, firstBuilding || firstSymbol);

  try {
    m.addSource('gelaende', { type: 'raster-dem', tiles: [TERRAIN_TILES], tileSize: 256, maxzoom: 14, encoding: 'terrarium', attribution: 'Höhen: Mapzen Terrain Tiles' });
    m.setTerrain({ source: 'gelaende', exaggeration: 1 });
  } catch (e) { console.warn('Gelände nicht verfügbar', e); }

  m.addSource('route3d', { type: 'geojson', data: routeGeo3d() });
  m.addLayer({ id: 'route3d-rand', type: 'line', source: 'route3d', filter: ['!', ['get', 'contra']],
    layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0a1424', 'line-width': 10, 'line-opacity': 0.75 } }, firstSymbol);
  m.addLayer({ id: 'route3d', type: 'line', source: 'route3d',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['case', ['get', 'contra'], cssVar('--contra'), cssVar('--route')], 'line-width': 6 } }, firstSymbol);

  m.addSource('ziel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  m.addLayer({ id: 'ziel-3d', type: 'fill-extrusion', source: 'ziel', paint: {
    'fill-extrusion-color': '#e5383b',
    'fill-extrusion-height': ['+', ['coalesce', ['get', 'render_height'], 8], 0.6],
    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
    'fill-extrusion-opacity': 0.95
  } });
  applyAir();
}

function applyAir() {
  const m = v3.map;
  v3el.air.setAttribute('aria-pressed', v3.air ? 'true' : 'false');
  if (!m || !v3.ready) return;
  m.setLayoutProperty('luftbild', 'visibility', v3.air ? 'visible' : 'none');
  if (v3.bldLayer && m.getLayer(v3.bldLayer)) {
    try { m.setPaintProperty(v3.bldLayer, 'fill-extrusion-opacity', v3.air ? 0.45 : 0.9); } catch { /* Stilvorgabe beibehalten */ }
  }
}

/* Zielgebäude suchen: Gebäude unter dem Zielpunkt, sonst das nächstgelegene im Umkreis */
function highlightTarget() {
  const m = v3.map;
  if (!m || !v3.ready || !dest || !v3.bldLayer || v3.hlKey === destKey() || v3.hlTries > 6) return;
  v3.hlTries++;
  const p = m.project([dest.lon, dest.lat]);
  let feats = m.queryRenderedFeatures(p, { layers: [v3.bldLayer] });
  if (!feats.length) {
    const r = 40;
    const near = m.queryRenderedFeatures([[p.x - r, p.y - r], [p.x + r, p.y + r]], { layers: [v3.bldLayer] });
    let best = null, bd = Infinity;
    for (const f of near) {
      const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0][0] : null;
      if (!ring || !ring.length) continue;
      const c = ring.reduce((a, q) => [a[0] + q[0] / ring.length, a[1] + q[1] / ring.length], [0, 0]);
      const d = haversine([dest.lat, dest.lon], [c[1], c[0]]);
      if (d < bd) { bd = d; best = f; }
    }
    if (best && bd < 35) feats = [best];
  }
  if (!feats.length) return;
  const f = feats[0];
  m.getSource('ziel').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { ...f.properties }, geometry: f.geometry }] });
  v3.hlKey = destKey();
}

function focus3d(animate) {
  const m = v3.map;
  if (!m || !dest) return;
  const opts = { center: [dest.lon, dest.lat], zoom: 17.4, pitch: 62, bearing: approachBearing() };
  if (animate) m.easeTo({ ...opts, duration: 900 }); else m.jumpTo(opts);
  if (!v3.marker) v3.marker = new maplibregl.Marker({ color: '#e5383b' });
  v3.marker.setLngLat([dest.lon, dest.lat]).addTo(m);
  if (v3.hlKey !== destKey()) { v3.hlTries = 0; m.getSource('ziel') && m.getSource('ziel').setData({ type: 'FeatureCollection', features: [] }); }
  update3dRoute();
}

function update3dRoute() {
  if (!v3.map || !v3.ready) return;
  const src = v3.map.getSource('route3d');
  if (src) src.setData(routeGeo3d());
}

function setSpin(on) {
  v3.spin = on;
  v3el.spin.setAttribute('aria-pressed', on ? 'true' : 'false');
  cancelAnimationFrame(v3.raf);
  if (!on || !v3.map) return;
  let last = performance.now();
  const step = now => {
    if (!v3.spin || !v3.map) return;
    v3.map.setBearing((v3.map.getBearing() + (now - last) * 0.012) % 360);
    last = now;
    v3.raf = requestAnimationFrame(step);
  };
  v3.raf = requestAnimationFrame(step);
}

async function open3d() {
  if (!dest) return;
  v3el.box.hidden = false;
  v3el.btn.setAttribute('aria-pressed', 'true');
  v3el.addr.textContent = dest.label || 'Ziel';
  /* Zu wenig Platz für das kleine Fenster (z. B. iPhone SE hochkant): direkt im Vollbild öffnen */
  if (!v3.big && !document.body.classList.contains('landscape')) {
    const free = innerHeight - ui.routeSheet.getBoundingClientRect().height - ui.navBanner.getBoundingClientRect().bottom - (document.body.classList.contains('fabs-row') ? 96 : 28);
    if (free < 170) setBig(true);
  }
  if (v3.map) { v3.map.resize(); focus3d(true); return; }
  v3msg('3D-Ansicht wird geladen');
  try { await loadMapLibre(); } catch (e) { v3msg('3D-Bibliothek nicht erreichbar. Netzverbindung prüfen.'); return; }
  if (v3el.box.hidden) return;
  try {
    v3.map = new maplibregl.Map({
      container: v3el.map, style: STYLE_3D,
      center: [dest.lon, dest.lat], zoom: 17.4, pitch: 62, bearing: approachBearing(),
      minZoom: 14, maxZoom: 19.8, maxPitch: 80,
      attributionControl: false, dragRotate: false, dragPan: false, touchPitch: false,
      doubleClickZoom: false, keyboard: false, boxZoom: false, pitchWithRotate: false
    });
  } catch (e) {
    v3.map = null;
    v3msg('3D-Darstellung wird von diesem Gerät nicht unterstützt (WebGL).');
    return;
  }
  v3.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right');
  setup3dGestures();
  v3.map.on('load', () => {
    v3.ready = true;
    v3msg('');

    try { setup3dLayers(); } catch (e) { console.warn('3D-Ebenen', e); }
    focus3d(false);
    /* Quellenangabe nach dem Laden aller Quellen einklappen (Tipp auf „i“ zeigt sie wieder) */
    v3.map.once('idle', collapseAttrib);
  });
  v3.map.on('idle', highlightTarget);
  v3.map.on('error', e => {
    if (!v3.ready) v3msg('Kartendaten für die 3D-Ansicht nicht erreichbar.');
    console.warn('3D', e && e.error ? e.error.message : e);
  });
  v3.map.on('zoomstart', e => { if (e.originalEvent && v3.spin) setSpin(false); });
}

/* Bedienung der 3D-Ansicht: Das Ziel bleibt in der Bildmitte.
   Ein Finger (oder Maus) waagrecht: um das Ziel drehen. Senkrecht: Ansicht neigen.
   Zwei Finger (oder Mausrad): zoomen, immer auf die Bildmitte bezogen. */
function setup3dGestures() {
  const m = v3.map;
  m.touchZoomRotate.enable({ around: 'center' });
  m.touchZoomRotate.disableRotation();
  m.scrollZoom.enable({ around: 'center' });
  const el = m.getCanvasContainer();
  el.style.touchAction = 'none';
  const pts = new Map();
  let last = null;
  el.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) {
      last = [e.clientX, e.clientY];
      try { el.setPointerCapture(e.pointerId); } catch { /* nicht unterstützt */ }
      if (v3.spin) setSpin(false);
    } else last = null;
  });
  el.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size !== 1 || !last) return;
    const dx = e.clientX - last[0], dy = e.clientY - last[1];
    last = [e.clientX, e.clientY];
    m.jumpTo({
      bearing: m.getBearing() - dx * 0.4,
      pitch: Math.max(0, Math.min(80, m.getPitch() - dy * 0.35))
    });
  });
  const end = e => {
    pts.delete(e.pointerId);
    /* Nach einem Zweifinger-Zoom nicht sofort weiterdrehen */
    last = null;
  };
  for (const t of ['pointerup', 'pointercancel']) el.addEventListener(t, end);
}

function collapseAttrib() {
  v3el.map.querySelectorAll('.maplibregl-ctrl-attrib').forEach(a => { a.classList.remove('maplibregl-compact-show'); a.removeAttribute('open'); });
}

function v3pad(action) {
  const m = v3.map;
  if (!m) return;
  setSpin(false);
  const b = m.getBearing(), p = m.getPitch(), z = m.getZoom();
  if (action === 'rotl') m.easeTo({ bearing: b + 45, duration: 350 });
  else if (action === 'rotr') m.easeTo({ bearing: b - 45, duration: 350 });
  else if (action === 'tilt') m.easeTo({ pitch: p > 30 ? 0 : 62, duration: 450 });
  else if (action === 'in') m.easeTo({ zoom: Math.min(19.8, z + 0.8), duration: 300 });
  else if (action === 'out') m.easeTo({ zoom: Math.max(14, z - 0.8), duration: 300 });
  if (action === 'tilt') syncTilt(p > 30 ? 0 : 62);
}
function syncTilt(pitch) {
  const b = document.querySelector('[data-v3="tilt"]');
  if (b) b.textContent = pitch > 30 ? '2D' : '3D';
}



function close3d() {
  setSpin(false);
  v3el.box.hidden = true;
  v3el.btn.setAttribute('aria-pressed', 'false');
}

function setBig(on) {
  v3.big = on;
  v3el.box.classList.toggle('big', on);
  v3el.box.classList.toggle('small', !on);
  v3el.size.setAttribute('aria-label', on ? 'Verkleinern' : 'Vergrößern');
  v3el.size.title = on ? 'Verkleinern' : 'Vergrößern';
  v3el.size.innerHTML = on
    ? '<svg viewBox="0 0 24 24"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
  if (v3.map) requestAnimationFrame(() => v3.map.resize());
}

v3el.btn.addEventListener('click', () => { v3el.box.hidden ? open3d() : close3d(); });
v3el.close.addEventListener('click', close3d);
v3el.size.addEventListener('click', () => setBig(!v3.big));
v3el.air.addEventListener('click', () => { v3.air = !v3.air; applyAir(); if (v3.map) v3.map.once('idle', collapseAttrib); });
v3el.spin.addEventListener('click', () => setSpin(!v3.spin));
v3el.center.addEventListener('click', () => { setSpin(false); focus3d(true); syncTilt(62); });
document.querySelector('.v3-pad').addEventListener('click', e => {
  const b = e.target.closest('[data-v3]');
  if (b) v3pad(b.dataset.v3);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && v3.big) setBig(false); });

/* ================================================================ Diagnose */

const diagLayer = L.layerGroup();
const ARROW_SVG = '<svg viewBox="0 0 14 14"><path d="M7 1 L12.5 12 L7 9.2 L1.5 12 Z"/></svg>';
function drawDiagOverlay() {
  diagLayer.clearLayers();
  if (!lastDiag) return false;
  const { G, contra, all } = lastDiag;
  const col = cssVar('--diag'), off = cssVar('--muted');
  const reasonById = new Map(G.ways.map(w => [w.id, w.reason]));
  let arrows = 0;
  for (const el of G.geomEls) {
    const pts = el.geometry.map(g => [g.lat, g.lon]);
    const blocked = !!reasonById.get(el.id);
    const name = el.tags.name || el.tags.ref || el.tags.highway;
    L.polyline(pts, { pane: 'contra', color: blocked ? off : col, weight: 5, opacity: .9 })
      .bindTooltip(`${name}: Einbahn, ${blocked ? 'Gegenrichtung gesperrt' : 'Gegenrichtung zulässig'}`).addTo(diagLayer);
    const dir = onewayDir(el.tags);
    for (let k = 0; k < pts.length - 1 && arrows < 500; k++) {
      const a = proj(pts[k], G.lat0), b = proj(pts[k + 1], G.lat0);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 12) continue;
      const brg = (planarBearing(a, b) + (dir === -1 ? 180 : 0)) % 360;
      const mid = lerp(pts[k], pts[k + 1], .5);
      L.marker(mid, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'ow-arrow' + (blocked ? ' off' : ''), iconSize: [14, 14], iconAnchor: [7, 7], html: `<div style="transform:rotate(${brg}deg)">${ARROW_SVG}</div>` }) }).addTo(diagLayer);
      arrows++;
    }
  }
  const alt = contra && contra.contraEdges.length ? contra : all;
  if (alt && alt.contraEdges.length) {
    L.polyline(alt.nodes.map(i => [G.N.lat[i], G.N.lon[i]]), { pane: 'contra', color: cssVar('--contra'), weight: 4, dashArray: '10 8', opacity: 1, interactive: false }).addTo(diagLayer);
  }
  return true;
}
function toggleDiagMap() {
  const btn = $('diagMap');
  if (map.hasLayer(diagLayer)) { map.removeLayer(diagLayer); btn.textContent = 'Einbahnstraßen auf Karte zeigen'; return; }
  if (!drawDiagOverlay()) { toast('Noch keine Kartendaten geladen. Zuerst eine Route berechnen.', 'warn'); return; }
  diagLayer.addTo(map);
  btn.textContent = 'Einbahnstraßen ausblenden';
  closePanels();
  nav.follow = false; syncFollowUi();
  fitRoute();
  toast('Violett: Einbahnstraße mit erlaubter Fahrtrichtung. Grau: Gegenrichtung gesperrt. Gelb gestrichelt: Weg gegen Einbahnrichtung.', '', 8000);
}
$('diagBtn').addEventListener('click', () => {
  $('diagLog').textContent = diag.length ? diag.join('\n') : 'Noch keine Route berechnet.';
  openP($('diagPanel'));
});
$('diagMap').addEventListener('click', toggleDiagMap);
$('diagCopy').addEventListener('click', async () => {
  const text = diag.join('\n');
  try { await navigator.clipboard.writeText(text); toast('Protokoll kopiert'); }
  catch {
    const r = document.createRange(); r.selectNodeContents($('diagLog'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    toast('Text markiert. Über Kopieren übernehmen.', 'warn');
  }
});
$('versionLine').textContent = `Version ${APP_VERSION}`;
/* Tasten rechts: passen sie nicht zwischen Banner und Routenblatt, werden sie als Reihe unter dem Banner angeordnet */
function layoutFabs(sheetH, bannerB) {
  const fabs = [...document.querySelectorAll('.fabs .fab')].filter(f => !f.hidden);
  if (!fabs.length) return;
  const size = parseFloat(getComputedStyle(fabs[0]).height) || 56;
  const gap = parseFloat(getComputedStyle(document.querySelector('.fabs')).rowGap) || 12;
  const need = fabs.length * size + (fabs.length - 1) * gap;
  const land = document.body.classList.contains('landscape');
  const avail = land ? innerHeight - 24 : innerHeight - (document.body.classList.contains('has-route') ? sheetH : 0) - bannerB - 28;
  document.body.classList.toggle('fabs-row', !land && document.body.classList.contains('has-route') && need > avail);
}

/* Routenblatt ein- und ausklappen, Stellung wird gemerkt */
let sheetCollapsed = load('sheetCollapsed', innerWidth < 900);
function applySheet() {
  ui.routeSheet.classList.toggle('collapsed', sheetCollapsed);
  const t = $('sheetToggle');
  t.setAttribute('aria-expanded', sheetCollapsed ? 'false' : 'true');
  t.setAttribute('aria-label', sheetCollapsed ? 'Details einblenden' : 'Details ausblenden');
  t.classList.toggle('has-info', sheetCollapsed && !ui.routeStatus.hidden && !!ui.routeStatus.textContent);
}
function toggleSheet() { sheetCollapsed = !sheetCollapsed; save('sheetCollapsed', sheetCollapsed); applySheet(); }
$('sheetToggle').addEventListener('click', toggleSheet);
document.querySelector('.route-stats').addEventListener('click', toggleSheet);
applySheet();

/* Höhe des Routenblatts als CSS-Variable, damit Tasten und Einblendungen darüber bleiben */
try {
  const ro = new ResizeObserver(() => {
    const h = ui.routeSheet.hidden ? 0 : ui.routeSheet.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--sheet-h', `${Math.round(h)}px`);
    const b = ui.navBanner.hidden ? 0 : ui.navBanner.getBoundingClientRect().bottom;
    document.documentElement.style.setProperty('--banner-b', `${Math.round(b)}px`);
    layoutFabs(h, b);
  });
  ro.observe(ui.routeSheet);
  ro.observe(ui.navBanner);
} catch { /* ältere Browser: Standardwert aus CSS */ }

/* ================================================================ Einstellungen */

let openPanel = null;
function openP(panel) {
  closePanels();
  openPanel = panel;
  panel.hidden = false;
  ui.scrim.hidden = false;
}
function closePanels() {
  if (openPanel) openPanel.hidden = true;
  openPanel = null;
  ui.scrim.hidden = true;
}
ui.scrim.addEventListener('click', closePanels);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closePanels));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (openPanel) closePanels();
  else if (cmode) exitClosureMode();
});
ui.settingsBtn.addEventListener('click', () => openP(ui.settingsPanel));
ui.vehicleChip.addEventListener('click', () => { openP(ui.settingsPanel); $('vehicleGroup').scrollIntoView({ block: 'start' }); });
ui.closureChip.addEventListener('click', () => openP(ui.closurePanel));

const fld = {
  height: $('vHeight'), width: $('vWidth'), length: $('vLength'), weight: $('vWeight'), axle: $('vAxle'),
  preset: $('presetSel'), contra: $('optContra'), dual: $('optDual'), minGain: $('optMinGain'), voice: $('optVoice'),
  night: $('optNight'), radius: $('optRadius'), layer: $('optLayer'),
  valhalla: $('srvValhalla'), photon: $('srvPhoton'), overpass: $('srvOverpass')
};

PRESETS.forEach(p => fld.preset.add(new Option(p.name, p.id)));
Object.entries(LAYERS).forEach(([k, v]) => fld.layer.add(new Option(v.name, k)));
const classList = $('classList');
CLASSES.forEach(([k, label]) => {
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" value="${k}" id="cls-${k}"> <span>${esc(label)}</span>`;
  classList.appendChild(l);
});

function fillSettings() {
  const v = settings.vehicle;
  document.querySelectorAll('[data-vtype]').forEach(b => {
    const on = b.dataset.vtype === v.type;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  $('truckFields').classList.toggle('off', v.type !== 'lkw');
  fld.preset.value = v.preset;
  fld.height.value = v.height; fld.width.value = v.width; fld.length.value = v.length;
  fld.weight.value = v.weight; fld.axle.value = v.axle;
  fld.contra.checked = settings.contra.enabled;
  fld.minGain.value = settings.contra.minGain;
  fld.dual.checked = !!settings.contra.dual;
  classList.querySelectorAll('input').forEach(i => { i.checked = settings.contra.classes.includes(i.value); });
  fld.voice.checked = settings.voice;
  fld.night.checked = settings.night;
  fld.radius.value = settings.radius;
  fld.layer.value = settings.layer;
  fld.valhalla.value = settings.servers.valhalla;
  fld.photon.value = settings.servers.photon;
  fld.overpass.value = settings.servers.overpass;
  ui.vehicleChipText.textContent = vehicleLabel();
}

let rerouteTimer = null;
function saveSettings(reroute) {
  save('settings', settings);
  ui.vehicleChipText.textContent = vehicleLabel();
  renderBadges();
  if (reroute && dest && nav.active) {
    clearTimeout(rerouteTimer);
    rerouteTimer = setTimeout(() => computeRoute('settings'), 700);
  }
}

document.querySelectorAll('[data-vtype]').forEach(b => b.addEventListener('click', () => {
  settings.vehicle.type = b.dataset.vtype;
  fillSettings(); saveSettings(true);
}));
fld.preset.addEventListener('change', () => {
  const p = PRESETS.find(x => x.id === fld.preset.value);
  settings.vehicle.preset = p.id;
  if (p.h) Object.assign(settings.vehicle, { height: p.h, width: p.w, length: p.l, weight: p.t, axle: p.a });
  fillSettings(); saveSettings(true);
});
[['height', 1.5, 5], ['width', 1.5, 3.5], ['length', 3, 25], ['weight', 2, 60], ['axle', 1, 15]].forEach(([k, lo, hi]) => {
  fld[k].addEventListener('change', () => {
    const v = parseFloat(String(fld[k].value).replace(',', '.'));
    if (!Number.isFinite(v)) { fld[k].value = settings.vehicle[k]; return; }
    settings.vehicle[k] = Math.min(hi, Math.max(lo, v));
    settings.vehicle.preset = 'custom';
    fillSettings(); saveSettings(true);
  });
});
fld.contra.addEventListener('change', () => { settings.contra.enabled = fld.contra.checked; saveSettings(true); });
fld.dual.addEventListener('change', () => { settings.contra.dual = fld.dual.checked; saveSettings(true); });
fld.minGain.addEventListener('change', () => { settings.contra.minGain = Math.max(0, +fld.minGain.value || 0); saveSettings(true); });
classList.addEventListener('change', () => {
  settings.contra.classes = [...classList.querySelectorAll('input:checked')].map(i => i.value);
  saveSettings(true);
});
fld.voice.addEventListener('change', () => { settings.voice = fld.voice.checked; if (settings.voice) { unlockSpeech(); say('Sprachansagen aktiv.'); } saveSettings(false); });
fld.night.addEventListener('change', () => { settings.night = fld.night.checked; applyLayer(); saveSettings(false); });
fld.radius.addEventListener('change', () => { settings.radius = Math.min(200, Math.max(5, +fld.radius.value || 20)); fld.radius.value = settings.radius; saveSettings(false); });
fld.layer.addEventListener('change', () => { settings.layer = fld.layer.value; applyLayer(); saveSettings(false); });
['valhalla', 'photon', 'overpass'].forEach(k => fld[k].addEventListener('change', () => {
  settings.servers[k] = fld[k].value.trim() || DEFAULT_SERVERS[k]; fillSettings(); saveSettings(false);
}));
$('srvReset').addEventListener('click', () => { settings.servers = { ...DEFAULT_SERVERS }; fillSettings(); saveSettings(false); });

ui.layerBtn.addEventListener('click', () => {
  settings.night = !settings.night;
  applyLayer(); fillSettings(); saveSettings(false);
  toast(settings.night ? 'Nachtkarte an' : 'Tageskarte an', '', 1500);
});

/* ================================================================ Start */

/* ---------- iPhone: Querformat, Home-Bildschirm, Offline ---------- */

let sideW = 0;
const mqLand = matchMedia('(orientation: landscape) and (max-height: 600px)');
function applyOrientation() {
  const land = mqLand.matches;
  document.body.classList.toggle('landscape', land);
  sideW = land ? Math.round(Math.min(360, Math.max(280, innerWidth * 0.38))) : 0;
  if (land) document.documentElement.style.setProperty('--side-w', `${sideW}px`);
  map.invalidateSize();
  if (v3.map && !v3el.box.hidden) v3.map.resize();
  layoutFabs(ui.routeSheet.hidden ? 0 : ui.routeSheet.getBoundingClientRect().height, ui.navBanner.hidden ? 0 : ui.navBanner.getBoundingClientRect().bottom);
  const p = trackingPos();
  if (nav.active && nav.follow && p) followCamera(p);
}
if (mqLand.addEventListener) mqLand.addEventListener('change', applyOrientation); else mqLand.addListener(applyOrientation);
let orientTimer = null;
addEventListener('resize', () => { clearTimeout(orientTimer); orientTimer = setTimeout(applyOrientation, 150); });
applyOrientation();

function onceHint(key, msg, ms = 9000) {
  const seen = load('hints', {});
  if (seen[key]) return;
  seen[key] = Date.now();
  save('hints', seen);
  toast(msg, 'warn', ms);
}
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
document.body.classList.toggle('standalone', isStandalone);


fillSettings();
drawClosures();
syncFollowUi();
startGps();
if (!window.isSecureContext) setGpsState('err', 'GPS nur über HTTPS');
