// HODIM service worker
const CACHE = 'hodim-v4';
const SHELL = ['./', 'index.html', 'hodim-manifest.json', 'hodim-192.png', 'hodim-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    // Har doim serverdan yangisini tekshiradi (brauzer keshidagi eski versiya ko'rsatilmaydi)
    fetch(req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(req, { cache: 'no-cache' })).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./')))
  );
});

// Push-eslatma keldi (ilova yopiq bo'lsa ham)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '⏰ HODIM', {
    body: d.body || '',
    icon: 'hodim-192.png',
    badge: 'hodim-192.png',
    tag: 'hodim-' + (d.type || 'remind'),
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [500, 200, 500, 200, 500, 200, 500],
    data: { url: './?remind=' + (d.type || '') }
  }));
});

// Eslatma bosilganda ilovani ochish
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
    for (const c of list) { if ('focus' in c) { if ('navigate' in c) c.navigate(url).catch(()=>{}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
