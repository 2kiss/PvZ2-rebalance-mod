// Offline support. Everything is served cache-first:
//  - the code (listed in precache.json) is cached when the service worker installs;
//  - game files come either from the server (private build, cached as they are used and in a
//    background "download-all") or from the imported pvz2-assets.zip (cache "pvz2pack-*").
const CORE = ['./', './index.html', './precache.json'];

async function cacheName() {
  try {
    const r = await fetch('./precache.json', { cache: 'no-store' });
    return 'pvz2-' + (await r.json()).version;
  } catch (e) {
    const keys = await caches.keys();
    return keys.find(k => k.startsWith('pvz2-')) || 'pvz2-offline';
  }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const name = await cacheName();
    const c = await caches.open(name);
    await c.addAll(CORE);
    try {
      const list = (await (await fetch('./precache.json', { cache: 'no-store' })).json()).code || [];
      await c.addAll(list.map(f => './' + f));
    } catch (err) { /* code is cached on first use instead */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = await cacheName();
    for (const k of await caches.keys()) if (k !== keep && k.startsWith('pvz2-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const keys = await caches.keys();
        const name = keys.find(k => k.startsWith('pvz2-'));
        if (name) (await caches.open(name)).put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      return new Response('offline', { status: 504 });
    }
  })());
});

// Private build only: the page posts {type: 'download-all'} to cache every game file it lists.
self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'download-all') return;
  const port = e.ports[0];
  e.waitUntil((async () => {
    const list = (await (await fetch('./precache.json', { cache: 'no-store' })).json()).files || [];
    const c = await caches.open(await cacheName());
    let done = 0;
    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const f = './' + queue.shift();
        try { if (!(await caches.match(f))) { const r = await fetch(f); if (r.ok) await c.put(f, r); } } catch (err) { /* retried next launch */ }
        done += 1;
        if (port) port.postMessage({ done, total: list.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (port) port.postMessage({ done: list.length, total: list.length });
  })());
});
