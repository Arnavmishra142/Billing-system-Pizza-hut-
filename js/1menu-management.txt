// menu-management.js
// Real-time menu management panel for the admin drawer.
// Pizza availability is managed by size (Regular / Medium / Large) via
// settings/pizza_sizes. All other items are toggled individually via inStock.

// ===== AI UPDATE =====
// Date: 2026-07-31
// Feature: Global Online Ordering Toggle
// Summary:
// - Added a global "Online Ordering: ON/OFF" toggle at the top of the Menu tab.
// - State is stored in settings/restaurant_status { onlineOrderingEnabled: boolean }.
// - The settings collection already allows read:if true, write:if isOperator() —
//   no Firestore rules changes were needed.
// - When absent, the field defaults to true (backward compatible — nothing breaks
//   for existing restaurants after deployment).
// - A realtime onSnapshot listener (_startRestaurantStatusListener) keeps the toggle
//   in sync across multiple operator devices without page refresh.
// - The Customer Panel (teamdovolve-hue/Order-) reads the same document via
//   order-panel-updates/js/restaurant-status.js and shows an offline screen when OFF.
// - Files changed: js/menu-management.js (this file), index.html (added
//   #menuMgmtGlobalToggle container), order-panel-updates/js/restaurant-status.js (new),
//   sw.js (cache bump), ARCHITECTURE_LOCK.md, AI_HANDOFF.md.
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-28
// Feature: Menu Management Toggle — Auth Guard Fix
// Summary:
// - Toggle was failing with "Could not update <item>" on every tap.
// - Root cause: menu items are served from IndexedDB offline cache (reads work
//   without auth), but updateDoc/setDoc writes always hit the Firestore server
//   which returns permission-denied when auth.currentUser is null.
// - Fix: imported auth from firebase-config; _toggle() and _togglePizzaSize()
//   now check auth.currentUser before attempting a write.
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-28 (v2)
// Feature: Menu Management Toggle — Auth Wait Fix
// Summary:
// - Deeper root cause: index.html never calls signInAnonymously at all.
// - Fix: incoming-orders.js bootstraps anonymous auth; menu-management.js
//   now waits up to 5 s for auth instead of bailing immediately.
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-28 (v3)
// Feature: Menu Management — Three root-cause fixes
// Summary:
//
// Fix A — Individual pizza variant toggles:
//   Pizza variant items (e.g. "Paneer Pizza (Large)") were permanently excluded
//   from the toggle list and could only be affected by the whole-size toggle.
//   An operator could NOT mark a single pizza variant as out of stock.
//   Fix: a new "Individual Pizza Availability" section now renders all pizza
//   variant items with their own inStock toggle, below the size cards, whenever
//   the Pizza or All category is shown.
//
// Fix B — Listener error recovery:
//   When the Firestore onSnapshot listener hit an error (network drop, auth
//   expiry), it stopped firing but _unsubItems stayed non-null, so
//   initMenuManagement() thought listeners were still alive and never restarted
//   them. The error state was permanent until a full page reload.
//   Fix: error handlers now set _unsubItems / _unsubPizzaSizes = null and
//   schedule an auto-retry after 5 s. initMenuManagement() detects dropped
//   listeners (null refs) and restarts them without a loading flash.
//
// Fix C — Category stats accuracy:
//   Pizza variant items were excluded from category stats (offCount), so the
//   "N off" badge on the "All" category header was inaccurate.
//   Fix: stats now include pizza variant items.
// =====================

