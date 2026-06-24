/* Trip OS service worker — offline shell, map-tile caching, API fallback */
const APP   = 'tripos-app-v10';
const TILES = 'tripos-tiles-v1';
const API   = 'tripos-api-v1';
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
  LEAFLET_CSS, LEAFLET_JS
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(APP)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => ![APP, TILES, API].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isTile = u => /tile\.openstreetmap\.org/.test(u);
const isAPI  = u => /(api\.open-meteo\.com|api\.frankfurter\.app|overpass-api\.de)/.test(u);

async function trim(name, max) {
  const c = await caches.open(name);
  const ks = await c.keys();
  if (ks.length > max) for (let i = 0; i < ks.length - max; i++) await c.delete(ks[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;            // Overpass POST etc. — handled by app's own localStorage cache
  const url = req.url;

  // Map tiles: cache-first, so areas you've panned over stay available offline.
  if (isTile(url)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) { c.put(req, res.clone()); trim(TILES, 800); }
        return res;
      } catch (err) { return hit || Response.error(); }
    }));
    return;
  }

  // Weather / rates (GET): network-first, fall back to last good response offline.
  if (isAPI(url)) {
    e.respondWith((async () => {
      const c = await caches.open(API);
      try {
        const res = await fetch(req);
        if (res && res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await c.match(req);
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  // App shell: cache-first (instant + offline), refreshed in the background when online.
  e.respondWith((async () => {
    const c = await caches.open(APP);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => {
      try {
        const sameOrigin = new URL(url).origin === self.location.origin;
        if (res && res.ok && (sameOrigin || /cdnjs\.cloudflare\.com/.test(url))) c.put(req, res.clone());
      } catch (e) {}
      return res;
    }).catch(() => null);
    return hit || (await net) || fetch(req);
  })());
});
