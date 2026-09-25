"use strict";
/**
 * api/weather.js   —   GET /api/weather?lat=..&lon=..
 * ─────────────────────────────────────────────────────────────
 * [AI UPDATE 2026-09-24] NEW FILE — Weather + Effect Engine.
 * [AI UPDATE 2026-09-25] COPIED into the Billing (Admin) Panel repo, byte-for-
 * byte identical to the Customer Panel's api/weather.js, so the Admin Panel's
 * new "Live Status" card (js/effects-admin.js) can show the restaurant's
 * current real-world weather without a cross-origin call to the Customer
 * Panel's own deployment. Each deployment needs its OWN OPENWEATHER_API_KEY
 * env var (same key value is fine) and each has its own independent 10-minute
 * in-memory cache — that's fine, they're read-only lookups of the same public
 * data. If you change the response shape here, change it in BOTH repos.
 *
 * Reads OpenWeather's "current weather" endpoint SERVER-SIDE and returns only
 * the small subset of fields the effect engine needs. The
 * OpenWeather key is read from process.env.OPENWEATHER_API_KEY and NEVER sent
 * to the browser, logged, or echoed back in any response.
 *
 * Request:  GET /api/weather?lat=<number>&lon=<number>
 *   lat/lon are the restaurant's coordinates (public — not secret — the
 *   Customer Panel reads them from Firestore settings/restaurant_location and
 *   forwards them here). If omitted, falls back to DEFAULT_LAT/DEFAULT_LON.
 *
 * Response: 200 application/json
 *   { ok:true, condId:<OpenWeather condition id>, main:<string>,
 *     icon:<string>, isNight:<bool>, tempC:<number|null>, fetchedAt:<ms> }
 *   or, on any upstream failure:
 *   { ok:false, error:"<code>" }   (still 200 — the frontend must never treat
 *   this as a hard error; it just keeps the previous/neutral effect)
 *
 * Caching (OpenWeather's own guidance: don't poll faster than their data
 * updates, ~10 min):
 *   - In-memory per-serverless-instance cache, keyed by rounded lat/lon,
 *     TTL 10 minutes. Cheap and correct across the many requests one warm
 *     instance serves, even though it doesn't persist across cold starts.
 *   - `Cache-Control: public, max-age=300, stale-while-revalidate=1800` lets
 *     Vercel's edge/CDN network absorb repeat requests across instances too.
 *   - The client (weather-service.js) ALSO caches in sessionStorage, so a
 *     single customer's device does not call this endpoint on every
 *     navigation/render — see that file for the client-side TTL.
 *
 * Env vars (Vercel → Project → Settings → Environment Variables):
 *   OPENWEATHER_API_KEY   (required — set by the restaurant owner)
 *
 * Failure handling: any missing key / network error / bad upstream response
 * resolves to { ok:false }, HTTP 200. This endpoint must never throw a 5xx
 * that could make the frontend treat weather as a blocking dependency.
 */

const OPENWEATHER_URL = "https://api.openweathermap.org/data/2.5/weather";
const UPSTREAM_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches OpenWeather's update cadence

// Fallback coordinates, used only if the request has no lat/lon at all
// (e.g. Firestore restaurant_location doc not yet configured).
const DEFAULT_LAT = 28.6139; // New Delhi — placeholder, override via Firestore/admin
const DEFAULT_LON = 77.2090;

// Per-instance cache. Keyed by "lat,lon" rounded to 2 decimals (~1km) so
// nearby requests share a cache entry.
const cache = new Map(); // key -> { data, expiresAt }

function roundCoord(n) {
  return Math.round(n * 100) / 100;
}

function isFiniteNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    // Node 18+ has global fetch (Vercel Node runtime). node-fetch is also a
    // project dependency (see package.json) as a fallback for older runtimes.
    const doFetch = typeof fetch === "function" ? fetch : require("node-fetch");
    return await doFetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=1800");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    // Not configured yet — fail soft, not an error the customer ever sees.
    return sendJson(res, 200, { ok: false, error: "not_configured" });
  }

  let lat = DEFAULT_LAT;
  let lon = DEFAULT_LON;
  try {
    const url = new URL(req.url, "http://internal");
    const qLat = parseFloat(url.searchParams.get("lat"));
    const qLon = parseFloat(url.searchParams.get("lon"));
    if (isFiniteNum(qLat) && isFiniteNum(qLon)) {
      lat = qLat;
      lon = qLon;
    }
  } catch (_) {
    // keep defaults
  }

  const key = `${roundCoord(lat)},${roundCoord(lon)}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return sendJson(res, 200, cached.data);
  }

  try {
    const url =
      `${OPENWEATHER_URL}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}` +
      `&appid=${encodeURIComponent(apiKey)}&units=metric`;
    const upstream = await fetchWithTimeout(url, UPSTREAM_TIMEOUT_MS);

    if (!upstream || !upstream.ok) {
      // Serve stale cache if we have one rather than a hard failure.
      if (cached) return sendJson(res, 200, cached.data);
      return sendJson(res, 200, { ok: false, error: "upstream_error" });
    }

    const json = await upstream.json();
    const w = Array.isArray(json.weather) && json.weather[0] ? json.weather[0] : {};
    const icon = typeof w.icon === "string" ? w.icon : "";
    const data = {
      ok: true,
      condId: typeof w.id === "number" ? w.id : null,
      main: typeof w.main === "string" ? w.main : "",
      icon,
      isNight: icon.endsWith("n"),
      tempC: json.main && isFiniteNum(json.main.temp) ? Math.round(json.main.temp) : null,
      fetchedAt: now,
    };
    cache.set(key, { data, expiresAt: now + CACHE_TTL_MS });
    return sendJson(res, 200, data);
  } catch (err) {
    if (cached) return sendJson(res, 200, cached.data); // stale-but-valid beats nothing
    return sendJson(res, 200, { ok: false, error: "fetch_failed" });
  }
};
