/* Einsatznavigation, Kilometrierung von Autobahn und Bahn
 * Datenquellen (NPGeo-Kat, vfdb, ArcGIS Feature Services):
 *   Kilometrierungen der Bundesautobahnen (KmBAB): ein Punkt je Kilometer auf der Achse
 *   Deutsche Bahn Geo-Streckennetz (Stand 2020): Streckenabschnitte mit Kilometrierung von/bis,
 *   Elektrifizierung, Gleisanzahl, Geschwindigkeit
 * Eingaben:  "A5 km 487,3"  |  "Strecke 4000 km 12,345"  |  "4000 km 2,3 + 45"  |  "Strecke 4000"
 */
'use strict';

const KM_BAB_URL = 'https://services2.arcgis.com/jUpNdisbWqRpMo35/arcgis/rest/services/KmBAB/FeatureServer/0/query';
const DB_NET_URL = 'https://services2.arcgis.com/jUpNdisbWqRpMo35/arcgis/rest/services/DB_Geo_Streckennetz/FeatureServer/0/query';

const nf3 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 3 });
map.createPane('rail').style.zIndex = 412;
const railLayer = L.layerGroup().addTo(map);

/* ---------- Eingabe erkennen ---------- */

/* "487,3" | "487.3" | "2,3 + 45" (DB-Schreibweise: Hektometer plus Meter) */
function parseKm(t) {
  t = String(t).trim();
  const db = t.match(/^(-?\d+)[.,](\d)\s*\+\s*(\d{1,4})$/);
  if (db) return (Math.abs(+db[1]) * 10 + +db[2]) / 10 * Math.sign(+db[1] || 1) + Math.sign(+db[1] || 1) * +db[3] / 1000;
  const n = parseFloat(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
const KM_RE = '(-?\\d+(?:[.,]\\d+)?(?:\\s*\\+\\s*\\d{1,4})?)';

function parseSpecial(q) {
  const s = q.trim();
  let m = s.match(new RegExp(`^(?:BAB\\s*)?A\\s?(\\d{1,3})(?:\\s*[,;]\\s*|\\s+|(?=\\s*km))(?:km\\.?|kilometer)?\\s*${KM_RE}\\s*$`, 'i'));
  if (m) {
    const km = parseKm(m[2]);
    if (km != null) return { type: 'bab', road: 'A' + (+m[1]), km };
  }
  m = s.match(new RegExp(`^(?:strecke|str\\.?|bahn(?:strecke)?|db|vzg)\\s*(?:nr\\.?)?\\s*(\\d{4})(?:\\s*[,;]?\\s*(?:km\\.?|kilometer)?\\s*${KM_RE})?\\s*$`, 'i'))
    || s.match(new RegExp(`^(\\d{4})\\s*[,;]?\\s*(?:km\\.?|kilometer)\\s*${KM_RE}\\s*$`, 'i'));
  if (m) {
    if (m[2] == null) return { type: 'railLine', nr: +m[1] };
    const km = parseKm(m[2]);
    if (km != null) return { type: 'rail', nr: +m[1], km };
  }
  return null;
}

/* ---------- ArcGIS-Abfragen ---------- */

async function arcQuery(url, params) {
  const qs = new URLSearchParams({ f: 'json', ...params });
  let res;
  try { res = await fetchT(`${url}?${qs}`, {}, 12000); } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Kilometrierungsdienst antwortet nicht' : 'Kilometrierungsdienst nicht erreichbar');
  }
  const data = await res.json();
  if (data.error) throw new Error(`Kilometrierungsdienst: ${data.error.message || 'Fehler'}`);
  return data.features || [];
}

/* DB-Kodierung: 100230045 = km 2,3 + 45 m = 2,345 km */
function kmFromCode(c) {
  const v = c - 100000000;
  const a = Math.abs(v);
  return Math.sign(v || 1) * (Math.floor(a / 10000) / 10 + (a % 10000) / 1000);
}
function codeFromKm(km) {
  const a = Math.abs(km);
  let h = Math.floor(a * 10 + 1e-9);
  let m = Math.round((a - h / 10) * 1000);
  if (m >= 100) { h += Math.floor(m / 100); m %= 100; }
  return 100000000 + Math.sign(km || 1) * (h * 10000 + m);
}
function fmtKm(km) { return nf3.format(km); }
function cleanLineName(n) { return String(n || '').split(/\s*-+\s*/).filter(Boolean).join(' – '); }

function bearingLL(a, b) { return planarBearing(proj(a, a[0]), proj(b, a[0])); }

async function placeName(lat, lon) {
  try {
    const res = await fetchT(`${settings.servers.photon.replace(/\/$/, '')}/reverse?lat=${lat}&lon=${lon}&lang=de&limit=1`, {}, 5000);
    const f = ((await res.json()).features || [])[0];
    if (!f) return null;
    const p = f.properties || {};
    return p.city || p.town || p.village || p.county || p.name || null;
  } catch { return null; }
}

/* ---------- Autobahn ---------- */

async function babLookup(road, km) {
  const lo = Math.floor(km), hi = Math.ceil(km);
  const feats = await arcQuery(KM_BAB_URL, {
    where: `Bez='${road}' AND ((Kilometer>=${lo - 3} AND Kilometer<=${hi + 3}) OR Kilometer=${Math.round(km - 20)} OR Kilometer=${Math.round(km + 20)})`,
    outFields: 'Kilometer', outSR: 4326, returnGeometry: true, resultRecordCount: 200
  });
  const pts = feats.filter(f => f.geometry).map(f => ({ km: +f.attributes.Kilometer, ll: [f.geometry.y, f.geometry.x] }));
  if (!pts.length) throw new Error(`${road} km ${fmtKm(km)} nicht in der Kilometrierung gefunden`);
  /* Paare benachbarter Kilometerpunkte suchen, welche km einschließen (Abstand plausibel) */
  const cands = [];
  for (const a of pts) for (const b of pts) {
    if (!(a.km <= km && b.km > km || a.km < km && b.km >= km) || b.km - a.km > 2) continue;
    const d = haversine(a.ll, b.ll);
    if (d > (b.km - a.km) * 1600 + 300) continue;
    const f = (km - a.km) / (b.km - a.km);
    const ll = lerp(a.ll, b.ll, f);
    if (cands.some(c => haversine(c.ll, ll) < 800)) continue;
    cands.push({ ll, brg: bearingLL(a.ll, b.ll), a, b });
  }
  if (!cands.length) {
    const exact = pts.filter(p => Math.abs(p.km - km) < 0.05);
    if (!exact.length) throw new Error(`${road} km ${fmtKm(km)}: Abschnitt nicht eindeutig`);
    exact.forEach(p => cands.push({ ll: p.ll, brg: null }));
  }
  const items = [];
  for (const c of cands.slice(0, 3)) {
    const ahead = pts.filter(p => Math.abs(p.km - Math.round(km + 20)) < 0.01 && haversine(p.ll, c.ll) < 30000)[0];
    const back = pts.filter(p => Math.abs(p.km - Math.round(km - 20)) < 0.01 && haversine(p.ll, c.ll) < 30000)[0];
    const [nUp, nDown, here] = await Promise.all([
      ahead ? placeName(...ahead.ll) : null, back ? placeName(...back.ll) : null, placeName(...c.ll)
    ]);
    /* Achse: Kilometerpunkte desselben Abschnitts im Umkreis von 4 km, nach km sortiert */
    const axis = [];
    for (const p of pts.filter(p => Math.abs(p.km - km) <= 3.5 && haversine(p.ll, c.ll) < 4000).sort((x, y) => x.km - y.km)) {
      const prev = axis[axis.length - 1];
      if (prev && prev.km === p.km) { if (haversine(p.ll, c.ll) < haversine(prev.ll, c.ll)) axis[axis.length - 1] = p; }
      else axis.push(p);
    }
    const base = { lat: c.ll[0], lon: c.ll[1], label: `${road} km ${fmtKm(km)}`, kmInfo: { kind: 'bab', road, km, here, axis } };
    const filter = { search_filter: { min_road_class: 'motorway', max_road_class: 'motorway' } };
    if (c.brg == null) { items.push({ ...base, sub: here ? `bei ${here}` : 'Fahrtrichtung unbestimmt', loc: filter }); continue; }
    items.push({ ...base, sub: `Fahrtrichtung ${nUp || 'steigende km'}${here ? `, bei ${here}` : ''}`,
      loc: { ...filter, heading: Math.round(c.brg), heading_tolerance: 45 }, kmInfo: { ...base.kmInfo, dir: nUp || 'steigende km', inc: true } });
    items.push({ ...base, sub: `Fahrtrichtung ${nDown || 'fallende km'}${here ? `, bei ${here}` : ''}`,
      loc: { ...filter, heading: Math.round((c.brg + 180) % 360), heading_tolerance: 45 }, kmInfo: { ...base.kmInfo, dir: nDown || 'fallende km', inc: false } });
  }
  return items;
}

/* ---------- Bahn ---------- */

function railAttrs(a, nr, km) {
  return {
    kind: 'rail', nr, km,
    name: cleanLineName(a.strecke_ku), elek: a.elektrifiz || 'unbekannt',
    gleise: a.gleisanzah || '', speed: a.geschwindi || '', art: a.bahnart || '', nutzung: a.bahnnutzun || ''
  };
}

function pathOf(f) {
  const paths = (f.geometry && f.geometry.paths) || [];
  const out = [];
  for (const p of paths) for (const c of p) out.push([c[1], c[0]]);
  return out;
}
function pathLength(path) { let s = 0; for (let i = 1; i < path.length; i++) s += haversine(path[i - 1], path[i]); return s; }
function pointOnPath(path, frac) {
  const total = pathLength(path);
  let target = Math.max(0, Math.min(1, frac)) * total, s = 0;
  for (let i = 1; i < path.length; i++) {
    const d = haversine(path[i - 1], path[i]);
    if (s + d >= target) return { ll: lerp(path[i - 1], path[i], d ? (target - s) / d : 0), brg: bearingLL(path[i - 1], path[i]) };
    s += d;
  }
  return { ll: path[path.length - 1], brg: path.length > 1 ? bearingLL(path[path.length - 2], path[path.length - 1]) : null };
}

async function railLookup(nr, km) {
  const c = codeFromKm(km);
  const feats = await arcQuery(DB_NET_URL, {
    where: `strecke_nr=${nr} AND ((von_km_i<=${c} AND bis_km_i>=${c}) OR (von_km_i>=${c} AND bis_km_i<=${c}))`,
    outFields: 'von_km_i,bis_km_i,elektrifiz,strecke_ku,gleisanzah,geschwindi,bahnart,bahnnutzun', outSR: 4326, returnGeometry: true
  });
  if (!feats.length) {
    const range = await arcQuery(DB_NET_URL, {
      where: `strecke_nr=${nr}`, returnGeometry: false,
      outStatistics: JSON.stringify([{ statisticType: 'min', onStatisticField: 'von_km_i', outStatisticFieldName: 'kmin' }, { statisticType: 'max', onStatisticField: 'bis_km_i', outStatisticFieldName: 'kmax' }])
    }).catch(() => []);
    const r = range[0] && range[0].attributes;
    if (r && r.kmin != null) throw new Error(`Strecke ${nr}: km ${fmtKm(km)} liegt außerhalb (km ${fmtKm(kmFromCode(r.kmin))} bis ${fmtKm(kmFromCode(r.kmax))})`);
    throw new Error(`Strecke ${nr} nicht im Streckennetz gefunden`);
  }
  const items = [];
  for (const f of feats) {
    const a = f.attributes, path = pathOf(f);
    if (path.length < 1) continue;
    const v = kmFromCode(a.von_km_i), b = kmFromCode(a.bis_km_i);
    const frac = b === v ? 0 : (km - v) / (b - v);
    const p = pointOnPath(path, frac);
    if (items.some(it => haversine([it.lat, it.lon], p.ll) < 60)) continue;
    const info = railAttrs(a, nr, km);
    items.push({ lat: p.ll[0], lon: p.ll[1], label: `Strecke ${nr} km ${fmtKm(km)}`, sub: `${info.name} · ${info.elek}`, kmInfo: info });
  }
  return items.slice(0, 3);
}

/* Ganze Strecke anzeigen, Antippen liefert den Kilometer */
let railLineData = null;
async function showRailLine(nr) {
  const feats = await arcQuery(DB_NET_URL, {
    where: `strecke_nr=${nr}`, outFields: 'von_km_i,bis_km_i,elektrifiz,strecke_ku,gleisanzah,geschwindi,bahnart,bahnnutzun',
    outSR: 4326, returnGeometry: true, maxAllowableOffset: 0.00003, geometryPrecision: 6, resultRecordCount: 2000
  });
  if (!feats.length) throw new Error(`Strecke ${nr} nicht im Streckennetz gefunden`);
  railLayer.clearLayers();
  railLineData = { nr, parts: feats.map(f => ({ a: f.attributes, path: pathOf(f) })).filter(p => p.path.length > 1) };
  const bounds = L.latLngBounds([]);
  for (const part of railLineData.parts) {
    const e = part.a.elektrifiz || '';
    const col = e === 'Oberleitung' ? '#7c3aed' : e === 'Stromschiene' ? '#db2777' : '#334155';
    L.polyline(part.path, { pane: 'rail', color: '#ffffff', weight: 10, opacity: .8, interactive: false }).addTo(railLayer);
    L.polyline(part.path, { pane: 'rail', color: col, weight: 6, opacity: 1, dashArray: e === 'nicht elektrifiziert' ? '10 8' : null })
      .on('click', ev => railClick(part, ev.latlng)).addTo(railLayer);
    part.path.forEach(p => bounds.extend(p));
  }
  const a0 = railLineData.parts[0].a;
  const kms = railLineData.parts.flatMap(p => [kmFromCode(p.a.von_km_i), kmFromCode(p.a.bis_km_i)]);
  nav.follow = false; syncFollowUi();
  map.fitBounds(bounds, { padding: [40, 40] });
  toast(`Strecke ${nr} ${cleanLineName(a0.strecke_ku)}, km ${fmtKm(Math.min(...kms))} bis ${fmtKm(Math.max(...kms))}. Strecke antippen für Kilometer und Ziel.`, '', 7000);
}

function railClick(part, latlng) {
  const P = [latlng.lat, latlng.lng];
  const lat0 = P[0];
  const xy = part.path.map(p => proj(p, lat0)), Q = proj(P, lat0);
  let best = { d: Infinity, s: 0, ll: P }, s = 0;
  for (let i = 1; i < xy.length; i++) {
    const r = segDist(Q, xy[i - 1], xy[i]);
    const L2 = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    if (r.d < best.d) best = { d: r.d, s: s + r.t * L2, ll: lerp(part.path[i - 1], part.path[i], r.t) };
    s += L2;
  }
  const v = kmFromCode(part.a.von_km_i), b = kmFromCode(part.a.bis_km_i);
  const km = v + (b - v) * (s ? best.s / s : 0);
  const kmR = Math.round(km * 1000) / 1000;
  const info = railAttrs(part.a, railLineData.nr, kmR);
  const div = document.createElement('div');
  div.innerHTML = `<div class="ctx-title">Strecke ${info.nr} km ${esc(fmtKm(kmR))}</div>
    <div class="tr-pop"><span>${esc(info.name)}</span><span>${esc(info.elek)} · ${esc(info.gleise)} · ${esc(info.speed)}</span></div>
    <button class="btn small" type="button">Als Ziel</button>`;
  div.querySelector('button').addEventListener('click', () => {
    map.closePopup();
    chooseDest({ lat: best.ll[0], lon: best.ll[1], label: `Strecke ${info.nr} km ${fmtKm(kmR)}`, sub: `${info.name} · ${info.elek}`, kmInfo: info });
  });
  L.popup({ className: 'ctx-pop' }).setLatLng(best.ll).setContent(div).openOn(map);
}

/* ---------- Einbindung in die Zielsuche ---------- */

async function specialSearch(sp) {
  if (sp.type === 'bab') return babLookup(sp.road, sp.km);
  if (sp.type === 'rail') return railLookup(sp.nr, sp.km);
  return [{ label: `Strecke ${sp.nr} auf der Karte anzeigen`, sub: 'Kilometer durch Antippen der Strecke wählen', action: () => showRailLine(sp.nr).catch(e => toast(e.message, 'err', 6000)) }];
}

/* ---------- Zielinformation (Elektrifizierung, Fahrtrichtung) ---------- */

const ELEK_TEXT = {
  'Oberleitung': ['warn', 'Elektrifiziert: Oberleitung 15 kV / 16,7 Hz. Lebensgefahr bis zur Abschaltung und Bahnerdung durch den Notfallmanager der DB. Abstand zur Oberleitung halten.'],
  'Stromschiene': ['warn', 'Elektrifiziert: Stromschiene (Gleichspannung). Stromschiene nicht berühren oder betreten, Abschaltung und Erdung abwarten.'],
  'nicht elektrifiziert': ['ok', 'Laut Datensatz nicht elektrifiziert. Vor Ort prüfen, Bahnbetrieb trotzdem über Notfallmanager einstellen lassen.']
};

/* ---------- Umfeld der Bahnstelle: Lärmschutzwände, Nachbargleise, Gleislage ---------- */

const LSW_URL = 'https://services-eu1.arcgis.com/XfUqDXJfAezaKUnU/arcgis/rest/services/Schallschutzwand_ArcGIS_Pro/FeatureServer/0/query';
const wallLayer = L.layerGroup().addTo(map);

function envelope(ll, m) {
  const dLat = m / 111320, dLon = m / (111320 * Math.cos(toRad(ll[0])));
  return [ll[1] - dLon, ll[0] - dLat, ll[1] + dLon, ll[0] + dLat].map(v => v.toFixed(6)).join(',');
}
const envQuery = (ll, m) => ({ geometry: envelope(ll, m), geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outSR: 4326 });

/* Gleisachse der Strecke um km herum als Polylinie in Richtung steigender Kilometrierung, je Stützpunkt mit km */
async function trackAround(nr, km, span) {
  const c1 = codeFromKm(km - span), c2 = codeFromKm(km + span);
  const feats = await arcQuery(DB_NET_URL, {
    where: `strecke_nr=${nr} AND ((von_km_i<=${c2} AND bis_km_i>=${c1}) OR (bis_km_i<=${c2} AND von_km_i>=${c1}))`,
    outFields: 'von_km_i,bis_km_i', outSR: 4326, returnGeometry: true, resultRecordCount: 400
  });
  const parts = feats.map(f => {
    let v = kmFromCode(f.attributes.von_km_i), b = kmFromCode(f.attributes.bis_km_i), path = pathOf(f);
    if (v > b) { [v, b] = [b, v]; path = path.slice().reverse(); }
    return { v, b, path };
  }).filter(p => p.path.length > 1).sort((x, y) => x.v - y.v);
  const pts = [];
  for (const p of parts) {
    const L = pathLength(p.path);
    let s = 0;
    p.path.forEach((ll, i) => {
      if (i) s += haversine(p.path[i - 1], ll);
      const kmv = p.v + (p.b - p.v) * (L ? s / L : 0);
      const last = pts[pts.length - 1];
      if (last && haversine(last.ll, ll) < 0.5) return;
      pts.push({ ll, km: kmv });
    });
  }
  if (pts.length < 2) return null;
  const lat0 = pts[0].ll[0];
  const xy = pts.map(p => proj(p.ll, lat0));
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  return { pts, xy, cum, lat0 };
}

/* Lage eines Punkts zur Gleisachse: Position s entlang der Achse und seitlicher Abstand d (links positiv) */
function onTrack(tr, ll) {
  const P = proj(ll, tr.lat0);
  let best = null;
  for (let i = 0; i < tr.xy.length - 1; i++) {
    const a = tr.xy[i], b = tr.xy[i + 1];
    const r = segDist(P, a, b);
    if (!best || r.d < best.dist) {
      const cross = (b[0] - a[0]) * (P[1] - a[1]) - (b[1] - a[1]) * (P[0] - a[0]);
      best = { dist: r.d, s: tr.cum[i] + r.t * (tr.cum[i + 1] - tr.cum[i]), d: Math.sign(cross) * r.d, i, brg: planarBearing(a, b) };
    }
  }
  return best;
}
function kmAt(tr, s) {
  let i = 0;
  while (i < tr.cum.length - 2 && tr.cum[i + 1] < s) i++;
  const L = tr.cum[i + 1] - tr.cum[i];
  const f = L ? Math.max(0, Math.min(1, (s - tr.cum[i]) / L)) : 0;
  return tr.pts[i].km + (tr.pts[i + 1].km - tr.pts[i].km) * f;
}
function llAt(tr, s) {
  let i = 0;
  while (i < tr.cum.length - 2 && tr.cum[i + 1] < s) i++;
  const L = tr.cum[i + 1] - tr.cum[i];
  return lerp(tr.pts[i].ll, tr.pts[i + 1].ll, L ? Math.max(0, Math.min(1, (s - tr.cum[i]) / L)) : 0);
}

/* Lärmschutzwände Bahn: EBA-Datensatz (NPGeo-Kat) */
async function ebaWalls(ll) {
  const feats = await arcQuery(LSW_URL, { ...envQuery(ll, 1500), outFields: 'hoehe_ok', returnGeometry: true, resultRecordCount: 2000 });
  return feats.map(f => ({ path: pathOf(f), h: +f.attributes.hoehe_ok || null })).filter(w => w.path.length > 1);
}

/* Lärmschutzwände Straße: OpenStreetMap (wall=noise_barrier), kleiner Ausschnitt über Overpass */
async function osmWalls(ll) {
  const dLat = 1500 / 111320, dLon = 1500 / (111320 * Math.cos(toRad(ll[0])));
  const bb = [ll[0] - dLat, ll[1] - dLon, ll[0] + dLat, ll[1] + dLon].map(v => v.toFixed(5)).join(',');
  const data = await overpass(`[out:json][timeout:15];(way["wall"="noise_barrier"](${bb});way["barrier"="noise_barrier"](${bb}););out geom tags;`);
  return (data.elements || []).filter(e => e.type === 'way' && e.geometry && e.geometry.length > 1)
    .map(e => ({ path: e.geometry.map(g => [g.lat, g.lon]), h: parseFloat(String((e.tags || {}).height || '').replace(',', '.')) || null }));
}

/* Ordnet Wände den Seiten der Achse zu und sucht die nächsten Lücken (Wandenden) */
function matchWalls(tr, here, walls, dmin, dmax) {
  const sides = { L: [], R: [] };
  for (const w of walls) {
    const pr = w.path.map(p => onTrack(tr, p)).filter(o => o && o.dist <= dmax && o.dist >= dmin);
    if (pr.length < 2) continue;
    const side = pr.reduce((s, o) => s + Math.sign(o.d), 0) >= 0 ? 'L' : 'R';
    sides[side].push({ s0: Math.min(...pr.map(o => o.s)), s1: Math.max(...pr.map(o => o.s)), h: w.h });
  }
  const merge = list => {
    list.sort((a, b) => a.s0 - b.s0);
    const out = [];
    for (const w of list) {
      const last = out[out.length - 1];
      if (last && w.s0 <= last.s1 + 4) { last.s1 = Math.max(last.s1, w.s1); last.h = Math.max(last.h || 0, w.h || 0) || null; }
      else out.push({ ...w });
    }
    return out;
  };
  const sMax = tr.cum[tr.cum.length - 1];
  const res = {};
  for (const side of ['L', 'R']) {
    const list = merge(sides[side]);
    const cover = list.find(w => w.s0 <= here.s && w.s1 >= here.s);
    if (cover) {
      res[side] = {
        wall: true, h: cover.h,
        fwd: { dist: cover.s1 - here.s, km: kmAt(tr, cover.s1), ll: llAt(tr, cover.s1), open: cover.s1 < sMax - 5 },
        back: { dist: here.s - cover.s0, km: kmAt(tr, cover.s0), ll: llAt(tr, cover.s0), open: cover.s0 > 5 }
      };
    } else {
      const ahead = list.find(w => w.s0 > here.s), behind = [...list].reverse().find(w => w.s1 < here.s);
      res[side] = { wall: false, ahead: ahead ? { dist: ahead.s0 - here.s, km: kmAt(tr, ahead.s0) } : null, behind: behind ? { dist: here.s - behind.s1, km: kmAt(tr, behind.s1) } : null };
    }
  }
  return res;
}

/* Achse aus Stützpunkten mit km (aufsteigend) */
function axisTrack(pts) {
  if (!pts || pts.length < 2) return null;
  const lat0 = pts[0].ll[0];
  const xy = pts.map(p => proj(p.ll, lat0));
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  return { pts, xy, cum, lat0 };
}

/* Alle Wände zeichnen, Lücken der zugeordneten Wände beschriften */
function drawWalls(walls, res) {
  for (const w of walls) {
    L.polyline(w.path, { pane: 'rail', color: '#ffffff', weight: 8, opacity: .8, interactive: false }).addTo(wallLayer);
    L.polyline(w.path, { pane: 'rail', color: '#374151', weight: 5, opacity: 1 })
      .bindTooltip(`Lärmschutzwand${w.h ? `, ${nf1.format(w.h)} m` : ''}`).addTo(wallLayer);
  }
  if (!res) return;
  for (const side of ['L', 'R']) {
    const r = res[side];
    if (!r || !r.wall) continue;
    for (const g of [r.fwd, r.back]) if (g.open) {
      L.marker(g.ll, { keyboard: false, interactive: false, zIndexOffset: 700,
        icon: L.divIcon({ className: '', iconSize: [0, 0], iconAnchor: [0, 0], html: `<div class="gap-label">Lücke km ${esc(fmtKm(Math.round(g.km * 1000) / 1000))}</div>` }) }).addTo(wallLayer);
    }
  }
}

async function neighborsAround(nr, info, tr, here, ll) {
  const feats = await arcQuery(DB_NET_URL, { ...envQuery(ll, 60), outFields: 'strecke_nr,gleisanzah,elektrifiz,strecke_ku', returnGeometry: true, resultRecordCount: 200 });
  const by = new Map();
  for (const f of feats) {
    const a = f.attributes;
    if (a.strecke_nr === nr) continue;
    const path = pathOf(f);
    if (path.length < 2) continue;
    /* Nächster Punkt der Nachbarstrecke zur Bahnstelle, Richtung dort vergleichen */
    const lat0 = ll[0], P = proj(ll, lat0);
    let best = null;
    for (let i = 0; i < path.length - 1; i++) {
      const A = proj(path[i], lat0), B = proj(path[i + 1], lat0);
      const r = segDist(P, A, B);
      if (!best || r.d < best.d) best = { d: r.d, brg: planarBearing(A, B), pt: lerp(path[i], path[i + 1], r.t) };
    }
    if (!best || best.d > 50) continue;
    const diff = angDiff(best.brg, here.brg);
    if (diff > 30 && diff < 150) continue;
    const side = onTrack(tr, best.pt);
    const prev = by.get(a.strecke_nr);
    if (!prev || best.d < prev.dist) by.set(a.strecke_nr, { nr: a.strecke_nr, dist: best.d, side: side && side.d >= 0 ? 'links' : 'rechts', gleise: a.gleisanzah || '', elek: a.elektrifiz || '', name: cleanLineName(a.strecke_ku) });
  }
  const list = [...by.values()].sort((x, y) => x.dist - y.dist);
  const own = info.gleise === 'zweigleisig' ? 2 : 1;
  const total = own + list.reduce((s, n) => s + (n.gleise === 'zweigleisig' ? 2 : 1), 0);
  let lage, text;
  if (total <= 1) { lage = 'Eingleisige Strecke'; text = 'Kein Nachbargleis.'; }
  else if (total === 2) {
    lage = 'Nachbargleislage';
    text = own === 2 ? 'Ein Nachbargleis (Gegengleis der eigenen Strecke).' : `Ein Nachbargleis (Strecke ${list[0].nr}).`;
  } else {
    lage = 'Innengleislage möglich';
    text = `${total} Gleise nebeneinander. Je nach betroffenem Gleis liegt dieses zwischen zwei Gleisen.`;
  }
  return { lage, text, total, list };
}

let babCtxToken = 0;
async function loadBabContext() {
  const d = dest, info = d && d.kmInfo;
  if (!info || info.kind !== 'bab') return;
  const token = ++babCtxToken;
  info.ctx = { loading: true };
  renderDestInfo();
  const ll = [d.lat, d.lon];
  const ctx = { loading: false };
  try {
    const walls = await osmWalls(ll);
    if (token !== babCtxToken || dest !== d) return;
    const tr = axisTrack(info.axis);
    let res = null;
    if (tr) {
      const here = onTrack(tr, ll);
      res = matchWalls(tr, here, walls, 5, 70);
      /* Seiten und Richtungen auf die gewählte Fahrtrichtung beziehen */
      if (info.inc === false) res = { L: flipSide(res.R), R: flipSide(res.L) };
    }
    ctx.walls = { res, count: walls.length };
    drawWalls(walls, res);
  } catch (e) { ctx.walls = { error: e.message }; }
  if (token !== babCtxToken || dest !== d) return;
  info.ctx = ctx;
  renderDestInfo();
}
function flipSide(r) {
  if (!r) return r;
  if (r.wall) return { ...r, fwd: r.back, back: r.fwd };
  return { ...r, ahead: r.behind, behind: r.ahead };
}

let railCtxToken = 0;
async function loadRailContext() {
  const d = dest, info = d && d.kmInfo;
  if (!info || info.kind !== 'rail') return;
  const token = ++railCtxToken;
  info.ctx = { loading: true };
  renderDestInfo();
  wallLayer.clearLayers();
  const ll = [d.lat, d.lon];
  const ctx = { loading: false };
  try {
    const tr = await trackAround(info.nr, info.km, 1.6);
    if (!tr) throw new Error('Gleisachse nicht verfügbar');
    const here = onTrack(tr, ll);
    const [walls, n] = await Promise.all([
      ebaWalls(ll).catch(e => ({ error: e.message })),
      neighborsAround(info.nr, info, tr, here, ll).catch(e => ({ error: e.message }))
    ]);
    const w = walls.error ? walls : { res: matchWalls(tr, here, walls, 1.5, 35) };
    ctx.walls = w; ctx.nb = n;
    if (token !== railCtxToken || dest !== d) return;
    if (!walls.error) drawWalls(walls, w.res);
  } catch (e) { ctx.error = e.message; }
  if (token !== railCtxToken || dest !== d) return;
  info.ctx = ctx;
  renderDestInfo();
}

/* ---------- Zielinformation (Elektrifizierung, Gleislage, Lärmschutz, Fahrtrichtung) ---------- */

let destInfoHidden = load('destInfoHidden', false);
function setDestInfoHidden(on) { destInfoHidden = on; save('destInfoHidden', on); renderDestInfo(); }

function wallText(r, side, road) {
  const name = side === 'L' ? 'Links' : 'Rechts';
  const up = road ? 'voraus' : 'steigende km', down = road ? 'zurück' : 'fallende km';
  if (!r) return `${name}: keine Angabe`;
  if (!r.wall) {
    const near = [r.ahead && r.ahead.dist < 300 ? `nächste Wand in ${fmtDist(r.ahead.dist)} (km ${fmtKm(Math.round(r.ahead.km * 1000) / 1000)})` : '',
      r.behind && r.behind.dist < 300 ? `Wandende ${fmtDist(r.behind.dist)} ${road ? 'zurück' : 'in Richtung fallender km'}` : ''].filter(Boolean).join(', ');
    return `${name}: keine Lärmschutzwand${near ? `, ${near}` : ''}`;
  }
  const gap = g => g.open ? `${fmtDist(g.dist)} bis km ${fmtKm(Math.round(g.km * 1000) / 1000)}` : `über ${fmtDist(g.dist)}`;
  return `${name}: Lärmschutzwand${r.h ? ` ${nf1.format(r.h)} m${road ? ' hoch' : ' über SO'}` : ''}. Nächste Lücke ${gap(r.fwd)} (${up}) oder ${gap(r.back)} (${down})`;
}

function renderDestInfo() {
  const box = $('destInfo'), chip = $('destInfoChip');
  const k = dest && dest.kmInfo;
  if (!k) { box.hidden = true; box.innerHTML = ''; chip.hidden = true; return; }
  const warn = k.kind === 'rail' && (k.elek === 'Oberleitung' || k.elek === 'Stromschiene');
  chip.classList.toggle('warn', warn);
  chip.innerHTML = `${warn ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>' : ''}Zielhinweise einblenden`;
  chip.hidden = !destInfoHidden;
  if (destInfoHidden) { box.hidden = true; return; }
  const close = '<button type="button" class="di-close" aria-label="Zielhinweise ausblenden" title="Ausblenden"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
  if (k.kind === 'bab') {
    const c = k.ctx || {}, w = c.walls || {};
    let rows = '', more = '';
    if (c.loading) rows = '<div class="di-row muted">Prüfe Lärmschutzwände</div>';
    else if (w.error) rows = `<div class="di-row muted">Lärmschutzwände nicht abrufbar (OpenStreetMap-Dienst): ${esc(w.error)}</div>`;
    else if (w.res) {
      const any = w.res.L.wall || w.res.R.wall;
      rows = `<div class="di-row"><b>Lärmschutzwand:</b> ${any ? `${[w.res.R.wall ? 'rechts' : '', w.res.L.wall ? 'links' : ''].filter(Boolean).join(' und ')} in Fahrtrichtung` : 'keine an dieser Stelle'}</div>`;
      more = `<div class="di-row">${esc(wallText(w.res.R, 'R', true))}.</div><div class="di-row">${esc(wallText(w.res.L, 'L', true))}.</div>`;
    } else if (w.count != null) rows = `<div class="di-row muted">${w.count} Lärmschutzwände im Umkreis auf der Karte, Achse zur Zuordnung nicht verfügbar</div>`;
    box.innerHTML = `<div class="di-top"><div class="di-head">${esc(k.road)} km ${esc(fmtKm(k.km))}</div>${close}</div>
      <div class="di-sub">${k.dir ? `Fahrtrichtung ${esc(k.dir)}` : 'Fahrtrichtung offen'}${k.here ? ` · bei ${esc(k.here)}` : ''}</div>
      ${rows}<div class="di-more">${more}</div>
      ${c.loading || w.error ? '' : '<div class="di-src">Seiten in Fahrtrichtung. Lärmschutzwände aus OpenStreetMap, Vollständigkeit nicht gesichert. Lücken = Wandenden.</div>'}`;
  } else {
    const [lvl, txt] = ELEK_TEXT[k.elek] || ['warn', `Elektrifizierung: ${k.elek}. Vor Ort prüfen.`];
    const c = k.ctx || {};
    let lage = '', more = '';
    if (c.loading) lage = '<div class="di-row muted">Prüfe Gleislage und Lärmschutzwände</div>';
    else if (c.error) lage = `<div class="di-row muted">Umfeld nicht abrufbar: ${esc(c.error)}</div>`;
    else {
      const nb = c.nb || {};
      if (nb.error) lage = `<div class="di-row muted">Gleislage nicht abrufbar: ${esc(nb.error)}</div>`;
      else if (nb.lage) {
        lage = `<div class="di-row"><b>${esc(nb.lage)}:</b> ${esc(nb.text)}</div>`;
        const elekNb = nb.list.filter(n => n.elek === 'Oberleitung' || n.elek === 'Stromschiene');
        if (nb.list.length) more += `<div class="di-row"><b>Nachbargleise:</b> ${nb.list.map(n => `Strecke ${n.nr} (${esc(n.gleise)}, ${esc(n.elek)}) ${n.side} in ca. ${Math.round(n.dist)} m`).join(', ')}.</div>`;
        if (elekNb.length && k.elek !== 'Oberleitung' && k.elek !== 'Stromschiene') more += `<div class="di-row warnline">Nachbarstrecke elektrifiziert: Abschaltung und Erdung auch für Strecke ${elekNb.map(n => n.nr).join(', ')} anfordern.</div>`;
        else if (elekNb.length) more += `<div class="di-row warnline">Abschaltung und Erdung auch für Strecke ${elekNb.map(n => n.nr).join(', ')} anfordern.</div>`;
      }
      const w = c.walls || {};
      if (w.error) more += `<div class="di-row muted">Lärmschutzwände nicht abrufbar: ${esc(w.error)}</div>`;
      else if (w.res) {
        const any = w.res.L.wall || w.res.R.wall;
        lage += `<div class="di-row"><b>Lärmschutzwand:</b> ${any ? `${[w.res.L.wall ? 'links' : '', w.res.R.wall ? 'rechts' : ''].filter(Boolean).join(' und ')} vorhanden` : 'keine an dieser Stelle'}</div>`;
        more += `<div class="di-row">${esc(wallText(w.res.L, 'L'))}.</div><div class="di-row">${esc(wallText(w.res.R, 'R'))}.</div>`;
      }
    }
    box.innerHTML = `<div class="di-top"><div class="di-head">Strecke ${k.nr} km ${esc(fmtKm(k.km))}</div>${close}</div>
      <div class="di-sub">${esc([k.name, k.gleise, k.art, k.speed].filter(Boolean).join(' · '))}</div>
      <div class="di-elek ${lvl}">${lvl === 'warn' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>' : ''}<span>${esc(txt)}</span></div>
      ${lage}<div class="di-more">${more}</div>
      <div class="di-src">Seiten in Richtung steigender Kilometrierung. Gleislage aus Streckenachsen, betroffenes Gleis vor Ort klären. Lücken = Wandenden, Türen sind nicht erfasst. Quellen: DB Geo-Streckennetz (Stand 2020), EBA Lärmkartierung Runde 4.</div>`;
  }
  box.querySelector('.di-close').addEventListener('click', () => setDestInfoHidden(true));
  box.hidden = false;
}

function announceDestInfo() {
  const k = dest && dest.kmInfo;
  if (!k || k.kind !== 'rail') return;
  if (k.elek === 'Oberleitung') say('Ziel an elektrifizierter Bahnstrecke mit Oberleitung.');
  else if (k.elek === 'Stromschiene') say('Ziel an elektrifizierter Bahnstrecke mit Stromschiene.');
}

function onDestChosen() {
  wallLayer.clearLayers();
  renderDestInfo();
  announceDestInfo();
  loadRailContext();
  loadBabContext();
}
$('destInfoChip').addEventListener('click', () => setDestInfoHidden(false));
