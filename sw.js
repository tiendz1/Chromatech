// FreshTrack service worker: nhận Web Push (FCM) khi web đóng + mở offline cơ bản
const CACHE = 'freshtrack-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
})()));

// Mở trang khi mất mạng: ưu tiên mạng, lỗi thì dùng bản đã lưu
self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET' || req.mode !== 'navigate') return;
    e.respondWith(fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./'))));
});

// Nhận thông báo đẩy (tin "data" do server gửi qua FCM)
self.addEventListener('push', event => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { data: { body: event.data ? event.data.text() : '' } }; }
    const d = Object.assign({}, payload.notification || {}, payload.data || {});
    event.waitUntil(self.registration.showNotification(d.title || 'FreshTrack', {
        body: d.body || '',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: d.tag || 'freshtrack-daily',
        renotify: true,
        data: { url: d.url || './' }
    }));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        for (const c of list) {
            if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
                if ('navigate' in c) c.navigate(url).catch(() => {});
                return c.focus();
            }
        }
        return self.clients.openWindow(url);
    }));
});
