// AI UPDATE [2026-09-16]: NEW FILE — "Edit History" feature.
// AI UPDATE [2026-09-16] round 2: window.editHistoryOrder() is now callable
// from ANY page that loads this file — the Admin Sales tab (admin/index.html),
// the standalone bill-details page (details.html), AND the History drawer
// inside the POS page itself (index.html) — see the note above
// window.editHistoryOrder below for why that last one needs different
// handling than the first two.
//
// PROBLEM: the Admin Sales tab (admin/index.html, js/admin.js) and
// details.html are separate pages from the POS (index.html, js/cart.js +
// js/tables.js). "Edit History"/"Edit" can be clicked from any of them, but
// the order must always be reopened in the POS page's cart. This module is
// the bridge, using localStorage (same-origin, visible across all pages of
// this app) to hand off which order to load when a redirect is needed.
//
// FLOW (from the Admin page or details.html — a different page than the POS):
//   1. operator taps "Edit History"/"✏️ Edit" → window.editHistoryOrder(saleId)
//      stores a small { saleId } flag in localStorage and navigates to index.html.
//   2. POS page loads: this module checks for that flag. If present, it
//      fetches the sales_history/{saleId} record, reconstructs the cart and
//      customer identity into a synthetic, per-order table name
//      ("EditOrder-<saleId>"), sets the editingOrder_<table>_<slot> flag that
//      js/cart.js's Bill & Settle / Save & Exit handlers check for (see the
//      "EDIT HISTORY" comment block near the top of js/cart.js), and opens
//      the existing POS cart screen via the already-exposed
//      window._posOpenTable() hook (js/tables.js) — no new POS UI is built;
//      the existing cart screen is reused exactly as-is.
//
// FLOW (from the POS page's own History drawer — same page as the cart):
//   No redirect needed or possible (there's nowhere else to navigate to) —
//   window.editHistoryOrder(saleId) loads the order directly, in place.
//
// SCOPE: this file only ever runs on the Billing/POS app's own pages (never
// on the customer-facing Order- app), so "Edit History" is inherently
// unreachable by customers — satisfies the authorization requirement without
// any new auth code.
//
// This module makes NO changes to any frozen system — it only reads/writes
// the same localStorage keys and Firestore collections js/cart.js already
// owns, using the exact key formats/shapes it already uses.
import { db, auth } from './firebase-config.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

const PENDING_EDIT_KEY = 'pendingOrderEdit';

// Per architecture rule (ARCHITECTURE_LOCK.md §7 item 15): any module that
// reads/writes Firestore bootstraps signInAnonymously() and gates on
// onAuthStateChanged. Every page here already has its own anonymous session
// by the time this runs in practice, but this keeps the module correct/safe
// on its own regardless of load order.
signInAnonymously(auth).catch(() => {}); // no-op if already signed in

// window.editHistoryOrder is defined unconditionally (not gated by page
// type) so the exact same button/onclick works from admin/index.html,
// details.html, and index.html's own History drawer.
window.editHistoryOrder = function (saleId) {
    if (!saleId) return;
    if (typeof window._posOpenTable === 'function') {
        // We're already ON the POS page (e.g. clicked from the History
        // drawer on index.html itself) — load directly, no redirect needed.
        _loadOrderForEdit(saleId);
        return;
    }
    // We're on a different page (admin/index.html or details.html) —
    // hand off via localStorage and navigate to the POS page.
    localStorage.setItem(PENDING_EDIT_KEY, JSON.stringify({ saleId }));
    const posPath = window.location.pathname.includes('/admin/') ? '../index.html' : 'index.html';
    window.location.href = posPath;
};

document.addEventListener('DOMContentLoaded', () => {
    // Only the POS page can actually pick up a pending handoff (it's the
    // only page with window._posOpenTable / a cart to load into).
    if (document.getElementById('activeTableName')) {
        _checkPendingEdit();
    }
});

// ── Pick up a handoff flag left by editHistoryOrder() on a different page ──
function _checkPendingEdit() {
    let raw;
    try { raw = localStorage.getItem(PENDING_EDIT_KEY); } catch (_) { raw = null; }
    if (!raw) return;

    // Consume the flag immediately so refreshing the POS page never re-triggers it.
    localStorage.removeItem(PENDING_EDIT_KEY);

    let saleId;
    try { saleId = JSON.parse(raw).saleId; } catch (_) { saleId = null; }
    if (!saleId) return;

    const unsubscribe = onAuthStateChanged(auth, (user) => {
        if (!user) return;
        unsubscribe(); // one-shot — only need to load the order once auth is ready
        _loadOrderForEdit(saleId);
    });
}

