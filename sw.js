// ============================================================
//  POS Service Worker — Cache-first for static assets
//  Version: 3 (bump this number whenever you deploy changes)
// ============================================================
const CACHE_NAME = 'pos-static-v4';

// All static files that make the app shell work offline
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/css/style.css',
    '/js/firebase-config.js',
    '/js/menu.js',
    '/js/cart.js',
    '/js/tables.js',
    '/js/admin.js',
    '/js/expense.js',
    '/manifest.json',
    '/sounds/'
];

// ── INSTALL: pre-cache all static assets ──────────────────
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // addAll fails if any single resource 404s — use individual adds so
            // optional assets don't break the whole install
            return Promise.allSettled(
                STATIC_ASSETS.map(url =>
                    cache.add(url).catch(() => { /* skip missing assets */ })
                )
            );
        })
    );
    // Activate immediately without waiting for old tabs to close
    self.skipWaiting();
});

// ── ACTIVATE: delete old caches ───────────────────────────
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        )
    );
    // Take control of all open tabs right away
    self.clients.claim();
});

// ── FETCH: smart routing ──────────────────────────────────
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // 1. Firebase / Google APIs — always go to network, never cache
    //    (Firestore has its own IndexedDB persistence layer)
    if (
        url.hostname.includes('firestore.googleapis.com') ||
        url.hostname.includes('firebase.googleapis.com') ||
        url.hostname.includes('firebaseio.com') ||
        url.hostname.includes('gstatic.com') ||
        url.hostname.includes('googleapis.com') ||
        url.hostname.includes('firebasestorage.googleapis.com')
    ) {
        return; // let the browser handle it normally
    }

    // 2. Non-GET requests (POST, etc.) — skip caching
    if (e.request.method !== 'GET') return;

    // 3. Static assets — cache-first, update cache in background
    e.respondWith(
        caches.match(e.request).then((cachedResponse) => {
            // Kick off a background network fetch to keep cache fresh
            const networkFetch = fetch(e.request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.ok) {
                        const clone = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
                    }
                    return networkResponse;
                })
                .catch(() => null);

            // Return cached version immediately (stale-while-revalidate)
            return cachedResponse || networkFetch;
        })
    );
});
