// js/customers.js
// Customer Management Panel — list, view, and delete customers.
//
// AI UPDATE [2026-09-13]:
//   Added a FILTER + SORT panel (Joined Date, Last Order, Total Orders,
//   Lifetime Spend, Customer Status, Coupons, Sort By) alongside the existing
//   Name/Phone search — see admin/index.html #custFilterOverlay for markup.
//   All filtering/sorting runs client-side over the SAME `_customers` array
//   the cards already use (orderCount, totalSpending, lastOrderTs, createdAt
//   — no new customer stats, no new customer-status system, no duplicate
//   coupon logic). The only new Firestore read is a one-time, cached bulk
//   fetch of the `coupons` collection, and only when the Coupons filter is
//   actually set to something other than "All" (see _ensureCouponsLoaded).
//   "Coupon Expired" has no backing data (coupons/{code} has no expiry field
//   anywhere in this codebase) so it intentionally matches 0 customers with
//   an on-screen note, rather than inventing a new expiry concept.
//   Existing search, cards, detail overlay, coupon send, delete, and
//   password-recovery flows are untouched.
//
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

import { showAlert, showConfirm } from './dialog.js';
import { db, auth } from './firebase-config.js';
import {
    collection, getDocs, getDoc, doc, writeBatch, updateDoc, deleteDoc, setDoc, serverTimestamp, query, where
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

// ── Filter + Sort state — AI UPDATE [2026-09-13] ───────────────────────────
// All filtering/sorting runs client-side over the already-fetched `_customers`
// array (same data the cards already use: orderCount, totalSpending,
// lastOrderTs, createdAt). No new Firestore reads for filtering/sorting
// itself — the single exception is the Coupons filter, which needs a
// one-time bulk read of the `coupons` collection (see _ensureCouponsLoaded).
const DEFAULT_FILTERS = {
    joined: 'all', joinedFrom: '', joinedTo: '',
    lastOrder: 'all', lastOrderFrom: '', lastOrderTo: '',
    orders: 'all', ordersMin: '', ordersMax: '',
    spend: 'all', spendMin: '', spendMax: '',
    status: 'all',
    coupon: 'all',
    // Default matches the pre-existing (pre-filter-feature) sort order —
    // most-recently-active customers first — so simply opening this feature
    // does not change anything for operators who never touch the panel.
    sort: 'recent-order',
};
function _DEFAULT_FILTERS_CLONE() { return JSON.parse(JSON.stringify(DEFAULT_FILTERS)); }
let _filters = _DEFAULT_FILTERS_CLONE();

// Lazy cache: phone -> array of that customer's coupon docs. Built once
// (single getDocs over the whole `coupons` collection) the first time the
// Coupons filter is used, and reused after that. Reset on manual refresh.
let _couponsByPhone = null;

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
    ${Number(o.customDiscount) > 0 ? `<div class="cust-ord-item-row"><span class="name" style="color:#3fb950;">Custom Discount</span><span class="qty"></span><span class="sub" style="color:#3fb950;">-${_fmtRupee(o.customDiscount)}</span></div>` : ''}
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

// ── Coupons ────────────────────────────────────────────────────────────────
// AI UPDATE [2026-09-12]: Personalized coupon sending from the Customer
// Management panel. Same coupons/{code} collection used by the loyalty
// auto-issuer in the Billing Panel (js/cart.js) and the "Offers" drawer in
// the Customer Order Panel. type: 'personalized' distinguishes operator-sent
// coupons from auto-issued loyalty rewards.
function _couponCodeFromName(name) {
    const base = (name || 'CUST').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) || 'CUST';
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `${base}#${rand}`;
}

async function _fetchCustomerCoupons(phone) {
    try {
        const snap = await getDocs(query(collection(db, 'coupons'), where('phone', '==', phone)));
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
        return list;
    } catch (err) {
        console.warn('[customers] Coupon fetch failed:', err);
        return [];
    }
}