async function _loadOrderForEdit(saleId) {
    let sale;
    try {
        const snap = await getDoc(doc(db, 'sales_history', saleId));
        if (!snap.exists()) {
            console.warn('[EditHistory] Order not found:', saleId);
            return;
        }
        sale = snap.data();
    } catch (err) {
        console.error('[EditHistory] Failed to load order:', err);
        return;
    }

    // Synthetic, per-order table name — unique per saleId so it can never
    // collide with a real "Table N"/"Parcel X", and always resolves back to
    // the same slot if the operator navigates away and reopens the same
    // order for editing again before settling it. Underscores are stripped
    // from saleId (e.g. "SALE_123") so this table name always has exactly
    // one underscore itself, same as a real "Table 3"/"Parcel A" — safe for
    // any existing code that does `key.split('_')` on a cart_<table>_<slot>
    // localStorage key (e.g. js/tables.js renderRunningOrders()).
    const editTable = `EditOrder-${saleId.replace(/_/g, '-')}`;
    const slot = 'C1';

    // 1. Restore the cart items exactly as they were saved (same item shape
    //    cart.js already reads/writes: id, name, price, qty, extras, etc.).
    localStorage.setItem(`cart_${editTable}_${slot}`, JSON.stringify(sale.items || []));

    // 2. Restore customer identity WITHOUT asking for it again.
    if (sale.onlineCustomerUid) {
        // QR / online customer — mirrors what "Open in POS" already writes,
        // so syncCustomerOrderCompletion() in js/cart.js needs no special
        // casing to recognize this slot as belonging to that customer.
        localStorage.setItem(`activeCustomerUid_${editTable}_${slot}`, sale.onlineCustomerUid);
        localStorage.setItem(`customerName_${editTable}_${slot}`, sale.onlineCustomerName || 'Customer');
        if (sale.onlineCustomerPhone) {
            localStorage.setItem(`customerPhone_${editTable}_${slot}`, sale.onlineCustomerPhone);
        }
    } else if (sale.manualCustomerPhone) {
        // Manually-captured POS customer — pre-resolve the identity popup so
        // it never re-appears (js/cart.js reads this exact key/shape).
        const phoneDigits = String(sale.manualCustomerPhone).replace(/^\+91/, '');
        localStorage.setItem(
            `manualCustomerIdentity_${editTable}_${slot}`,
            JSON.stringify({ name: sale.manualCustomerName || '', phone: phoneDigits })
        );
        localStorage.setItem(`customerName_${editTable}_${slot}`, sale.manualCustomerName || 'Customer');
        localStorage.setItem(`customerPhone_${editTable}_${slot}`, sale.manualCustomerPhone);
    }
    // Anonymous/walk-in order (neither field present): nothing to restore —
    // editing behaves exactly like any new manual bill on this slot.

    // AI UPDATE [2026-09-20]: restore a Custom Instant Discount so re-settling the edited order
    // keeps it (js/cart.js re-validates it against the edited cart and drops it, with a notice,
    // if it no longer fits). Same key/shape cart.js reads: customDiscount_<table>_<slot> = {amount}.
    if (Number(sale.customDiscount) > 0) {
        localStorage.setItem(`customDiscount_${editTable}_${slot}`, JSON.stringify({ amount: Number(sale.customDiscount) }));
    }

    // AI UPDATE [2026-09-16] session 5 — CUSTOMER STATS BUG FIX:
    // hadCustomer records whether THIS order already had a customer identity
    // attached BEFORE this edit session. This is the missing signal that
    // caused the bug: js/cart.js's edit-mode stats branch was applying a
    // DELTA (new total − old total) unconditionally whenever `_editMode`
    // existed, with no way to tell "editing an order that already belonged
    // to this customer" (delta is correct) apart from "attaching a customer
    // to a previously-anonymous order for the first time" (the FULL total
    // should count, since this customer never got any prior credit for this
    // order). See the matching fix in js/cart.js Bill & Settle / Save & Exit.
    const hadCustomer = !!(sale.onlineCustomerUid || sale.manualCustomerPhone);

    // 3. Flag this slot as an edit-in-progress — js/cart.js's Bill & Settle /
    //    Save & Exit handlers check for this to update the ORIGINAL record
    //    instead of creating a new one (see js/cart.js "EDIT HISTORY" block).
    localStorage.setItem(
        `editingOrder_${editTable}_${slot}`,
        JSON.stringify({ orderId: saleId, originalTotal: Number(sale.total) || 0, hadCustomer })
    );

    // 4. Open the existing POS cart screen — no new UI, same screen every
    //    other order (QR import, walk-in, etc.) already opens into.
    if (typeof window._posOpenTable === 'function') {
        window._posOpenTable(editTable, slot);
    } else {
        console.warn('[EditHistory] window._posOpenTable not available yet.');
    }
}