// AI UPDATE [2026-08-03]: Added products-collection support to the stock-toggle
// drawer (billing panel Menu tab). When the products collection is non-empty,
// items are read from products+variantsList instead of menu_items. Toggle writes
// go to the products or variants subcollection. Falls back to menu_items when
// products is empty. All rendering code is unchanged (flat items array format).
import { db, auth } from './firebase-config.js';
import {
    collection,
    onSnapshot,
    doc,
    updateDoc,
    setDoc,
    getDocs,
    getDocsFromServer,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// ── State ─────────────────────────────────────────────────────────────────────
let _allItems               = [];
let _pizzaSizes             = { regular: true, medium: true, large: true };
let _search                 = '';
let _activeCat              = 'All';
let _unsubItems             = null;
let _unsubPizzaSizes        = null;
// AI UPDATE [2026-08-03]: New-architecture state
let _usingProducts          = false;   // true when reading from products collection
let _unsubProducts          = null;    // listener for products collection
// AI UPDATE [2026-07-31]: Global Online Ordering state.
// _orderingEnabled mirrors settings/restaurant_status.onlineOrderingEnabled.
// Defaults to true so nothing breaks if the document doesn't exist yet.
let _orderingEnabled        = true;
let _unsubRestaurantStatus  = null;
let _orderingToggleSaving   = false;
let _initted                = false;
let _toggling               = new Set(); // item IDs currently saving
let _pizzaSizeSaving        = new Set(); // size keys currently saving ('regular'|'medium'|'large')

// ── Pizza helpers ─────────────────────────────────────────────────────────────
function _isPizzaVariant(item) {
    return (item.category || '').toLowerCase() === 'pizza' &&
        /\(\s*(regular|medium|large)\s*\)/i.test(item.name || '');
}

function _getPizzaSize(item) {
    if (/\(\s*regular\s*\)/i.test(item.name || '')) return 'regular';
    if (/\(\s*medium\s*\)/i.test(item.name || ''))  return 'medium';
    if (/\(\s*large\s*\)/i.test(item.name || ''))   return 'large';
    return null;
}

// ── CSS ───────────────────────────────────────────────────────────────────────
(function injectCSS() {
    if (document.getElementById('menu-mgmt-style')) return;
    const s = document.createElement('style');
    s.id = 'menu-mgmt-style';
    s.textContent = `
        /* ── Search bar ── */
        #menuMgmtSearch {
            display: block;
            width: 100%;
            padding: 10px 16px 10px 40px;
            background: rgba(255,255,255,0.07);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 10px;
            color: inherit;
            font-size: 0.95rem;
            outline: none;
            transition: border-color 0.2s;
        }
        #menuMgmtSearch:focus { border-color: #6366f1; }
        #menuMgmtSearch::placeholder { color: rgba(255,255,255,0.35); }
        .mm-search-wrap {
            position: relative;
            padding: 12px 16px 8px;
            flex-shrink: 0;
        }
        .mm-search-icon {
            position: absolute;
            left: 28px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 0.95rem;
            opacity: 0.45;
            pointer-events: none;
        }

        /* ── Category pills ── */
        .mm-cats {
            display: flex;
            gap: 8px;
            padding: 0 16px 10px;
            overflow-x: auto;
            flex-shrink: 0;
            scrollbar-width: none;
        }
        .mm-cats::-webkit-scrollbar { display: none; }
        .mm-cat-pill {
            flex-shrink: 0;
            padding: 5px 14px;
            border-radius: 20px;
            border: 1px solid rgba(255,255,255,0.15);
            background: transparent;
            color: rgba(255,255,255,0.65);
            font-size: 0.82rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.18s;
            white-space: nowrap;
        }
        .mm-cat-pill.active {
            background: #6366f1;
            border-color: #6366f1;
            color: #fff;
        }

        /* ── Items container ── */
        #menuMgmtItems {
            flex: 1;
            overflow-y: auto;
            padding: 4px 16px 24px;
        }

        /* ── Category header ── */
        .mm-cat-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 14px 0 8px;
            font-size: 0.78rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: rgba(255,255,255,0.4);
            border-bottom: 1px solid rgba(255,255,255,0.06);
            margin-bottom: 6px;
        }
        .mm-cat-header .mm-cat-stats {
            font-weight: 500;
            font-size: 0.75rem;
            color: rgba(255,255,255,0.3);
            text-transform: none;
            letter-spacing: 0;
        }

        /* ── Pizza size card ── */
        .mm-pizza-size-card {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 13px 14px;
            border-radius: 10px;
            margin-bottom: 6px;
            border: 1px solid rgba(255,255,255,0.08);
            background: rgba(245,158,11,0.06);
            transition: opacity 0.2s;
        }
        .mm-pizza-size-card.mm-off {
            opacity: 0.5;
            background: rgba(255,255,255,0.03);
        }
        .mm-pizza-size-icon {
            font-size: 1.6rem;
            flex-shrink: 0;
            width: 36px;
            text-align: center;
        }
        .mm-pizza-size-label {
            font-size: 1rem;
            font-weight: 700;
            color: #f1f5f9;
        }
        .mm-pizza-size-desc {
            font-size: 0.78rem;
            color: rgba(255,255,255,0.4);
            margin-top: 2px;
        }

        /* ── Item row ── */
        .mm-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 11px 14px;
            border-radius: 10px;
            margin-bottom: 6px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.06);
            transition: background 0.15s, opacity 0.2s;
        }
        .mm-item.mm-off {
            opacity: 0.5;
        }
        .mm-item-info { flex: 1; min-width: 0; }
        .mm-item-name {
            font-size: 0.92rem;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: #f1f5f9;
        }
        .mm-item-meta {
            font-size: 0.78rem;
            color: rgba(255,255,255,0.45);
            margin-top: 2px;
        }
        .mm-item-price {
            font-weight: 700;
            color: #34d399;
            font-size: 0.9rem;
        }
        .mm-oos-badge {
            font-size: 0.7rem;
            font-weight: 700;
            color: #ef4444;
            background: rgba(239,68,68,0.12);
            border: 1px solid rgba(239,68,68,0.25);
            border-radius: 5px;
            padding: 1px 6px;
            margin-left: 6px;
            vertical-align: middle;
        }

        /* ── Toggle switch ── */
        .mm-toggle { position: relative; width: 48px; height: 26px; flex-shrink: 0; }
        .mm-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
        .mm-slider {
            position: absolute; inset: 0;
            background: rgba(255,255,255,0.12);
            border-radius: 26px;
            cursor: pointer;
            transition: background 0.25s;
        }
        .mm-slider::before {
            content: '';
            position: absolute;
            width: 20px; height: 20px;
            background: rgba(255,255,255,0.55);
            border-radius: 50%;
            top: 3px; left: 3px;
            transition: transform 0.25s, background 0.25s;
        }
        .mm-toggle input:checked + .mm-slider { background: #10b981; }
        .mm-toggle input:checked + .mm-slider::before {
            background: #fff;
            transform: translateX(22px);
        }
        .mm-toggle.saving .mm-slider { opacity: 0.6; cursor: not-allowed; }

        /* ── Empty / loading state ── */
        .mm-empty, .mm-loading {
            text-align: center;
            padding: 40px 20px;
            color: rgba(255,255,255,0.3);
            font-size: 0.9rem;
        }
        .mm-empty-icon { font-size: 2.5rem; margin-bottom: 10px; }

        /* ── Global Online Ordering toggle banner ── */
        /* AI UPDATE [2026-07-31]: Styles for the persistent toggle that controls
           settings/restaurant_status.onlineOrderingEnabled in Firestore. */
        #mmGlobalToggleBanner {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 16px;
            margin: 10px 16px 4px;
            border-radius: 12px;
            border: 1px solid rgba(255,255,255,0.1);
            background: rgba(255,255,255,0.04);
            flex-shrink: 0;
            gap: 12px;
            transition: background 0.25s, border-color 0.25s;
        }
        #mmGlobalToggleBanner.mm-ordering-off {
            background: rgba(239,68,68,0.08);
            border-color: rgba(239,68,68,0.25);
        }
        #mmGlobalToggleBanner.mm-ordering-on {
            background: rgba(16,185,129,0.07);
            border-color: rgba(16,185,129,0.2);
        }
        .mm-gto-left {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
        }
        .mm-gto-icon {
            font-size: 1.25rem;
            flex-shrink: 0;
        }
        .mm-gto-label {
            font-size: 0.88rem;
            font-weight: 700;
            color: rgba(255,255,255,0.85);
            white-space: nowrap;
        }
        .mm-gto-status {
            font-size: 0.76rem;
            font-weight: 600;
            margin-top: 1px;
            transition: color 0.25s;
        }
        .mm-gto-status.on  { color: #10b981; }
        .mm-gto-status.off { color: #ef4444; }

        /* ── Big toggle for the global switch (larger than item toggles) ── */
        .mm-gto-toggle { position: relative; width: 54px; height: 28px; flex-shrink: 0; }
        .mm-gto-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
        .mm-gto-slider {
            position: absolute; inset: 0;
            background: rgba(255,255,255,0.12);
            border-radius: 28px;
            cursor: pointer;
            transition: background 0.25s;
        }
        .mm-gto-slider::before {
            content: '';
            position: absolute;
            width: 22px; height: 22px;
            background: rgba(255,255,255,0.55);
            border-radius: 50%;
            top: 3px; left: 3px;
            transition: transform 0.25s, background 0.25s;
        }
        .mm-gto-toggle input:checked + .mm-gto-slider { background: #10b981; }
        .mm-gto-toggle input:checked + .mm-gto-slider::before {
            background: #fff;
            transform: translateX(26px);
        }
        .mm-gto-toggle.saving .mm-gto-slider { opacity: 0.6; cursor: not-allowed; }

        /* ── Light mode overrides for global toggle ── */
        .light-mode #mmGlobalToggleBanner {
            background: rgba(0,0,0,0.04);
            border-color: rgba(0,0,0,0.1);
        }
        .light-mode #mmGlobalToggleBanner.mm-ordering-off {
            background: rgba(239,68,68,0.06);
            border-color: rgba(239,68,68,0.2);
        }
        .light-mode #mmGlobalToggleBanner.mm-ordering-on {
            background: rgba(16,185,129,0.06);
            border-color: rgba(16,185,129,0.18);
        }
        .light-mode .mm-gto-label { color: #1e293b; }
        .light-mode .mm-gto-slider { background: rgba(0,0,0,0.15); }
        .light-mode .mm-gto-slider::before { background: rgba(0,0,0,0.4); }
        .light-mode .mm-gto-toggle input:checked + .mm-gto-slider::before { background: #fff; }

        /* ── Light mode overrides ── */
        .light-mode #menuMgmtSearch {
            background: rgba(0,0,0,0.05);
            border-color: rgba(0,0,0,0.12);
            color: #1f2937;
        }
        .light-mode #menuMgmtSearch::placeholder { color: rgba(0,0,0,0.35); }
        .light-mode .mm-cat-pill {
            border-color: rgba(0,0,0,0.15);
            color: rgba(0,0,0,0.55);
        }
        .light-mode .mm-cat-pill.active { color: #fff; }
        .light-mode .mm-item {
            background: rgba(0,0,0,0.03);
            border-color: rgba(0,0,0,0.07);
        }
        .light-mode .mm-pizza-size-card {
            background: rgba(245,158,11,0.08);
            border-color: rgba(0,0,0,0.08);
        }
        .light-mode .mm-pizza-size-card.mm-off { background: rgba(0,0,0,0.03); }
        .light-mode .mm-item-name, .light-mode .mm-pizza-size-label { color: #1e293b; }
        .light-mode .mm-item-meta, .light-mode .mm-pizza-size-desc { color: rgba(0,0,0,0.45); }
        .light-mode .mm-cat-header { color: rgba(0,0,0,0.4); border-color: rgba(0,0,0,0.08); }
        .light-mode .mm-slider { background: rgba(0,0,0,0.15); }
        .light-mode .mm-slider::before { background: rgba(0,0,0,0.4); }
        .light-mode .mm-toggle input:checked + .mm-slider::before { background: #fff; }

        /* ── Product group (multi-size products in new architecture) ── */
        .mm-product-group {
            background: rgba(99,102,241,0.04);
            border: 1px solid rgba(99,102,241,0.15);
            border-radius: 10px;
            margin-bottom: 8px;
            overflow: hidden;
        }
        .mm-product-group-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 9px 14px;
            background: rgba(99,102,241,0.06);
            border-bottom: 1px solid rgba(99,102,241,0.12);
        }
        .mm-product-group-name {
            font-size: 0.88rem;
            font-weight: 700;
            color: #a5b4fc;
        }
        /* Variant rows inside a product group — slightly indented */
        .mm-variant-row {
            border-radius: 0;
            margin-bottom: 0;
            border: none;
            border-bottom: 1px solid rgba(255,255,255,0.04);
            background: transparent;
            padding-left: 20px;
        }
        .mm-variant-row:last-child { border-bottom: none; }
        .light-mode .mm-product-group {
            background: rgba(99,102,241,0.03);
            border-color: rgba(99,102,241,0.18);
        }
        .light-mode .mm-product-group-header { background: rgba(99,102,241,0.05); border-color: rgba(99,102,241,0.14); }
        .light-mode .mm-product-group-name { color: #4f46e5; }
        .light-mode .mm-variant-row { border-bottom-color: rgba(0,0,0,0.05); }
    `;
    document.head.appendChild(s);
})();

// ── Public API ────────────────────────────────────────────────────────────────

export function initMenuManagement() {
    if (!_initted) {
        // First call — set up search bar and start all listeners.
        _initted = true;
        _setupSearch();
        _renderGlobalToggle();
        _showLoading();
        _startItemsListener();   // detects architecture and starts correct listener
        _startPizzaSizesListener();
        _startRestaurantStatusListener();
    } else if (!_unsubItems && !_unsubProducts || !_unsubPizzaSizes || !_unsubRestaurantStatus) {
        // AI UPDATE [2026-08-03]: check both _unsubItems (legacy) and _unsubProducts (new)
        if (!_unsubItems && !_unsubProducts) {
            if (_allItems.length === 0) _showLoading();
            _startItemsListener();
        }
        if (!_unsubPizzaSizes) {
            _startPizzaSizesListener();
        }
        if (!_unsubRestaurantStatus) {
            _startRestaurantStatusListener();
        }
    } else {
        // Listeners are alive — just re-render with current data.
        _render();
    }
}

export function destroyMenuManagement() {
    if (_unsubItems)             { _unsubItems();             _unsubItems             = null; }
    if (_unsubPizzaSizes)        { _unsubPizzaSizes();        _unsubPizzaSizes        = null; }
    if (_unsubRestaurantStatus)  { _unsubRestaurantStatus();  _unsubRestaurantStatus  = null; }
    // AI UPDATE [2026-08-03]: clean up products listener
    if (_unsubProducts)          { _unsubProducts();          _unsubProducts          = null; }
    _initted              = false;
    _usingProducts        = false;
    _allItems             = [];
    _pizzaSizes           = { regular: true, medium: true, large: true };
    _orderingEnabled      = true;
    _orderingToggleSaving = false;
    _search               = '';
    _activeCat            = 'All';
    _toggling.clear();
    _pizzaSizeSaving.clear();
}

// ── Global Online Ordering listener ───────────────────────────────────────────
//
// AI UPDATE [2026-07-31]: Listens to settings/restaurant_status for the global
// onlineOrderingEnabled flag. When the document does not exist, defaults to true
// (backward compatible). Calls _renderGlobalToggle() on every change so the
// toggle UI stays in sync with Firestore in real time.
//
// This listener starts on the first initMenuManagement() call and is torn down
// by destroyMenuManagement(). If the listener errors it marks itself null and
// auto-retries after 5 s, matching the pattern used by _startItemsListener().

function _startRestaurantStatusListener() {
    if (_unsubRestaurantStatus) { _unsubRestaurantStatus(); _unsubRestaurantStatus = null; }
    _unsubRestaurantStatus = onSnapshot(
        doc(db, 'settings', 'restaurant_status'),
        (snap) => {
            _orderingEnabled = snap.exists()
                ? (snap.data().onlineOrderingEnabled !== false)
                : true; // default ON when document absent
            _renderGlobalToggle();
        },
        (err) => {
            console.error('[menu-mgmt] restaurant_status listener error:', err);
            _unsubRestaurantStatus = null;
            setTimeout(() => {
                if (!_unsubRestaurantStatus && _initted) _startRestaurantStatusListener();
            }, 5000);
        }
    );
}

// ── Global toggle write ───────────────────────────────────────────────────────
//
// AI UPDATE [2026-07-31]: Writes the new onlineOrderingEnabled value to
// settings/restaurant_status using setDoc with merge:true so the document is
// created on first use without overwriting any other fields that may exist.
// The same auth guard as _toggle() is used — writes require a signed-in user.
// Optimistic UI: flips _orderingEnabled immediately and re-renders; rolls back
// on error so the toggle snaps back and an error toast is shown.

async function _toggleOnlineOrdering() {
    if (_orderingToggleSaving) return;

    if (!auth.currentUser) {
        const user = await _waitForAuth(5000);
        if (!user) {
            _showToastError('Could not sign in. Please reload the page and try again.');
            return;
        }
    }

    const wasOn = _orderingEnabled;
    _orderingEnabled      = !wasOn;
    _orderingToggleSaving = true;
    _renderGlobalToggle();

    try {
        await setDoc(
            doc(db, 'settings', 'restaurant_status'),
            { onlineOrderingEnabled: !wasOn },
            { merge: true }
        );
        console.log(`[menu-mgmt] Online ordering set to ${!wasOn ? 'ON' : 'OFF'}`);
    } catch (e) {
        console.error('[menu-mgmt] Global ordering toggle failed:', e);
        _orderingEnabled = wasOn; // roll back
        _showToastError('Could not update Online Ordering status. Please try again.');
    } finally {
        _orderingToggleSaving = false;
        _renderGlobalToggle();
    }
}

// ── Global toggle render ──────────────────────────────────────────────────────
//
// AI UPDATE [2026-07-31]: Renders the Global Online Ordering toggle banner into
// #menuMgmtGlobalToggle (added to index.html). This element is above the search
// bar and category pills — it is always visible in the Menu tab regardless of
// the active category or search term. The toggle is wired on every render call
// because innerHTML replacement removes previous event listeners.

function _renderGlobalToggle() {
    const el = document.getElementById('menuMgmtGlobalToggle');
    if (!el) return;

    const isOn    = _orderingEnabled;
    const saving  = _orderingToggleSaving;
    const stateClass  = isOn ? 'mm-ordering-on' : 'mm-ordering-off';
    const statusClass = isOn ? 'on' : 'off';
    const statusText  = isOn ? 'ON — Accepting online orders' : 'OFF — Orders paused on Customer Panel';
    const icon        = isOn ? '🟢' : '🔴';

    el.innerHTML = `
        <div id="mmGlobalToggleBanner" class="${stateClass}">
            <div class="mm-gto-left">
                <span class="mm-gto-icon">${icon}</span>
                <div>
                    <div class="mm-gto-label">Online Ordering</div>
                    <div class="mm-gto-status ${statusClass}">${statusText}</div>
                </div>
            </div>
            <label class="mm-gto-toggle ${saving ? 'saving' : ''}"
                   title="${isOn ? 'Turn OFF — customers will see an offline screen' : 'Turn ON — resume accepting online orders'}">
                <input type="checkbox" ${isOn ? 'checked' : ''} id="mmGlobalOrderingChk" ${saving ? 'disabled' : ''}>
                <span class="mm-gto-slider"></span>
            </label>
        </div>
    `;

    const chk = el.querySelector('#mmGlobalOrderingChk');
    if (chk) chk.addEventListener('change', _toggleOnlineOrdering);
}

// ── Firestore listeners ───────────────────────────────────────────────────────

// AI UPDATE [2026-08-03]: _startItemsListener now tries the products collection
// first. If products is non-empty, items are read from products + variantsList
// (denormalized); if products is empty, falls back to menu_items.
//
// AI FIX [2026-08-08]: Switched the one-shot architecture check from getDocs()
// to getDocsFromServer(). With offline persistence enabled (firebase-config.js),
// plain getDocs() could resolve from the still-empty local IndexedDB cache
// before the network round-trip landed, wrongly reporting "products is empty"
// on a fresh load and permanently falling back to the (now-unused) menu_items
// collection — making the Menu tab appear empty even though items exist in
// products. getDocsFromServer forces a real network read, matching the pattern
// already used successfully in js/menu.js.
function _startItemsListener() {
    if (_unsubItems) { _unsubItems(); _unsubItems = null; }
    if (_unsubProducts) { _unsubProducts(); _unsubProducts = null; }

    // Try products collection first (one-shot check, forced server read)
    getDocsFromServer(collection(db, 'products')).then((prodSnap) => {
        if (!prodSnap.empty) {
            // New architecture — listen to products
            _usingProducts = true;
            _startProductsListener();
        } else {
            // Legacy architecture — listen to menu_items
            _usingProducts = false;
            _startMenuItemsListener();
        }
    }).catch(() => {
        // On error, fall back to menu_items
        _usingProducts = false;
        _startMenuItemsListener();
    });
}

// New architecture listener: reads from products collection
function _startProductsListener() {
    if (_unsubProducts) { _unsubProducts(); _unsubProducts = null; }
    _unsubProducts = onSnapshot(
        collection(db, 'products'),
        (snap) => {
            const flat = [];
            snap.docs.forEach(d => {
                const prod = { id: d.id, ...d.data() };
                if (prod.hasVariants && prod.variantsList && prod.variantsList.length > 0) {
                    prod.variantsList.forEach(v => {
                        flat.push({
                            id:           v.id,
                            // AI UPDATE [2026-08-05]: When variant name is empty, use only the product
                            // name to avoid "Munch Chocolate ()" as the menu-management row label.
                            name:         v.name ? `${prod.name} (${v.name})` : prod.name,
                            price:        v.price || 0,
                            category:     prod.categoryName || prod.category || 'Other',
                            inStock:      v.inStock !== false && prod.inStock !== false,
                            imageUrl:     v.imageUrl || prod.imageUrl || null,
                            _type:        'variant',
                            _productId:   prod.id,
                            _productName: prod.name,
                            _variantName: v.name,
                        });
                    });
                } else {
                    flat.push({
                        id:       prod.id,
                        name:     prod.name,
                        price:    prod.price || 0,
                        category: prod.categoryName || prod.category || 'Other',
                        inStock:  prod.inStock !== false,
                        imageUrl: prod.imageUrl || null,
                        _type:    'product',
                    });
                }
            });
            _allItems = flat.sort((a, b) => {
                const ca = (a.category || 'Other').toLowerCase();
                const cb = (b.category || 'Other').toLowerCase();
                if (ca !== cb) return ca < cb ? -1 : 1;
                return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1;
            });
            _render();
        },
        (err) => {
            console.error('[menu-mgmt] products listener error:', err);
            _unsubProducts = null;
            const el = document.getElementById('menuMgmtItems');
            if (el) el.innerHTML = `<div class="mm-empty"><div class="mm-empty-icon">⚠️</div><div>Failed to load menu. Retrying…</div></div>`;
            setTimeout(() => { if (!_unsubProducts && _initted) _startProductsListener(); }, 5000);
        }
    );
}

// Legacy architecture listener: reads from menu_items
function _startMenuItemsListener() {
    if (_unsubItems) { _unsubItems(); _unsubItems = null; }
    _unsubItems = onSnapshot(
        collection(db, 'menu_items'),
        (snap) => {
            _allItems = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => {
                    const ca = (a.category || 'Other').toLowerCase();
                    const cb = (b.category || 'Other').toLowerCase();
                    if (ca !== cb) return ca < cb ? -1 : 1;
                    return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1;
                });
            _render();
        },
        (err) => {
            console.error('[menu-mgmt] items listener error:', err);
            _unsubItems = null;
            const el = document.getElementById('menuMgmtItems');
            if (el) el.innerHTML = `<div class="mm-empty"><div class="mm-empty-icon">⚠️</div><div>Failed to load menu. Retrying…</div></div>`;
            setTimeout(() => { if (!_unsubItems && _initted) _startMenuItemsListener(); }, 5000);
        }
    );
}