// AI UPDATE [2026-09-22]: Admin coupon management — Mark as Used / Delete.
// Controls render ONLY here (Customer Management panel, admin-only surface).
// Buttons only appear on ACTIVE (cp.used === false) coupons per spec — a
// used coupon is already a closed record and gets no action controls.
// See window._custMarkCouponUsed / window._custDeleteCoupon below and
// AI_HANDOFF.md "Admin Coupon Management" for the full design + data flow.
function _buildCouponsHtml(coupons, phone) {
    if (!coupons || coupons.length === 0) {
        return `<div class="empty-state" style="padding:14px 0;">No coupons yet.</div>`;
    }
    return `<div class="bills-list">` + coupons.map(cp => `
<div class="bill-card" style="flex-direction:column;align-items:stretch;gap:6px;border-left:3px solid ${cp.used ? '#8b949e' : '#3fb950'};" data-coupon-card="${_esc(cp.code)}">
    <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-family:monospace;font-weight:800;color:#58a6ff;font-size:0.95rem;">${_esc(cp.code)}</span>
        <span style="font-weight:800;color:#3fb950;">${_fmtRupee(cp.amount)}</span>
    </div>
    ${cp.message ? `<div style="font-size:0.8rem;color:#c9d1d9;">${_esc(cp.message)}</div>` : ''}
    <div style="font-size:0.72rem;font-weight:700;color:${cp.used ? '#8b949e' : '#3fb950'};text-transform:uppercase;letter-spacing:0.3px;">
        ${cp.used ? '✅ Used' : '🟢 Active'} ${cp.minOrder ? `· Min order ₹${cp.minOrder}` : ''} ${cp.type === 'loyalty' ? '· 🎖️ Loyalty' : ''}
    </div>
    ${!cp.used ? `
    <div style="display:flex;gap:8px;margin-top:2px;">
        <button type="button" class="btn" data-coupon-action="used" data-coupon-code="${_esc(cp.code)}"
            style="flex:1;padding:9px 8px;font-size:0.76rem;justify-content:center;background:#238636;color:#fff;border:none;font-weight:700;"
            onclick="window._custMarkCouponUsed('${_esc(phone)}','${_esc(cp.code)}',this)">
            ✅ Mark as Used
        </button>
        <button type="button" class="btn btn-danger" data-coupon-action="delete" data-coupon-code="${_esc(cp.code)}"
            style="flex:1;padding:9px 8px;font-size:0.76rem;justify-content:center;"
            onclick="window._custDeleteCoupon('${_esc(phone)}','${_esc(cp.code)}',this)">
            🗑️ Delete
        </button>
    </div>` : ''}
</div>`).join('') + `</div>`;
}

// In-flight guard, keyed by coupon code — prevents a double-click (or a
// second click while the confirm dialog is open / the write is in progress)
// from firing two mark-used or delete actions for the same coupon.
const _couponActionBusy = new Set();

// Re-fetches this customer's coupons and re-renders the coupons container in
// the (still-open) detail overlay. Also drops the bulk coupons-by-phone cache
// used by the Coupons filter (see _ensureCouponsLoaded) so a later filter
// pass reflects the change instead of stale used/active data.
async function _refreshCustomerCouponsUI(phone) {
    _couponsByPhone = null;
    const el = document.getElementById('custCouponsContainer');
    if (!el) return;
    const coupons = await _fetchCustomerCoupons(phone);
    el.innerHTML = _buildCouponsHtml(coupons, phone);
}

// ── Admin: Mark coupon as used ──────────────────────────────────────────────
// Manually flips an ACTIVE coupon to USED. Writes ONLY `used` + `usedAt` —
// usedBillId/usedTable are intentionally left untouched (null), since no real
// order/bill exists for this action. This is the exact same coupons/{code}
// doc the POS redemption flow (js/cart.js) and loyalty issuer write to — no
// second coupon system, no new collection.
window._custMarkCouponUsed = async function(phone, code, btn) {
    if (_couponActionBusy.has(code)) return; // duplicate-click guard
    _couponActionBusy.add(code);

    try {
        const confirmed = await showConfirm(
            `Mark coupon ${code} as used? This does not create an order and cannot be undone.`,
            { title: 'Mark Coupon as Used', type: 'warning', confirmText: 'Mark as Used', danger: false }
        );
        if (!confirmed) return;

        if (btn) { btn.disabled = true; btn.textContent = 'Marking…'; }
        await _waitForAuth();

        // Re-check current state right before writing — guards against the
        // coupon having been redeemed at POS or already actioned by another
        // admin session while this confirm dialog was open. A claimed/
        // available coupon must never be silently flipped to used except by
        // this explicit admin action or a real POS redemption.
        const snap = await getDoc(doc(db, 'coupons', code));
        if (!snap.exists() || snap.data().used) {
            await showAlert('This coupon is no longer active — it may already be used.', 'info', 'Already Updated');
            await _refreshCustomerCouponsUI(phone);
            return;
        }

        await updateDoc(doc(db, 'coupons', code), {
            used:   true,
            usedAt: serverTimestamp(),
            // usedBillId / usedTable intentionally NOT set — no fake order.
        });

        await _refreshCustomerCouponsUI(phone);
    } catch (err) {
        console.error('[customers] Mark coupon used failed:', err);
        await showAlert('Failed to mark coupon as used: ' + err.message, 'error', 'Action Failed');
        if (btn) { btn.disabled = false; btn.textContent = '✅ Mark as Used'; }
    } finally {
        _couponActionBusy.delete(code);
    }
};

