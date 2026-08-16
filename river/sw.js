/* Riverwise service worker.

   Shell is cache-first so the app opens instantly with no signal. API calls are
   network-first with a cache fallback, which matters on a riverbank: you get
   the last forecast you loaded rather than an error page. */
/* BUMP THIS whenever any shell file changes. The shell is served cache-first,
   so a device that has already installed the app keeps serving the old bundle
   until the cache name changes and the activate handler purges the old one.
   Forgetting this ships a release that never reaches existing installs. */
const APP = 'riverwise-v3';
const API = 'riverwise-api-v1';
const TILES = 'riverwise-tiles-v1';
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
const SHELL = [
  LEAFLET_CSS, LEAFLET_JS,
  './', './index.html', './manifest.webmanifest',
  './model.js', './data.js', './archive.js', './runs.js', './app.js', './worker.js',
  './sections.json',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'
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
      .then(ks => Promise.all(ks.filter(k => ![APP, API, TILES].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isAPI = u => /environment\.data\.gov\.uk|open-meteo\.com|timeseries\.sepa\.org\.uk/.test(u);
const isTile = u => /basemaps\.cartocdn\.com/.test(u);

async function trim(name, max) {
  const c = await caches.open(name);
  const ks = await c.keys();
  for (let i = 0; i < ks.length - max; i++) await c.delete(ks[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  /* map tiles: cache-first and capped, so a map you have already looked at
     still draws on a riverbank with no signal */
  if (isTile(url)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(TILES).then(c => c.put(req, copy)).then(() => trim(TILES, 400));
        return res;
      }).catch(() => new Response('', { status: 504 })))
    );
    return;
  }

  if (isAPI(url)) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(API).then(c => c.put(req, copy)).then(() => trim(API, 120));
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || Response.error()))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok && new URL(url).origin === location.origin) {
        const copy = res.clone();
        caches.open(APP).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});
