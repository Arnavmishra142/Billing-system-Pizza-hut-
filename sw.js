// sw.js - Basic Service Worker for PWA
self.addEventListener('install', (e) => {
    console.log('Service Worker: Installed');
});

self.addEventListener('fetch', (e) => {
    // Browser bas check karta hai ki fetch event hai ya nahi.
});