function _startPizzaSizesListener() {
    if (_unsubPizzaSizes) { _unsubPizzaSizes(); _unsubPizzaSizes = null; }
    _unsubPizzaSizes = onSnapshot(
        doc(db, 'settings', 'pizza_sizes'),
        (snap) => {
            _pizzaSizes = snap.exists()
                ? { regular: true, medium: true, large: true, ...snap.data() }
                : { regular: true, medium: true, large: true };
            _render();
        },
        (err) => {
            console.error('[menu-mgmt] pizza sizes listener error:', err);
            // Mark as dropped — initMenuManagement() will restart on next open.
            _unsubPizzaSizes = null;
            // Auto-retry after 5 s.
            setTimeout(() => {
                if (!_unsubPizzaSizes && _initted) _startPizzaSizesListener();
            }, 5000);
        }
    );
}

// ── Auth helper ───────────────────────────────────────────────────────────────

// Wait up to `timeoutMs` for auth.currentUser to become non-null.
// Returns the user object if auth resolves in time, or null on timeout.
// Needed because menu_items load from IndexedDB (no auth required for reads)
// so the toggle UI appears before signInAnonymously() may have completed.
function _waitForAuth(timeoutMs = 5000) {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise(resolve => {
        const unsub = onAuthStateChanged(auth, (user) => {
            if (user) { unsub(); resolve(user); }
        });
        setTimeout(() => { unsub(); resolve(null); }, timeoutMs);
    });
}

