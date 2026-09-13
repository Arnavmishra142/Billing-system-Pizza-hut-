// js/incoming-orders-customers.js
// AI UPDATE [2026-09-13]: NEW FILE — "Customers" tab for the Incoming Orders
// drawer in the POS Billing Panel (index.html: Orders | Menu | Customers).
//
// ── Reuse, not duplication ──────────────────────────────────────────────────
// - Customer list: reads the SAME `customers/{phone}` Firestore collection
//   already used by js/customers.js (Admin Panel → Customer Management) and
//   customer.html. No new collection, no new customer-identity mechanism.
//   Identifier used for recovery is the Firestore doc ID, which IS the
//   customer's normalised phone (`+91XXXXXXXXXX`) — same identifier the
//   Admin Panel's recovery button already uses.
// - "Generate Recovery Code": calls `callRecoveryFn('generateRecoveryCode', …)`,
//   which is `js/customers.js`'s own `_callRecoveryFn` re-exported unchanged
//   (see the one-line export added there). This hits the exact same
//   Cloudflare Worker endpoint, with the exact same code generation, 10-minute
//   expiry, single-use, and server-side PIN/claim authorization the Admin
//   Panel's "🔑 Generate Recovery Code" button already uses. No new
//   recovery-code collection or backend logic was written for this feature.
//
// ── Why this file exists instead of importing js/customers.js's UI directly ─
// js/customers.js's own list renderer/detail-overlay is wired to
// admin/index.html-specific element IDs (#customerCardList,
// #custDetailOverlay, #custRecoveryOverlay, …) and to `window.__OPERATOR_PIN`,
// which is only ever set by js/admin.js's PIN-1414 screen — a screen that
// only exists on admin/index.html, not on this POS index.html. Rather than
// changing js/customers.js's existing (frozen-adjacent, Admin-Panel-facing)
// rendering to serve two different pages, this file renders its own small
// list matching the simpler layout requested for the POS drawer (name, phone,
// one button) and prompts for the operator PIN inline when needed — the
// Worker still performs the exact same server-side PIN check either way.
//
// Untouched by this file: js/customers.js's own UI/exports (only one export
// line was added there), js/admin.js, admin/index.html, the Orders tab, the
// Menu tab, and all billing/order/menu logic.

