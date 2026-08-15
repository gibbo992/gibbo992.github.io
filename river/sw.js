/* Riverwise service worker.

   Shell is cache-first so the app opens instantly with no signal. API calls are
   network-first with a cache fallback, which matters on a riverbank: you get
   the last forecast you loaded rather than an error page. */
const APP = 'riverwise-v1';
const API = 'riverwise-api-v1';
const SHELL = [
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
      .then(ks => Promise.all(ks.filter(k => ![APP, API].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isAPI = u => /environment\.data\.gov\.uk|open-meteo\.com/.test(u);

async function trim(name, max) {
  const c = await caches.open(name);
  const ks = await c.keys();
  for (let i = 0; i < ks.length - max; i++) await c.delete(ks[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;

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
