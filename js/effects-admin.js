// js/effects-admin.js
// [AI UPDATE 2026-09-24] REWRITTEN -- Admin Panel side of the Weather + Manual
// Effect engine ("Effects" tab in admin/index.html bottom nav).
//
// Storage: two Firestore docs (both public-read / operator-write, same rules
// as before -- no rules change needed):
//   settings/seasonal_effects
//     { effectsEnabled: boolean,          // global master switch
//       automaticWeatherEnabled: boolean, // OpenWeather drives the effect
//       manualEffectId: string|null,      // explicit override, wins over weather
//       effects: { rainSound: boolean },  // kept: rain-effect's optional sound
//       updatedAt: number }
//   settings/restaurant_location
//     { lat: number, lon: number, updatedAt: number }
//
// The Customer Panel (separate repo) listens to seasonal_effects with
// onSnapshot and resolves the active effect via effect-resolver.js -- see
// AI_HANDOFF.md "Weather + Effect Engine" for the full architecture.
//
// Priority (must match js/effects/effect-resolver.js in the Customer Panel):
//   1. effectsEnabled === false        -> no effect, overrides everything
//   2. manualEffectId set              -> that exact effect, overrides weather
//   3. automaticWeatherEnabled === true -> weather-mapped effect
//   4. otherwise                       -> no effect
//
// ADDING A FUTURE EFFECT: add it to WEATHER_EFFECTS or FESTIVAL_EFFECTS below
// with `soon:false`. The `key` must equal the key registered in the Customer
// Panel's seasonal-effects-manager.js REGISTRY.
//
// Exports: initEffectsAdmin(), destroyEffectsAdmin()
// Called from: js/admin.js switchTab('effects', ...)

