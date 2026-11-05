/* Service worker — Living in the IT Era (GEEL 1)
   Pages: network-first (4 s timeout) → cached copy when offline/slow.
   Pages are always fetched with cache: 'no-cache', so the browser's HTTP cache (GitHub Pages
   keeps pages 10 minutes) cannot hand back an old copy as "fresh". If a saved copy had to be
   shown and a newer one then arrives, open pages get { type: 'fresh', path } → pwa.js Reload bar.
   Fonts: cache, refresh in background.
   Google Apps Script (scores): never touched — always goes to the network.
   Bump VERSION when this file's PRECACHE list changes. */
const VERSION = 'itera-v10';
const PAGES = VERSION + '-pages';
const FONTS = 'itera-fonts';
const PRECACHE = [
    './',
    './abacus_addition_activity.html',
    './binary_activity.html',
    './card_catalog.html',
    './cyber_defense_ops.html',
    './ecommerce_week.html',
    './exam_gate.js',
    './finals_ITEra.html',
    './index.html',
    './it_ict_sentence_order_v2.html',
    './midterm_ITEra.html',
    './midterm_exam_ITEra.html',
    './netiquette_desk.html',
    './packet_auto.html',
    './packet_relay.html',
    './pascaline.html',
    './phish_flag.html',
    './prefinal_exam_ITEra.html',
    './prefinals_ITEra.html',
    './prefinals_summative.html',
    './prelim_ITEra.html',
    './prelim_exam_ITEra.html',
    './qrispy_queen.html',
    './special_exam_ITEra.html',
    './manifest.webmanifest',
    './pwa.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/maskable-512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon-32.png'
];
const TIMEOUT_MS = 4000;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(PAGES);
    /* one by one: a single missing file must not abort the whole install */
    await Promise.all(PRECACHE.map(u =>
      fetch(new Request(u, { cache: 'reload' })).then(r => r.ok && c.put(u, r)).catch(() => {})));
    await self.skipWaiting();
    notify();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [PAGES, FONTS];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.disable();   /* preload obeys the HTTP cache */
    await self.clients.claim();
    notify();
  })());
});

/* A saved copy was shown because the network was slow, and a newer copy has now arrived. */
async function fresh(path) {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'fresh', path });
}

/* Tell open pages the offline copies changed (the hub refreshes its "Available offline" chips). */
async function notify() {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })) c.postMessage({ type: 'cached' });
}

/* Revalidate with GitHub every time (a 304 is tiny); never trust the browser's HTTP cache. */
function fromNetwork(e, req) {
  return fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }));
}

async function pageFirstNetwork(e) {
  const req = e.request;
  const url = new URL(req.url);
  const key = url.origin + url.pathname;            /* ignore ?query / #hash */
  const cache = await caches.open(PAGES);
  let servedSaved = false;
  const net = fromNetwork(e, req).then(r => {
    if (r && r.ok && r.type === 'basic') cache.put(key, r.clone()).then(() => { notify(); if (servedSaved) fresh(url.pathname); });
    return r;
  });
  e.waitUntil(net.catch(() => {}));
  const timed = new Promise(res => setTimeout(res, TIMEOUT_MS, null));
  try {
    const r = await Promise.race([net, timed]);
    if (r) return r;
  } catch (err) {}
  const hit = await cache.match(key) || (url.pathname.endsWith('/') && await cache.match(key + 'index.html'));
  if (hit) { servedSaved = true; return hit; }
  try { return await net; } catch (err) {
    return (await cache.match(new URL('./index.html', self.registration.scope).href)) ||
      new Response('<meta name=viewport content="width=device-width"><p style="font:16px system-ui;padding:24px">Offline. Open this page once while online so it is saved on this device.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(e, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(e.request);
  const net = fetch(e.request).then(r => {
    if (r && (r.ok || r.type === 'opaque')) cache.put(e.request, r.clone());
    return r;
  }).catch(() => null);
  e.waitUntil(net);
  return hit || (await net) || Response.error();
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                  /* score uploads (POST) pass through */
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com')
    return e.respondWith(staleWhileRevalidate(e, FONTS));
  if (url.origin !== self.location.origin) return;   /* Apps Script & other sites: untouched */
  if (url.pathname.endsWith('/admin.html')) return;  /* instructor console: always live */
  if (req.mode === 'navigate' || url.pathname.endsWith('.html'))
    return e.respondWith(pageFirstNetwork(e));
  e.respondWith(staleWhileRevalidate(e, PAGES));
});
