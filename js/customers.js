// js/customers.js
// Customer Management Panel — list, view, and delete customers.
// AI UPDATE [2026-07-30]: Import custom dialog system — replaces alert().
//
// AI UPDATE [2026-07-29] session 17:
//   BUG FIX — Customer statistics always showed 0 orders / ₹0 / empty history.
//   Root cause: customer.html wrote the anonymous UID to customers/{phone} under
//   the field name `authUid`, but this module read it as `c.uid` (undefined for
//   every existing document → guard `if (!c.uid)` fired immediately → no history
//   ever fetched).
//   Fix:
//     1. customers.js now resolves the UID as `c.uid || c.authUid` in both the
//        fetch enrichment path and the delete path — backward-compat with all
//        existing documents regardless of which field name was used.
//     2. customer.html corrected to write `uid` (schema-spec field name); also
//        merges `uid` on every returning-customer order so the profile stays
//        current if the browser's anonymous auth state is ever reset.
//   Only js/customers.js and customer.html were changed.  No Firestore schema,
//   collection names, billing workflow, or UI was modified.
//
// AI UPDATE [2026-07-29] session 15:
//   NEW FILE — Customer Management Panel feature.
//   - Fetches all docs from `customers/{phone}` collection.
//   - Enriches each customer with stats from `customer_order_history/{uid}/orders`.
//   - Renders a searchable card list (name, phone, orders count, last order, spending).
//   - Opens a full-screen detail overlay with complete order history.
//   - Deletes customer: removes `customers/{phone}`, all `customer_order_history/{uid}/orders/*`
//     docs, and the `customer_order_history/{uid}` parent doc in a single Firestore batch.
//   - Follows the mandatory auth-bootstrap pattern (signInAnonymously → onAuthStateChanged
//     guard) used by incoming-orders.js, menu-management.js, and expense.js.
//
// Firestore collections touched (read + delete only):
//   customers/{phone}
//   customer_order_history/{uid}/orders/{orderId}
//
// Billing records (sales_history) are intentionally NOT touched — they must
// survive customer deletion per the architecture spec.