// ── Toggles ───────────────────────────────────────────────────────────────────

async function _toggle(id) {
    if (_toggling.has(id)) return;
    const item = _allItems.find(i => i.id === id);
    if (!item) return;

    if (!auth.currentUser) {
        const user = await _waitForAuth(5000);
        if (!user) {
            _showToastError('Could not sign in. Please reload the page and try again.');
            return;
        }
    }

    const wasOn = item.inStock !== false;
    item.inStock = !wasOn;
    _toggling.add(id);
    _render();

    try {
        // AI UPDATE [2026-08-03]: Route toggle to correct collection based on architecture.
        if (_usingProducts && item._type === 'variant' && item._productId) {
            // Toggle variant inStock in the variants subcollection
            await updateDoc(doc(db, 'products', item._productId, 'variants', id), { inStock: !wasOn });
            // Also update the denormalized variantsList on the product document
            // so billing panel reads get the updated inStock immediately
            const prodItems = _allItems.filter(i => i._type === 'variant' && i._productId === item._productId);
            const updatedList = prodItems.map(v => ({
                id: v.id, name: (v._variantName || v.name), price: v.price || 0,
                imageUrl: v.imageUrl || null, active: v.active !== false,
                inStock: v.id === id ? !wasOn : v.inStock !== false,
                displayOrder: v.displayOrder || 0
            }));
            updateDoc(doc(db, 'products', item._productId), { variantsList: updatedList }).catch(() => {});
        } else if (_usingProducts && item._type === 'product') {
            await updateDoc(doc(db, 'products', id), { inStock: !wasOn });
        } else {
            // Legacy: toggle on menu_items
            await updateDoc(doc(db, 'menu_items', id), { inStock: !wasOn });
        }
    } catch (e) {
        console.error('[menu-mgmt] item toggle failed:', e);
        item.inStock = wasOn;
        _render();
        _showToastError(`Could not update "${item.name}". Please try again.`);
    } finally {
        _toggling.delete(id);
    }
}

