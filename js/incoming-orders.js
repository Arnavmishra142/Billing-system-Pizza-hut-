// incoming-orders.js
// Listens to Firestore `pending_table_orders` for new customer orders.
// Shows badge on #btn-orders and a toast notification.
// New orders are reported to the backend via POST /api/notify-order,
// which forwards a Pushover push notification to the operator's phone.

// ===== AI UPDATE =====
// Date: 2026-07-30
// Feature: Complete emergency Pushover acknowledgement workflow.
//
// Problem: Emergency Pushover notifications (priority=2) re-notify every 30 s
//   indefinitely (up to expire=3600 s) unless explicitly cancelled via the
//   Pushover receipts/cancel API. There was no way for the operator to stop the
//   emergency alerts once an order arrived.
//
// Implementation:
//   1. notifyNewOrder() now returns the receipt string from the server response.
//   2. Per-order receipt storage: _activeReceipts (Map: orderId → receipt).
//      Multiple simultaneous orders each track their own receipt independently.
//   3. In the Firestore snapshot callback, after notifyNewOrder() resolves, the
//      receipt is stored and renderDrawer() is called to show the Acknowledge button.
//   4. renderDrawer() shows a prominent "🔕 Acknowledge Order" button on each card
//      that has an active receipt stored in _activeReceipts.
//   5. acknowledgeOrder(orderId): calls POST /api/cancel-receipt on the Express
//      server (which proxies to Pushover's cancel API, keeping the token
//      server-side), clears the receipt from _activeReceipts, and re-renders.
//   6. _cancellingReceipts (Set) prevents duplicate cancel requests if the operator
//      clicks "Acknowledge Order" multiple times before the first request resolves.
//   7. Orphan cleanup: on every snapshot, receipts for orders no longer in the
//      pending list are deleted (order was accepted/dismissed before acknowledged).
//
// All important steps are logged with [incoming-orders] prefix.
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-29 (v11)
// Bug fix: Pushover notifications unreliable — root cause was client/server clock drift.
//
// Root cause (v9 timestamp guard had a fatal flaw):
//   v9 replaced _initialLoadDone with a timestamp comparison:
//     isGenuinelyNew = createdAtMs > (_sessionStartedAt - 10_000)
//   where _sessionStartedAt = Date.now() (CLIENT clock) and
//         createdAtMs = order.createdAt.toMillis() (FIRESTORE SERVER clock).
//   If the client clock is more than 10 seconds AHEAD of the Firestore server
//   clock (common on mobile, after sleep, or when NTP hasn't synced recently):
//     - Client: Date.now() = T_server + 15000
//     - New order createdAt = T_server + 30  (30 ms after order was placed)
//     - Check: T_server + 30 > T_server + 15000 - 10000 = T_server + 5000  → FALSE
//     → New order SILENCED even though it is genuinely new
//   Worse: the order ID is added to _notified BEFORE the timestamp check, so
//   it is permanently deduplicated and will never be notified in this session.
//   Result: ALL notifications silently fail whenever client clock drifts > 10 s.
//
// Fix (v11) — clock-independent guard:
//   1. Restore _initialLoadDone as the primary notification guard, but fix the
//      original fragility: DO NOT reset _initialLoadDone = false in startListening().
//      _initialLoadDone starts false (page load), becomes true after the first
//      snapshot, and STAYS true for all subsequent listener restarts.
//      Why this works on listener restart:
//        - Pre-existing orders: already in _notified (added in previous snapshot)
//          → DEDUP skip, never re-notified.
//        - New orders placed during restart window: NOT in _notified,
//          _initialLoadDone = true → NOTIFY correctly.
//   2. Remove _sessionStartedAt and the timestamp comparison entirely.
//   3. Keep _notified un-cleared across restarts (v9 rule, still correct).
//
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-28 (v9)
// Bug fix: Only first Pushover notification fired — subsequent orders silenced.
// (Superseded by v11 for the notification guard; other v9 changes preserved.)
//
//   3. acceptedOrderIds_<table> localStorage key added to the "Open in POS"
//      handler to track which specific orders were imported.  syncCustomerOrder
//      Completion() uses this key to mark ONLY those orders as 'completed',
//      leaving other pending cards for the same table untouched.
//      (Issue 2 fix — see also js/cart.js)
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-28 (v6)
// Feature: Pushover push notification via backend — replaces browser audio/notification
// Summary:
// - Removed import of order-notify.js (triggerAlert / stopAlert).
// - Removed all browser Notification API, audio looping, and autoplay-unlock logic.
// - Added notifyNewOrder(data) — calls POST /api/notify-order on the Express
//   server, which proxies to the Pushover API. Fire-and-forget; failures are
//   logged but never disrupt the order flow.
// - _initialLoadDone flag retained: existing orders on page load are silenced;
//   only genuinely new orders trigger Pushover.
// - stopAlert() calls removed from "Open in POS" and "Dismiss" handlers.
// - 'orders-open-drawer' event listener removed (was for browser notification clicks).
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-28
// Feature: Incoming Orders Listener — Auth Race Fix
// Summary:
// - Listener previously started immediately on DOMContentLoaded, before the
//   admin had entered their PIN and before signInAnonymously() completed.
// - Firestore returned permission-denied (isOperator() needs request.auth != null).
// - Fix: imported auth + onAuthStateChanged; startListening() is now triggered
//   by the first non-null auth state rather than by DOMContentLoaded directly.
// - visibilitychange path unchanged — still restarts listener on tab focus.
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-28 (v2)
// Feature: Incoming Orders Listener — Auth Bootstrap Fix
// Summary:
// - Root cause identified: index.html never calls signInAnonymously.
//   admin.js (which calls signInAnonymously) is only loaded by admin/index.html,
//   NOT by index.html (the main billing panel).
// - Because no one ever called signInAnonymously on index.html, auth.currentUser
//   was always null, so onAuthStateChanged only ever fired with null, and
//   startListening() was never invoked.
// - Fix: this module now imports signInAnonymously and calls it immediately at
//   module top-level (outside DOMContentLoaded) so auth is bootstrapped as soon
//   as the billing panel loads.
// - onAuthStateChanged registration is also moved to module top-level so it is
//   registered as early as possible and cannot miss the initial auth state.
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-28 (v3)
// Feature: Incoming Orders — Two performance / delay fixes
// Summary:
//
// Fix A — visibilitychange was cancelling and recreating the listener:
//   The handler called enableNetwork(db).then(startListening), which always
//   unsubscribed the existing listener and created a new one.  A new onSnapshot
//   with persistentLocalCache first emits the stale IndexedDB cache, then the
//   fresh network result — introducing a perceived delay on every tab focus.
//   Fix: visibilitychange now only calls enableNetwork() to re-open the network
//   channel and only calls startListening() if the listener was actually null
//   (dropped by an error or sign-out).  An already-live listener is left in
//   place and automatically resumes receiving real-time updates.
//
// Fix B — getCustomerOrderCount ran an uncached getDocs on every render:
//   renderDrawer() calls getCustomerOrderCount(phone) for every pending order.
//   With three orders in the drawer that was three extra Firestore round-trips
//   on every snapshot fire, blocking the card HTML from appearing.
//   Fix: results are stored in _countCache (Map keyed by phone number).
//   The cache is cleared whenever startListening() recreates the snapshot so
//   counts stay accurate across reconnects.
// =====================