import { showAlert } from './dialog.js';
import { db, auth } from './firebase-config.js';
import {
    collection, getDocs, doc, writeBatch, updateDoc
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { signInAnonymously, onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';

// ── Auth bootstrap (mandatory pattern) ────────────────────────────────────
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

// ── Module state ──────────────────────────────────────────────────────────
let _customers  = []; // enriched customer objects (see _fetchCustomers)
let _search     = '';
let _loaded     = false;

// ── Public exports (called by admin.js) ──────────────────────────────────
export async function initCustomerManagement() {
    if (_loaded) { _renderList(); return; }
    _showSkeletons();
    await _waitForAuth();
    await _fetchCustomers();
}

export function destroyCustomerManagement() {
    // No live onSnapshot listeners in this module — nothing to clean up.
}

// ── Data fetching ─────────────────────────────────────────────────────────
//
// AI UPDATE [2026-07-29] session 18 — Architecture improvement:
// Previous implementation fetched full order history for EVERY customer on
// every admin panel open (N Firestore reads).  New approach:
//
//   FAST PATH  (new customers + already-migrated customers):
//     Stats (totalOrders, lifetimeSpend, lastOrderAt) live directly in the
//     customers/{phone} profile — written by cart.js syncCustomerOrderCompletion
//     via FieldValue.increment() on each order completion.  No history reads
//     needed for the list view.
//
//   MIGRATION PATH  (legacy customers without stats fields):
//     Fetches history once, computes stats, writes them to the profile, and
//     never repeats the scan (stats are now in the profile for fast-path use).
//
//   Order history is lazy-loaded per customer in _custOpenDetail (only when the
//   operator actually opens a customer card — not on list load).
//
async function _fetchCustomers() {
    const listEl  = document.getElementById('customerCardList');
    try {
        const snap = await getDocs(collection(db, 'customers'));
        const raw  = [];
        snap.forEach(d => raw.push({ id: d.id, ...d.data() }));

        const enriched = await Promise.all(raw.map(async c => {
            // ── Fast path: stats already in profile ───────────────────────────
            if (typeof c.totalOrders === 'number') {
                return {
                    ...c,
                    orderCount:     c.totalOrders,
                    lastOrderTs:    c.lastOrderAt?.toMillis?.() ?? 0,
                    totalSpending:  c.lifetimeSpend || 0,
                    orders:         [],     // lazy-loaded in _custOpenDetail
                    _historyLoaded: false,
                };
            }

            // ── Migration path: legacy customer without pre-computed stats ────
            // Fetch history once, compute stats, save to profile for future loads.
            const resolvedUid = c.uid || c.authUid || '';
            if (!resolvedUid) {
                // No UID — can't read history; initialise stats at 0 so we skip this branch next time
                updateDoc(doc(db, 'customers', c.id), {
                    totalOrders: 0, lifetimeSpend: 0, lastOrderAt: null,
                }).catch(() => {});
                return { ...c, orderCount: 0, lastOrderTs: 0, totalSpending: 0, orders: [], _historyLoaded: true };
            }

            try {
                const ordSnap = await getDocs(
                    collection(db, `customer_order_history/${resolvedUid}/orders`)
                );
                let totalSpending = 0, lastOrderTs = 0, orderCount = 0;
                ordSnap.forEach(od => {
                    const data = od.data();
                    orderCount++;
                    totalSpending += data.total || 0;
                    const ts = data.completedAt?.toMillis?.() ?? 0;
                    if (ts > lastOrderTs) lastOrderTs = ts;
                });
                // Save computed stats to profile — non-blocking (one-time migration)
                updateDoc(doc(db, 'customers', c.id), {
                    totalOrders:   orderCount,
                    lifetimeSpend: totalSpending,
                    lastOrderAt:   lastOrderTs ? new Date(lastOrderTs) : null,
                }).catch(() => {});
                return { ...c, orderCount, lastOrderTs, totalSpending, orders: [], _historyLoaded: false };
            } catch {
                return { ...c, orderCount: 0, lastOrderTs: 0, totalSpending: 0, orders: [], _historyLoaded: false };
            }
        }));

        // Most-recently-active customers first
        _customers = enriched.sort((a, b) => b.lastOrderTs - a.lastOrderTs);
        _loaded = true;
        _renderList();
    } catch (err) {
        console.error('[customers] Fetch error:', err);
        if (listEl) listEl.innerHTML =
            `<div class="empty-state">⚠️ Failed to load customers.<br><small style="color:#8b949e">${err.message}</small></div>`;
    }
}

// ── Lazy-load order history for one customer ──────────────────────────────
// Called by _custOpenDetail the first time a customer card is tapped.
// Result is cached on the in-memory customer object (c.orders, c._historyLoaded).
async function _loadCustomerHistory(c) {
    const resolvedUid = c.uid || c.authUid || '';
    if (!resolvedUid) { c.orders = []; c._historyLoaded = true; return; }
    try {
        const ordSnap = await getDocs(
            collection(db, `customer_order_history/${resolvedUid}/orders`)
        );
        const orders = [];
        ordSnap.forEach(od => orders.push({ id: od.id, ...od.data() }));
        orders.sort((a, b) => (b.completedAt?.toMillis?.() ?? 0) - (a.completedAt?.toMillis?.() ?? 0));
        c.orders = orders;
    } catch {
        c.orders = [];
    }
    c._historyLoaded = true;
}

// ── Build order history HTML ──────────────────────────────────────────────
function _buildOrdersHtml(orders) {
    if (!orders || orders.length === 0) {
        return `<div class="empty-state">No orders yet.</div>`;
    }
    return `<div class="bills-list">` + orders.map(o => {
        const ts = o.completedAt?.toMillis?.() ?? 0;
        const orderLabel = [
            o.orderId || o.id,
            o.billNumber ? `Bill #${_esc(String(o.billNumber))}` : '',
        ].filter(Boolean).join(' · ');
        const statusLabel = o.completionReason === 'bill_settle' ? '✅ Billed & Settled'
                          : o.completionReason === 'save_exit'   ? '✅ Saved'
                          : '✅ Completed';
        const itemsHtml = (o.items || []).map(it => `
<div class="cust-ord-item-row">
    <span class="name">${_esc(it.name)}</span>
    <span class="qty">×${it.quantity || 1}</span>
    <span class="sub">${_fmtRupee(it.subtotal)}</span>
</div>`).join('');
        return `
<div class="bill-card" style="flex-direction:column;align-items:stretch;gap:10px;border-left:3px solid #1f6feb;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div class="bill-card-left">
            <div class="bill-card-name" style="color:#58a6ff;font-size:0.88rem;">${_esc(orderLabel)}</div>
            <div class="bill-card-time">${_esc(o.tableId || '—')} · ${_fmtDate(ts)}${ts ? ' · ' + _fmtTime(ts) : ''}</div>
        </div>
        <div class="bill-card-amt" style="flex-shrink:0;">${_fmtRupee(o.total)}</div>
    </div>
    ${itemsHtml ? `<div style="border-top:1px solid #21262d;padding-top:8px;">${itemsHtml}</div>` : ''}
    <div style="font-size:0.75rem;font-weight:600;color:#3fb950;">${_esc(statusLabel)}</div>
</div>`;
    }).join('') + `</div>`;
}

// ── Rendering helpers ─────────────────────────────────────────────────────
function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('en-IN',
        { day: 'numeric', month: 'short', year: 'numeric' });
}

function _fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('en-IN',
        { hour: '2-digit', minute: '2-digit' });
}

