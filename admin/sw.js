// Admin Panel Service Worker — caches admin files for PWA install
const CACHE = 'admin-pos-v1';
const PRECACHE = [
    '/admin/index.html',
    '/css/admin.css',
    '/js/admin.js',
    '/js/firebase-config.js',
    '/admin/admin-logo.png',
    '/admin/manifest.json',
];

// Skip Firebase / Google API URLs — never cache them
const SKIP = [
    'firebaseio.com',
    'googleapis.com',
    'gstatic.com',
    'firestore.googleapis.com',
    'firebase.googleapis.com',
    'storage.googleapis.com',
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const url = e.request.url;
    // Never intercept Firebase / Google API calls
    if (SKIP.some(s => url.includes(s))) return;
    // Only handle GET
    if (e.request.method !== 'GET') return;

    e.respondWith(
        caches.match(e.request).then(cached => {
            const network = fetch(e.request).then(res => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return res;
            }).catch(() => null);
            return cached || network;
        })
    );
});