async function _togglePizzaSize(size) {
    if (_pizzaSizeSaving.has(size)) return;

    // Same auth guard as _toggle() — writes need a signed-in anonymous operator.
    if (!auth.currentUser) {
        const user = await _waitForAuth(5000);
        if (!user) {
            _showToastError('Could not sign in. Please reload the page and try again.');
            return;
        }
    }

    const wasOn = _pizzaSizes[size] !== false;
    _pizzaSizes[size] = !wasOn;
    _pizzaSizeSaving.add(size);
    _render();

    try {
        // setDoc with merge so the doc is created if it doesn't exist yet
        await setDoc(doc(db, 'settings', 'pizza_sizes'), { [size]: !wasOn }, { merge: true });
    } catch (e) {
        console.error('[menu-mgmt] pizza size toggle failed:', e);
        _pizzaSizes[size] = wasOn;
        _render();
        _showToastError(`Could not update ${size} size. Please try again.`);
    } finally {
        _pizzaSizeSaving.delete(size);
    }
}

// ── Render ────────────────────────────────────────────────────────────────────

function _render() {
    const catContainer  = document.getElementById('menuMgmtCats');
    const itemContainer = document.getElementById('menuMgmtItems');
    if (!itemContainer) return;

    _renderCategoryPills(catContainer);

    const scrollTop        = itemContainer.scrollTop;
    const showPizza        = (_activeCat === 'All' || _activeCat === 'Pizza');
    const showOthers       = (_activeCat !== 'Pizza');
    const filteredNonPizza = showOthers ? _getFilteredNonPizza() : [];
    const pizzaVariants    = showPizza  ? _getPizzaVariants()    : [];

    let html = '';

    if (showPizza) {
        // Size-level toggles (whole size on/off)
        html += _buildPizzaSizesHtml();
        // Individual pizza variant toggles — lets operator mark a specific
        // pizza (e.g. "Paneer Pizza (Large)") OOS independently of the size.
        if (pizzaVariants.length > 0) {
            html += _buildPizzaVariantsHtml(pizzaVariants);
        }
    }

    if (showOthers && filteredNonPizza.length > 0) {
        html += _buildItemsHtml(filteredNonPizza);
    }

    if (!html) {
        html = `<div class="mm-empty">
            <div class="mm-empty-icon">${_search ? '🔍' : '🍽️'}</div>
            <div>${_search ? `No items match "${_search}"` : 'No items in this category.'}</div>
        </div>`;
    }

    itemContainer.innerHTML = html;

    // Wire pizza size toggle events
    itemContainer.querySelectorAll('input[data-size]').forEach(cb => {
        cb.addEventListener('change', () => _togglePizzaSize(cb.dataset.size));
    });
    // Wire item toggle events (covers both non-pizza items AND pizza variants)
    itemContainer.querySelectorAll('input[data-id]').forEach(cb => {
        cb.addEventListener('change', () => _toggle(cb.dataset.id));
    });

    itemContainer.scrollTop = scrollTop;
}

