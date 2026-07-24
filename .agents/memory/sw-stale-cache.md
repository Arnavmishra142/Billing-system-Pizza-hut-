---
name: PWA service worker serving stale JS
description: Symptoms and fix when a service worker keeps serving old JS/HTML after code changes, e.g. a feature "not working" even though the source was fixed.
---

A service worker with a cache-first (or stale-while-revalidate returning cache immediately) `fetch` handler will keep serving the old cached response forever if the cache name never changes — the background network fetch only updates the cache for the *next* load, so the very load that should show the fix still shows old behavior.

**Why:** This produces a confusing symptom: the source code is correct and verified via curl/screenshot of the server, yet the user's real browser still exhibits the old (buggy) behavior, because their browser's SW cache — not the server — is the one serving the response, for any GET request that page issues (including cross-path JS files, not just precached ones).

**How to apply:** If a user reports a fix "isn't working" on a PWA/installable app that registers a service worker, check the SW's fetch strategy first. Bump the cache name (invalidates old entries) and switch to network-first-with-cache-fallback so future code changes propagate on the very next load instead of being silently held back by the cache.