// ── Admin: Delete coupon ────────────────────────────────────────────────────
// Deletes the coupons/{code} doc after confirmation. Only touches the
// `coupons` collection — never customers/{phone} or customer_order_history,
// so orders, lifetime spend, order count, and loyalty progress are untouched.
window._custDeleteCoupon = async function(phone, code, btn) {
    if (_couponActionBusy.has(code)) return; // duplicate-click guard
    _couponActionBusy.add(code);

    try {
        const confirmed = await showConfirm(
            `Delete coupon ${code}? This removes it from the customer's coupon records and cannot be undone.`,
            { title: 'Delete Coupon', type: 'error', confirmText: 'Delete', danger: true }
        );
        if (!confirmed) return;

        if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
        await _waitForAuth();
        await deleteDoc(doc(db, 'coupons', code));

        await _refreshCustomerCouponsUI(phone);
    } catch (err) {
        console.error('[customers] Delete coupon failed:', err);
        await showAlert('Failed to delete coupon: ' + err.message, 'error', 'Action Failed');
        if (btn) { btn.disabled = false; btn.textContent = '🗑️ Delete'; }
    } finally {
        _couponActionBusy.delete(code);
    }
};

// Opens the "Send Coupon" form for a customer (amount, code, message).
window._custOpenCouponForm = function(phone) {
    const c = _customers.find(x => x.id === phone);
    const overlay = document.getElementById('custCouponOverlay');
    const body    = document.getElementById('custCouponBody');
    if (!overlay || !body) return;

    body.innerHTML = `
<div class="form-group">
    <label>Amount (₹)</label>
    <input type="number" id="couponAmountInput" placeholder="100" inputmode="numeric">
</div>
<div class="form-group">
    <label>Coupon Code</label>
    <input type="text" id="couponCodeInput" value="${_esc(_couponCodeFromName(c?.name))}" style="text-transform:uppercase;">
</div>
<div class="form-group">
    <label>Message <span style="font-weight:400;text-transform:none;font-size:0.78rem;opacity:0.55;">(optional)</span></label>
    <textarea id="couponMessageInput" rows="2" placeholder="e.g. Thanks for being a loyal customer!"></textarea>
</div>
<div style="font-size:0.75rem;color:#8b949e;margin:2px 0 16px;">Minimum order to redeem: ₹200</div>
<div id="couponSendMsg" style="font-size:0.82rem;margin-bottom:10px;min-height:16px;"></div>
<button class="btn btn-primary full-width" id="couponSendBtn" style="padding:14px;font-size:1rem;justify-content:center;" onclick="window._custSendCoupon('${_esc(phone)}')">
    🎟️ Send Coupon
</button>`;
    overlay.classList.remove('hidden');
};

window._custCloseCouponForm = function() {
    document.getElementById('custCouponOverlay')?.classList.add('hidden');
};