import { db, auth } from './firebase-config.js';
import {
    collection,
    onSnapshot,
    query,
    orderBy,
    where,
    getDocs,
    doc,
    updateDoc,
    enableNetwork
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// ── Order-count cache: keyed by phone number ──────────────────────────────────
// getCustomerOrderCount is called for every order on every renderDrawer() call.
// Without caching that is N Firestore getDocs round-trips per render, which
// blocks card HTML from painting.  Cache is cleared in startListening() so
// counts stay accurate across reconnects and listener restarts.
const _countCache = new Map();

// ── Fix 3: Count how many times a phone number has ordered ───────────────────
async function getCustomerOrderCount(phone) {
    if (!phone) return 1;
    if (_countCache.has(phone)) return _countCache.get(phone);
    try {
        const q     = query(collection(db, 'pending_table_orders'), where('customer.phone', '==', phone));
        const snap  = await getDocs(q);
        const count = Math.max(1, snap.size);
        _countCache.set(phone, count);
        return count;
    } catch(e) { return 1; }
}

function toOrdinal(n) {
    const s = ['th','st','nd','rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnOrders   = document.getElementById('btn-orders');
const badge       = document.getElementById('orders-badge');
const drawer      = document.getElementById('ordersDrawer');
const overlay     = document.getElementById('ordersOverlay');
const drawerList  = document.getElementById('ordersDrawerList');

// Track order IDs we've already notified about so we don't re-toast on re-render.
// Never cleared on listener restart (v9 fix) — persists for the page lifetime to
// prevent re-notification of orders already processed this session.
const _notified = new Set();

// AI UPDATE [2026-07-30] — Per-order emergency receipt tracking.
// _activeReceipts: Map from Firestore order doc ID → Pushover receipt string.
//   Each order that triggers an emergency notification gets its own entry so that
//   multiple simultaneous orders can be acknowledged independently.
//   Entries are removed on successful cancel or when the order leaves the pending list.
// _cancellingReceipts: Set of order IDs currently being cancelled (in-flight guard).
//   Prevents duplicate POST /api/cancel-receipt calls if the operator clicks the
//   Acknowledge button more than once before the first request resolves.
const _activeReceipts     = new Map();   // orderId → receipt string
const _cancellingReceipts = new Set();   // orderId → cancel in progress

// AI UPDATE [2026-07-29] v11: _initialLoadDone is the primary (and only)
// notification guard.  Starts false on page load.  Set to true after the first
// snapshot is processed.  NEVER reset to false again — not even on listener
// restarts.  See v11 AI UPDATE at the top of this file for the full explanation.
let _initialLoadDone = false;

// ── Pushover notification via backend ─────────────────────────────────────────
// AI UPDATE [2026-07-28] v6: Replaced browser audio/notification with Pushover.
// AI UPDATE [2026-07-29] v10: Rich payload — pass orderId, customerPhone, and
//   items array so server.js can build a fully-formatted Pushover notification
//   (Customer Name, Phone, Table, Order #, itemised list).  Priority bumped to
//   emergency (2) in server.js.
// AI UPDATE [2026-07-29] session 22: Removed temporary [notify-debug] trace logs.
//   Notification chain confirmed working end-to-end in session 14. Only failure
//   paths are logged (non-OK response, fetch error).
// AI UPDATE [2026-07-30]: Returns the Pushover receipt string (or null on failure)
//   so the caller can store it for later acknowledgement via POST /api/cancel-receipt.
// Calls POST /api/notify-order on the local Express server (server.js), which
// proxies to the Pushover API with the operator's credentials.
// A failure is logged but never disrupts the order flow.
async function notifyNewOrder(orderId, data) {
    const tableId       = data.tableId           || 'Unknown Table';
    const customerName  = data.customer?.name    || '';
    const customerPhone = data.customer?.phone   || '';
    const items         = data.items             || [];
    const itemCount     = items.reduce((s, i) => s + (i.quantity || 1), 0);

    console.log(`[incoming-orders] Sending emergency Pushover notification for order ${orderId} (${tableId})`);

    try {
        const res = await fetch('/api/notify-order', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ orderId, tableId, customerName, customerPhone, items, itemCount })
        });

        console.log(`[incoming-orders] Pushover response status: ${res.status}`);

        if (!res.ok) {
            let body;
            try { body = await res.clone().json(); } catch(_) { body = await res.text(); }
            console.warn('[incoming-orders] Pushover endpoint error:', res.status, body);
            return null;
        }

        const json = await res.json();
        console.log('[incoming-orders] Pushover response received:', json);

        if (json.receipt) {
            console.log(`[incoming-orders] Receipt extracted for order ${orderId}:`, json.receipt);
            return json.receipt;
        }

        return null;
    } catch (err) {
        console.error('[incoming-orders] Pushover fetch failed:', err.name, err.message);
        return null;
    }
}