function _getFilteredNonPizza() {
    return _allItems.filter(item => {
        if (_isPizzaVariant(item)) return false; // pizza variants shown in their own section
        const matchSearch = !_search || (item.name || '').toLowerCase().includes(_search);
        const matchCat    = _activeCat === 'All' || item.category === _activeCat;
        return matchSearch && matchCat;
    });
}

// Returns all pizza variant items that match the current search term.
// These are shown with individual inStock toggles in the Pizza section so
// the operator can mark a specific variant (e.g. "Paneer Pizza (Large)")
// as out of stock independently of the whole-size toggle.
function _getPizzaVariants() {
    return _allItems.filter(item => {
        if (!_isPizzaVariant(item)) return false;
        return !_search || (item.name || '').toLowerCase().includes(_search);
    });
}

// ── Pizza variants section builder ───────────────────────────────────────────

// Renders individual pizza variant items (e.g. "Paneer Pizza (Large)") with
// their own inStock toggle, below the size-level toggles.
// This lets the operator mark a specific pizza OOS while keeping the size
// available for all other pizzas.
//
// Customer Panel behaviour (no change needed there):
//   _isItemOos() in the Customer Panel's menu.js already checks BOTH:
//     1. item.inStock === false  ← set by this individual toggle
//     2. _pizzaSizes[size] === false  ← set by the size toggle above
//   So the customer panel treats a pizza as OOS if EITHER condition is true.
function _buildPizzaVariantsHtml(variants) {
    const _esc = (s = '') => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const offCount = variants.filter(i => i.inStock === false).length;
    const stats    = offCount > 0
        ? `${variants.length} variants · <span style="color:#ef4444;">${offCount} off</span>`
        : `${variants.length} variants`;

    const rows = variants.map(item => {
        const isOn     = item.inStock !== false;
        const isSaving = _toggling.has(item.id);
        return `
            <div class="mm-item ${isOn ? '' : 'mm-off'}">
                <div class="mm-item-info">
                    <div class="mm-item-name">
                        ${_esc(item.name)}
                        ${!isOn ? '<span class="mm-oos-badge">OFF</span>' : ''}
                    </div>
                    <div class="mm-item-meta mm-item-price">₹${item.price || 0}</div>
                </div>
                <label class="mm-toggle ${isSaving ? 'saving' : ''}"
                       title="${isOn ? 'Turn off (out of stock)' : 'Turn on (available)'}">
                    <input type="checkbox" ${isOn ? 'checked' : ''} data-id="${_esc(item.id)}" ${isSaving ? 'disabled' : ''}>
                    <span class="mm-slider"></span>
                </label>
            </div>
        `;
    }).join('');

    return `
        <div class="mm-cat-header" style="margin-top:6px;">
            <span>🍕 Individual Pizza Availability</span>
            <span class="mm-cat-stats">${stats}</span>
        </div>
        ${rows}
    `;
}