window._custSendCoupon = async function(phone) {
    const c = _customers.find(x => x.id === phone);
    const amount  = Number(document.getElementById('couponAmountInput')?.value || 0);
    const code    = (document.getElementById('couponCodeInput')?.value || '').trim().toUpperCase();
    const message = (document.getElementById('couponMessageInput')?.value || '').trim();
    const msgEl   = document.getElementById('couponSendMsg');
    const btn     = document.getElementById('couponSendBtn');

    if (!code)              { if (msgEl) msgEl.innerHTML = '<span style="color:#f85149;">Please enter a coupon code.</span>'; return; }
    if (!amount || amount <= 0) { if (msgEl) msgEl.innerHTML = '<span style="color:#f85149;">Please enter a valid amount.</span>'; return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    if (msgEl) msgEl.innerHTML = '';

    try {
        await _waitForAuth();
        // Guard: don't silently overwrite an existing coupon with the same code.
        const existing = await getDocs(query(collection(db, 'coupons'), where('code', '==', code)));
        if (!existing.empty) {
            if (msgEl) msgEl.innerHTML = '<span style="color:#f85149;">That code is already in use — try another.</span>';
            if (btn) { btn.disabled = false; btn.textContent = '🎟️ Send Coupon'; }
            return;
        }

        await setDoc(doc(db, 'coupons', code), {
            code,
            phone,
            name:       c?.name || '',
            amount,
            minOrder:   200,
            message,
            type:       'personalized',
            used:       false,
            usedAt:     null,
            usedBillId: null,
            usedTable:  null,
            createdAt:  serverTimestamp(),
        });

        window._custCloseCouponForm();
        await showAlert(`Coupon ${code} (₹${amount}) sent to ${c?.name || phone}!`, 'success', 'Coupon Sent');
    } catch (err) {
        console.error('[customers] Send coupon failed:', err);
        if (msgEl) msgEl.innerHTML = `<span style="color:#f85149;">Failed: ${_esc(err.message)}</span>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🎟️ Send Coupon'; }
    }
};

// ── Filter + Sort helpers — AI UPDATE [2026-09-13] ──────────────────────────
// Derives the customer's status bucket from the SAME fields already computed
// by _fetchCustomers (orderCount, lastOrderTs) — no separate/conflicting
// status system, no extra reads. Definitions (documented in AI_HANDOFF.md):
//   never ordered  → orderCount === 0
//   new             → exactly 1 completed order
//   returning       → 2+ completed orders, ordered within the last 30 days
//   inactive        → 1+ completed orders, but none in the last 30 days
function _customerStatus(c) {
    const n = c.orderCount || 0;
    if (n === 0) return 'never';
    const lastTs = c.lastOrderTs || 0;
    const daysSinceLast = lastTs ? (Date.now() - lastTs) / 86400000 : Infinity;
    if (daysSinceLast > 30) return 'inactive';
    return n === 1 ? 'new' : 'returning';
}

function _sortCustomers(list, sort) {
    const arr = list.slice();
    const byCreated = c => c.createdAt?.toMillis?.() ?? 0;
    switch (sort) {
        case 'oldest':        arr.sort((a, b) => byCreated(a) - byCreated(b)); break;
        case 'spend-high':    arr.sort((a, b) => (b.totalSpending || 0) - (a.totalSpending || 0)); break;
        case 'spend-low':     arr.sort((a, b) => (a.totalSpending || 0) - (b.totalSpending || 0)); break;
        case 'orders-most':   arr.sort((a, b) => (b.orderCount || 0) - (a.orderCount || 0)); break;
        case 'orders-least':  arr.sort((a, b) => (a.orderCount || 0) - (b.orderCount || 0)); break;
        case 'recent-order':  arr.sort((a, b) => (b.lastOrderTs || 0) - (a.lastOrderTs || 0)); break;
        // "Longest since last order" — never-ordered customers (lastOrderTs = 0)
        // sort first, since they have no order at all (the longest possible gap).
        case 'longest-since': arr.sort((a, b) => (a.lastOrderTs || 0) - (b.lastOrderTs || 0)); break;
        case 'newest':        arr.sort((a, b) => byCreated(b) - byCreated(a)); break;
        default:              arr.sort((a, b) => (b.lastOrderTs || 0) - (a.lastOrderTs || 0)); break;
    }
    return arr;
}

// Bulk-loads the `coupons` collection once (single query, same collection/
// fields used by _fetchCustomerCoupons and js/cart.js) and indexes it by
// phone in memory. Only called when the Coupons filter is actually used —
// never on every render — to avoid unnecessary Firestore reads.
async function _ensureCouponsLoaded() {
    if (_couponsByPhone) return;
    try {
        const snap = await getDocs(collection(db, 'coupons'));
        const map = new Map();
        snap.forEach(d => {
            const data  = d.data();
            const phone = data.phone;
            if (!phone) return;
            if (!map.has(phone)) map.set(phone, []);
            map.get(phone).push(data);
        });
        _couponsByPhone = map;
    } catch (err) {
        console.warn('[customers] Coupon bulk fetch failed:', err);
        _couponsByPhone = new Map(); // fail safe — treat as "no coupon data" rather than retry every render
    }
}

// Combines search + all 6 filters + sort into the final list shown. Every
// filter narrows the same array (AND semantics) so "Last 30 Days + 5,000+ +
// Most Orders" naturally returns only customers matching all three.
function _getFilteredCustomers() {
    const q = _search.toLowerCase().trim();
    let list = q
        ? _customers.filter(c =>
            (c.name  || '').toLowerCase().includes(q) ||
            (c.phone || '').includes(q)
          )
        : _customers.slice();

    const now = Date.now();
    const DAY = 86400000;

    if (_filters.joined !== 'all') {
        list = list.filter(c => {
            const ts = c.createdAt?.toMillis?.() ?? 0;
            if (!ts) return false;
            switch (_filters.joined) {
                case 'today':  return now - ts < DAY;
                case '7d':     return now - ts < 7 * DAY;
                case '30d':    return now - ts < 30 * DAY;
                case 'custom': {
                    const from = _filters.joinedFrom ? new Date(_filters.joinedFrom).getTime() : -Infinity;
                    const to   = _filters.joinedTo   ? new Date(_filters.joinedTo).getTime() + DAY - 1 : Infinity;
                    return ts >= from && ts <= to;
                }
                default: return true;
            }
        });
    }

    if (_filters.lastOrder !== 'all') {
        list = list.filter(c => {
            const ts = c.lastOrderTs || 0;
            if (_filters.lastOrder === 'never') return !ts;
            if (!ts) return false;
            switch (_filters.lastOrder) {
                case 'today':  return now - ts < DAY;
                case '7d':     return now - ts < 7 * DAY;
                case '30d':    return now - ts < 30 * DAY;
                case 'custom': {
                    const from = _filters.lastOrderFrom ? new Date(_filters.lastOrderFrom).getTime() : -Infinity;
                    const to   = _filters.lastOrderTo   ? new Date(_filters.lastOrderTo).getTime() + DAY - 1 : Infinity;
                    return ts >= from && ts <= to;
                }
                default: return true;
            }
        });
    }

    if (_filters.orders !== 'all') {
        list = list.filter(c => {
            const n = c.orderCount || 0;
            switch (_filters.orders) {
                case '0':      return n === 0;
                case '1-5':    return n >= 1 && n <= 5;
                case '6-10':   return n >= 6 && n <= 10;
                case '10+':    return n > 10;
                case 'custom': {
                    const min = _filters.ordersMin !== '' ? Number(_filters.ordersMin) : 0;
                    const max = _filters.ordersMax !== '' ? Number(_filters.ordersMax) : Infinity;
                    return n >= min && n <= max;
                }
                default: return true;
            }
        });
    }

    if (_filters.spend !== 'all') {
        list = list.filter(c => {
            const s = c.totalSpending || 0;
            switch (_filters.spend) {
                case '0':          return s === 0;
                case '1-500':      return s >= 1 && s <= 500;
                case '500-1000':   return s > 500 && s <= 1000;
                case '1000-5000':  return s > 1000 && s <= 5000;
                case '5000+':      return s > 5000;
                case 'custom': {
                    const min = _filters.spendMin !== '' ? Number(_filters.spendMin) : 0;
                    const max = _filters.spendMax !== '' ? Number(_filters.spendMax) : Infinity;
                    return s >= min && s <= max;
                }
                default: return true;
            }
        });
    }

    if (_filters.status !== 'all') {
        list = list.filter(c => _customerStatus(c) === _filters.status);
    }

    if (_filters.coupon !== 'all') {
        // Coupon data is loaded on-demand (see _ensureCouponsLoaded, called
        // from _custApplyFilters before this function runs). If it isn't
        // loaded yet for any reason, fail safe to "no matches" rather than
        // silently ignoring the filter the operator selected.
        const map = _couponsByPhone || new Map();
        list = list.filter(c => {
            const arr = map.get(c.phone || c.id) || [];
            switch (_filters.coupon) {
                case 'available': return arr.some(cp => !cp.used);
                case 'none':      return !arr.some(cp => !cp.used);
                case 'used':      return arr.some(cp => cp.used);
                // No expiry field exists anywhere in the coupons/{code} schema
                // today (see ARCHITECTURE_LOCK.md) — nothing to check against,
                // so this intentionally matches 0 customers instead of
                // inventing a new expiry concept. Surfaced to the operator via
                // #filterCouponExpiredNote in the panel.
                case 'expired':   return false;
                default:          return true;
            }
        });
    }

    return _sortCustomers(list, _filters.sort);
}

// ── List rendering — uses existing bill-card / bill-card-* classes ────────
function _renderList() {
    const listEl  = document.getElementById('customerCardList');
    const countEl = document.getElementById('customerCount');
    if (!listEl) return;

    const filtered      = _getFilteredCustomers();
    const searchActive  = !!_search.trim();
    const filtersActive = _custFiltersActive();

    if (countEl) {
        countEl.textContent = `${filtered.length} customer${filtered.length !== 1 ? 's' : ''}`;
    }

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="empty-state">${
            searchActive || filtersActive
                ? '🔍 No customers match your search/filters.'
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

// ── Filter + Sort panel — AI UPDATE [2026-09-13] ────────────────────────────
// Panel markup lives in admin/index.html (#custFilterOverlay). This module
// only reads/writes its form fields and re-runs _renderList() — it never
// touches customer history, coupon send/redeem, delete, or auth logic.

// True if any filter differs from "All", or sort differs from the default —
// used to badge the Filter button so operators can see a filter is active.
function _custFiltersActive() {
    return _filters.joined   !== DEFAULT_FILTERS.joined
        || _filters.lastOrder !== DEFAULT_FILTERS.lastOrder
        || _filters.orders    !== DEFAULT_FILTERS.orders
        || _filters.spend     !== DEFAULT_FILTERS.spend
        || _filters.status    !== DEFAULT_FILTERS.status
        || _filters.coupon    !== DEFAULT_FILTERS.coupon
        || _filters.sort      !== DEFAULT_FILTERS.sort;
}

function _updateFilterButtonBadge() {
    document.getElementById('custFilterBtn')?.classList.toggle('active', _custFiltersActive());
}

// Shows/hides the "Custom …" range rows and the coupon-expired note based on
// the CURRENT (unsaved) select values in the open panel — called on every
// select change, before Apply is pressed.
function _updateCustomRangeVisibility() {
    const toggle = (selectId, rowId) => {
        const sel = document.getElementById(selectId);
        const row = document.getElementById(rowId);
        if (sel && row) row.classList.toggle('hidden', sel.value !== 'custom');
    };
    toggle('filterJoined',    'filterJoinedRangeRow');
    toggle('filterLastOrder', 'filterLastOrderRangeRow');
    toggle('filterOrders',    'filterOrdersRangeRow');
    toggle('filterSpend',     'filterSpendRangeRow');

    const couponSel  = document.getElementById('filterCoupon');
    const couponNote = document.getElementById('filterCouponExpiredNote');
    if (couponSel && couponNote) couponNote.classList.toggle('hidden', couponSel.value !== 'expired');
}

// Writes the in-memory _filters state back into the form fields — used when
// opening the panel (so it reflects the last-Applied filters) and on Reset.
function _syncFilterFormFromState() {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
    set('filterJoined',        _filters.joined);
    set('filterJoinedFrom',    _filters.joinedFrom);
    set('filterJoinedTo',      _filters.joinedTo);
    set('filterLastOrder',     _filters.lastOrder);
    set('filterLastOrderFrom', _filters.lastOrderFrom);
    set('filterLastOrderTo',   _filters.lastOrderTo);
    set('filterOrders',        _filters.orders);
    set('filterOrdersMin',     _filters.ordersMin);
    set('filterOrdersMax',     _filters.ordersMax);
    set('filterSpend',         _filters.spend);
    set('filterSpendMin',      _filters.spendMin);
    set('filterSpendMax',      _filters.spendMax);
    set('filterStatus',        _filters.status);
    set('filterCoupon',        _filters.coupon);
    set('filterSort',          _filters.sort);
    _updateCustomRangeVisibility();
}

window._custOpenFilters = function() {
    _syncFilterFormFromState();
    document.getElementById('custFilterOverlay')?.classList.remove('hidden');
};

window._custCloseFilters = function() {
    document.getElementById('custFilterOverlay')?.classList.add('hidden');
};

// Called from each filter <select>'s onchange — only toggles which "Custom
// range" rows are visible. Does not apply the filter yet (Apply does that).
window._custFilterFieldChange = function() {
    _updateCustomRangeVisibility();
};

window._custResetFilters = function() {
    _filters = _DEFAULT_FILTERS_CLONE();
    _syncFilterFormFromState();
    _updateFilterButtonBadge();
    _renderList();
};

window._custApplyFilters = async function() {
    const val = id => document.getElementById(id)?.value ?? '';

    _filters = {
        joined:        val('filterJoined'),
        joinedFrom:    val('filterJoinedFrom'),
        joinedTo:      val('filterJoinedTo'),
        lastOrder:     val('filterLastOrder'),
        lastOrderFrom: val('filterLastOrderFrom'),
        lastOrderTo:   val('filterLastOrderTo'),
        orders:        val('filterOrders'),
        ordersMin:     val('filterOrdersMin'),
        ordersMax:     val('filterOrdersMax'),
        spend:         val('filterSpend'),
        spendMin:      val('filterSpendMin'),
        spendMax:      val('filterSpendMax'),
        status:        val('filterStatus'),
        coupon:        val('filterCoupon'),
        sort:          val('filterSort') || DEFAULT_FILTERS.sort,
    };

    // Coupon data is only fetched (once, cached) when actually needed.
    if (_filters.coupon !== 'all') {
        const btn = document.getElementById('custFilterApplyBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
        await _ensureCouponsLoaded();
        if (btn) { btn.disabled = false; btn.textContent = 'APPLY'; }
    }

    _updateFilterButtonBadge();
    window._custCloseFilters();
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
    // Password row — shows stored passwordHash with a show/hide eye toggle.
    // passwordHash is a SHA-256 hex string (not the raw password).
    const pwHash = c.passwordHash || '';
    const passwordRowHtml = pwHash ? `
<div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;">
    <span style="font-size:0.75rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;">Password</span>
    <span id="custPwHidden" style="font-size:0.9rem;color:#6b7280;letter-spacing:3px;flex:1;">••••••••</span>
    <span id="custPwValue" style="font-size:0.78rem;color:#c9d1d9;font-family:monospace;word-break:break-all;flex:1;display:none;">${_esc(pwHash)}</span>
    <button type="button" id="custPwToggle" title="Show / hide password"
        onclick="window._custTogglePassword()"
        style="background:none;border:1.5px solid #30363d;border-radius:6px;cursor:pointer;color:#6b7280;font-size:0.9rem;padding:3px 8px;line-height:1;flex-shrink:0;transition:color 0.2s,border-color 0.2s;"
        onmouseover="this.style.color='#f97316';this.style.borderColor='#f97316'"
        onmouseout="this.style.color='#6b7280';this.style.borderColor='#30363d'">👁</button>
</div>` : '';

    const headerHtml = `
<!-- Profile header -->
<div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #30363d;">
    <div class="cust-av cust-av-lg">${_avatarLetter(c.name)}</div>
    <div style="min-width:0;flex:1;">
        <div style="font-size:1.15rem;font-weight:800;color:#e6edf3;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(c.name || 'Unknown')}</div>
        <div style="font-size:0.92rem;color:#58a6ff;letter-spacing:0.2px;">${_esc(c.phone || c.id)}</div>
        ${passwordRowHtml}
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

    const recoveryHtml = `
<!-- AI UPDATE [2026-09-11]: Staff-assisted password recovery -->
<div style="padding:16px 0 0;">
    <button class="btn full-width" style="padding:14px;font-size:1rem;justify-content:center;background:#1f6feb;color:#fff;border:none;"
        onclick="window._custGenerateRecovery('${_esc(c.id)}')">
        🔑 Generate Recovery Code
    </button>
    <div style="font-size:0.75rem;color:#8b949e;margin-top:8px;line-height:1.5;">
        Read the code out to the customer. They set their own new password on their device. Valid 10 minutes, single use.
    </div>
</div>`;

    // AI UPDATE [2026-09-12]: Send Coupon button + coupons list.
    const couponBtnHtml = `
<div style="padding:16px 0 0;">
    <button class="btn full-width" style="padding:14px;font-size:1rem;justify-content:center;background:#d29922;color:#0d1117;border:none;font-weight:800;"
        onclick="window._custOpenCouponForm('${_esc(c.id)}')">
        🎟️ Send Personalized Coupon
    </button>
</div>
<div class="list-title" style="margin-top:16px;margin-bottom:12px;">Coupons</div>
<div id="custCouponsContainer"><div class="loading-state">Loading coupons… ☁️</div></div>`;

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
}</div>` + couponBtnHtml + recoveryHtml + deleteHtml;
    overlay.classList.remove('hidden');

    // Phase 2 — fetch history if not yet loaded, then update the container
    if (!c._historyLoaded) {
        await _loadCustomerHistory(c);
        const container = document.getElementById('custHistoryContainer');
        if (container) container.innerHTML = _buildOrdersHtml(c.orders);
    }

    // Phase 3 — fetch this customer's coupons (loyalty + personalized)
    _fetchCustomerCoupons(c.id).then(coupons => {
        const el = document.getElementById('custCouponsContainer');
        if (el) el.innerHTML = _buildCouponsHtml(coupons, c.id);
    });
};

window._custCloseDetail = function() {
    document.getElementById('custDetailOverlay')?.classList.add('hidden');
};

// Toggle show/hide for the customer's stored passwordHash in the detail overlay.
// Uses the same show/hide idiom as the login password toggle in customer.html.
window._custTogglePassword = function() {
    const valEl    = document.getElementById('custPwValue');
    const hiddenEl = document.getElementById('custPwHidden');
    const btnEl    = document.getElementById('custPwToggle');
    if (!valEl || !hiddenEl) return;
    const isHidden = valEl.style.display === 'none';
    valEl.style.display    = isHidden ? '' : 'none';
    hiddenEl.style.display = isHidden ? 'none' : '';
    if (btnEl) btnEl.textContent = isHidden ? '🙈' : '👁';
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
    // AI UPDATE [2026-09-13]: Drop the cached coupon-by-phone map so a manual
    // refresh re-reads current coupon state (used/available) if the Coupons
    // filter is applied again — otherwise a coupon sent/redeemed after the
    // first filter use would show stale results indefinitely.
    _couponsByPhone = null;
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


// ══════════════════════════════════════════════════════════════════════════
// STAFF-ASSISTED PASSWORD RECOVERY  (AI UPDATE [2026-09-11])
//
// Staff press "Generate Recovery Code" on a customer. The Cloudflare Worker
// (server-side, Firebase Admin credentials) computes the code — the last 4
// digits of that customer's own registered phone number — stores ONLY its
// hash in customer_recovery/{phone}, and returns the plain code once for
// display here. Staff read it out verbally.
//
// Staff never see nor set the customer's new password — the customer enters
// the code on their own device and chooses the password themselves.
// ══════════════════════════════════════════════════════════════════════════

const RECOVERY_FN_BASE = 'https://pizza-billing-functions.mishrarnav142.workers.dev';
let _recoveryTimer = null;

async function _callRecoveryFn(fnName, payload) {
    const res  = await fetch(`${RECOVERY_FN_BASE}/${fnName}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data: payload }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Request failed (${res.status})`);
    return json.result;
}

// AI UPDATE [2026-09-13]: Exported so other Billing Panel modules (the
// Incoming Orders drawer's new "Customers" tab — js/incoming-orders-customers.js)
// can call the exact same Worker endpoints for staff-assisted recovery instead
// of duplicating this fetch/security logic. Nothing above this line changed;
// window._custGenerateRecovery below (the Admin Panel's own button) is untouched.
export { _callRecoveryFn as callRecoveryFn };

window._custGenerateRecovery = async function(phone) {
    const c = _customers.find(x => x.id === phone);
    const overlay = document.getElementById('custRecoveryOverlay');
    const body    = document.getElementById('custRecoveryBody');
    if (!overlay || !body) return;

    body.innerHTML = `<div class="loading-state">Generating secure code… 🔐</div>`;
    overlay.classList.remove('hidden');

    try {
        const r = await _callRecoveryFn('generateRecoveryCode', {
            phone,
            pin: window.__OPERATOR_PIN || '',
        });

        body.innerHTML = `
<div style="text-align:center;padding:8px 0 4px;">
    <div style="font-size:0.72rem;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:1px;">Recovery Code</div>
    <div style="font-size:2.6rem;font-weight:900;color:#3fb950;letter-spacing:10px;margin:10px 0 6px;font-family:monospace;">${_esc(r.code)}</div>
    <div style="font-size:0.95rem;color:#e6edf3;font-weight:700;">${_esc(r.name || c?.name || 'Customer')}</div>
    <div style="font-size:0.9rem;color:#58a6ff;margin-top:2px;">${_esc(r.phone || phone)}</div>
    <div id="custRecoveryTtl" style="font-size:0.85rem;color:#d29922;margin-top:12px;font-weight:700;">Expires in 10:00</div>
    <div style="font-size:0.78rem;color:#8b949e;margin-top:14px;line-height:1.6;">
        Tell this code to the customer. They enter it on their own device and create their own new password.<br>
        <strong style="color:#f0883e;">Never ask the customer for their password.</strong>
    </div>
</div>`;

        // Live countdown — display only; the Worker enforces the real expiry.
        clearInterval(_recoveryTimer);
        const endAt = Number(r.expiresAt) || (Date.now() + 10 * 60 * 1000);
        const tick = () => {
            const el = document.getElementById('custRecoveryTtl');
            if (!el) { clearInterval(_recoveryTimer); return; }
            const left = Math.max(0, Math.floor((endAt - Date.now()) / 1000));
            const m = String(Math.floor(left / 60)).padStart(2, '0');
            const sec = String(left % 60).padStart(2, '0');
            el.textContent = left ? `Expires in ${m}:${sec}` : 'Code expired — generate a new one';
            if (!left) { el.style.color = '#f85149'; clearInterval(_recoveryTimer); }
        };
        tick();
        _recoveryTimer = setInterval(tick, 1000);

    } catch (err) {
        body.innerHTML = `<div class="empty-state">⚠️ Could not generate code.<br><small style="color:#8b949e">${_esc(err.message)}</small></div>`;
    }
};

window._custCloseRecovery = function() {
    clearInterval(_recoveryTimer);
    document.getElementById('custRecoveryOverlay')?.classList.add('hidden');
    const body = document.getElementById('custRecoveryBody');
    if (body) body.innerHTML = '';   // never leave a code on screen
};

// AI UPDATE [2026-09-21]: Exported so the POS Billing Panel's new "View
// History" button (Customer Offers modal → js/pos-customer-history.js) can
// render the SAME order-history data/markup as this Admin Panel detail
// overlay, instead of duplicating the fetch or the HTML — same pattern as
// the `callRecoveryFn` re-export above for js/incoming-orders-customers.js.
// Nothing above this line changed.
export {
    _buildOrdersHtml as buildOrdersHtml,
    _esc as escHtml,
    _fmtDate as fmtDate,
    _fmtRupee as fmtRupee,
    _avatarLetter as avatarLetter,
};

// Standalone fetch for ONE customer's profile + order history — reads the
// exact same `customers/{phone}` doc and `customer_order_history/{uid}/orders`
// subcollection as _loadCustomerHistory() above (same uid/authUid
// resolution, same totalOrders/lifetimeSpend/lastOrderAt fast-path fields,
// same completedAt sort) — just callable directly by phone, since the POS
// only ever needs ONE customer at a time and never loads the full
// Customer Management `_customers` list.
export async function fetchCustomerHistoryData(phone) {
    if (!phone) return null;
    const snap = await getDoc(doc(db, 'customers', phone));
    if (!snap.exists()) return null;

    const c = { id: phone, ...snap.data() };
    const resolvedUid = c.uid || c.authUid || '';

    let orders = [];
    if (resolvedUid) {
        try {
            const ordSnap = await getDocs(
                collection(db, `customer_order_history/${resolvedUid}/orders`)
            );
            ordSnap.forEach(od => orders.push({ id: od.id, ...od.data() }));
            orders.sort((a, b) => (b.completedAt?.toMillis?.() ?? 0) - (a.completedAt?.toMillis?.() ?? 0));
        } catch { orders = []; }
    }

    const orderCount    = typeof c.totalOrders === 'number' ? c.totalOrders : orders.length;
    const totalSpending = typeof c.lifetimeSpend === 'number' ? c.lifetimeSpend
                         : orders.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const lastOrderTs   = c.lastOrderAt?.toMillis?.() ?? (orders[0]?.completedAt?.toMillis?.() ?? 0);
    const joinedTs      = c.createdAt?.toMillis?.() ?? 0;

    return {
        id: phone,
        name: c.name || 'Unknown',
        phone: c.phone || phone,
        orderCount,
        totalSpending,
        lastOrderTs,
        joinedTs,
        orders,
    };
}