// ── Acknowledge (cancel) an active emergency notification ─────────────────────
// AI UPDATE [2026-07-30]: Calls POST /api/cancel-receipt on the Express server,
//   which proxies to Pushover's receipts/{receipt}/cancel.json API.
//   The Pushover token never leaves the server — not exposed in browser source.
//   _cancellingReceipts guards against duplicate in-flight cancel requests.
async function acknowledgeOrder(orderId) {
    const receipt = _activeReceipts.get(orderId);
    if (!receipt) {
        console.warn('[incoming-orders] acknowledgeOrder — no receipt found for order', orderId);
        return;
    }
    if (_cancellingReceipts.has(orderId)) {
        console.log('[incoming-orders] acknowledgeOrder — cancel already in progress for order', orderId);
        return;
    }

    _cancellingReceipts.add(orderId);
    console.log(`[incoming-orders] Acknowledge clicked — cancelling emergency receipt for order ${orderId} → receipt: ${receipt}`);

    try {
        const res = await fetch('/api/cancel-receipt', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ receipt })
        });

        console.log(`[incoming-orders] Cancel response status: ${res.status}`);
        const data = await res.json();
        console.log('[incoming-orders] Cancel response body:', data);

        if (data.ok) {
            _activeReceipts.delete(orderId);
            console.log(`[incoming-orders] Receipt cleared — emergency notification cancelled for order ${orderId}`);
        } else {
            console.warn(`[incoming-orders] Cancel request succeeded but server reported failure for order ${orderId}:`, data);
        }
    } catch (err) {
        console.error(`[incoming-orders] Cancel fetch failed for order ${orderId}:`, err.name, err.message);
    } finally {
        _cancellingReceipts.delete(orderId);
        renderDrawer(_pendingOrders);
    }
}

