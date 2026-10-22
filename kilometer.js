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
    where: `Bez='${road}' AND ((Kilometer>=${lo - 1} AND Kilometer<=${hi + 1}) OR Kilometer=${Math.round(km - 20)} OR Kilometer=${Math.round(km + 20)})`,
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
    const base = { lat: c.ll[0], lon: c.ll[1], label: `${road} km ${fmtKm(km)}`, kmInfo: { kind: 'bab', road, km, here } };
    const filter = { search_filter: { min_road_class: 'motorway', max_road_class: 'motorway' } };
    if (c.brg == null) { items.push({ ...base, sub: here ? `bei ${here}` : 'Fahrtrichtung unbestimmt', loc: filter }); continue; }
    items.push({ ...base, sub: `Fahrtrichtung ${nUp || 'steigende km'}${here ? `, bei ${here}` : ''}`,
      loc: { ...filter, heading: Math.round(c.brg), heading_tolerance: 45 }, kmInfo: { ...base.kmInfo, dir: nUp || 'steigende km' } });
    items.push({ ...base, sub: `Fahrtrichtung ${nDown || 'fallende km'}${here ? `, bei ${here}` : ''}`,
      loc: { ...filter, heading: Math.round((c.brg + 180) % 360), heading_tolerance: 45 }, kmInfo: { ...base.kmInfo, dir: nDown || 'fallende km' } });
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

function renderDestInfo() {
  const box = $('destInfo');
  const k = dest && dest.kmInfo;
  if (!k) { box.hidden = true; box.innerHTML = ''; return; }
  if (k.kind === 'bab') {
    box.className = 'dest-info';
    box.innerHTML = `<div class="di-head">${esc(k.road)} km ${esc(fmtKm(k.km))}</div>
      <div class="di-sub">${k.dir ? `Fahrtrichtung ${esc(k.dir)}` : 'Fahrtrichtung offen'}${k.here ? ` · bei ${esc(k.here)}` : ''}</div>`;
  } else {
    const [lvl, txt] = ELEK_TEXT[k.elek] || ['warn', `Elektrifizierung: ${k.elek}. Vor Ort prüfen.`];
    box.className = 'dest-info';
    box.innerHTML = `<div class="di-head">Strecke ${k.nr} km ${esc(fmtKm(k.km))}</div>
      <div class="di-sub">${esc([k.name, k.gleise, k.art, k.speed].filter(Boolean).join(' · '))}</div>
      <div class="di-elek ${lvl}">${lvl === 'warn' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>' : ''}<span>${esc(txt)}</span></div>
      <div class="di-src">DB Geo-Streckennetz, Stand 2020</div>`;
  }
  box.hidden = false;
}

function announceDestInfo() {
  const k = dest && dest.kmInfo;
  if (!k || k.kind !== 'rail') return;
  if (k.elek === 'Oberleitung') say('Ziel an elektrifizierter Bahnstrecke mit Oberleitung.');
  else if (k.elek === 'Stromschiene') say('Ziel an elektrifizierter Bahnstrecke mit Stromschiene.');
}