// ── Pizza sizes section builder ───────────────────────────────────────────────

function _buildPizzaSizesHtml() {
    const SIZE_META = [
        { key: 'regular', icon: '🍕', label: 'Regular',  desc: 'All Regular-size pizzas' },
        { key: 'medium',  icon: '🍕', label: 'Medium',   desc: 'All Medium-size pizzas'  },
        { key: 'large',   icon: '🍕', label: 'Large',    desc: 'All Large-size pizzas'   },
    ];

    const offCount = SIZE_META.filter(s => _pizzaSizes[s.key] === false).length;
    const stats    = offCount > 0
        ? `3 sizes · <span style="color:#ef4444;">${offCount} off</span>`
        : '3 sizes';

    const rows = SIZE_META.map(({ key, icon, label, desc }) => {
        const isOn     = _pizzaSizes[key] !== false;
        const isSaving = _pizzaSizeSaving.has(key);
        return `
            <div class="mm-pizza-size-card ${isOn ? '' : 'mm-off'}">
                <div class="mm-pizza-size-icon">${icon}</div>
                <div class="mm-item-info">
                    <div class="mm-pizza-size-label">
                        ${label}
                        ${!isOn ? '<span class="mm-oos-badge">OFF</span>' : ''}
                    </div>
                    <div class="mm-pizza-size-desc">${desc}</div>
                </div>
                <label class="mm-toggle ${isSaving ? 'saving' : ''}"
                       title="${isOn ? 'Turn off — marks all ' + label + ' pizzas out of stock' : 'Turn on — makes all ' + label + ' pizzas available'}">
                    <input type="checkbox" ${isOn ? 'checked' : ''} data-size="${key}" ${isSaving ? 'disabled' : ''}>
                    <span class="mm-slider"></span>
                </label>
            </div>
        `;
    }).join('');

    return `
        <div class="mm-cat-header">
            <span>🍕 Pizza Sizes</span>
            <span class="mm-cat-stats">${stats}</span>
        </div>
        ${rows}
    `;
}