import { db, auth } from './firebase-config.js';
import {
    doc, onSnapshot, setDoc, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { normalizeWeather, resolveActiveEffect, EFFECT_LABELS }
    from "./effects/weather-status.js";

// [AI UPDATE 2026-09-25] Live Status card -- see js/effects/weather-status.js
// header comment for why this duplicates (not imports) the Customer Panel's
// normalizer/resolver. Polls this repo's OWN /api/weather (api/weather.js,
// wired in server.js) -- same 10-minute upstream cache, so polling here is
// cheap and never hits OpenWeather more often than the Customer Panel does.
const WEATHER_POLL_MS = 2 * 60 * 1000; // UI refresh cadence (upstream data itself only changes ~10 min)

// Weather-driven effects -- resolved automatically from real weather when
// "Automatic Weather Effects" is ON. Rows are status-only (no per-row
// switch): use the master toggles above to control the mode, and the
// "Force a specific look" switch on any row to override with that one effect.
const WEATHER_EFFECTS = [
    { key: 'sunny',   icon: '☀️', name: 'Sunny / Clear',   desc: 'Warm subtle sunlight atmosphere.' },
    { key: 'cloudy',  icon: '☁️', name: 'Cloudy',          desc: 'Soft moving cloud atmosphere.' },
    { key: 'rain',    icon: '🌧️', name: 'Rain / Thunderstorm', desc: 'Existing Rainy Days effect -- also covers drizzle and thunderstorms (with lightning).' },
    { key: 'snow',    icon: '❄️', name: 'Snow',            desc: 'Animated snow particles, winter atmosphere.' },
    { key: 'fog',     icon: '🌫️', name: 'Mist / Fog / Haze', desc: 'Soft low-opacity haze -- also covers smoke, dust, sand and ash.' },
];

const FESTIVAL_EFFECTS = [
    { key: 'christmas', icon: '🎄', name: 'Christmas',      soon: true },
    { key: 'diwali',    icon: '🪔', name: 'Diwali',         soon: true },
    { key: 'newyear',   icon: '🎆', name: 'New Year',       soon: true },
    { key: 'holi',      icon: '🎨', name: 'Holi',           soon: true },
    { key: 'valentine', icon: '❤️', name: "Valentine's Day", soon: true },
];

let _config = {};          // mirrors settings/seasonal_effects
let _location = null;      // mirrors settings/restaurant_location
let _unsub  = null;
let _saving = new Set();
let _loaded = false;

// Live Status card state [AI UPDATE 2026-09-25]
let _liveWeather = null;   // last /api/weather response (raw, { ok, condId, main, icon, tempC, ... })
let _weatherLoading = false;
let _weatherTimer = 0;

const _ref = () => doc(db, 'settings', 'seasonal_effects');
const _locRef = () => doc(db, 'settings', 'restaurant_location');
const _root = () => document.getElementById('effectsCardGrid');

export function initEffectsAdmin() {
    _render();
    _loadLocation();
    _fetchLiveWeather();
    if (!_weatherTimer) _weatherTimer = setInterval(_fetchLiveWeather, WEATHER_POLL_MS);
    if (_unsub) return;
    _unsub = onSnapshot(_ref(), (snap) => {
        _config = snap.exists() ? snap.data() : {};
        _loaded = true;
        _render();
    }, (err) => {
        console.error('[effects-admin] listener error:', err);
        if (_unsub) { _unsub(); _unsub = null; }
        setTimeout(() => { if (!_unsub) initEffectsAdmin(); }, 5000);
    });
}

export function destroyEffectsAdmin() {
    if (_unsub) { _unsub(); _unsub = null; }
    if (_weatherTimer) { clearInterval(_weatherTimer); _weatherTimer = 0; }
    _loaded = false;
}

// Fetches THIS deployment's /api/weather using the saved restaurant location
// (falls back to the endpoint's own default coords if none saved yet -- same
// fallback behaviour as the Customer Panel). Never throws; a failure just
// shows a clear "couldn't load" state in the card rather than breaking the tab.
async function _fetchLiveWeather() {
    if (_weatherLoading) return;
    _weatherLoading = true;
    try {
        const qs = (_location && typeof _location.lat === 'number' && typeof _location.lon === 'number')
            ? `?lat=${_location.lat}&lon=${_location.lon}` : '';
        const res = await fetch(`/api/weather${qs}`, { cache: 'no-store' });
        _liveWeather = res && res.ok ? await res.json() : { ok: false, error: 'request_failed' };
    } catch (e) {
        console.warn('[effects-admin] live weather fetch failed:', e);
        _liveWeather = { ok: false, error: 'request_failed' };
    } finally {
        _weatherLoading = false;
        _render();
    }
}

async function _loadLocation() {
    try {
        const snap = await getDoc(_locRef());
        _location = snap.exists() ? snap.data() : null;
    } catch (e) {
        console.error('[effects-admin] location load failed:', e);
        _location = null;
    }
    _renderLocation();
    if (_location) _fetchLiveWeather(); // re-fetch with the real coords once loaded (first call used defaults)
}

function _effectsEnabled() { return _config.effectsEnabled !== false; }         // default true
function _autoWeather()    { return _config.automaticWeatherEnabled === true; } // default false
function _manualId()       { return typeof _config.manualEffectId === 'string' ? _config.manualEffectId : null; }

function _render() {
    const root = _root();
    if (!root) return;
    const enabled = _effectsEnabled();
    const auto = _autoWeather();
    const manual = _manualId();

    root.innerHTML = `
        <div class="section-action-bar">
            <div class="section-page-title">Effects</div>
        </div>
        <p class="fx-intro">Control the atmosphere shown on the customer app. Changes appear live on customers' phones.</p>

        ${_liveStatusHtml({ enabled })}

        <div class="fx-master${enabled ? '' : ' fx-off'}">
            <div class="fx-master-row">
                <div class="fx-info">
                    <div class="fx-name">All Effects</div>
                    <div class="fx-desc">Master switch. OFF disables every effect below, no matter what else is configured.</div>
                </div>
                <span class="fx-state">${enabled ? 'ON' : 'OFF'}</span>
                <button type="button" class="fx-switch${enabled ? ' on' : ''}" data-master
                        role="switch" aria-checked="${enabled}" aria-label="All Effects"
                        ${_loaded ? '' : 'disabled'}><span class="fx-knob"></span></button>
            </div>
            <div class="fx-master-row${enabled ? '' : ' fx-disabled'}">
                <div class="fx-info">
                    <div class="fx-name">Automatic Weather Effects</div>
                    <div class="fx-desc">When ON, real current weather (OpenWeather) picks the effect automatically. When OFF, only a manually forced effect below will show.</div>
                </div>
                <span class="fx-state">${auto ? 'ON' : 'OFF'}</span>
                <button type="button" class="fx-switch${auto ? ' on' : ''}" data-auto
                        role="switch" aria-checked="${auto}" aria-label="Automatic Weather Effects"
                        ${_loaded && enabled ? '' : 'disabled'}><span class="fx-knob"></span></button>
            </div>
        </div>

        <div class="fx-location">
            <div class="fx-name">Restaurant Location</div>
            <div class="fx-desc">Coordinates used to look up the current weather. Needed only when Automatic Weather Effects is used.</div>
            <div class="fx-location-row">
                <input type="text" id="fxLocName" class="fx-loc-input fx-loc-name" placeholder="Location name (e.g. Salempur) -- for display only">
            </div>
            <div class="fx-location-row">
                <input type="text" id="fxLat" class="fx-loc-input" placeholder="Latitude" inputmode="decimal">
                <input type="text" id="fxLon" class="fx-loc-input" placeholder="Longitude" inputmode="decimal">
                <button type="button" id="fxLocSave" class="fx-loc-save">Save</button>
            </div>
            <div id="fxLocStatus" class="fx-loc-status"></div>
        </div>

        <div class="fx-section-title">Weather Effects</div>
        <p class="fx-subintro">${auto && !manual
            ? 'Automatic mode is on -- the effect matching current weather runs by itself.'
            : 'Automatic mode is off (or a manual effect is forced) -- these will not run on their own. Use "Force this" to show one anyway.'}</p>
        <div class="fx-list">
            ${WEATHER_EFFECTS.map((e) => _rowHtml(e, { manual, auto, enabled })).join('')}
            ${_rainSoundRowHtml({ enabled })}
        </div>

        <div class="fx-section-title">Festival / Seasonal Effects</div>
        <div class="fx-list">
            ${FESTIVAL_EFFECTS.map((e) => _rowHtml(e, { manual, auto, enabled })).join('')}
        </div>`;

    root.querySelector('[data-master]')?.addEventListener('click', () => _toggleMaster());
    root.querySelector('[data-auto]')?.addEventListener('click', () => _toggleAuto());
    root.querySelector('[data-rainsound]')?.addEventListener('click', () => _toggleRainSound());
    root.querySelectorAll('.fx-switch[data-key]').forEach((btn) => {
        btn.addEventListener('click', () => _toggleManual(btn.dataset.key));
    });
    root.querySelector('#fxLocSave')?.addEventListener('click', _saveLocation);
    root.querySelector('#fxWeatherRefresh')?.addEventListener('click', () => { if (!_weatherLoading) _fetchLiveWeather(); });
    _renderLocation();
}

// [AI UPDATE 2026-09-25] "Live Status" card -- answers, at a glance, the two
// things an operator actually needs to know: what the real weather is doing
// at the restaurant right now, and what the customer app is showing BECAUSE
// of that (or in spite of it, if a manual override or the master switch is
// in the way). Uses the same normalizeWeather()/resolveActiveEffect() the
// Customer Panel uses -- see js/effects/weather-status.js.
function _liveStatusHtml({ enabled }) {
    const locName = (_location && _location.locationName) ? _location.locationName : null;
    const w = _liveWeather;

    let weatherLine;
    let normalized = null;
    if (_weatherLoading && !w) {
        weatherLine = `<span class="fx-live-muted">Checking current weather…</span>`;
    } else if (!w || w.ok !== true) {
        const reason = w && w.error === 'not_configured'
            ? 'Weather API key not set up yet on this server (OPENWEATHER_API_KEY).'
            : "Couldn't reach the weather service right now.";
        weatherLine = `<span class="fx-live-muted">${reason}</span>`;
    } else {
        normalized = normalizeWeather(w);
        const label = EFFECT_LABELS[normalized.effect] || { icon: '🌡️', name: normalized.effect };
        const place = locName ? `in ${locName}` : '(location not named -- set it below)';
        const temp = typeof w.tempC === 'number' ? `${w.tempC}°C, ` : '';
        weatherLine = `${label.icon} <strong>${temp}${label.name}</strong> ${place}${normalized.isNight ? ' · night' : ''}`;
    }

    const resolved = resolveActiveEffect(_config, normalized);
    let customerLine, customerTone = '';
    if (resolved.source === 'none' && !enabled) {
        customerLine = '⛔ Nothing -- All Effects is OFF';
    } else if (resolved.source === 'none') {
        customerLine = '— Nothing right now (Automatic Weather is off and no effect is forced)';
    } else {
        const label = EFFECT_LABELS[resolved.key] || { icon: '✨', name: resolved.key };
        const via = resolved.source === 'manual' ? 'forced manually' : 'from automatic weather';
        customerLine = `${label.icon} <strong>${label.name}</strong> <span class="fx-live-via">(${via})</span>`;
        customerTone = ' fx-live-on';
    }

    return `
        <div class="fx-live">
            <div class="fx-live-row">
                <span class="fx-live-label">Weather</span>
                <span class="fx-live-value">${weatherLine}</span>
            </div>
            <div class="fx-live-row${customerTone}">
                <span class="fx-live-label">Customer app is showing</span>
                <span class="fx-live-value">${customerLine}</span>
            </div>
            <button type="button" id="fxWeatherRefresh" class="fx-live-refresh" ${_weatherLoading ? 'disabled' : ''}>
                ${_weatherLoading ? 'Refreshing…' : '↻ Refresh'}
            </button>
        </div>`;
}

function _rowHtml(e, { manual, auto, enabled }) {
    if (e.soon) {
        return `
        <div class="fx-card fx-soon">
            <div class="fx-icon">${e.icon}</div>
            <div class="fx-info"><div class="fx-name">${e.name}</div></div>
            <span class="fx-badge">Coming Soon</span>
        </div>`;
    }
    const isManual = manual === e.key;
    const isAutoStatus = !isManual && auto; // weather rows only: "governed by automatic mode" indicator
    const isWeatherRow = WEATHER_EFFECTS.some((w) => w.key === e.key);
    let badge;
    if (isManual) badge = 'ON (forced)';
    else if (isWeatherRow && isAutoStatus) badge = 'AUTO';
    else badge = 'OFF';

    return `
        <div class="fx-card${isManual ? ' fx-on' : ''}">
            <div class="fx-icon">${e.icon}</div>
            <div class="fx-info">
                <div class="fx-name">${e.name}</div>
                ${e.desc ? `<div class="fx-desc">${e.desc}</div>` : ''}
            </div>
            <span class="fx-state">${badge}</span>
            <button type="button" class="fx-switch${isManual ? ' on' : ''}" data-key="${e.key}"
                    role="switch" aria-checked="${isManual}" aria-label="Force ${e.name}"
                    title="${isManual ? 'Stop forcing this effect' : 'Force this effect on, overriding weather'}"
                    ${_loaded && enabled ? '' : 'disabled'}><span class="fx-knob"></span></button>
        </div>`;
}

function _rainSoundRowHtml({ enabled }) {
    const on = _config.effects && _config.effects.rainSound === true;
    return `
        <div class="fx-card">
            <div class="fx-icon">🔊</div>
            <div class="fx-info">
                <div class="fx-name">Rain Sound</div>
                <div class="fx-desc">Optional soft rain + distant thunder. Customers see a small button and choose to turn it on (off by default). Only has an effect while Rain is showing.</div>
            </div>
            <span class="fx-state">${on ? 'ON' : 'OFF'}</span>
            <button type="button" class="fx-switch${on ? ' on' : ''}" data-rainsound
                    role="switch" aria-checked="${on}" aria-label="Rain Sound"
                    ${_loaded && enabled ? '' : 'disabled'}><span class="fx-knob"></span></button>
        </div>`;
}

function _renderLocation() {
    const nameEl = document.getElementById('fxLocName');
    const latEl = document.getElementById('fxLat');
    const lonEl = document.getElementById('fxLon');
    const statusEl = document.getElementById('fxLocStatus');
    if (!latEl || !lonEl) return;
    if (nameEl) nameEl.value = (_location && typeof _location.locationName === 'string') ? _location.locationName : '';
    if (_location && typeof _location.lat === 'number' && typeof _location.lon === 'number') {
        latEl.value = String(_location.lat);
        lonEl.value = String(_location.lon);
        if (statusEl) statusEl.textContent = 'Saved.';
    } else if (statusEl) {
        statusEl.textContent = 'Not set yet -- weather effects will use a default location (New Delhi) until this is saved.';
    }
}

function _waitForAuth(ms = 5000) {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise((resolve) => {
        const off = onAuthStateChanged(auth, (u) => { if (u) { off(); resolve(u); } });
        setTimeout(() => { off(); resolve(null); }, ms);
    });
}

async function _saveLocation() {
    const nameEl = document.getElementById('fxLocName');
    const latEl = document.getElementById('fxLat');
    const lonEl = document.getElementById('fxLon');
    const statusEl = document.getElementById('fxLocStatus');
    const locationName = (nameEl?.value || '').trim().slice(0, 60);
    const lat = parseFloat(latEl?.value);
    const lon = parseFloat(lonEl?.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        if (statusEl) statusEl.textContent = 'Enter valid coordinates (e.g. 28.6139, 77.2090).';
        return;
    }
    if (!(await _waitForAuth())) { alert('Could not sign in. Please reload the page and try again.'); return; }
    try {
        await setDoc(_locRef(), { lat, lon, locationName, updatedAt: Date.now() }, { merge: true });
        _location = { lat, lon, locationName };
        if (statusEl) statusEl.textContent = 'Saved.';
        _fetchLiveWeather(); // coords may have just changed -- refresh the Live Status card right away
    } catch (e) {
        console.error('[effects-admin] location save failed:', e);
        if (statusEl) statusEl.textContent = 'Could not save. Please try again.';
    }
}

async function _toggleMaster() {
    if (_saving.has('__master')) return;
    if (!(await _waitForAuth())) { alert('Could not sign in. Please reload the page and try again.'); return; }
    const was = _effectsEnabled();
    _saving.add('__master');
    _config = { ..._config, effectsEnabled: !was };
    _render();
    try {
        await setDoc(_ref(), { effectsEnabled: !was, updatedAt: Date.now() }, { merge: true });
    } catch (e) {
        console.error('[effects-admin] master toggle failed:', e);
        _config = { ..._config, effectsEnabled: was };
        _render();
        alert('Could not update Effects. Please try again.');
    } finally {
        _saving.delete('__master');
    }
}

async function _toggleAuto() {
    if (_saving.has('__auto') || !_effectsEnabled()) return;
    if (!(await _waitForAuth())) { alert('Could not sign in. Please reload the page and try again.'); return; }
    const was = _autoWeather();
    _saving.add('__auto');
    _config = { ..._config, automaticWeatherEnabled: !was };
    _render();
    try {
        await setDoc(_ref(), { automaticWeatherEnabled: !was, updatedAt: Date.now() }, { merge: true });
    } catch (e) {
        console.error('[effects-admin] auto toggle failed:', e);
        _config = { ..._config, automaticWeatherEnabled: was };
        _render();
        alert('Could not update Automatic Weather Effects. Please try again.');
    } finally {
        _saving.delete('__auto');
    }
}

async function _toggleRainSound() {
    if (_saving.has('__rainsound') || !_effectsEnabled()) return;
    if (!(await _waitForAuth())) { alert('Could not sign in. Please reload the page and try again.'); return; }
    const was = _config.effects && _config.effects.rainSound === true;
    _saving.add('__rainsound');
    _config = { ..._config, effects: { ..._config.effects, rainSound: !was } };
    _render();
    try {
        await setDoc(_ref(), { effects: { rainSound: !was }, updatedAt: Date.now() }, { merge: true });
    } catch (e) {
        console.error('[effects-admin] rain sound toggle failed:', e);
        _config = { ..._config, effects: { ..._config.effects, rainSound: was } };
        _render();
        alert('Could not update Rain Sound. Please try again.');
    } finally {
        _saving.delete('__rainsound');
    }
}

async function _toggleManual(key) {
    if (_saving.has(key) || !_effectsEnabled()) return;
    if (!(await _waitForAuth())) { alert('Could not sign in. Please reload the page and try again.'); return; }
    const was = _manualId() === key;
    const nextManual = was ? null : key; // only one manual effect at a time -- picking one clears any other
    _saving.add(key);
    _config = { ..._config, manualEffectId: nextManual };
    _render();
    try {
        // Firestore does not support writing `null` via a plain merge field the same
        // way as a value -- setDoc with merge:true DOES support null (clears/sets the
        // field), so this is safe.
        await setDoc(_ref(), { manualEffectId: nextManual, updatedAt: Date.now() }, { merge: true });
    } catch (e) {
        console.error('[effects-admin] manual toggle failed:', e);
        _config = { ..._config, manualEffectId: was ? key : (_manualId() === null ? null : _manualId()) };
        _render();
        alert('Could not update the effect. Please try again.');
    } finally {
        _saving.delete(key);
    }
}
