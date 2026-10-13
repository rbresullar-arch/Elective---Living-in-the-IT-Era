/* Service worker — Living in the IT Era (GEEL 1)
   Pages: network-first (4 s timeout) → cached copy when offline/slow.
   Fonts: cache, refresh in background.
   Google Apps Script (scores): never touched — always goes to the network.
   Bump VERSION when this file's PRECACHE list changes. */
const VERSION = 'itera-v1';
const PAGES = VERSION + '-pages';
const FONTS = 'itera-fonts';
const PRECACHE = [
    './',
    './abacus_addition_activity.html',
    './binary_activity.html',
    './cyber_defense_ops.html',
    './ecommerce_week.html',
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
    './prefinals_ITEra.html',
    './prelim_ITEra.html',
    './prelim_exam_ITEra.html',
    './qrispy_queen.html',
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
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [PAGES, FONTS];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

function fromNetwork(e, req) {
  return (e.preloadResponse ? e.preloadResponse.catch(() => null) : Promise.resolve(null))
    .then(p => p || fetch(req));
}

async function pageFirstNetwork(e) {
  const req = e.request;
  const url = new URL(req.url);
  const key = url.origin + url.pathname;            /* ignore ?query / #hash */
  const cache = await caches.open(PAGES);
  const net = fromNetwork(e, req).then(r => {
    if (r && r.ok && r.type === 'basic') cache.put(key, r.clone());
    return r;
  });
  e.waitUntil(net.catch(() => {}));
  const timed = new Promise(res => setTimeout(res, TIMEOUT_MS, null));
  try {
    const r = await Promise.race([net, timed]);
    if (r) return r;
  } catch (err) {}
  const hit = await cache.match(key) || (url.pathname.endsWith('/') && await cache.match(key + 'index.html'));
  if (hit) return hit;
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