function _fmtRupee(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN');
}

function _avatarLetter(name) {
    return (name || '?').trim()[0].toUpperCase();
}

// ── List rendering — uses existing bill-card / bill-card-* classes ────────
function _renderList() {
    const listEl  = document.getElementById('customerCardList');
    const countEl = document.getElementById('customerCount');
    if (!listEl) return;

    const q        = _search.toLowerCase().trim();
    const filtered = q
        ? _customers.filter(c =>
            (c.name  || '').toLowerCase().includes(q) ||
            (c.phone || '').includes(q)
          )
        : _customers;

    if (countEl) {
        countEl.textContent = `${filtered.length} customer${filtered.length !== 1 ? 's' : ''}`;
    }

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="empty-state">${
            q ? '🔍 No customers match your search.'
              : '👤 No customers registered yet.'
        }</div>`;
        return;
    }

    listEl.innerHTML = filtered.map(c => {
        const joinedTs = c.createdAt?.toMillis?.() ?? 0;
        // Build meta line — joined date + last order date
        const metaParts = [];
        if (joinedTs)      metaParts.push(`Joined ${_fmtDate(joinedTs)}`);
        if (c.lastOrderTs) metaParts.push(`Last order ${_fmtDate(c.lastOrderTs)}`);

        return `
<div class="bill-card cust-bill-card" onclick="window._custOpenDetail('${_esc(c.id)}')">
    <div class="cust-av">${_avatarLetter(c.name)}</div>
    <div class="bill-card-left" style="flex:1;min-width:0;margin-left:2px;">
        <div class="bill-card-name">${_esc(c.name || 'Unknown')}</div>
        <div class="bill-card-time" style="color:#58a6ff;">${_esc(c.phone || c.id)}</div>
        ${metaParts.length ? `<div class="bill-card-time">${_esc(metaParts.join(' · '))}</div>` : ''}
    </div>
    <div class="bill-card-right" style="flex-direction:column;align-items:flex-end;gap:1px;">
        <span style="font-size:1.15rem;font-weight:900;color:#58a6ff;line-height:1.15;">${c.orderCount}</span>
        <span style="font-size:0.68rem;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:0.4px;">orders</span>
        <span class="bill-card-amt" style="font-size:0.88rem;">${_fmtRupee(c.totalSpending)}</span>
    </div>
    <span style="color:#8b949e;font-size:1.1rem;margin-left:2px;flex-shrink:0;">›</span>
</div>`;
    }).join('');
}

function _showSkeletons() {
    const listEl = document.getElementById('customerCardList');
    if (!listEl) return;
    listEl.innerHTML = `<div class="loading-state">Loading customers… ☁️</div>`;
}

// ── Search (called from inline oninput) ───────────────────────────────────
window._custSearch = function(val) {
    _search = val;
    _renderList();
};

// ── Detail overlay — reuses modal-overlay/modal-box + existing CSS ────────
// AI UPDATE [2026-07-29] session 18:
// Now async — opens immediately with pre-computed stats from the profile, then
// lazy-loads the full order history in the background.  On subsequent opens of
// the same customer the history is already cached (c._historyLoaded = true) and
// renders instantly.
window._custOpenDetail = async function(phone) {
    const c = _customers.find(x => x.id === phone);
    if (!c) return;

    const overlay = document.getElementById('custDetailOverlay');
    const body    = document.getElementById('custDetailBody');
    if (!overlay || !body) return;

    const joinedTs = c.createdAt?.toMillis?.() ?? 0;

    // Helper that builds the invariant header + stats HTML
    const headerHtml = `
<!-- Profile header -->
<div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #30363d;">
    <div class="cust-av cust-av-lg">${_avatarLetter(c.name)}</div>
    <div style="min-width:0;">
        <div style="font-size:1.15rem;font-weight:800;color:#e6edf3;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(c.name || 'Unknown')}</div>
        <div style="font-size:0.92rem;color:#58a6ff;letter-spacing:0.2px;">${_esc(c.phone || c.id)}</div>
    </div>
</div>

<!-- Stats — reuse stats-row / stat-card -->
<div class="stats-row">
    <div class="stat-card blue">
        <div class="stat-label">Total Orders</div>
        <div class="stat-value">${c.orderCount}</div>
    </div>
    <div class="stat-card green">
        <div class="stat-label">Lifetime Spend</div>
        <div class="stat-value" style="font-size:1.4rem;">${_fmtRupee(c.totalSpending)}</div>
    </div>
</div>
<div class="stats-row" style="margin-top:-6px;">
    <div class="stat-card" style="border-left:4px solid #6e40c9;flex:1 1 100%;">
        <div class="stat-label">Date Joined</div>
        <div class="stat-value" style="font-size:1.1rem;color:#c9d1d9;">${joinedTs ? _fmtDate(joinedTs) : '—'}</div>
    </div>
    ${c.lastOrderTs ? `
    <div class="stat-card" style="border-left:4px solid #8b949e;flex:1 1 100%;">
        <div class="stat-label">Last Order</div>
        <div class="stat-value" style="font-size:1.1rem;color:#c9d1d9;">${_fmtDate(c.lastOrderTs)}</div>
    </div>` : ''}
</div>`;

    const deleteHtml = `
<!-- Delete button -->
<div style="padding:20px 0 4px;">
    <button class="btn btn-danger full-width" style="padding:14px;font-size:1rem;justify-content:center;"
        onclick="window._custConfirmDelete('${_esc(c.id)}')">
        🗑️ Delete Customer
    </button>
</div>`;

    // Phase 1 — open overlay immediately with stats + history placeholder
    body.innerHTML = headerHtml + `
<!-- Order history -->
<div class="list-title" style="margin-top:4px;margin-bottom:12px;">Order History</div>
<div id="custHistoryContainer">${
    c._historyLoaded
        ? _buildOrdersHtml(c.orders)
        : '<div class="loading-state">Loading orders… ☁️</div>'
}</div>` + deleteHtml;
    overlay.classList.remove('hidden');

    // Phase 2 — fetch history if not yet loaded, then update the container
    if (!c._historyLoaded) {
        await _loadCustomerHistory(c);
        const container = document.getElementById('custHistoryContainer');
        if (container) container.innerHTML = _buildOrdersHtml(c.orders);
    }
};

window._custCloseDetail = function() {
    document.getElementById('custDetailOverlay')?.classList.add('hidden');
};

// ── Delete confirmation ───────────────────────────────────────────────────
window._custConfirmDelete = function(phone) {
    const confirmEl = document.getElementById('custDeleteConfirm');
    if (!confirmEl) return;
    confirmEl.dataset.phone = phone;
    confirmEl.classList.remove('hidden');
    // Reset button state
    const btn = document.getElementById('custDeleteBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'Delete Permanently'; }
};

window._custCancelDelete = function() {
    document.getElementById('custDeleteConfirm')?.classList.add('hidden');
};

window._custExecuteDelete = async function() {
    const confirmEl = document.getElementById('custDeleteConfirm');
    const phone     = confirmEl?.dataset.phone;
    if (!phone) return;

    const btn = document.getElementById('custDeleteBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

    const c = _customers.find(x => x.id === phone);
    if (!c) { confirmEl.classList.add('hidden'); return; }

    try {
        await _waitForAuth();
        const batch = writeBatch(db);

        // 1. Delete all order history documents
        // AI UPDATE [2026-07-29] session 17: use resolvedUid (c.uid || c.authUid) so
        // deletion works for both old documents (authUid) and new ones (uid).
        const resolvedUid = c.uid || c.authUid || '';
        if (resolvedUid) {
            const ordSnap = await getDocs(
                collection(db, `customer_order_history/${resolvedUid}/orders`)
            );
            ordSnap.forEach(od => batch.delete(od.ref));
            // 2. Delete the uid-level parent document (if it exists)
            batch.delete(doc(db, `customer_order_history/${resolvedUid}`));
        }

        // 3. Delete the customer profile
        batch.delete(doc(db, `customers/${phone}`));

        // 4. Delete username registry entry to prevent orphaned username documents.
        // AI UPDATE [2026-07-29] session 22: without this step the username stays
        // permanently reserved in the usernames/{username} collection after the
        // customer profile is deleted — the handle can never be reused by a new
        // registration. Firestore rule: usernames allow delete if isOperator().
        if (c.username) {
            batch.delete(doc(db, `usernames/${c.username}`));
        }

        await batch.commit();

        // Update local state
        _customers = _customers.filter(x => x.id !== phone);

        // Close both overlays
        confirmEl.classList.add('hidden');
        document.getElementById('custDetailOverlay')?.classList.add('hidden');

        // Re-render the list
        _renderList();

    } catch (err) {
        console.error('[customers] Delete failed:', err);
        if (btn) { btn.disabled = false; btn.textContent = 'Delete Permanently'; }
        // AI UPDATE [2026-07-30]: Replaced alert() with custom dialog.
        await showAlert('Delete failed: ' + err.message, 'error', 'Delete Failed');
    }
};

// ── Refresh (called when tab is reopened after data may have changed) ──────
export async function refreshCustomerManagement() {
    _loaded = false;
    _showSkeletons();
    await _waitForAuth();
    await _fetchCustomers();
}

// Global hook for the refresh icon-btn in admin/index.html
window._custRefresh = async function() {
    const btn = document.getElementById('custRefreshBtn');
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
    await refreshCustomerManagement();
    if (btn) { btn.textContent = '↻'; btn.disabled = false; }
};
