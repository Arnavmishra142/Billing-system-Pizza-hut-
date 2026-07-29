// js/customers.js
// Customer Management Panel — list, view, and delete customers.
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

import { db, auth } from './firebase-config.js';
import {
    collection, getDocs, doc, writeBatch
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
async function _fetchCustomers() {
    const listEl = document.getElementById('customerCardList');
    const countEl = document.getElementById('customerCount');
    try {
        const snap = await getDocs(collection(db, 'customers'));
        const raw = [];
        snap.forEach(d => raw.push({ id: d.id, ...d.data() }));

        // Enrich with order stats — fetch all customers in parallel
        const enriched = await Promise.all(raw.map(async c => {
            if (!c.uid) {
                return { ...c, orderCount: 0, lastOrderTs: 0, totalSpending: 0, orders: [] };
            }
            try {
                const ordSnap = await getDocs(
                    collection(db, `customer_order_history/${c.uid}/orders`)
                );
                const orders = [];
                let totalSpending = 0;
                let lastOrderTs   = 0;
                ordSnap.forEach(od => {
                    const data = od.data();
                    orders.push({ id: od.id, ...data });
                    totalSpending += data.total || 0;
                    const ts = data.completedAt?.toMillis?.() ?? 0;
                    if (ts > lastOrderTs) lastOrderTs = ts;
                });
                // Newest-first
                orders.sort(
                    (a, b) => (b.completedAt?.toMillis?.() ?? 0) - (a.completedAt?.toMillis?.() ?? 0)
                );
                return { ...c, orderCount: orders.length, lastOrderTs, totalSpending, orders };
            } catch {
                return { ...c, orderCount: 0, lastOrderTs: 0, totalSpending: 0, orders: [] };
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

// ── List rendering ────────────────────────────────────────────────────────
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
        return `
<div class="cust-card" onclick="window._custOpenDetail('${_esc(c.id)}')">
    <div class="cust-card-avatar">${_avatarLetter(c.name)}</div>
    <div class="cust-card-body">
        <div class="cust-card-name">${_esc(c.name || 'Unknown')}</div>
        <div class="cust-card-phone">${_esc(c.phone || c.id)}</div>
        <div class="cust-card-meta">
            ${joinedTs         ? `<span>Joined ${_fmtDate(joinedTs)}</span>` : ''}
            ${c.lastOrderTs    ? `<span>Last order ${_fmtDate(c.lastOrderTs)}</span>` : ''}
        </div>
    </div>
    <div class="cust-card-stats">
        <div class="cust-stat-num">${c.orderCount}</div>
        <div class="cust-stat-lbl">orders</div>
        <div class="cust-stat-spend">${_fmtRupee(c.totalSpending)}</div>
    </div>
</div>`;
    }).join('');
}

function _showSkeletons() {
    const listEl = document.getElementById('customerCardList');
    if (!listEl) return;
    listEl.innerHTML = Array(5).fill(`
<div class="cust-card cust-card--skel">
    <div class="cust-card-avatar cust-skel-block" style="border-radius:50%"></div>
    <div class="cust-card-body">
        <div class="cust-skel-block" style="width:120px;height:13px;border-radius:6px;margin-bottom:7px"></div>
        <div class="cust-skel-block" style="width:88px;height:11px;border-radius:6px;margin-bottom:7px"></div>
        <div class="cust-skel-block" style="width:140px;height:10px;border-radius:5px"></div>
    </div>
</div>`).join('');
}

// ── Search (called from inline oninput) ───────────────────────────────────
window._custSearch = function(val) {
    _search = val;
    _renderList();
};

// ── Detail overlay ────────────────────────────────────────────────────────
window._custOpenDetail = function(phone) {
    const c = _customers.find(x => x.id === phone);
    if (!c) return;

    const overlay = document.getElementById('custDetailOverlay');
    const body    = document.getElementById('custDetailBody');
    if (!overlay || !body) return;

    const joinedTs = c.createdAt?.toMillis?.() ?? 0;

    // Order history rows
    let ordersHtml;
    if (c.orders.length === 0) {
        ordersHtml = `<div class="empty-state" style="margin-top:8px">No orders yet.</div>`;
    } else {
        ordersHtml = c.orders.map(o => {
            const ts       = o.completedAt?.toMillis?.() ?? 0;
            const itemsHtml = (o.items || []).map(it => `
<div class="cust-ord-item">
    <span class="cust-ord-item-name">${_esc(it.name)}</span>
    <span class="cust-ord-item-qty">×${it.quantity || 1}</span>
    <span class="cust-ord-item-sub">${_fmtRupee(it.subtotal)}</span>
</div>`).join('');

            return `
<div class="cust-ord-card">
    <div class="cust-ord-header">
        <div class="cust-ord-id-block">
            <span class="cust-ord-id">${_esc(o.orderId || o.id)}</span>
            <span class="cust-ord-table">${_esc(o.tableId || '—')}</span>
        </div>
        <div class="cust-ord-total">${_fmtRupee(o.total)}</div>
    </div>
    <div class="cust-ord-datetime">${_fmtDate(ts)}${ts ? ' · ' + _fmtTime(ts) : ''}</div>
    <div class="cust-ord-items">${itemsHtml}</div>
    <div class="cust-ord-status">✅ Completed</div>
</div>`;
        }).join('');
    }

    body.innerHTML = `
<!-- Profile header -->
<div class="cust-detail-top">
    <div class="cust-detail-avatar">${_avatarLetter(c.name)}</div>
    <div class="cust-detail-info">
        <div class="cust-detail-name">${_esc(c.name || 'Unknown')}</div>
        <div class="cust-detail-phone">${_esc(c.phone || c.id)}</div>
    </div>
</div>

<!-- Stats row -->
<div class="cust-detail-stats">
    <div class="cust-ds">
        <div class="cust-ds-val">${c.orderCount}</div>
        <div class="cust-ds-lbl">Orders</div>
    </div>
    <div class="cust-ds">
        <div class="cust-ds-val" style="font-size:1.15rem">${_fmtRupee(c.totalSpending)}</div>
        <div class="cust-ds-lbl">Lifetime Spend</div>
    </div>
    <div class="cust-ds">
        <div class="cust-ds-val" style="font-size:1rem">${joinedTs ? _fmtDate(joinedTs) : '—'}</div>
        <div class="cust-ds-lbl">Joined</div>
    </div>
</div>

<!-- Order history -->
<div class="cust-detail-section-title">Order History</div>
<div class="cust-ord-list">${ordersHtml}</div>

<!-- Delete button -->
<div style="padding: 20px 0 8px;">
    <button class="btn btn-danger full-width" style="padding:14px;font-size:1rem;"
        onclick="window._custConfirmDelete('${_esc(c.id)}')">
        🗑️ Delete Customer
    </button>
</div>`;

    overlay.classList.remove('hidden');
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
        if (c.uid) {
            const ordSnap = await getDocs(
                collection(db, `customer_order_history/${c.uid}/orders`)
            );
            ordSnap.forEach(od => batch.delete(od.ref));
            // 2. Delete the uid-level parent document (if it exists)
            batch.delete(doc(db, `customer_order_history/${c.uid}`));
        }

        // 3. Delete the customer profile
        batch.delete(doc(db, `customers/${phone}`));

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
        alert('Delete failed: ' + err.message);
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
