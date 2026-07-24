// Admin Panel Service Worker — caches admin files for PWA install
//
// v2: switched from cache-first to network-first. Cache-first was serving
// stale JS (e.g. old ai-manager.js / ai-data-cache.js) forever after any
// code update, because the cache name never changed and every GET request
// was served straight from cache before the network response could replace
// it for *this* load. Network-first always tries fresh code first and only
// falls back to cache when offline.
const CACHE = 'admin-pos-v2';
const PRECACHE = [
    '/admin/index.html',
    '/css/admin.css',
    '/js/admin.js',
    '/js/ai-manager.js',
    '/js/ai-data-cache.js',
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

    // Network-first: always try to get the latest file. Only fall back to
    // the cached copy when the network is unavailable (offline).
    e.respondWith(
        fetch(e.request).then(res => {
            if (res && res.status === 200) {
                const clone = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, clone));
            }
            return res;
        }).catch(() => caches.match(e.request))
    );
});
