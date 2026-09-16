// AI UPDATE [2026-09-16]: NEW FILE — "Edit History" feature.
//
// PROBLEM: the Admin Sales tab (admin/index.html, js/admin.js) and the POS
// (index.html, js/cart.js + js/tables.js) are two SEPARATE pages of the same
// static site. "Edit History" is clicked on a bill card in the Admin page,
// but the order must be reopened in the POS page's cart. This module is the
// bridge between them, using localStorage (same-origin, so visible across
// both pages) to hand off which order to load.
//
// FLOW:
//   1. Admin page: operator taps "Edit History" on a sales_history bill card
//      → window.editHistoryOrder(saleId) (defined here) stores a small
//        { saleId } flag in localStorage and navigates to the POS page.
//   2. POS page: on load, this module checks for that flag. If present, it
//      fetches the sales_history/{saleId} record, reconstructs the cart and
//      customer identity into a synthetic, per-order table name
//      ("EditOrder_<saleId>"), sets the editingOrder_<table>_<slot> flag that
//      js/cart.js's Bill & Settle / Save & Exit handlers check for (see the
//      "EDIT HISTORY" comment block near the top of js/cart.js), and opens
//      the existing POS cart screen via the already-exposed
//      window._posOpenTable() hook (js/tables.js) — no new POS UI is built;
//      the existing cart screen is reused exactly as-is.
//
// SCOPE: this file only ever runs on the Billing/Admin panel (never on the
// customer-facing Order- app), so "Edit History" is inherently unreachable
// by customers — satisfies the authorization requirement without any new
// auth code.
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
// onAuthStateChanged. Both pages already have their own anonymous session by
// the time this runs in practice, but this keeps the module correct/safe on
// its own regardless of load order.
signInAnonymously(auth).catch(() => {}); // no-op if already signed in

document.addEventListener('DOMContentLoaded', () => {
    const isPOSPage = !!document.getElementById('activeTableName');
    if (isPOSPage) {
        initPOSSide();
    } else {
        initAdminSide();
    }
});

// ── Admin side: "Edit History" button on a Sales tab bill card ─────────────
function initAdminSide() {
    window.editHistoryOrder = function (saleId) {
        if (!saleId) return;
        localStorage.setItem(PENDING_EDIT_KEY, JSON.stringify({ saleId }));
        // admin/index.html → ../index.html is the POS app's location.
        window.location.href = '../index.html';
    };
}

// ── POS side: pick up the handoff flag and load the order into the cart ────
function initPOSSide() {
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

    // 3. Flag this slot as an edit-in-progress — js/cart.js's Bill & Settle /
    //    Save & Exit handlers check for this to update the ORIGINAL record
    //    instead of creating a new one (see js/cart.js "EDIT HISTORY" block).
    localStorage.setItem(
        `editingOrder_${editTable}_${slot}`,
        JSON.stringify({ orderId: saleId, originalTotal: Number(sale.total) || 0 })
    );

    // 4. Open the existing POS cart screen — no new UI, same screen every
    //    other order (QR import, walk-in, etc.) already opens into.
    if (typeof window._posOpenTable === 'function') {
        window._posOpenTable(editTable, slot);
    } else {
        console.warn('[EditHistory] window._posOpenTable not available yet.');
    }
}