// ── Non-pizza items section builder ──────────────────────────────────────────

function _buildItemsHtml(items) {
    const _esc = (s = '') => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Group by category
    const groups = {};
    items.forEach(item => {
        const cat = item.category || 'Other';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(item);
    });

    return Object.entries(groups).map(([cat, catItems]) => {
        const offCount  = catItems.filter(i => i.inStock === false).length;
        const statsText = offCount > 0
            ? `${catItems.length} items · <span style="color:#ef4444;">${offCount} off</span>`
            : `${catItems.length} items`;

        // ── Sub-group variant items by _productId (new products architecture) ──
        // Items with _type==='variant' and _productId are shown as ONE expandable
        // product entry with variant sub-rows (e.g. Frooti → 125ml / 250ml / 600ml).
        // Items without _productId (legacy menu_items or single-product entries)
        // are shown as individual toggle rows.
        const processedProductIds = new Set();
        const renderEntries = [];

        catItems.forEach(item => {
            if (item._type === 'variant' && item._productId) {
                if (processedProductIds.has(item._productId)) return;
                processedProductIds.add(item._productId);
                const variants = catItems.filter(i => i._productId === item._productId);
                renderEntries.push({ _isGroup: true, productName: item._productName || item.name.replace(/\s*\([^)]*\)\s*$/, '').trim(), variants });
            } else {
                renderEntries.push(item);
            }
        });

        const rows = renderEntries.map(entry => {
            if (entry._isGroup) {
                // ── Product group with variant sub-rows ──
                const offV    = entry.variants.filter(v => v.inStock === false).length;
                const groupStats = offV > 0
                    ? `${entry.variants.length} sizes · <span style="color:#ef4444;">${offV} off</span>`
                    : `${entry.variants.length} sizes`;
                const variantRows = entry.variants.map(v => {
                    const isOn     = v.inStock !== false;
                    const isSaving = _toggling.has(v.id);
                    return `
                        <div class="mm-item mm-variant-row ${isOn ? '' : 'mm-off'}">
                            <div class="mm-item-info">
                                <div class="mm-item-name">
                                    ${v._variantName ? _esc(v._variantName) : ''}
                                    ${!isOn ? '<span class="mm-oos-badge">OFF</span>' : ''}
                                </div>
                                <div class="mm-item-meta mm-item-price">₹${v.price || 0}</div>
                            </div>
                            <label class="mm-toggle ${isSaving ? 'saving' : ''}"
                                   title="${isOn ? 'Turn off (out of stock)' : 'Turn on (available)'}">
                                <input type="checkbox" ${isOn ? 'checked' : ''} data-id="${_esc(v.id)}" ${isSaving ? 'disabled' : ''}>
                                <span class="mm-slider"></span>
                            </label>
                        </div>
                    `;
                }).join('');
                return `
                    <div class="mm-product-group">
                        <div class="mm-product-group-header">
                            <span class="mm-product-group-name">${_esc(entry.productName)}</span>
                            <span class="mm-cat-stats">${groupStats}</span>
                        </div>
                        ${variantRows}
                    </div>
                `;
            }
            // ── Single item row (legacy or no-variant product) ──
            const isOn     = entry.inStock !== false;
            const isSaving = _toggling.has(entry.id);
            return `
                <div class="mm-item ${isOn ? '' : 'mm-off'}">
                    <div class="mm-item-info">
                        <div class="mm-item-name">
                            ${_esc(entry.name)}
                            ${!isOn ? '<span class="mm-oos-badge">OFF</span>' : ''}
                        </div>
                        <div class="mm-item-meta mm-item-price">₹${entry.price || 0}</div>
                    </div>
                    <label class="mm-toggle ${isSaving ? 'saving' : ''}"
                           title="${isOn ? 'Turn off (out of stock)' : 'Turn on (available)'}">
                        <input type="checkbox" ${isOn ? 'checked' : ''} data-id="${_esc(entry.id)}" ${isSaving ? 'disabled' : ''}>
                        <span class="mm-slider"></span>
                    </label>
                </div>
            `;
        }).join('');

        return `
            <div class="mm-cat-header">
                <span>${cat}</span>
                <span class="mm-cat-stats">${statsText}</span>
            </div>
            ${rows}
        `;
    }).join('');
}

// ── Category pills ────────────────────────────────────────────────────────────

function _renderCategoryPills(el) {
    if (!el) return;
    // Include 'Pizza' as a category pill (shows the 3-size section)
    const cats = ['All', ...[...new Set(_allItems.map(i => i.category || 'Other'))].sort()];
    el.innerHTML = cats.map(cat => `
        <button class="mm-cat-pill ${cat === _activeCat ? 'active' : ''}" data-cat="${cat}">
            ${cat}
        </button>
    `).join('');
    el.querySelectorAll('.mm-cat-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            _activeCat = btn.dataset.cat;
            _render();
        });
    });
}

// ── Search setup ──────────────────────────────────────────────────────────────

function _setupSearch() {
    const input = document.getElementById('menuMgmtSearch');
    if (!input) return;
    input.addEventListener('input', (e) => {
        _search = e.target.value.toLowerCase().trim();
        _render();
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _showLoading() {
    const el = document.getElementById('menuMgmtItems');
    if (el) el.innerHTML = `<div class="mm-loading">Loading menu items…</div>`;
}

function _showToastError(msg) {
    const t = document.createElement('div');
    t.style.cssText = `
        position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
        background:#ef4444; color:#fff; border-radius:10px;
        padding:10px 20px; font-size:0.88rem; font-weight:600;
        z-index:99999; white-space:nowrap; box-shadow:0 4px 20px rgba(0,0,0,0.3);
    `;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
}
