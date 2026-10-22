/* Einsatznavigation, Service Worker
 * App-Dateien: zuerst Netz, bei Ausfall Zwischenspeicher (neue Versionen greifen sofort)
 * Bibliotheken und Schriften: Zwischenspeicher zuerst (Adressen enthalten die Version)
 * Kartenkacheln: Zwischenspeicher sofort, im Hintergrund aktualisieren, begrenzte Anzahl
 * Routing, Adresssuche, Overpass: immer direkt über das Netz
 */
'use strict';

const VERSION = '2026-10-22.7';
const APP_CACHE = 'app-' + VERSION;
const LIB_CACHE = 'lib-v1';
const TILE_CACHE = 'tiles-v1';
const TILE_MAX = 3000;

const APP_FILES = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png'
];
const LIB_HOSTS = ['cdnjs.cloudflare.com', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const TILE_HOSTS = ['tile.openstreetmap.org', 'sgx.geodatenzentrum.de', 'tiles.openfreemap.org', 'server.arcgisonline.com', 's3.amazonaws.com'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await Promise.all(APP_FILES.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

let putCount = 0;
async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - TILE_MAX; i++) await cache.delete(keys[i]);
}

async function networkFirst(req) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html') || await cache.match('./');
      if (shell) return shell;
    }
    throw e;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(LIB_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  const update = fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') {
      cache.put(req, res.clone()).catch(() => {});
      if (++putCount % 100 === 0) trimTiles();
    }
    return res;
  });
  if (hit) {
    event.waitUntil(update.catch(() => {}));
    return hit;
  }
  return update;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) { event.respondWith(networkFirst(req)); return; }
  if (LIB_HOSTS.includes(url.hostname)) { event.respondWith(cacheFirst(req)); return; }
  const isTile = TILE_HOSTS.includes(url.hostname) &&
    (url.hostname !== 's3.amazonaws.com' || url.pathname.startsWith('/elevation-tiles-prod/')) &&
    !url.pathname.startsWith('/styles/');
  if (isTile) { event.respondWith(staleWhileRevalidate(req, event)); return; }
  /* Alles Übrige (Routing, Suche, Overpass, Kartenstil) direkt über das Netz */
});
