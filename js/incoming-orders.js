// incoming-orders.js
// Listens to Firestore `pending_table_orders` for new customer orders.
// Shows badge on #btn-orders and a toast notification — NO SOUND.

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

// Track order IDs we've already notified about so we don't re-toast on re-render
const _notified = new Set();

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

            // Toast only for truly new orders we haven't seen yet
            if (!_notified.has(docSnap.id)) {
                _notified.add(docSnap.id);
                const itemCount = (data.items || []).reduce((s, i) => s + (i.quantity || 1), 0);
                showToast(data.tableId || 'Unknown Table', itemCount || 1);
            }
        });

        _pendingOrders = pending;
        setBadge(pending.length);
        renderDrawer(pending);
    }, (err) => {
        console.error('incoming-orders listener error:', err);
        // Retry after 5 s so a transient network hiccup doesn't kill the feed
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