// ── Inject drawer + badge CSS immediately (not inside showToast) ──────────────
(function injectDrawerCSS() {
    if (document.getElementById('orders-drawer-style')) return;
    const s = document.createElement('style');
    s.id = 'orders-drawer-style';
    s.textContent = `
        @keyframes badgePop { 0%{transform:scale(1)} 50%{transform:scale(1.4)} 100%{transform:scale(1)} }
        .btn-pulse { animation: badgePop 0.5s ease 3; }
        #orders-badge {
            position: absolute; top: -8px; right: -8px;
            background: #ef4444; color: #fff;
            border-radius: 999px; min-width: 22px; height: 22px;
            font-size: 0.72rem; font-weight: 700;
            display: none; align-items: center; justify-content: center;
            padding: 0 5px; pointer-events: none;
            z-index: 10; box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        }
        .orders-drawer {
            position: fixed; bottom: 0; left: 0; right: 0;
            background: #1e1e2e; border-radius: 20px 20px 0 0;
            z-index: 5000; transform: translateY(100%);
            transition: transform 0.3s ease;
            max-height: 80vh; display: flex; flex-direction: column;
        }
        .orders-drawer.open { transform: translateY(0); }
        .orders-overlay {
            position: fixed; inset: 0;
            background: rgba(0,0,0,0.55); z-index: 4999;
            display: none; opacity: 0; transition: opacity 0.3s ease;
        }
        .orders-overlay.open { display: block; opacity: 1; }
        .order-card-item {
            background: #2a2a3e; border-radius: 12px;
            padding: 14px 16px; margin-bottom: 12px;
            border-left: 4px solid #f59e0b;
        }
        .order-card-item .oc-head {
            display: flex; justify-content: space-between;
            align-items: center; margin-bottom: 8px;
        }
        .order-card-item .oc-table { font-weight: 700; font-size: 1rem; }
        .order-card-item .oc-time  { font-size: 0.75rem; opacity: 0.6; }
        .order-card-item .oc-items {
            font-size: 0.85rem; opacity: 0.85;
            margin-bottom: 10px; line-height: 1.5;
        }
        .order-card-item .oc-actions { display: flex; gap: 8px; }
        .oc-btn-accept {
            flex: 1; background: linear-gradient(135deg, #10b981, #34d399);
            color: #fff; border: none; border-radius: 8px;
            padding: 9px; font-weight: 600; font-size: 0.9rem; cursor: pointer;
        }
        .oc-btn-dismiss {
            background: rgba(255,255,255,0.08); color: inherit;
            border: none; border-radius: 8px; padding: 9px 14px;
            font-size: 0.85rem; cursor: pointer; opacity: 0.7;
        }
        .oc-btn-ack {
            width: 100%; background: linear-gradient(135deg, #ef4444, #f87171);
            color: #fff; border: none; border-radius: 8px;
            padding: 10px; font-weight: 700; font-size: 0.9rem; cursor: pointer;
            margin-top: 8px; letter-spacing: 0.02em;
        }
        .oc-btn-ack:disabled { opacity: 0.55; cursor: not-allowed; }
    `;
    document.head.appendChild(s);
})();