import { db, auth } from './firebase-config.js';
import { collection, getDocs }
    from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { signInAnonymously, onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { showPrompt } from './dialog.js';
import { callRecoveryFn } from './customers.js';

// ── Auth bootstrap (mandatory pattern — ARCHITECTURE_LOCK.md §7 rule 15) ────
signInAnonymously(auth).catch(() => {});

let _authReady = false;
const _authQueue = [];
onAuthStateChanged(auth, user => {
    if (user && !_authReady) {
        _authReady = true;
        _authQueue.splice(0).forEach(r => r());
    }
});
const _waitForAuth = () =>
    _authReady ? Promise.resolve() : new Promise(r => _authQueue.push(r));

// ── Module state ────────────────────────────────────────────────────────────
let _customers      = [];   // [{ id (phone/doc-id), name, phone }]
let _loaded          = false;
let _search           = '';
let _recoveryTimer    = null;

// ── Scoped CSS — injected once, same pattern as incoming-orders.js /
//    menu-management.js (each drawer feature owns its own <style> block) ────
(function injectCSS() {
    if (document.getElementById('io-cust-style')) return;
    const s = document.createElement('style');
    s.id = 'io-cust-style';
    s.textContent = `
        .io-cust-card {
            background: #2a2a3e; border-radius: 12px;
            padding: 14px 16px; margin-bottom: 12px;
            border-left: 4px solid #3b82f6;
            display: flex; align-items: center; justify-content: space-between; gap: 12px;
        }
        .io-cust-info { min-width: 0; }
        .io-cust-name {
            font-weight: 700; font-size: 0.92rem;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .io-cust-phone { font-size: 0.8rem; opacity: 0.75; margin-top: 3px; }
        .io-cust-recovery-btn {
            flex-shrink: 0; background: linear-gradient(135deg, #6366f1, #818cf8);
            color: #fff; border: none; border-radius: 8px;
            padding: 9px 12px; font-weight: 600; font-size: 0.78rem; cursor: pointer;
            white-space: nowrap;
        }
        .io-cust-recovery-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .io-cust-empty { text-align: center; opacity: 0.6; padding: 30px 10px; font-size: 0.9rem; }

        .io-recovery-code {
            font-size: 2.3rem; font-weight: 900; letter-spacing: 8px;
            font-family: monospace; color: #3fb950; margin: 10px 0 6px;
        }
        .io-recovery-ttl  { font-size: 0.85rem; color: #d29922; font-weight: 700; margin-top: 10px; }
        .io-recovery-note { font-size: 0.76rem; opacity: 0.7; margin-top: 14px; line-height: 1.5; }
    `;
    document.head.appendChild(s);
})();

// ── Escaping (same helper pattern as js/customers.js) ───────────────────────
function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Public API (called by index.html's switchDrawerTab) ─────────────────────
export async function initCustomersTab() {
    if (_loaded) { _render(); return; }
    _showLoading();
    await _waitForAuth();
    await _fetchCustomers();
}

// ── Data fetching — reads the existing customers/{phone} collection ────────
async function _fetchCustomers() {
    const listEl = document.getElementById('ioCustList');
    try {
        const snap = await getDocs(collection(db, 'customers'));
        const list = [];
        snap.forEach(d => {
            const data = d.data();
            list.push({ id: d.id, name: data.name || '', phone: data.phone || d.id });
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        _customers = list;
        _loaded = true;
        _render();
    } catch (err) {
        console.error('[incoming-orders-customers] Fetch error:', err);
        if (listEl) listEl.innerHTML =
            `<div class="io-cust-empty">⚠️ Failed to load customers.</div>`;
    }
}

function _showLoading() {
    const listEl = document.getElementById('ioCustList');
    if (listEl) listEl.innerHTML = `<div class="io-cust-empty">Loading customers… ☁️</div>`;
}

// ── List rendering — live search by name (case-insensitive) + phone ────────
function _render() {
    const listEl = document.getElementById('ioCustList');
    if (!listEl) return;

    const q = _search.toLowerCase().trim();
    const filtered = q
        ? _customers.filter(c =>
            c.name.toLowerCase().includes(q) ||
            c.phone.includes(q)
          )
        : _customers;

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="io-cust-empty">${
            q ? '🔍 No customers match your search.' : '👤 No customers registered yet.'
        }</div>`;
        return;
    }

    listEl.innerHTML = filtered.map(c => `
        <div class="io-cust-card">
            <div class="io-cust-info">
                <div class="io-cust-name">👤 ${_esc(c.name || 'Unknown')}</div>
                <div class="io-cust-phone">📱 ${_esc(c.phone)}</div>
            </div>
            <button class="io-cust-recovery-btn" onclick="window._ioGenerateRecovery('${_esc(c.id)}')">
                🔑 Generate Recovery Code
            </button>
        </div>
    `).join('');
}

// ── Live search — called from #ioCustSearch's oninput, no Enter needed ──────
window._ioCustSearch = function (val) {
    _search = val || '';
    _render();
};

// ── Staff-assisted recovery ───────────────────────────────────────────────
// Calls the EXACT same Worker function the Admin Panel's own
// "🔑 Generate Recovery Code" button uses (js/customers.js → callRecoveryFn).
window._ioGenerateRecovery = async function (phone) {
    const c       = _customers.find(x => x.id === phone);
    const overlay = document.getElementById('ioRecoveryModal');
    const body    = document.getElementById('ioRecoveryBody');
    if (!overlay || !body) return;

    // The Worker requires the operator PIN (or a billingOperator claim) for
    // this call — same authorization the Admin Panel already relies on. The
    // POS panel has no PIN session of its own (js/admin.js's PIN screen only
    // exists on admin/index.html), so it's collected here and handed to the
    // unchanged Worker check. Cached in-memory only for this page session,
    // exactly like admin.js's own window.__OPERATOR_PIN — never persisted.
    let pin = window.__OPERATOR_PIN || '';
    if (!pin) {
        pin = await showPrompt('Enter operator PIN to generate a recovery code:', {
            title:       'Operator PIN Required',
            inputType:   'password',
            placeholder: '••••',
            confirmText: 'Continue',
        });
        if (!pin) return; // staff cancelled
    }

    body.innerHTML = `<div class="io-cust-empty">Generating secure code… 🔐</div>`;
    overlay.classList.remove('hidden');

    try {
        const r = await callRecoveryFn('generateRecoveryCode', { phone, pin });
        window.__OPERATOR_PIN = pin; // cache only after a successful call

        body.innerHTML = `
            <div class="io-recovery-code">${_esc(r.code)}</div>
            <div style="font-weight:700;">${_esc(r.name || c?.name || 'Customer')}</div>
            <div style="opacity:0.75;font-size:0.85rem;">${_esc(r.phone || phone)}</div>
            <div id="ioRecoveryTtl" class="io-recovery-ttl">Expires in 10:00</div>
            <div class="io-recovery-note">
                Tell this code to the customer. They enter it on their own device and set
                their own new password.<br>
                <strong>Never ask the customer for their password.</strong>
            </div>`;

        // Live countdown — display only; the Worker enforces the real expiry.
        clearInterval(_recoveryTimer);
        const endAt = Number(r.expiresAt) || (Date.now() + 10 * 60 * 1000);
        const tick = () => {
            const el = document.getElementById('ioRecoveryTtl');
            if (!el) { clearInterval(_recoveryTimer); return; }
            const left = Math.max(0, Math.floor((endAt - Date.now()) / 1000));
            const m = String(Math.floor(left / 60)).padStart(2, '0');
            const s = String(left % 60).padStart(2, '0');
            el.textContent = left ? `Expires in ${m}:${s}` : 'Code expired — generate a new one';
            if (!left) { el.style.color = '#f85149'; clearInterval(_recoveryTimer); }
        };
        tick();
        _recoveryTimer = setInterval(tick, 1000);

    } catch (err) {
        // Bad/stale PIN → don't keep re-using it on the next attempt.
        if ((err.message || '').toLowerCase().includes('billing staff')) {
            window.__OPERATOR_PIN = '';
        }
        body.innerHTML = `<div class="io-cust-empty">⚠️ Could not generate code.<br>` +
            `<small style="opacity:0.7;">${_esc(err.message)}</small></div>`;
    }
};

window._ioCloseRecovery = function () {
    clearInterval(_recoveryTimer);
    document.getElementById('ioRecoveryModal')?.classList.add('hidden');
    const body = document.getElementById('ioRecoveryBody');
    if (body) body.innerHTML = ''; // never leave a code on screen
};
