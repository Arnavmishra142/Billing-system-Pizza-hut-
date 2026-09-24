// js/effects-admin.js
// AI UPDATE [2026-09-24]: NEW FILE — Admin Panel side of the Seasonal Effects
// system ("✨ Effects" tab in admin/index.html bottom nav).
//
// Storage: Firestore doc  settings/seasonal_effects  { effects: { rain: boolean } }
//   - Reuses the shared `db` from js/firebase-config.js (no second Firebase config).
//   - `settings/*` is already `read: if true` / `write: if isOperator()` — no rules change.
//   - Missing doc / missing key => effect OFF (an effect never appears unless Admin enabled it).
// The Customer Panel (separate repo) listens to the same doc with onSnapshot, so toggling
// here shows/hides the effect live on every customer device.
//
// ADDING A FUTURE EFFECT: change its entry in EFFECTS below from `soon: true` to
// `soon: false`. The `key` is the field name under `effects` in the Firestore doc and
// must match the key registered in the Customer Panel's SeasonalEffectsManager.
//
// Exports: initEffectsAdmin(), destroyEffectsAdmin()
// Called from: js/admin.js switchTab('effects', ...)

import { db, auth } from './firebase-config.js';
import {
    doc, onSnapshot, setDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

const EFFECTS = [
    { key: 'rain',      icon: '🌧️', name: 'Rainy Days',     desc: 'Soft animated rain and moody sky on the customer app.', soon: false },
    { key: 'christmas', icon: '🎄', name: 'Christmas',      soon: true },
    { key: 'diwali',    icon: '🪔', name: 'Diwali',         soon: true },
    { key: 'newyear',   icon: '🎆', name: 'New Year',       soon: true },
    { key: 'holi',      icon: '🎨', name: 'Holi',           soon: true },
    { key: 'valentine', icon: '❤️', name: "Valentine's Day", soon: true },
];

let _state  = {};          // { rain: true, ... } mirrors Firestore `effects`
let _unsub  = null;
let _saving = new Set();
let _loaded = false;

const _ref = () => doc(db, 'settings', 'seasonal_effects');
const _root = () => document.getElementById('effectsCardGrid');

export function initEffectsAdmin() {
    _render();
    if (_unsub) return;
    _unsub = onSnapshot(_ref(), (snap) => {
        _state  = (snap.exists() && snap.data().effects) || {};
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
    _loaded = false;
}

function _render() {
    const root = _root();
    if (!root) return;
    root.innerHTML = `
        <div class="section-action-bar">
            <div class="section-page-title">✨ Seasonal Effects</div>
        </div>
        <p class="fx-intro">Turn on an atmosphere for the customer app. Changes appear live on customers' phones.</p>
        <div class="fx-list">
            ${EFFECTS.map(_rowHtml).join('')}
        </div>`;
    root.querySelectorAll('.fx-switch[data-key]').forEach(btn => {
        btn.addEventListener('click', () => _toggle(btn.dataset.key));
    });
}

function _rowHtml(e) {
    if (e.soon) {
        return `
        <div class="fx-card fx-soon">
            <div class="fx-icon">${e.icon}</div>
            <div class="fx-info"><div class="fx-name">${e.name}</div></div>
            <span class="fx-badge">Coming Soon</span>
        </div>`;
    }
    const on = _state[e.key] === true;
    return `
        <div class="fx-card${on ? ' fx-on' : ''}">
            <div class="fx-icon">${e.icon}</div>
            <div class="fx-info">
                <div class="fx-name">${e.name}</div>
                <div class="fx-desc">${e.desc}</div>
            </div>
            <span class="fx-state">${on ? 'ON' : 'OFF'}</span>
            <button type="button" class="fx-switch${on ? ' on' : ''}" data-key="${e.key}"
                    role="switch" aria-checked="${on}" aria-label="${e.name}"
                    ${_loaded ? '' : 'disabled'}><span class="fx-knob"></span></button>
        </div>`;
}

function _waitForAuth(ms = 5000) {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise(resolve => {
        const off = onAuthStateChanged(auth, u => { if (u) { off(); resolve(u); } });
        setTimeout(() => { off(); resolve(null); }, ms);
    });
}

async function _toggle(key) {
    if (_saving.has(key)) return;
    if (!(await _waitForAuth())) {
        alert('Could not sign in. Please reload the page and try again.');
        return;
    }
    const was = _state[key] === true;
    _saving.add(key);
    _state = { ..._state, [key]: !was };   // optimistic
    _render();
    try {
        // merge:true creates the doc on first use and leaves other effects untouched.
        await setDoc(_ref(), { effects: { [key]: !was }, updatedAt: Date.now() }, { merge: true });
    } catch (e) {
        console.error('[effects-admin] toggle failed:', e);
        _state = { ..._state, [key]: was }; // roll back
        _render();
        alert('Could not update the effect. Please try again.');
    } finally {
        _saving.delete(key);
    }
}