// ── Badge counter ─────────────────────────────────────────────────────────────
function setBadge(count) {
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'flex';
        btnOrders && btnOrders.classList.add('btn-pulse');
    } else {
        badge.style.display = 'none';
        btnOrders && btnOrders.classList.remove('btn-pulse');
    }
}

// ── Toast notification ────────────────────────────────────────────────────────
function showToast(tableName, itemCount) {
    const existing = document.getElementById('order-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'order-toast';
    toast.innerHTML = `
        <span style="font-size:1.3rem;">🔔</span>
        <div>
            <strong>New Order!</strong>
            <div style="font-size:0.85rem;opacity:0.9;">${tableName} · ${itemCount} item${itemCount !== 1 ? 's' : ''}</div>
        </div>
    `;
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999;
        background: linear-gradient(135deg, #f59e0b, #fbbf24);
        color: #1a1a1a;
        border-radius: 14px;
        padding: 14px 20px;
        display: flex;
        align-items: center;
        gap: 12px;
        font-family: inherit;
        font-weight: 600;
        box-shadow: 0 8px 30px rgba(0,0,0,0.35);
        cursor: pointer;
        animation: toastIn 0.35s ease;
    `;

    // toast animation only (drawer CSS is injected on load)
    if (!document.getElementById('toast-anim-style')) {
        const s = document.createElement('style');
        s.id = 'toast-anim-style';
        s.textContent = `
            @keyframes toastIn  { from { opacity:0; transform:translateY(-16px); } to { opacity:1; transform:translateY(0); } }
            @keyframes toastOut { from { opacity:1; transform:translateY(0); }     to { opacity:0; transform:translateY(-16px); } }
        `;
        document.head.appendChild(s);
    }

    document.body.appendChild(toast);
    toast.addEventListener('click', openDrawer);

    // Auto-dismiss after 6s
    setTimeout(() => {
        toast.style.animation = 'toastOut 0.35s ease forwards';
        setTimeout(() => toast.remove(), 350);
    }, 6000);
}

// ── Drawer open / close ───────────────────────────────────────────────────────
function openDrawer()  {
    drawer && drawer.classList.add('open');
    overlay && overlay.classList.add('open');
}
function closeDrawer() {
    drawer && drawer.classList.remove('open');
    overlay && overlay.classList.remove('open');
}

// ── Render orders inside the drawer ──────────────────────────────────────────
let _pendingOrders = [];

function renderDrawer(orders) {
    if (!drawerList) return;

    if (orders.length === 0) {
        drawerList.innerHTML = `<p style="text-align:center;opacity:0.5;padding:30px 0;">No pending orders right now 🎉</p>`;
        return;
    }

    drawerList.innerHTML = '';

    // renderDrawer is async because of getCustomerOrderCount
    const renders = orders.map(async order => {
        const { id, tableId = 'Unknown Table', items = [], createdAt, customer = {}, totalPrice } = order;

        const tableName     = tableId;
        const customerName  = customer.name  || 'Guest';
        const customerPhone = customer.phone || '—';

        const timeLabel = createdAt
            ? new Date(createdAt.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';

        // Fix 1: use item.quantity
        const itemsText = items.map(i => `${i.name} ×${i.quantity}`).join(', ') || 'No item details';

        // Fix 3: ordinal order count
        const count   = await getCustomerOrderCount(customer.phone);
        const ordinal = toOrdinal(count);

        // AI UPDATE [2026-07-30] — show Acknowledge button when an active receipt exists.
        const hasActiveReceipt = _activeReceipts.has(id);

        const card = document.createElement('div');
        card.className = 'order-card-item';
        card.innerHTML = `
            <div class="oc-head">
                <span class="oc-table">🔔 ${tableName}</span>
                <span class="oc-time">${timeLabel}</span>
            </div>
            <div style="font-size:0.85rem; margin-bottom:6px; opacity:0.9;">
                👤 <strong>${customerName}</strong> &nbsp;📱 ${customerPhone}
            </div>
            <div style="font-size:0.75rem; color:#f59e0b; margin-bottom:8px; font-weight:600;">
                ${ordinal} order from this customer
            </div>
            <div class="oc-items">${itemsText}</div>
            ${totalPrice ? `<div style="font-size:0.9rem; font-weight:700; margin-bottom:10px;">Total: ₹${totalPrice}</div>` : ''}
            <div class="oc-actions">
                <button class="oc-btn-accept">✅ Open in POS</button>
                <button class="oc-btn-dismiss">Dismiss</button>
            </div>
            ${hasActiveReceipt ? `<button class="oc-btn-ack">🔕 Acknowledge Order</button>` : ''}
        `;

        // Accept → load items into POS cart then open the table
        card.querySelector('.oc-btn-accept').addEventListener('click', async () => {
            // ── Capture authoritative session identifiers from the order ──────────
            // These are stored as UI convenience only.  Settlement decisions in
            // cart.js use Firestore (customer_table_sessions) as the source of truth.
            const customerUid      = order.customer?.uid          || '';
            const customerSessionId = order.customerSessionId      || '';
            const tableLockId      = order.tableLockId             || '';

            // 1. Merge customer items into localStorage cart for this table
            const cartKey = `cart_${tableName}_C1`;
            let existing = [];
            try { existing = JSON.parse(localStorage.getItem(cartKey) || '[]'); } catch(_) {}

            items.forEach(newItem => {
                const incomingQty = newItem.quantity || 1;

                // Try to match against actual POS menu items by name so the item
                // gets the right ID — this makes menu badges, delete and qty all work.
                const posMenuItems = window._posMenuItems || [];
                const posItem = posMenuItems.find(
                    m => m.name.trim().toLowerCase() === (newItem.name || '').trim().toLowerCase()
                );

                // Prefer the POS item's ID; fall back to itemId from customer panel;
                // last resort a stable string so at least cart ops work.
                const resolvedId    = posItem ? posItem.id    : (newItem.itemId || newItem.id || `inc_${newItem.name}`);
                const resolvedPrice = posItem ? posItem.price : (newItem.price || 0);
                const resolvedName  = posItem ? posItem.name  : (newItem.name  || 'Unknown Item');

                const found = existing.find(i => i.id === resolvedId);
                if (found) {
                    found.qty += incomingQty;
                } else {
                    existing.push({
                        id:         resolvedId,
                        name:       resolvedName,
                        price:      resolvedPrice,
                        qty:        incomingQty,
                        printedQty: 0
                    });
                }
            });
            localStorage.setItem(cartKey, JSON.stringify(existing));
            window.dispatchEvent(new Event('cart-updated'));

            // 2. Mark order as accepted in Firestore
            try {
                await updateDoc(doc(db, 'pending_table_orders', id), { status: 'accepted' });

                // UI convenience cache — NOT the source of truth for settlement.
                // cart.js reads customer_table_sessions from Firestore for lock release.
                localStorage.setItem(`activeOrderDocId_${tableName}`, id);
                if (customerUid)       localStorage.setItem(`activeCustomerUid_${tableName}`,  customerUid);
                if (customerSessionId) localStorage.setItem(`activeSessionId_${tableName}`,    customerSessionId);
                if (tableLockId)       localStorage.setItem(`activeLockId_${tableName}`,       tableLockId);

                // AI UPDATE [2026-07-28] v9 — Issue 2 fix:
                // Track the specific order IDs imported via "Open in POS" so that
                // syncCustomerOrderCompletion() marks ONLY those orders as 'completed'
                // at Bill & Settle / Save & Exit time.
                // Without this, sync marked ALL pending/active orders for the table as
                // 'completed', silently consuming any other unreviewed pending card.
                // Accumulate into an array so multiple orders can be imported before
                // the operator bills (the normal multi-order merge flow).
                const _prevAccepted = JSON.parse(
                    localStorage.getItem(`acceptedOrderIds_${tableName}`) || '[]'
                );
                if (!_prevAccepted.includes(id)) _prevAccepted.push(id);
                localStorage.setItem(`acceptedOrderIds_${tableName}`, JSON.stringify(_prevAccepted));
            } catch(e) { console.warn('Could not update order status:', e); }

            closeDrawer();

            // 3. Open POS directly to that table (cart already loaded)
            if (typeof window._posOpenTable === 'function') {
                window._posOpenTable(tableName);
            }
        });

        // Dismiss → mark as dismissed
        card.querySelector('.oc-btn-dismiss').addEventListener('click', async () => {
            try {
                await updateDoc(doc(db, 'pending_table_orders', id), { status: 'dismissed' });
            } catch(e) {}
        });

        // AI UPDATE [2026-07-30] — Acknowledge Order button: cancel the active emergency
        // notification via POST /api/cancel-receipt (server proxies to Pushover, token
        // never leaves server).  Button is disabled immediately to prevent duplicate clicks.
        const ackBtn = card.querySelector('.oc-btn-ack');
        if (ackBtn) {
            ackBtn.addEventListener('click', () => {
                ackBtn.disabled     = true;
                ackBtn.textContent  = '⏳ Acknowledging…';
                acknowledgeOrder(id);
            });
        }

        return card;
    });

    // Append all cards once async work is done
    Promise.all(renders).then(cards => {
        drawerList.innerHTML = '';
        cards.forEach(c => drawerList.appendChild(c));
    });
}

// ── Firestore listener ────────────────────────────────────────────────────────
let _unsubscribe = null;

function startListening() {
    // Cancel any existing listener before creating a new one.
    if (_unsubscribe) {
        _unsubscribe();
        _unsubscribe = null;
    }

    // Fresh listener — clear cached order counts so they're re-fetched
    // from Firestore rather than returning stale values from a previous session.
    _countCache.clear();

    // AI UPDATE [2026-07-29] v11 — DO NOT reset _initialLoadDone here.
    // _initialLoadDone starts false on page load, becomes true after the first
    // snapshot, and stays true for all restarts.  This is what makes the guard
    // work correctly across Firestore error retries:
    //   - Pre-existing orders on restart: already in _notified → DEDUP skip.
    //   - New orders placed during restart window: not in _notified,
    //     _initialLoadDone = true → notified correctly.
    // Resetting it here was the bug in v5–v8 that silenced new orders on restart.
    //
    // IMPORTANT: _notified is also NOT cleared here (v9 rule, preserved).
    // It accumulates all seen order IDs for the page lifetime, providing
    // dedup protection across every listener restart.

    const q = query(
        collection(db, 'pending_table_orders'),
        orderBy('createdAt', 'desc')
    );

    _unsubscribe = onSnapshot(q, (snapshot) => {
        const pending = [];

        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            // Only show pending orders (not yet accepted/dismissed)
            if (data.status !== 'pending') return;

            const order = { id: docSnap.id, ...data };
            pending.push(order);

            if (!_notified.has(docSnap.id)) {
                // Add to dedup set BEFORE the guard check so that if this order
                // is silenced (pre-existing on page load), it is still recorded
                // and won't be re-notified after a listener restart.
                _notified.add(docSnap.id);

                // AI UPDATE [2026-07-29] v11 — clock-independent guard:
                // If _initialLoadDone is false, this is the first snapshot of this
                // page session.  All docs in this snapshot are pre-existing orders
                // that the operator already knows about — silence them.
                // Once _initialLoadDone is true (set at the bottom of this callback),
                // any new doc arriving is genuinely new regardless of listener restarts.
                // This replaces the v9 timestamp-based guard which broke whenever
                // the client clock was ahead of the Firestore server clock by > 10 s.
                if (!_initialLoadDone) {
                    return;
                }

                const itemCount = (data.items || []).reduce((s, i) => s + (i.quantity || 1), 0);
                showToast(data.tableId || 'Unknown Table', itemCount || 1);

                // AI UPDATE [2026-07-28] v6: Pushover push notification via backend.
                // AI UPDATE [2026-07-29] v10: Pass docSnap.id as orderId for rich notification.
                // AI UPDATE [2026-07-29] v11: Timestamp guard removed; _initialLoadDone guard restored.
                // AI UPDATE [2026-07-29] session 22: [notify-debug] trace logs removed.
                // AI UPDATE [2026-07-30]: Capture returned receipt; store in _activeReceipts;
                //   re-render drawer to show Acknowledge button for this order.
                notifyNewOrder(docSnap.id, data).then(receipt => {
                    if (receipt) {
                        console.log(`[incoming-orders] Receipt stored for order ${docSnap.id}:`, receipt);
                        _activeReceipts.set(docSnap.id, receipt);
                        renderDrawer(_pendingOrders);
                    }
                });
            }
        });

        // Mark initial load complete.  After this point every unseen doc is new.
        // IMPORTANT: this is set AFTER iterating the snapshot so that ALL docs in
        // the first snapshot are processed with _initialLoadDone = false (silenced).
        _initialLoadDone = true;

        // AI UPDATE [2026-07-30] — Orphan cleanup: if an order was accepted or
        // dismissed before the operator acknowledged its emergency notification,
        // its receipt entry must be removed so no stale Acknowledge button appears
        // after the card disappears.
        const pendingIds = new Set(pending.map(o => o.id));
        for (const orderId of _activeReceipts.keys()) {
            if (!pendingIds.has(orderId)) {
                console.log(`[incoming-orders] Orphaned receipt cleaned up for removed order ${orderId}`);
                _activeReceipts.delete(orderId);
            }
        }

        _pendingOrders = pending;
        setBadge(pending.length);
        renderDrawer(pending);
    }, (err) => {
        console.error('[incoming-orders] Firestore listener error — retrying in 5s:', err.code, err.message);
        _unsubscribe = null;
        setTimeout(startListening, 5000);
    });
}

// ── Auth bootstrap ────────────────────────────────────────────────────────────
// index.html (the main billing panel) does NOT load admin.js and therefore
// never calls signInAnonymously on its own.  Without an anonymous session,
// auth.currentUser is always null, onAuthStateChanged only ever fires with
// null, and startListening() is never called — orders never appear.
//
// This module is now responsible for bootstrapping auth on the billing panel.
// signInAnonymously is idempotent: Firebase returns the existing cached session
// from IndexedDB instantly if one exists, or creates a new anonymous user once.
//
// onAuthStateChanged is registered HERE (module top-level, outside
// DOMContentLoaded) so it is wired up immediately when the module loads and
// cannot miss the initial auth-state notification from Firebase.

let _authListenerFired = false;
onAuthStateChanged(auth, (user) => {
    if (user && !_authListenerFired) {
        _authListenerFired = true;
        startListening();
    }
    // If user becomes null (sign-out), cancel the listener to avoid leaks
    if (!user && _unsubscribe) {
        _unsubscribe();
        _unsubscribe = null;
        _authListenerFired = false;
        setBadge(0);
    }
});

// Kick off anonymous sign-in immediately so onAuthStateChanged gets a user.
// auth.currentUser is synchronously available once IndexedDB cache is restored;
// if it is already set we skip the call to avoid an extra round-trip.
if (!auth.currentUser) {
    signInAnonymously(auth).catch(err =>
        console.warn('[incoming-orders] anonymous sign-in failed:', err.code)
    );
}

// ── Wire up button & overlay ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    if (btnOrders) {
        // Make btn position:relative so the badge positions correctly
        btnOrders.style.position = 'relative';
        btnOrders.addEventListener('click', openDrawer);
    }
    if (overlay) overlay.addEventListener('click', closeDrawer);

    // Re-establish the Firestore network channel whenever the tab comes back
    // into focus (browsers throttle WebSocket connections in background tabs).
    //
    // IMPORTANT: we do NOT recreate the listener here unless it was actually
    // dropped (null).  Previously this always called startListening(), which
    // cancelled and recreated the onSnapshot — causing Firestore to emit a
    // stale IndexedDB cache snapshot first, introducing a visible delay before
    // the live data appeared.  Now we just call enableNetwork() to resume the
    // existing listener, which picks up any missed updates automatically.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && auth.currentUser) {
            enableNetwork(db).catch(() => {});
            // Only restart the listener if it was truly dropped (error / sign-out).
            if (!_unsubscribe) {
                startListening();
            }
        }
    });
});
