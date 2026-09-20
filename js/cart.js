// AI UPDATE [2026-09-20]: Added CUSTOM INSTANT DISCOUNT — a flat ₹ order-level
// discount typed by staff. It is folded into the SAME authoritative pricing
// calculation the coupon already uses (see _computePricing() below), so the cart
// UI, Bill & Settle, Save & Exit, printed bill, sales_history and customer
// history all read one final total. See the "CUSTOM INSTANT DISCOUNT" block
// near _getRedeemableCoupon() and AI_HANDOFF.md for the full design.
// AI UPDATE [2026-09-13]: Added the "Customer Coupons" panel — tapping the
// online customer name badge in Order Details shows that customer's
// available/unused coupons (Copy / Apply). Reuses the existing coupons/{code}
// collection, phone-based query pattern, and #couponCodeInput/#applyCouponBtn
// validation logic unchanged. See the block near getCustomerPhoneKey() below.
import { db, functions } from './firebase-config.js';
import { doc, setDoc, updateDoc, serverTimestamp, getDocs, getDoc, query, where, collection, increment } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";
// AI UPDATE [2026-07-30]: Import receipt builder for ESC/POS bill printing.
import { initReceiptPrinter, buildBillReceipt } from './receipt-builder.js';
// AI UPDATE [2026-07-30]: Import custom dialog system — replaces alert()/confirm().
import { showAlert, showConfirm, showCustomerDetailsPopup } from './dialog.js';

// NOTE [2026-09-13]: The two historical session notes immediately below (dated
// 2026-07-28) describe the ORIGINAL table-only-scoped implementation and are
// kept for audit history only — they no longer describe current behavior.
// The keys they mention (activeCustomerUid_<table>, acceptedOrderIds_<table>)
// are now scoped per (table, customer slot) — see the up-to-date header comment
// directly above the syncCustomerOrderCompletion() function definition below,
// and AI_HANDOFF.md, for the current, correct design.
//
// ===== AI UPDATE =====
// Date: 2026-07-28
// Feature: Customer Order History Sync — Order Completion
// Summary:
// When the operator presses "Bill & Settle" or "Save & Exit", if the current
// table had an order from the Customer Panel (identified by the
// activeCustomerUid_<table> key that incoming-orders.js writes to localStorage
// when an order is accepted), this module:
//   1. Marks all active pending_table_orders docs for that table as 'completed'
//      → the customer's Active Orders view (which filters on status) updates in
//      real time without a page refresh.
//   2. Writes a completed-order record to:
//        customer_order_history/{customerUid}/orders/ORDER_{timestamp}
//      → the customer's Order History tab reads this subcollection.
//   3. Clears the localStorage convenience-cache keys for that table so the
//      next manual order on the same table starts clean.
//
// IMPORTANT — does NOT affect manual/walk-in orders:
//   The sync is gated on activeCustomerUid_<table> being present in
//   localStorage.  Manual bills (no Customer Panel order) never set that key,
//   so syncCustomerOrderCompletion() returns immediately without any Firestore
//   write.  All existing billing logic is untouched.
//
// Firestore collections written:
//   - pending_table_orders/{orderId}  update  { status:'completed', completedAt }
//   - customer_order_history/{uid}/orders/{orderId}  set  { full order record }
//
// Corresponding Firestore rules (see firestore.rules):
//   - pending_table_orders update: 'completed' added to isAllowedStatusUpdate()
//   - customer_order_history: operator can write, customer can read their own
//
// Customer Panel (Order- repo) changes needed:
//   - Replace js/order-status.js with the version in order-panel-updates/
//     (see that file for the full active-orders + history listener implementation)
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-28 (v2)
// Bug fix: Issue 2 — Two pending cards from same table; accepting one caused the other to disappear.
//
// Root cause:
//   syncCustomerOrderCompletion queried ALL pending/active orders for the table
//   (where('tableId', '==', tableName)) and marked EVERY active one as 'completed'.
//   When the operator accepted Card A and then billed it, the sync function also
//   marked Card B (still pending, never imported) as 'completed' — removing it
//   from the incoming-orders drawer permanently.
//
// Fix:
//   incoming-orders.js v9 now writes the specific Firestore document IDs that
//   were imported via "Open in POS" to localStorage key:
//     acceptedOrderIds_<tableName>  (JSON array, accumulates across multiple accepts)
//   This function now reads that list and marks ONLY those specific orders as
//   'completed'.  Other pending cards for the same table are left untouched so
//   the operator can process them independently.
//   Fallback: if the key is absent (manual/walk-in billing, or pre-fix sessions),
//   the original behavior (mark all active docs) is preserved for safety.
//   acceptedOrderIds_<tableName> is cleared in Step 3 alongside other keys.
// =====================

// ═══════════════════════════════════════════════════════════════════════════
// AI UPDATE [2026-09-12]: COUPON SYSTEM
//
// 1. Loyalty auto-issue: a customer who reaches LOYALTY_MIN_ORDERS completed
//    orders AND LOYALTY_MIN_SPEND lifetime spend automatically receives a
//    one-time coupon (LOYALTY_AMOUNT off, LOYALTY_MIN_REDEEM minimum order to
//    redeem). Issued exactly once per customer via the milestoneCouponIssued
//    flag on customers/{phone} — checked by _maybeIssueLoyaltyCoupon(), called
//    right after syncCustomerOrderCompletion() increments totalOrders/lifetimeSpend.
//
// 2. Personalized coupons: sent manually by the operator from the Customer
//    Management panel (js/customers.js) — same coupons/{code} collection,
//    type: 'personalized'.
//
// 3. Redemption: handled entirely in the Bill & Settle / Save & Exit handlers
//    below (coupon apply UI + verification + marking used).
//
// Firestore collection: coupons/{code}
//   { code, phone, name, amount, minOrder, message, type, used, usedAt,
//     usedBillId, usedTable, createdAt }
//
// [AI UPDATE 2026-09-12] session 2 — coupon-system audit fix:
//   a) COUPON SECTION GATING (new): the whole coupon box (input + Apply
//      button) is now disabled with the message "Available after ₹200
//      order subtotal" whenever the pre-discount cart subtotal is not
//      STRICTLY GREATER than ₹200 — enforced in _updateCouponUI() below,
//      driven off the same rawTotal every renderCart() already passes it.
//      NOTE — discrepancy on purpose, not silently resolved: every coupon
//      document's own `minOrder` field (and LOYALTY_MIN_REDEEM) already
//      used a ₹200-OR-MORE convention (rawTotal >= minOrder) before this
//      fix, and that per-coupon check is left exactly as-is so previously
//      issued coupons keep behaving the way their "Minimum order to
//      redeem: ₹200" messaging already promised. Only the NEW section-level
//      gate uses the strict "> ₹200" rule as explicitly requested. If this
//      inconsistency (>200 to open the box, >=200 for a specific coupon to
//      redeem) is not desired, tell a future agent which convention should
//      win and both call sites can be unified in one pass.
//   b) PERSONALIZED-COUPON CUSTOMER BINDING (bug fix): the Apply button
//      handler previously verified a coupon existed, was unused, and met
//      minOrder — but NEVER checked `coupons/{code}.phone` against the
//      customer actually seated at this table/slot. Any operator could
//      apply Customer A's personalized coupon to Customer B's bill. Fixed
//      by comparing cp.phone against a new customerPhone_<table>_<slot>
//      localStorage key (mirrors the existing customerName_ key), written
//      by this repo's js/incoming-orders.js "Open in POS" import —
//      see that file for the corresponding change. A coupon with no phone
//      on it (none currently exist, but kept forward-compatible in case a
//      future "global" coupon type is added) is treated as usable by anyone.
// ═══════════════════════════════════════════════════════════════════════════
const LOYALTY_MIN_ORDERS = 10;
const LOYALTY_MIN_SPEND  = 1000;
const LOYALTY_AMOUNT     = 100;
const LOYALTY_MIN_REDEEM = 200;
// [AI UPDATE 2026-09-12] session 2: minimum PRE-COUPON subtotal required before the
// coupon section itself becomes usable at all (strict >, see note above).
const COUPON_SECTION_MIN_SUBTOTAL = 200;

// ═══════════════════════════════════════════════════════════════════════════
// AI UPDATE [2026-09-16]: EDIT HISTORY — order-edit-mode helpers
//
// "Edit History" (admin/index.html Sales tab → js/order-edit.js) reopens an
// already-completed sales_history record in this SAME POS cart under a
// synthetic, per-order table name ("EditOrder_<saleId>") so the existing
// cart UI, KOT, and coupon logic all work completely unmodified. The ONLY
// thing that changes is what happens at Bill & Settle / Save & Exit time:
// instead of creating a brand-new sales_history / customer_order_history
// record, the existing ones (same document ID) are updated in place, and
// customer lifetime-spend is adjusted by the DELTA rather than re-added in
// full — see the edit-mode branches inside the Bill & Settle / Save & Exit
// handlers and inside syncCustomerOrderCompletion() / syncManualCustomerProfile()
// below. This is additive only — every existing (non-edit) code path is
// byte-for-byte unchanged when no edit-mode flag is present for the slot.
//
// Flag shape (localStorage, key: editingOrder_<table>_<slot>):
//   { orderId: string, originalTotal: number, hadCustomer: boolean }
// Written by js/order-edit.js when it loads a sales_history record into the
// cart; read here; cleared here once the edit is actually settled/saved.
// ═══════════════════════════════════════════════════════════════════════════
function _editModeKey(tableName, customerSlot) {
    return `editingOrder_${tableName}_${customerSlot}`;
}
function _getEditMode(tableName, customerSlot) {
    try {
        const raw = localStorage.getItem(_editModeKey(tableName, customerSlot));
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}
function _clearEditMode(tableName, customerSlot) {
    localStorage.removeItem(_editModeKey(tableName, customerSlot));
}

// AI UPDATE [2026-09-16] session 5 — CUSTOMER STATS BUG FIX.
//
// ROOT CAUSE: syncCustomerOrderCompletion()/syncManualCustomerProfile()'s
// `editContext` param (added session 4) was passed whenever `_editMode`
// existed, full stop — i.e. "an edit is happening" was treated as identical
// to "this order already contributed to this customer's stats once." Those
// are NOT the same thing: an order that was originally saved with NO
// customer attached, and only gets a customer attached during this very
// edit, has never contributed to ANY customer's totalOrders/lifetimeSpend —
// it needs the FULL normal increment (like a brand-new order), not a delta
// against its pre-edit total (which is frequently 0, e.g. when only the
// customer identity changed and no items did — exactly the reported bug).
//
// FIX: only ever build a delta-style editContext when the order ALREADY had
// a customer identity attached before this edit session started
// (`_editMode.hadCustomer`, set by js/order-edit.js from the loaded
// sales_history doc's onlineCustomerUid/manualCustomerPhone). Otherwise
// (anonymous → customer attach, or no edit at all) this returns null, which
// makes both sync functions take their normal "full add" path — exactly
// correct for a customer's first-ever contribution from this order.
//
// A missing `hadCustomer` field (only possible for an edit session that was
// started with a pre-session-5 build of js/order-edit.js and settled after
// this fix was deployed) defaults to `true` — i.e. still delta-only — since
// that is the safer failure mode: it can under-count a genuinely-new
// customer attachment made mid-transition, but it can never DOUBLE-count an
// order that truly already belonged to a customer. This is a narrow,
// self-resolving rollout edge case, not an ongoing design gap.
// AI UPDATE [2026-09-20] BUG FIX (online-customer Edit History): identity stored on the edit flag by
// js/order-edit.js. Used as a fallback when the customerName_/customerPhone_ badge keys are gone — they
// are deleted by saveLocalCart([]) whenever the cart is emptied mid-edit. Never returns null.
function _editOnlineIdentity(editMode) {
    const i = editMode && editMode.onlineIdentity;
    return { name: (i && i.name) || '', phone: (i && i.phone) || '' };
}

function _statsEditContext(editMode) {
    if (!editMode) return null;
    const hadCustomer = editMode.hadCustomer === undefined ? true : !!editMode.hadCustomer;
    return hadCustomer ? { previousTotal: editMode.originalTotal } : null;
}

async function _maybeIssueLoyaltyCoupon(phone, name) {
    if (!phone) return;
    try {
        const snap = await getDoc(doc(db, 'customers', phone));
        if (!snap.exists()) return;
        const data = snap.data();
        if (data.milestoneCouponIssued) return; // already issued — one-time reward

        const totalOrders   = data.totalOrders   || 0;
        const lifetimeSpend = data.lifetimeSpend || 0;
        if (totalOrders < LOYALTY_MIN_ORDERS || lifetimeSpend < LOYALTY_MIN_SPEND) return;

        const base = (data.name || name || 'CUST').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) || 'CUST';
        const code = `${base}#${Math.floor(1000 + Math.random() * 9000)}`;

        await setDoc(doc(db, 'coupons', code), {
            code,
            phone,
            name:      data.name || name || '',
            amount:    LOYALTY_AMOUNT,
            minOrder:  LOYALTY_MIN_REDEEM,
            message:   `🎉 Loyalty reward for ${totalOrders}+ orders — enjoy ₹${LOYALTY_AMOUNT} off your next bill!`,
            type:      'loyalty',
            used:      false,
            usedAt:    null,
            usedBillId: null,
            usedTable: null,
            createdAt: serverTimestamp(),
        });

        // Guard so this never fires again for this customer.
        await updateDoc(doc(db, 'customers', phone), { milestoneCouponIssued: true });
        console.log(`[Loyalty] Issued coupon ${code} to ${phone}`);
    } catch (err) {
        console.warn('[Loyalty] Coupon issue failed (non-fatal):', err.message || err);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// AI UPDATE [2026-09-14]: MANUAL POS CUSTOMER IDENTIFICATION
//
// Audit finding (per ARCHITECTURE_LOCK.md §6 + syncCustomerOrderCompletion()
// above): a table/order slot already HAS a customer identity if and only if
// `activeCustomerUid_<table>_<slot>` exists in localStorage — that key is
// written only by the QR/Customer-Panel "Open in POS" import flow
// (js/incoming-orders.js), never by manual billing. This is the exact same
// signal syncCustomerOrderCompletion() already gates on, so it's reused
// unchanged here rather than inventing a second notion of "identity".
//
// This feature adds an OPTIONAL name/phone popup for manual/walk-in orders
// ONLY — i.e. only when that key is absent for the slot being billed. QR
// orders are never shown this popup (see checkoutBtn / saveExitBtn below).
//
// Customer association reuses the EXISTING customers/{phone} +stats
// architecture — see Order-/js/auth.js registration write for the field
// shape this mirrors. No second customer system, no new collections.
//
// customer_order_history is keyed by `customers/{phone}.uid` everywhere else
// in this app (see js/customers.js resolvedUid = c.uid || c.authUid). A
// walk-in has no real Firebase Auth uid, so a manually-created profile here
// sets uid = phone — this is the one deliberate convention choice, and it's
// what makes a manual customer's history show up correctly in the existing
// admin Customer Detail screen without any changes to js/customers.js.
//
// Both new functions below are read/lookup-only or fire-and-forget — neither
// can ever delay or block Save & Exit / Bill & Settle.
// ═══════════════════════════════════════════════════════════════════════════

// Looks up an existing customer by phone for the popup's live "Customer Found"
// card. Returns null (silently, non-fatal) on any error or no match — the
// popup treats that identically to "no existing customer".
async function _lookupManualCustomerByPhone(rawTenDigitPhone) {
    const phone = `+91${rawTenDigitPhone}`;
    try {
        const snap = await getDoc(doc(db, 'customers', phone));
        if (!snap.exists()) return null;
        const d = snap.data();
        return {
            name:          d.name || '',
            createdAt:     d.createdAt?.toMillis?.() ?? null,
            lifetimeSpend: typeof d.lifetimeSpend === 'number' ? d.lifetimeSpend : 0,
        };
    } catch (err) {
        console.warn('[ManualCustomer] Lookup failed (non-fatal):', err.message || err);
        return null;
    }
}

// Associates a manual bill with a customer profile, creating one only if the
// phone truly doesn't exist yet (never a duplicate — same doc ID as every
// other customer lookup/write in this app: customers/{phone}).
// No-op if no phone was given (walk-in with no details, or name-only — see
// requirement 5: a name alone is printed on the bill but does not create or
// touch any customer profile, since phone is this app's customer key).
// AI UPDATE [2026-09-16]: Added optional trailing orderIdOverride/editContext
// params for the Edit History feature. orderIdOverride, when passed, makes
// this function reuse an EXISTING customer_order_history doc ID (the shared
// order ID also used as the sales_history doc ID) instead of minting a new
// ORDER_<timestamp> — this is what links the two records and lets an edit
// update the same history entry instead of creating a duplicate. editContext
// = { previousTotal } signals an edit: lifetimeSpend is adjusted by the
// DELTA (new total − previous total) instead of the full total, and
// totalOrders is NOT incremented again. Both params are no-ops (existing
// behavior, fully unchanged) when omitted — i.e. every normal, non-edit bill.
// AI UPDATE [2026-09-20]: trailing optional `pricing` = { subtotal, customDiscount } — written onto the
// customer_order_history doc so Customer History can show the discount. Omitted = fields not written.
async function syncManualCustomerProfile(name, rawPhone, total, billNumber, tableName, completionReason, cartSnapshot, orderIdOverride = null, editContext = null, pricing = null) {
    if (!rawPhone) return;
    const phone = rawPhone.startsWith('+91') ? rawPhone : `+91${rawPhone}`;

    try {
        const ref  = doc(db, 'customers', phone);
        const snap = await getDoc(ref);
        let resolvedUid;
        let resolvedName = (name || '').trim();

        if (snap.exists()) {
            // Existing customer (QR-registered or previously walk-in) — reuse
            // their real identity as-is. Never overwrite an existing name.
            const data   = snap.data();
            resolvedUid  = data.uid || data.authUid || phone;
            resolvedName = data.name || resolvedName;
        } else {
            // New customer, created from the billing counter. Field shape
            // mirrors Order-/js/auth.js registration exactly so this profile
            // is indistinguishable from a self-registered one to every
            // existing reader (admin Customer panel, loyalty coupons, etc.).
            // phoneVerified: false is REQUIRED — firestore.rules only allows
            // creating customers/{phone} when that field is present and false.
            resolvedUid = phone;
            await setDoc(ref, {
                phone,
                name:          resolvedName,
                uid:           phone,
                phoneVerified: false,
                createdAt:     serverTimestamp(),
                updatedAt:     serverTimestamp(),
                totalOrders:   0,
                lifetimeSpend: 0,
                lastOrderAt:   null,
                source:        'manual_pos', // provenance flag only, not read elsewhere
            });
        }

        if (cartSnapshot.length > 0) {
            // AI UPDATE [2026-09-16]: reuse the shared order ID on an edit (setDoc+
            // merge on the SAME doc = update-in-place, never a duplicate history entry).
            const historyId = orderIdOverride || `ORDER_${Date.now()}`;
            await setDoc(
                doc(db, 'customer_order_history', resolvedUid, 'orders', historyId),
                {
                    orderId:       historyId,
                    billNumber:    billNumber || null,
                    orderStatus:   'completed',
                    tableId:       tableName,
                    customerName:  resolvedName,
                    customerPhone: phone,
                    items: cartSnapshot.map(i => {
                        const ep = Array.isArray(i.extras) ? i.extras.reduce((s, e) => s + (Number(e.price) || 0), 0) : 0;
                        return {
                            name:           i.name,
                            price:          i.price,
                            quantity:       i.qty,
                            extras:         Array.isArray(i.extras) ? i.extras : [],
                            specialRequest: i.specialRequest || '',
                            subtotal:       +((i.price + ep) * i.qty).toFixed(2),
                        };
                    }),
                    total:            +total.toFixed(2),
                    completedAt:      serverTimestamp(),
                    completionReason, // 'bill_settle' | 'save_exit'
                    orderedAt:        new Date().toISOString(),
                    // AI UPDATE [2026-09-16] Edit History audit trail (absent on first save).
                    ...(editContext ? { isEdited: true, editedAt: serverTimestamp() } : {}),
                    // AI UPDATE [2026-09-20]: Custom Instant Discount — additive order-level fields.
                    ...(pricing ? { subtotal: pricing.subtotal, customDiscount: pricing.customDiscount } : {}),
                },
                { merge: true }
            );
        }

        // AI UPDATE [2026-09-16]: on an edit, add only the DELTA to lifetimeSpend and
        // do NOT increment totalOrders again — this order was already counted once,
        // when it was first completed. Non-edit path is byte-for-byte unchanged.
        const _statsUpdate = editContext
            ? { lifetimeSpend: increment(+(total - editContext.previousTotal).toFixed(2)), lastOrderAt: serverTimestamp() }
            : { totalOrders: increment(1), lifetimeSpend: increment(+total.toFixed(2)), lastOrderAt: serverTimestamp() };
        await updateDoc(ref, _statsUpdate);

        // A manual customer who crosses the loyalty milestone earns the same
        // reward a QR customer would — reuses the existing check as-is.
        _maybeIssueLoyaltyCoupon(phone, resolvedName);
    } catch (err) {
        // Non-fatal — the bill is already complete; this is CRM sync only.
        console.warn('[ManualCustomer] Profile sync failed (non-fatal):', err.message || err);
    }
}

// ── Customer order completion sync (best-effort, non-blocking) ───────────────
//
// Called by both "Bill & Settle" and "Save & Exit" handlers after the sale is
// saved.  Only has any effect when this specific customer SLOT (not the table)
// has an active Customer Panel order attached to it.
//
// AI UPDATE [2026-09-13] — ROOT CAUSE FIX for "wrong customer history" +
// "manual/QR order merging" bugs. See AI_HANDOFF.md for the full audit.
//
// Root cause (previous implementation): every identity key
// (activeCustomerUid_<table>, acceptedOrderIds_<table>, etc.) was scoped by
// TABLE ONLY. A table can host multiple independent customers at once (two
// QR customers, or a manual walk-in + a QR customer). Because the keys were
// shared across every customer on the table:
//   - activeCustomerUid_<table> held whichever customer was MOST RECENTLY
//     "Open in POS"'d — not necessarily the customer actually being billed.
//   - acceptedOrderIds_<table> accumulated EVERY accepted order for the whole
//     table in one array, so billing customer A also marked customer B's
//     still-open Firestore order as 'completed' as a side effect, and wrote
//     customer A's cart into customer B's (or whoever's uid happened to be
//     cached) customer_order_history.
//
// Fix: every identity key is now scoped by TABLE + CUSTOMER SLOT
// (`${tableName}_${customerSlot}`, e.g. "Table 3_C1" / "Table 3_C2"). The slot
// is the same C1/C2/C3… tab the operator is actually looking at (getCurrentCustomer()
// in the caller) — this is real, existing per-customer state (each slot already
// has its own isolated cart_<table>_<slot> in localStorage); it was only the
// *identity* bookkeeping that had been left table-wide. Table number alone is
// never used as customer identity — see notes below.
//
// What it does when this slot has a Customer Panel order:
//   1. Looks up ONLY the Firestore order doc IDs that were imported into THIS
//      slot via "Open in POS" (acceptedOrderIds_<table>_<slot>) by document ID
//      directly — never a table-wide query — so another customer's order on
//      the same table can never be touched or read from.
//   2. Marks those specific orders as 'completed'.
//   3. Writes one completed-order record to
//        customer_order_history/{customerUid}/orders/ORDER_{timestamp}
//      using the uid recovered from THIS slot's own order doc(s) only.
//   4. Clears the localStorage convenience-cache keys for this slot only —
//      other customers/slots on the same table are left untouched.
//
// What it does for manual/walk-in orders (no Customer Panel order in this slot):
//   Returns immediately without any Firestore write. All existing billing
//   logic is completely unaffected, and other customers on the same table are
//   never touched.
// ─────────────────────────────────────────────────────────────────────────────
// AI UPDATE [2026-07-29] session 18:
// Added optional billNumber parameter (passed from Bill & Settle shortOrderId).
// After writing history, also updates customers/{phone} stats atomically using
// increment() so the admin CRM can read pre-computed totals without re-scanning history.
// AI UPDATE [2026-09-16]: Added optional trailing orderIdOverride/editContext
// params for the Edit History feature — same purpose/behavior as the matching
// params on syncManualCustomerProfile() above (see that comment). No-ops when
// omitted, so every normal completion is completely unaffected.
// AI UPDATE [2026-09-20]: trailing optional `pricing` = { subtotal, customDiscount } — see
// syncManualCustomerProfile() above. `total` is already the final (post-discount) payable.
// AI UPDATE [2026-09-20] BUG FIX (online-customer Edit History — stale Lifetime Spend / Total Orders):
// trailing optional `identity` = { name, phone } — the online customer's badge name/phone captured by the
// Bill & Settle / Save & Exit handler BEFORE it calls saveLocalCart([]). ROOT CAUSE: saveLocalCart([])
// deletes the customerName_<table>_<slot> / customerPhone_<table>_<slot> badge keys, and both handlers call
// it BEFORE this function runs, so the localStorage fallback below (used on an Edit History re-settle, where
// there is no fresh pending_table_orders doc to read the phone from) always came back '' → the
// customers/{phone} stats update (`if (customerPhone)`) was silently SKIPPED, and the merge-write below
// overwrote the history doc's customerName/customerPhone with ''. The manual flow was immune because
// syncManualCustomerProfile() receives the phone as an argument, not from localStorage.
// Omitted (every pre-existing caller) = behaviour exactly as before.
async function syncCustomerOrderCompletion(tableName, customerSlot, cartSnapshot, total, completionReason, billNumber = null, orderIdOverride = null, editContext = null, pricing = null, identity = null) {
    // AI UPDATE [2026-09-13]: slot-scoped key suffix — see header comment above.
    const _slotSuffix = `${tableName}_${customerSlot}`;

    // ── Step 1: Identify only THIS slot's imported order(s), by doc ID ─────
    // Do this first so we can also recover the customerUid from Firestore
    // if localStorage doesn't have it (e.g. after a page refresh).
    let customerUid = localStorage.getItem(`activeCustomerUid_${_slotSuffix}`);

    try {
        // AI UPDATE [2026-09-13]: acceptedOrderIds is now scoped per (table, slot).
        // incoming-orders.js writes the accepted IDs to
        // acceptedOrderIds_<table>_<slot> — only ever the orders that were
        // merged into THIS slot's cart.
        const _acceptedIds = JSON.parse(
            localStorage.getItem(`acceptedOrderIds_${_slotSuffix}`) || '[]'
        );

        // AI UPDATE [2026-09-13]: fetch the accepted orders directly by document
        // ID instead of querying the whole table by tableId. This guarantees we
        // can never see — let alone complete or read identity from — another
        // customer's order on the same table, whether that other order is a
        // second QR customer or a manual/walk-in order. Table number is never
        // used as identity; only these specific, previously-recorded doc IDs are.
        let docsToComplete = [];
        if (_acceptedIds.length > 0) {
            const _fetched = await Promise.all(
                _acceptedIds.map(id => getDoc(doc(db, 'pending_table_orders', id)))
            );
            docsToComplete = _fetched.filter(d =>
                d.exists() && ['pending', 'accepted', 'kot'].includes((d.data().status || '').toLowerCase())
            );
        }

        // Recover customerUid from this slot's own imported orders only.
        // (No table-wide fallback — that was the exact cross-customer leak.)
        if (!customerUid && docsToComplete.length > 0) {
            customerUid = docsToComplete[0].data().customer?.uid || '';
            if (customerUid) {
                console.log(`[OrderSync] Recovered customerUid from Firestore for slot "${_slotSuffix}"`);
            }
        }

        if (!customerUid) {
            // No Customer Panel UID for THIS slot — manual/walk-in bill (or a
            // slot with no online order attached), nothing to sync. Other
            // customers/slots on this table are completely unaffected.
            return;
        }

        // Grab customer name/phone from this slot's own imported docs only.
        const _firstDoc = docsToComplete.length > 0 ? docsToComplete[0] : null;
        let customerName  = '';
        let customerPhone = '';
        if (_firstDoc) {
            const cust    = _firstDoc.data().customer || {};
            customerName  = cust.name  || '';
            customerPhone = cust.phone || '';
        } else {
            // AI UPDATE [2026-09-16] Edit History: reopening a previously-completed
            // QR order has no fresh pending_table_orders doc to read identity from
            // (it was already marked 'completed' the first time). Fall back to the
            // same customerName_/customerPhone_ badge keys the cart UI already reads
            // — js/order-edit.js sets these when it loads the order for editing.
            // AI UPDATE [2026-09-20]: prefer the identity the handler captured BEFORE saveLocalCart([])
            // wiped these keys (see the BUG FIX note on this function's signature); localStorage is
            // kept only as a last-resort fallback for callers that don't pass `identity`.
            customerName  = (identity && identity.name)  || localStorage.getItem(`customerName_${_slotSuffix}`)  || '';
            customerPhone = (identity && identity.phone) || localStorage.getItem(`customerPhone_${_slotSuffix}`) || '';
            if (editContext && !customerPhone) {
                console.warn(`[OrderSync] Edit History: no customer phone resolved for slot "${_slotSuffix}" — ` +
                    'customers/{phone} Total Orders / Lifetime Spend will NOT be adjusted for this edit.');
            }
        }

        // Mark ONLY the imported orders as 'completed'.
        // Other pending cards for the same table are left untouched.
        // The customer panel listens to this collection filtered by UID + status,
        // so these updates remove them from the Active Orders view in real time.
        await Promise.all(
            docsToComplete.map(d =>
                updateDoc(d.ref, {
                    status:      'completed',
                    completedAt: serverTimestamp(),
                }).catch(e => console.warn('[OrderSync] status update failed:', e))
            )
        );

        console.log(
            `[OrderSync] Marked ${docsToComplete.length} order(s) completed for slot "${_slotSuffix}"`,
            `(tracked: ${_acceptedIds.length})`
        );

        // ── Step 2: Write a permanent record to the customer's order history ───
        if (cartSnapshot.length > 0) {
            // AI UPDATE [2026-09-16]: reuse the shared order ID on an edit — see
            // syncManualCustomerProfile() header comment above for why.
            const historyId = orderIdOverride || `ORDER_${Date.now()}`;
            await setDoc(
                doc(db, 'customer_order_history', customerUid, 'orders', historyId),
                {
                    orderId:          historyId,
                    // AI UPDATE [2026-07-29] session 18: added billNumber + orderStatus
                    billNumber:       billNumber || null,     // short ID printed on bill (Bill & Settle only)
                    orderStatus:      'completed',
                    tableId:          tableName,
                    // AI UPDATE [2026-09-20]: on an Edit History re-settle (editContext set) never overwrite the
                    // stored name/phone with '' — this is a merge write on the SAME doc. Non-edit path unchanged.
                    ...(editContext
                        ? { ...(customerName ? { customerName } : {}), ...(customerPhone ? { customerPhone } : {}) }
                        : { customerName, customerPhone }),
                    items: cartSnapshot.map(i => {
                        const ep = Array.isArray(i.extras) ? i.extras.reduce((s, e) => s + (Number(e.price) || 0), 0) : 0;
                        return {
                            name:           i.name,
                            price:          i.price,
                            quantity:       i.qty,
                            extras:         Array.isArray(i.extras) ? i.extras : [],
                            specialRequest: i.specialRequest || '',
                            subtotal:       +((i.price + ep) * i.qty).toFixed(2),
                        };
                    }),
                    total:            +total.toFixed(2),
                    completedAt:      serverTimestamp(),
                    completionReason,          // 'bill_settle' | 'save_exit'
                    orderedAt:        new Date().toISOString(),
                    // AI UPDATE [2026-09-16] Edit History audit trail (absent on first save).
                    ...(editContext ? { isEdited: true, editedAt: serverTimestamp() } : {}),
                    // AI UPDATE [2026-09-20]: Custom Instant Discount — additive order-level fields.
                    ...(pricing ? { subtotal: pricing.subtotal, customDiscount: pricing.customDiscount } : {}),
                },
                { merge: true }
            );

            // ── Step 2b: Update pre-computed stats on the customer profile ───────
            // Uses increment() for atomic, race-condition-free updates.
            // The customers/{phone} profile is guaranteed to exist at this point
            // because the customer must have registered before placing an order.
            // Non-blocking — billing is already complete by this step.
            // AI UPDATE [2026-09-16]: on an edit, add only the DELTA to lifetimeSpend
            // and do NOT increment totalOrders again (already counted once). Non-edit
            // path below is byte-for-byte unchanged.
            if (customerPhone) {
                const _statsUpdate = editContext
                    ? { lifetimeSpend: increment(+(total - editContext.previousTotal).toFixed(2)), lastOrderAt: serverTimestamp() }
                    : { totalOrders: increment(1), lifetimeSpend: increment(+total.toFixed(2)), lastOrderAt: serverTimestamp() };
                updateDoc(doc(db, 'customers', customerPhone), _statsUpdate)
                    .then(() => _maybeIssueLoyaltyCoupon(customerPhone, customerName))
                    .catch(e => console.warn('[OrderSync] Profile stats update failed (non-fatal):', e.message));
            }
        }

        // ── Step 3: Clear localStorage convenience cache for THIS SLOT only ────
        // AI UPDATE [2026-09-13]: identity keys are slot-scoped, so clearing them
        // no longer touches another customer's still-active session on the same
        // table. `cartItemSourceMap` remains table-scoped (pre-existing, KOT/
        // "Mark as Served" feature, out of scope for this fix — see AI_HANDOFF.md
        // "Known Remaining Limitation") and is intentionally left as-is here.
        ['activeOrderDocId', 'activeCustomerUid', 'activeSessionId', 'activeLockId', 'acceptedOrderIds']
            .forEach(key => localStorage.removeItem(`${key}_${_slotSuffix}`));

        console.log(`[OrderSync] Order completion synced for slot "${_slotSuffix}" (${completionReason})`);
    } catch (err) {
        // Non-fatal — billing is already done, this is just customer-panel sync.
        console.warn('[OrderSync] Customer order history sync failed (non-fatal):', err.message || err);
    }
}

// ── Customer table-lock release (best-effort, non-blocking) ──────────────────
//
// Calls the releaseTableLock Cloud Function to clean up any active customer
// session for this table (used by the Customer Order Panel integration).
//
// This is fire-and-forget: billing operations (save to Firestore, clear cart,
// navigate back) always proceed regardless of whether the Cloud Function
// succeeds.  The function only exists to serve the customer-facing panel; the
// billing panel's core flow must never be blocked by it.
//
// If the operator is not signed in via Firebase Auth, or the function is not
// yet deployed, the call silently fails and we continue normally.
// ─────────────────────────────────────────────────────────────────────────────
function releaseTableLockInBackground(tableName, releaseReason) {
    try {
        const fn = httpsCallable(functions, 'releaseTableLock');
        fn({ tableId: tableName, releaseReason })
            .then(result => {
                console.log(`[LockRelease] OK for "${tableName}", reason: ${releaseReason}`, result.data);
            })
            .catch(err => {
                // Non-fatal — customer panel lock cleanup failed, but billing is done.
                console.warn(`[LockRelease] Cloud Function failed (non-fatal) for "${tableName}":`, err.code, err.message);
            });
    } catch (err) {
        console.warn('[LockRelease] Could not invoke Cloud Function (non-fatal):', err.message);
    }
}

// ── Auto-cancel imported order when cart is emptied before saving ─────────────
//
// Called by Hold and Save & Exit when the cart is empty at exit time.
// If the operator imported a customer order ("Open in POS") but removed every
// item before billing, the order would be stuck as "accepted" in Firestore
// forever — the customer would see "Order Confirmed" with no way to clear it.
//
// Reuses the existing "dismissed" status (same as the Dismiss button in
// incoming-orders.js) so the customer panel immediately removes the order from
// Active Orders, matching the behaviour of operator-dismissed orders.
//
// Guards:
//   1. acceptedOrderIds_<table> must be non-empty (an order was imported).
//   2. Firestore status must still be "pending" or "accepted" — if the order
//      has already reached "kot", the kitchen has it; do not silently cancel.
//
// Fire-and-forget: navigation back to the table grid always proceeds
// regardless of whether the Firestore writes succeed.
// ─────────────────────────────────────────────────────────────────────────────
// AI UPDATE [2026-07-29] session 23:
//   Added — handles the missing edge case where all imported items are removed
//   from the POS cart before Save/Bill.  Without this, status stayed "accepted"
//   and the customer saw "Order Confirmed" forever.
// AI UPDATE [2026-09-13]: added customerSlot param — acceptedOrderIds is now
// scoped per (table, slot), same root-cause fix as syncCustomerOrderCompletion
// above. Prevents emptying one customer's cart from silently dismissing a
// DIFFERENT customer's still-active order on the same table.
async function cancelImportedOrdersOnEmptyCart(tableName, customerSlot) {
    const _slotSuffix = `${tableName}_${customerSlot}`;
    const acceptedIds = JSON.parse(
        localStorage.getItem(`acceptedOrderIds_${_slotSuffix}`) || '[]'
    );
    if (acceptedIds.length === 0) return; // No imported order in this slot — nothing to cancel

    try {
        await Promise.all(
            acceptedIds.map(async id => {
                const ref      = doc(db, 'pending_table_orders', id);
                const snapshot = await getDoc(ref);
                if (!snapshot.exists()) return;
                const status = (snapshot.data().status || '').toLowerCase();
                // Only cancel pre-KOT orders.  "kot" or "completed" means the
                // kitchen / billing already owns the order — never touch those.
                if (!['pending', 'accepted'].includes(status)) return;
                return updateDoc(ref, { status: 'dismissed' })
                    .catch(e => console.warn('[OrderCancel] Failed to dismiss order:', id, e));
            })
        );

        // Clear the same localStorage convenience-cache keys that
        // syncCustomerOrderCompletion clears on normal completion — scoped to
        // this slot only, so other customers on the same table are untouched.
        ['activeOrderDocId', 'activeCustomerUid', 'activeSessionId', 'activeLockId', 'acceptedOrderIds']
            .forEach(key => localStorage.removeItem(`${key}_${_slotSuffix}`));

        console.log(`[OrderCancel] Auto-cancelled empty imported order(s) for slot "${_slotSuffix}"`);
    } catch (err) {
        // Non-fatal — the operator has already navigated back to the table grid.
        console.warn('[OrderCancel] Auto-cancel failed (non-fatal):', err.message || err);
    }
}

// ── Cancel Order — operator explicitly cancels while in POS ──────────────────
//
// AI UPDATE [2026-07-30]:
// Added to handle the case where the operator opens an order in POS but decides
// not to process it.  Without this, the customer's Active Orders card would be
// stuck forever showing "Order Confirmed" or "Preparing 🍕".
//
// Differences from cancelImportedOrdersOnEmptyCart():
//   - Also cancels 'kot'-status orders (operator decides to abort even after
//     KOT was printed and kitchen was notified).
//   - Only skips 'completed' orders (already billed — must never be un-billed).
//   - Triggered by an explicit CANCEL ORDER button press, not by an empty-cart
//     edge-case on Save & Exit.
//
// Firestore documents updated:
//   - pending_table_orders/{id}  →  { status: 'dismissed' }
//     for every doc in acceptedOrderIds_<tableName> whose status is not 'completed'.
//     'dismissed' is the existing shared contract: the Customer Panel's onSnapshot
//     listener removes any Active Order card when it sees this status.
//
// Does NOT write to:
//   - sales_history          (not a completed sale)
//   - customer_order_history (customer sees no record)
//   - ghost history / saveToGhostHistory
//
// Fire-and-forget: navigation back to the table grid has already happened before
// this function runs.  A Firestore failure is logged but never blocks the UI.
// ─────────────────────────────────────────────────────────────────────────────
// AI UPDATE [2026-09-13]: added customerSlot param — same root-cause fix as
// syncCustomerOrderCompletion / cancelImportedOrdersOnEmptyCart above. Cancelling
// the order currently open in POS must only ever touch THIS slot's own accepted
// order(s), never another customer sharing the same table.
async function cancelOrderInPOS(tableName, customerSlot) {
    const _slotSuffix = `${tableName}_${customerSlot}`;
    const acceptedIds = JSON.parse(
        localStorage.getItem(`acceptedOrderIds_${_slotSuffix}`) || '[]'
    );

    try {
        if (acceptedIds.length > 0) {
            await Promise.all(
                acceptedIds.map(async id => {
                    const ref      = doc(db, 'pending_table_orders', id);
                    const snapshot = await getDoc(ref);
                    if (!snapshot.exists()) return;
                    const status = (snapshot.data().status || '').toLowerCase();
                    // Skip only 'completed' — pending, accepted, and kot are all
                    // valid targets for an explicit operator cancel.
                    if (status === 'completed') return;
                    return updateDoc(ref, { status: 'dismissed' })
                        .catch(e => console.warn('[CancelOrder] dismiss failed for', id, e));
                })
            );
        }

        // Clear localStorage convenience-cache keys for THIS SLOT only — same
        // set as syncCustomerOrderCompletion / cancelImportedOrdersOnEmptyCart.
        ['activeOrderDocId', 'activeCustomerUid', 'activeSessionId', 'activeLockId', 'acceptedOrderIds']
            .forEach(key => localStorage.removeItem(`${key}_${_slotSuffix}`));

        console.log(`[CancelOrder] Order explicitly cancelled for slot "${_slotSuffix}".`);
    } catch (err) {
        // Non-fatal — UI has already returned to the table grid.
        console.warn('[CancelOrder] Firestore cancel failed (non-fatal):', err.message || err);
    }
}

// ── Error banner helper ───────────────────────────────────────────────────────
// Shows a temporary error message near the action buttons.
// Auto-removes after 6 seconds.  Uses the dark POS colour palette.
function _showReleaseError(message) {
    const existing = document.getElementById('lock-release-error');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'lock-release-error';
    banner.style.cssText = [
        'position:fixed',
        'bottom:80px',
        'left:50%',
        'transform:translateX(-50%)',
        'background:#7f1d1d',
        'color:#fecaca',
        'border:1px solid #ef4444',
        'border-radius:10px',
        'padding:12px 20px',
        'font-size:0.9rem',
        'font-weight:600',
        'text-align:center',
        'z-index:9999',
        'max-width:90vw',
        'box-shadow:0 4px 20px rgba(0,0,0,0.5)',
    ].join(';');
    banner.textContent = '⚠️ ' + message;
    document.body.appendChild(banner);

    setTimeout(() => banner.remove(), 6000);
}

// AI UPDATE [2026-07-30]: Pre-load the shop logo for thermal receipt printing.
// Fire-and-forget — printing falls back gracefully if logo isn't ready yet.
initReceiptPrinter();

/** Escape customer-controlled strings before inserting into innerHTML. */
const _escHtml = s => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

document.addEventListener('DOMContentLoaded', () => {
    const cartItemsContainer = document.getElementById('cartItems');
    const cartTotalElement = document.getElementById('cartTotal');
    const activeTableNameEl = document.getElementById('activeTableName');

    let currentCart = [];

    // AI UPDATE [2026-08-01]: Tracks which cart items have been marked served in
    // this session (keyed by item.id). Cleared when a new table is loaded via
    // load-table-cart so served state from a previous table does not leak across.
    const _servedItems = new Set();

    const getCurrentTable = () => activeTableNameEl.innerText;
    const getCurrentCustomer = () => activeTableNameEl.dataset.customer || 'C1';
    
    const getCartKey = () => `cart_${getCurrentTable()}_${getCurrentCustomer()}`;
    const getKotTimeKey = () => `kotTime_${getCurrentTable()}_${getCurrentCustomer()}`;
    // Key for the online customer name badge (per-slot, cleared when the cart empties).
    const getCustomerNameKey = () => `customerName_${getCurrentTable()}_${getCurrentCustomer()}`;
    // [AI UPDATE 2026-09-12] session 2: parallel key holding the online customer's phone
    // for this table/slot — written by js/incoming-orders.js (this repo) on
    // "Open in POS" import. Used to verify a personalized coupon belongs to whoever is
    // actually seated in this slot before it can be applied (see applyCouponBtn handler).
    const getCustomerPhoneKey = () => `customerPhone_${getCurrentTable()}_${getCurrentCustomer()}`;
    // [AI UPDATE 2026-09-15] Per-slot flag: has the manual-customer-identity
    // popup already been resolved (Continue or Skip) for THIS bill? Stores
    // JSON { name, phone } — phone is '' when skipped. Checked by the
    // checkoutBtn/saveExitBtn handlers below so the popup only ever appears
    // ONCE per bill; see the "two-step" flow fix in those handlers.
    const getManualCustomerIdentityKey = () => `manualCustomerIdentity_${getCurrentTable()}_${getCurrentCustomer()}`;

    // ── AI UPDATE [2026-09-13]: Customer Coupons panel ──────────────────────────
    // Tapping the online customer name badge above (e.g. "Test2") opens a small
    // panel listing that customer's available/unused coupons. This reuses the
    // SAME coupons/{code} Firestore collection and phone-based query pattern
    // already used by js/customers.js (_fetchCustomerCoupons, Customer
    // Management panel) and the Customer Panel's js/offers.js ("My Offers"
    // drawer) — no second coupon system is introduced.
    //
    // Identity used for lookup: customerPhone_<table>_<slot> — the customer's
    // real phone number, written by js/incoming-orders.js on "Open in POS"
    // import. This is the same key _getRedeemableCoupon()/applyCouponBtn
    // already trust for personalized-coupon binding below — NOT the display
    // name — so Customer A can never see Customer B's personalized coupons
    // through this panel.
    //
    // Apply reuses the EXISTING #couponCodeInput / #applyCouponBtn validation
    // logic verbatim (fills the input, clicks the real button) — it does not
    // duplicate or re-implement coupon validation/application.
    function _closeCustomerCouponsPanel() {
        document.getElementById('customerCouponsModal')?.classList.add('hidden');
    }

    async function _openCustomerCouponsPanel(phone, name) {
        const modal  = document.getElementById('customerCouponsModal');
        const nameEl = document.getElementById('couponPanelCustomerName');
        const listEl = document.getElementById('couponPanelList');
        if (!modal || !listEl) return;

        if (nameEl) nameEl.textContent = name || 'Customer';
        listEl.innerHTML = `<div class="coupon-panel-empty">Loading offers…</div>`;
        modal.classList.remove('hidden');

        let coupons;
        try {
            const snap = await getDocs(query(collection(db, 'coupons'), where('phone', '==', phone)));
            const all = [];
            snap.forEach(d => all.push({ id: d.id, ...d.data() }));
            // Only unused coupons are "available" — used coupons are excluded,
            // never presented here as usable (mirrors the "active" filter in
            // js/customers.js and js/offers.js, same coupons/{code} collection).
            coupons = all
                .filter(cp => !cp.used)
                .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        } catch (err) {
            console.warn('[pos-coupons] Failed to load coupons:', err);
            listEl.innerHTML = `<div class="coupon-panel-empty">⚠️ Could not load offers. Please try again.</div>`;
            return;
        }

        if (coupons.length === 0) {
            listEl.innerHTML = `<div class="coupon-panel-empty">No available coupons for this customer.</div>`;
            return;
        }

        listEl.innerHTML = coupons.map(cp => `
            <div class="coupon-panel-item">
                <div class="coupon-panel-item-top">
                    <span class="coupon-panel-code">${_escHtml(cp.code)}</span>
                    <span class="coupon-panel-amount">₹${Number(cp.amount) || 0} off</span>
                </div>
                <div class="coupon-panel-meta">
                    ${cp.message ? _escHtml(cp.message) + ' · ' : ''}Min order ₹${cp.minOrder || 200}${cp.type === 'loyalty' ? ' · 🎖️ Loyalty' : ''}
                </div>
                <div class="coupon-panel-actions">
                    <button type="button" class="coupon-panel-copy-btn" data-copy-code="${_escHtml(cp.code)}">📋 Copy</button>
                    <button type="button" class="coupon-panel-apply-btn" data-apply-code="${_escHtml(cp.code)}">Apply</button>
                </div>
            </div>
        `).join('');
    }

    // Badge click — wired once; the badge DOM node persists across renderCart()
    // calls (only its innerHTML/visibility is updated), so a single listener
    // here is safe and does not need to be re-attached per render.
    const onlineCustomerBadgeEl = document.getElementById('onlineCustomerBadge');
    if (onlineCustomerBadgeEl) {
        onlineCustomerBadgeEl.style.cursor = 'pointer';
        onlineCustomerBadgeEl.title = "View this customer's available coupons";
        onlineCustomerBadgeEl.addEventListener('click', () => {
            const phone = localStorage.getItem(getCustomerPhoneKey());
            if (!phone) return; // no online customer bound to this slot — nothing to look up
            const name = localStorage.getItem(getCustomerNameKey()) || 'Customer';
            _openCustomerCouponsPanel(phone, name);
        });
    }

    document.getElementById('closeCouponsPanelBtn')?.addEventListener('click', _closeCustomerCouponsPanel);
    document.getElementById('customerCouponsModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'customerCouponsModal') _closeCustomerCouponsPanel(); // backdrop click
    });

    document.getElementById('couponPanelList')?.addEventListener('click', (e) => {
        const copyBtn = e.target.closest('[data-copy-code]');
        if (copyBtn) {
            const code = copyBtn.dataset.copyCode;
            navigator.clipboard?.writeText(code).then(() => {
                const orig = copyBtn.textContent;
                copyBtn.textContent = '✅ Copied';
                copyBtn.disabled = true;
                setTimeout(() => { copyBtn.textContent = orig; copyBtn.disabled = false; }, 1500);
            }).catch(() => {
                copyBtn.textContent = '❌ Failed';
                setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 1500);
            });
            return;
        }

        const applyBtn = e.target.closest('[data-apply-code]');
        if (applyBtn) {
            const code = applyBtn.dataset.applyCode;
            const inputEl          = document.getElementById('couponCodeInput');
            const applyCouponBtnEl = document.getElementById('applyCouponBtn');

            // The real Apply button is disabled by _updateCouponUI() when the
            // pre-discount cart subtotal doesn't exceed COUPON_SECTION_MIN_SUBTOTAL
            // (₹200) — a disabled button's click handler does not fire, which is
            // exactly right: this panel must not bypass that existing gate.
            if (!applyCouponBtnEl || applyCouponBtnEl.disabled) {
                // AI UPDATE [2026-09-20]: the section can also be closed because a Custom
                // Instant Discount is applied (mutually exclusive with coupons) — say so.
                const _blockedByCustom = _customDiscountFor(_rawCartTotal()) > 0;
                applyBtn.closest('.coupon-panel-item')?.insertAdjacentHTML(
                    'beforeend',
                    `<div class="coupon-panel-gate-msg">${_blockedByCustom
                        ? 'Remove the Custom Discount to use a coupon'
                        : `Available after ₹${COUPON_SECTION_MIN_SUBTOTAL} order subtotal`}</div>`
                );
                return;
            }

            if (inputEl) inputEl.value = code;
            _closeCustomerCouponsPanel();
            applyCouponBtnEl.click(); // fires the EXISTING applyCouponBtn handler unchanged
        }
    });
    // ── end Customer Coupons panel ──────────────────────────────────────────────

    // ── AI UPDATE [2026-09-12]: Coupon redemption state (per table/customer slot) ──
    const getCouponKey = () => `coupon_${getCurrentTable()}_${getCurrentCustomer()}`;
    let _appliedCoupon = null; // { code, amount, minOrder } | null

    function _loadCoupon() {
        try {
            const raw = localStorage.getItem(getCouponKey());
            _appliedCoupon = raw ? JSON.parse(raw) : null;
        } catch (_) { _appliedCoupon = null; }
    }
    function _saveCoupon() {
        const key = getCouponKey();
        if (_appliedCoupon) localStorage.setItem(key, JSON.stringify(_appliedCoupon));
        else localStorage.removeItem(key);
    }
    function _rawCartTotal() {
        return currentCart.reduce((sum, item) => {
            const ep = Array.isArray(item.extras) ? item.extras.reduce((s, e) => s + (Number(e.price) || 0), 0) : 0;
            return sum + (item.price + ep) * item.qty;
        }, 0);
    }
    // Discount is 0 if no coupon applied, or if the current order no longer
    // meets that coupon's minimum order requirement (e.g. items were removed).
    // AI UPDATE [2026-09-20]: SUPERSEDED — no longer called by the UI or the settle
    // handlers; _computePricing() (below) is the single authoritative calculation
    // and uses _getRedeemableCoupon() so what the screen shows is exactly what is
    // charged. Kept only so this historical helper isn't silently removed; do not
    // add new callers.
    function _couponDiscount(rawTotal) {
        if (!_appliedCoupon) return 0;
        if (rawTotal < (_appliedCoupon.minOrder || 0)) return 0;
        return Math.min(_appliedCoupon.amount, rawTotal);
    }
    // [AI UPDATE 2026-09-12] session 2: single authoritative gate used by BOTH Bill & Settle
    // and Save & Exit right before a coupon is actually redeemed/marked used. Re-checks
    // everything that was checked at Apply time (section minimum, per-coupon minOrder,
    // customer-phone binding) rather than trusting the in-memory _appliedCoupon state —
    // covers the edge case where the table/slot was reassigned to a different customer, or
    // items were removed, between Apply and Bill & Settle.
    function _getRedeemableCoupon(rawTotal) {
        if (!_appliedCoupon) return null;
        if (rawTotal <= COUPON_SECTION_MIN_SUBTOTAL) return null;
        if (rawTotal < (_appliedCoupon.minOrder || 0)) return null;
        const _slotPhone = localStorage.getItem(getCustomerPhoneKey()) || '';
        if (_appliedCoupon.phone && _appliedCoupon.phone !== _slotPhone) return null;
        return _appliedCoupon;
    }
    // ═══════════════════════════════════════════════════════════════════════
    // AI UPDATE [2026-09-20]: CUSTOM INSTANT DISCOUNT
    //
    // A flat ₹ order-level discount typed by staff at the counter. It is stored
    // as ORDER-level data only (item prices are never touched) and lives in
    // localStorage per table/slot — exactly like the applied coupon — until the
    // order is settled/saved, when it is written to sales_history /
    // customer_order_history as `customDiscount` (with `subtotal` = pre-discount).
    //
    // ONE AUTHORITATIVE CALCULATION: _computePricing(rawTotal) below is the only
    // place that turns a pre-discount subtotal into a final total. The cart UI
    // (_updateCouponUI), getFinalTotal(), Bill & Settle and Save & Exit ALL call
    // it — do not compute a total or discount anywhere else.
    //
    // STACKING RULE (documented decision): the existing architecture is a
    // SINGLE-DISCOUNT model (one discount line on the printed bill, one
    // couponCode/couponDiscount pair per sale, one discount number in both
    // settle handlers). So a Custom Instant Discount and a coupon are MUTUALLY
    // EXCLUSIVE — the UI blocks whichever is applied second with an explicit
    // message, and _computePricing() enforces it too (custom wins, and the coupon
    // is then NOT redeemed/burned), so the two can never double-discount.
    //
    // Validation lives in _validateCustomDiscountInput() (entry) and is
    // re-checked on every calculation by _customDiscountFor() (cart changes).
    // BEGIN CUSTOM_DISCOUNT_CORE
    const getCustomDiscountKey = () => `customDiscount_${getCurrentTable()}_${getCurrentCustomer()}`;
    let _customDiscount = null;       // { amount: number } | null
    let _customDiscountNotice = '';   // one-shot message shown when a discount was auto-removed

    function _loadCustomDiscount() {
        try {
            const raw = localStorage.getItem(getCustomDiscountKey());
            _customDiscount = raw ? JSON.parse(raw) : null;
        } catch (_) { _customDiscount = null; }
    }
    function _saveCustomDiscount() {
        const key = getCustomDiscountKey();
        if (_customDiscount) localStorage.setItem(key, JSON.stringify(_customDiscount));
        else localStorage.removeItem(key);
    }
    // 850 -> "850", 12.5 -> "12.50" (whole rupees stay clean, paise only when present)
    function _fmtMoney(n) {
        const v = Number(n) || 0;
        return Number.isInteger(v) ? String(v) : v.toFixed(2);
    }
    // Entry validation. Returns { ok:true, value } or { ok:false, error }.
    // Rules: positive number, plain decimal (max 2 dp — the billing system
    // already works in 2-dp rupees), no signs/exponents/letters, and never
    // more than the current order amount.
    function _validateCustomDiscountInput(raw, orderAmount) {
        const s = String(raw == null ? '' : raw).trim();
        if (s === '') return { ok: false, error: 'Enter a discount amount.' };
        if (/^-/.test(s)) return { ok: false, error: 'Discount must be greater than 0.' };
        if (!/^\d+(\.\d{1,2})?$/.test(s)) {
            return { ok: false, error: 'Enter a valid amount (numbers only, up to 2 decimals).' };
        }
        const v = Number(s);
        if (!(v > 0)) return { ok: false, error: 'Discount must be greater than 0.' };
        // Compare in paise so 0.1+0.2-style float noise can never flip the result.
        if (Math.round(v * 100) > Math.round((Number(orderAmount) || 0) * 100)) {
            return { ok: false, error: 'Discount cannot exceed the order amount.' };
        }
        return { ok: true, value: +v.toFixed(2) };
    }
    // The custom discount that is VALID for this order amount, else 0. Called on every
    // calculation, so a cart change that shrinks the order below the stored discount
    // yields 0 here (never a negative payable) and the UI then removes it with a notice.
    function _customDiscountFor(rawTotal) {
        if (!_customDiscount) return 0;
        const amt = Number(_customDiscount.amount);
        if (!Number.isFinite(amt) || amt <= 0) return 0;
        if (Math.round(amt * 100) > Math.round((Number(rawTotal) || 0) * 100)) return 0;
        return +amt.toFixed(2);
    }
    // THE authoritative pricing calculation. rawTotal = pre-discount cart subtotal.
    //   coupon          -> the coupon to redeem at settle (null if none / not redeemable /
    //                      custom discount active)
    //   couponDiscount  -> ₹ off from that coupon (0 if none)
    //   customDiscount  -> ₹ off from the custom instant discount (0 if none/invalid)
    //   total           -> final payable, never below 0
    function _computePricing(rawTotal) {
        const raw = Number(rawTotal) || 0;
        const customDiscount = _customDiscountFor(raw);
        const coupon = customDiscount > 0 ? null : _getRedeemableCoupon(raw);
        const couponDiscount = coupon ? Math.min(coupon.amount, raw) : 0;
        const total = Math.max(0, +(raw - customDiscount - couponDiscount).toFixed(2));
        return { subtotal: +raw.toFixed(2), coupon, couponDiscount, customDiscount, total };
    }
    // END CUSTOM_DISCOUNT_CORE

    // Exposed so checkout/save-exit handlers can read the final payable amount.
    // AI UPDATE [2026-09-20]: now delegates to _computePricing() (single calculation).
    function getFinalTotal() {
        return _computePricing(_rawCartTotal()).total;
    }

    function _updateCouponUI(rawTotal) {
        const msgEl     = document.getElementById('couponMsg');
        const rowEl     = document.getElementById('couponDiscountRow');
        const amtEl     = document.getElementById('couponDiscountAmount');
        const inputEl   = document.getElementById('couponCodeInput');
        const applyBtn  = document.getElementById('applyCouponBtn');
        const grandRow  = document.getElementById('grandTotalRow');
        const grandEl   = document.getElementById('grandTotalAmount');
        const gateMsgEl = document.getElementById('couponGateMsg');

        // AI UPDATE [2026-09-20]: single authoritative calculation (coupon + custom
        // instant discount) — every number rendered below comes from `pricing`.
        const pricing = _computePricing(rawTotal);
        const customActive = pricing.customDiscount > 0;

        // [AI UPDATE 2026-09-12] session 2: whole-section gate. Below/at ₹200 the coupon
        // box is disabled outright — this is the UX layer; the authoritative business-rule
        // enforcement is the identical rawTotal check inside the applyCouponBtn handler and
        // the checkoutBtn/saveExitBtn redemption logic below, so a disabled attribute being
        // bypassed (e.g. dev tools) still cannot result in a coupon being redeemed.
        // AI UPDATE [2026-09-20]: the section is also closed while a Custom Instant
        // Discount is applied (single-discount model — see CUSTOM INSTANT DISCOUNT block).
        const sectionOpen = rawTotal > COUPON_SECTION_MIN_SUBTOTAL && !customActive;
        if (inputEl)  inputEl.disabled  = !sectionOpen;
        if (applyBtn) applyBtn.disabled = !sectionOpen;
        if (gateMsgEl) {
            gateMsgEl.textContent = customActive
                ? 'Remove Custom Discount to use a coupon'
                : (sectionOpen ? '' : `Available after ₹${COUPON_SECTION_MIN_SUBTOTAL} order subtotal`);
        }

        if (_appliedCoupon) {
            const valid = rawTotal >= (_appliedCoupon.minOrder || 0);
            if (inputEl) inputEl.value = _appliedCoupon.code;
            if (applyBtn) applyBtn.style.display = 'none';

            const _removeLink = ` <a href="#" id="removeCouponLink" style="color:#f85149;margin-left:8px;">Remove</a>`;
            if (!valid) {
                // AI UPDATE [2026-09-20]: a Remove link is now shown here too. Previously an
                // applied-but-below-minimum coupon had no way to be removed from this state,
                // which would now also block the Custom Instant Discount (mutually exclusive).
                if (msgEl) msgEl.innerHTML =
                    `<span style="color:#f85149;">⚠️ Coupon needs min order ₹${_appliedCoupon.minOrder} (add ₹${Math.ceil(_appliedCoupon.minOrder - rawTotal)} more)</span>` + _removeLink;
                if (rowEl) rowEl.style.display = 'none';
            } else if (pricing.couponDiscount <= 0) {
                // AI UPDATE [2026-09-20]: valid per its own minOrder but NOT redeemable at
                // settle (_getRedeemableCoupon: section minimum / customer binding). The old
                // UI still showed a discount here that Bill & Settle then refused to apply;
                // the screen now shows exactly what will be charged.
                if (msgEl) msgEl.innerHTML =
                    `<span style="color:#d29922;">⚠️ ${_appliedCoupon.code} can't be applied to this order</span>` + _removeLink;
                if (rowEl) rowEl.style.display = 'none';
            } else {
                if (msgEl) msgEl.innerHTML =
                    `<span style="color:#3fb950;">✅ ${_appliedCoupon.code} applied</span>` + _removeLink;
                if (rowEl) rowEl.style.display = 'flex';
                if (amtEl) amtEl.textContent = `-₹${pricing.couponDiscount.toFixed(0)}`;
            }
            const rmLink = document.getElementById('removeCouponLink');
            if (rmLink) rmLink.addEventListener('click', (e) => {
                e.preventDefault();
                _appliedCoupon = null;
                _saveCoupon();
                renderCart();
            });
        } else {
            if (rowEl) rowEl.style.display = 'none';
            if (msgEl) msgEl.innerHTML = '';
            if (applyBtn) applyBtn.style.display = '';
        }

        const discount = pricing.couponDiscount + pricing.customDiscount;
        if (grandRow) grandRow.style.display = discount > 0 ? 'flex' : 'none';
        if (grandEl)  grandEl.textContent = `₹${pricing.total.toFixed(2)}`;

        _updateCustomDiscountUI(rawTotal, pricing);
    }

    // AI UPDATE [2026-09-20]: refreshes the Custom Instant Discount controls/rows from the
    // authoritative `pricing` object. Also performs the "revalidate when the cart changes"
    // rule: a stored discount that no longer fits the order amount is REMOVED with a visible
    // notice (never silently clamped up/down, never allowed to make the payable negative).
    function _updateCustomDiscountUI(rawTotal, pricing) {
        const btn     = document.getElementById('customDiscountBtn');
        const msgEl   = document.getElementById('customDiscountMsg');
        const appliedEl = document.getElementById('customDiscountApplied');
        const amtEl   = document.getElementById('customDiscountAmount');

        if (_customDiscount && pricing.customDiscount === 0) {
            if (rawTotal > 0) {
                _customDiscountNotice =
                    `⚠️ Custom discount ₹${_fmtMoney(_customDiscount.amount)} removed — it no longer fits the order amount.`;
            }
            _customDiscount = null;
            _saveCustomDiscount();
        }
        if (rawTotal <= 0) _customDiscountNotice = '';

        const active = !!_customDiscount;
        if (appliedEl) appliedEl.style.display = active ? 'block' : 'none';
        if (amtEl && active) amtEl.textContent = `-₹${_fmtMoney(pricing.customDiscount)}`;

        if (btn) {
            btn.style.display = active ? 'none' : '';
            const blockedByCoupon = !!_appliedCoupon;
            btn.disabled = blockedByCoupon || rawTotal <= 0;
        }
        if (msgEl) {
            if (active) msgEl.innerHTML = '';
            else if (_appliedCoupon) msgEl.textContent = 'Remove the coupon to use a custom discount.';
            else if (rawTotal <= 0) msgEl.textContent = 'Add items to apply a discount.';
            else if (_customDiscountNotice) msgEl.innerHTML = `<span style="color:#d29922;">${_customDiscountNotice}</span>`;
            else msgEl.textContent = '';
        }
    }

    const getLocalCart = () => {
        const data = localStorage.getItem(getCartKey());
        return data ? JSON.parse(data) : [];
    };

    const saveLocalCart = (cartData) => {
        const key = getCartKey();
        if (cartData.length === 0) {
            localStorage.removeItem(key);
            localStorage.removeItem(getKotTimeKey());
            // Clear the customer name badge when the cart is emptied so it
            // does not re-appear if the same slot is reopened for a walk-in order.
            localStorage.removeItem(getCustomerNameKey());
            // [AI UPDATE 2026-09-12] session 2: clear the customer phone badge alongside the name.
            localStorage.removeItem(getCustomerPhoneKey());
            // [AI UPDATE 2026-09-15]: Clear the resolved manual-identity flag too, so a
            // fresh order in this slot always re-asks for customer details from scratch.
            localStorage.removeItem(getManualCustomerIdentityKey());
            // AI UPDATE [2026-09-12]: Clear any applied coupon for this slot too.
            localStorage.removeItem(getCouponKey());
            // AI UPDATE [2026-09-20]: ...and any Custom Instant Discount for this slot.
            localStorage.removeItem(getCustomDiscountKey());
        } else {
            localStorage.setItem(key, JSON.stringify(cartData));
        }
        window.dispatchEvent(new Event('cart-updated'));
    };

    window.addEventListener('pos-opened', (e) => {
        _loadCoupon(); // AI UPDATE [2026-09-12]: restore any applied coupon for this table/slot
        _loadCustomDiscount(); // AI UPDATE [2026-09-20]: restore any Custom Instant Discount for this slot
        _customDiscountNotice = '';
        const name = e.detail.name;
        const holdBtn = document.getElementById('holdBtn');
        const kotBtn = document.getElementById('kotBtn');
        const saveExitBtn = document.getElementById('saveExitBtn');

        if (name === 'Direct Entry') {
            if(holdBtn) holdBtn.style.display = 'none';
            if(kotBtn) kotBtn.style.display = 'none';
            if(saveExitBtn) {
                saveExitBtn.innerText = "SAVE ENTRY"; 
            }
        } else {
            if(holdBtn) holdBtn.style.display = 'block';
            if(kotBtn) kotBtn.style.display = 'block';
            if(saveExitBtn) {
                saveExitBtn.innerText = "SAVE & EXIT";
            }
        }
    });

    window.addEventListener('add-to-cart', (e) => {
        const item = e.detail;
        currentCart = getLocalCart();
        const existingItem = currentCart.find(i => i.id === item.id);
        if (existingItem) {
            existingItem.qty += 1;
            // Only update extras/specialRequest when the payload explicitly provides them
            // (property-presence check). A menu-panel event omits these keys entirely, so
            // existing addon metadata is preserved; a customer-panel re-merge supplies them.
            if ('extras' in item) {
                existingItem.extras = Array.isArray(item.extras) ? item.extras : [];
            }
            if ('specialRequest' in item) {
                existingItem.specialRequest = item.specialRequest || '';
            }
        } else {
            currentCart.push({
                id:             item.id,
                name:           item.name,
                price:          item.price,
                qty:            1,
                printedQty:     0,
                parcel:         false,
                extras:         Array.isArray(item.extras) ? item.extras : [],
                specialRequest: item.specialRequest || '',
            });
        }
        saveLocalCart(currentCart);
        renderCart();
    });

    window.addEventListener('add-custom-item-to-bill', (e) => {
        const item = e.detail;
        currentCart = getLocalCart();
        // AI UPDATE [2026-08-01]: Added parcel:false default — item-level parcel toggle (Table Orders only).
        currentCart.push({ id: item.id, name: item.name, price: item.price, qty: 1, printedQty: 0, parcel: false });
        saveLocalCart(currentCart);
        renderCart();
    });

    window.addEventListener('set-cart-quantity', (e) => {
        const item = e.detail;
        currentCart = getLocalCart();
        const existingIndex = currentCart.findIndex(i => i.id === item.id);

        if (item.qty <= 0) {
            if (existingIndex > -1) currentCart.splice(existingIndex, 1);
        } else if (existingIndex > -1) {
            currentCart[existingIndex].qty = item.qty;
            if ((currentCart[existingIndex].printedQty || 0) > item.qty) {
                currentCart[existingIndex].printedQty = item.qty;
            }
            // Property-presence check: only overwrite extras/specialRequest when the
            // payload explicitly contains the key. Menu quantity events omit these fields
            // entirely so existing addon metadata is never silently cleared; an explicit
            // empty value (e.g. extras: []) intentionally clears them.
            if ('extras' in item) {
                currentCart[existingIndex].extras = Array.isArray(item.extras) ? item.extras : [];
            }
            if ('specialRequest' in item) {
                currentCart[existingIndex].specialRequest = item.specialRequest || '';
            }
        } else {
            currentCart.push({
                id:             item.id,
                name:           item.name,
                price:          item.price,
                qty:            item.qty,
                printedQty:     0,
                parcel:         false,
                extras:         Array.isArray(item.extras) ? item.extras : [],
                specialRequest: item.specialRequest || '',
            });
        }

        saveLocalCart(currentCart);
        renderCart();
    });

    function updateQuantity(id, delta) {
        currentCart = getLocalCart();
        const itemIndex = currentCart.findIndex(item => item.id === id);
        if (itemIndex > -1) {
            currentCart[itemIndex].qty += delta;
            
            if ((currentCart[itemIndex].printedQty || 0) > currentCart[itemIndex].qty) {
                currentCart[itemIndex].printedQty = currentCart[itemIndex].qty;
            }

            if (currentCart[itemIndex].qty <= 0) currentCart.splice(itemIndex, 1);
            saveLocalCart(currentCart);
            renderCart();
        }
    }

    window.addEventListener('load-table-cart', () => {
        currentCart = getLocalCart();
        _servedItems.clear(); // clear served state when switching to a different table
        _loadCoupon();        // AI UPDATE [2026-09-12]: restore coupon state for this table/slot
        _loadCustomDiscount(); // AI UPDATE [2026-09-20]: restore Custom Instant Discount for this table/slot
        _customDiscountNotice = '';
        renderCart();
    });

    // =====================================
    // RENDER CART (COMPLETE FUNCTION)
    // =====================================
    // AI UPDATE [2026-08-01]: Added item-level Parcel Toggle support (Table Orders only).
    // Each cart item now has a small 📦 toggle button on the left of the item name.
    // Tapping it instantly marks that item as "Parcel" (green filled) or "Dine-In" (grey).
    // The parcel state is stored in the cart item (localStorage) as item.parcel: true/false.
    // Backward compatible — items without the field are treated as parcel: false.
    function renderCart() {
        cartItemsContainer.innerHTML = '';
        let totalAmount = 0;

        // ── Online customer name badge ──────────────────────────────────────────
        // Show the customer's real name (stored by incoming-orders.js when the
        // operator taps "Open in POS") at the top of the cart panel.
        // Only appears for online orders; hidden for manual/walk-in carts.
        // Animation (ocbPulse) is declared in index.html <style> and stops
        // automatically when the badge is hidden (display:none via ocb-hidden).
        const _badgeEl = document.getElementById('onlineCustomerBadge');
        if (_badgeEl) {
            const _cname = localStorage.getItem(getCustomerNameKey());
            if (_cname) {
                _badgeEl.innerHTML =
                    `<span class="ocb-icon">👤</span>` +
                    `<span class="ocb-label">Customer</span>` +
                    `<span class="ocb-name">${_cname}</span>`;
                _badgeEl.classList.remove('ocb-hidden');
            } else {
                _badgeEl.classList.add('ocb-hidden');
            }
        }
        // ── end badge ──────────────────────────────────────────────────────────

        let fullKotBtn = document.getElementById('fullKotBtn');
        const kotBtn = document.getElementById('kotBtn');
        
        if(!fullKotBtn && kotBtn) {
            fullKotBtn = document.createElement('button');
            fullKotBtn.id = 'fullKotBtn';
            fullKotBtn.className = 'btn';
            fullKotBtn.style.background = '#8b5cf6'; 
            fullKotBtn.innerText = 'PRINT FULL K.O.T';
            fullKotBtn.style.display = 'none';
            
            // Insert right after KOT: View Details | KOT | PRINT FULL K.O.T | SAVE & EXIT
            kotBtn.insertAdjacentElement('afterend', fullKotBtn);
            
            fullKotBtn.addEventListener('click', () => printKOT(true)); 
        }

        let hasPrintedItems = currentCart.some(item => (item.printedQty || 0) > 0);
        
        if (fullKotBtn) {
            if (hasPrintedItems && activeTableNameEl.innerText !== 'Direct Entry') {
                fullKotBtn.style.display = 'block';
            } else {
                fullKotBtn.style.display = 'none';
            }
        }

        if (currentCart.length === 0) {
            cartItemsContainer.innerHTML = `
                <div style="text-align: center; color: #9ca3af; margin-top: 50px; font-weight: bold;">
                    Cart is empty <br> <span style="font-size: 0.8rem; font-weight: normal;">Click items to add</span>
                </div>  
            `;
            cartTotalElement.innerText = '₹0.00';
            _updateCouponUI(0); // AI UPDATE [2026-09-12]
            return;
        }

        // AI UPDATE [2026-08-01]: Read cartItemSourceMap once per render pass so each
        // item row knows whether it came from a Customer Panel order (and should show
        // the "Mark as Served" button).
        let _renderSourceMap = {};
        try {
            _renderSourceMap = JSON.parse(
                localStorage.getItem(`cartItemSourceMap_${getCurrentTable()}`) || '{}'
            );
        } catch (_) {}

        // AI UPDATE [2026-08-01]: Determine if this is a Table Order session.
        // The parcel toggle is only shown for Table Orders ("Table N"), not for
        // Parcel orders or Direct Entry.  Treat missing item.parcel as false (backward compat).
        const _isTableOrder = !getCurrentTable().includes('Parcel') && getCurrentTable() !== 'Direct Entry';

        currentCart.forEach(item => {
            const _extraPrice = Array.isArray(item.extras) ? item.extras.reduce((s, e) => s + (Number(e.price) || 0), 0) : 0;
            const itemTotal = (item.price + _extraPrice) * item.qty;
            totalAmount += itemTotal;

            // Backward compat: items saved before this feature have no parcel field → treat as false.
            const _isParcel = item.parcel === true;

            let unprintedQty = item.qty - (item.printedQty || 0);
            let unprintedTag = unprintedQty > 0 ? `<span style="background: #ef4444; color: white; font-size: 0.7rem; padding: 2px 5px; border-radius: 4px; margin-left: 5px;">+${unprintedQty} New</span>` : '';

            // 📦 Parcel badge — shown inline next to item name when marked Parcel
            const _parcelBadge = _isParcel ? `<span class="parcel-item-badge">📦 Parcel</span>` : '';

            // Parcel toggle button — only rendered in Table Order sessions
            const _parcelToggle = _isTableOrder
                ? `<button class="parcel-toggle-btn${_isParcel ? ' active' : ''}" data-id="${item.id}" title="${_isParcel ? 'Marked as Parcel — tap to set Dine-In' : 'Tap to mark as Parcel'}">📦</button>`
                : '';

            // Extras and special request HTML (pre-computed to avoid nested template literal issues)
            const _extrasHTML = Array.isArray(item.extras) && item.extras.length > 0
                ? '<div style="margin-top:4px;padding:0 2px;">' +
                  item.extras.map(e => '<span style="display:inline-block;font-size:0.72rem;background:rgba(245,158,11,0.12);color:#f59e0b;border:1px solid rgba(245,158,11,0.25);border-radius:4px;padding:2px 6px;margin:2px 2px 0 0;">+ ' + _escHtml(e.name) + (e.price ? ' (+₹' + Number(e.price) + ')' : '') + '</span>').join('') +
                  '</div>'
                : '';
            const _noteHTML = item.specialRequest
                ? '<div style="margin-top:5px;padding:5px 8px;background:rgba(99,102,241,0.10);border-left:2px solid #6366f1;border-radius:0 4px 4px 0;font-size:0.75rem;color:#a5b4fc;">📝 ' + _escHtml(item.specialRequest) + '</div>'
                : '';

            // AI UPDATE [2026-09-14]: Individual item timer badge. Shown only once the
            // item has its own KOT start time (item.kotStartTime, set in printKOT()).
            // Reuses the existing .order-timer badge/refresh mechanism (tables.js
            // refreshTimers(), already running on a 30s interval document-wide) —
            // the .item-timer class only overrides layout, not the color/threshold logic.
            // This is purely additive and does not touch the existing overall table timer.
            const _itemTimerHTML = item.kotStartTime
                ? `<span class="order-timer item-timer" data-start="${item.kotStartTime}">⏱ 0m</span>`
                : '';

            const cartItemDiv = document.createElement('div');
            cartItemDiv.className = 'cart-item';
            cartItemDiv.innerHTML = `
                <button class="cart-item-remove" data-id="${item.id}" title="Remove item">✕</button>
                <div class="cart-item-header">
                    <span style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">${_parcelToggle}${item.name} ${unprintedTag}${_parcelBadge}${_itemTimerHTML}</span>
                    <span class="editable-price" data-id="${item.id}" style="cursor:pointer; color:#10b981; font-weight:bold; border-bottom:1px dashed #10b981;">
                        ₹${itemTotal}
                    </span>
                </div>
                <div class="cart-item-controls">
                    <span style="color: #4b5563; font-size: 1.1rem; font-weight: bold;">₹${item.price} × ${item.qty}</span>
                    <div class="quantity-control">
                        <button class="qty-btn qty-minus" data-id="${item.id}">−</button>
                        <input type="number" class="qty-input" data-id="${item.id}" value="${item.qty}" min="1">
                        <button class="qty-btn qty-plus" data-id="${item.id}">+</button>
                    </div>
                </div>
                ${_extrasHTML}${_noteHTML}
                ${_renderSourceMap.hasOwnProperty(item.id) ? `
                <div style="margin-top:6px;">
                    <button class="mark-served-btn${_servedItems.has(item.id) ? ' served' : ''}"
                        data-id="${item.id}"
                        ${_servedItems.has(item.id) ? 'disabled' : ''}
                        style="width:100%;padding:5px 10px;border:none;border-radius:6px;font-size:0.78rem;font-weight:600;cursor:${_servedItems.has(item.id) ? 'default' : 'pointer'};background:${_servedItems.has(item.id) ? 'rgba(16,185,129,0.12)' : 'rgba(16,185,129,0.22)'};color:${_servedItems.has(item.id) ? '#6ee7b7' : '#10b981'};opacity:${_servedItems.has(item.id) ? '0.6' : '1'};">
                        ${_servedItems.has(item.id) ? '✅ Served' : '✓ Mark Served'}
                    </button>
                </div>` : ''}
            `;

            cartItemsContainer.appendChild(cartItemDiv);
        });

        cartTotalElement.innerText = `₹${totalAmount.toFixed(2)}`;
        _updateCouponUI(totalAmount); // AI UPDATE [2026-09-12]: refresh coupon discount / payable rows

        // AI UPDATE [2026-09-14]: Immediately compute correct "Xm" text + color state
        // for the per-item timer badges just inserted above, instead of waiting for
        // tables.js's next 30s tick. Reuses tables.js's existing refreshTimers()
        // (exposed as window._refreshOrderTimers) rather than duplicating the
        // threshold logic here. No-op if tables.js hasn't loaded yet.
        if (typeof window._refreshOrderTimers === 'function') {
            window._refreshOrderTimers();
        }

        document.querySelectorAll('.qty-minus').forEach(btn => {
            btn.addEventListener('click', (e) => updateQuantity(e.target.dataset.id, -1));
        });
        document.querySelectorAll('.qty-plus').forEach(btn => {
            btn.addEventListener('click', (e) => updateQuantity(e.target.dataset.id, 1));
        });

        // Qty input: direct typing → update on change/blur
        document.querySelectorAll('.qty-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const id = e.target.dataset.id;
                const newQty = parseInt(e.target.value, 10);
                const idx = currentCart.findIndex(i => i.id === id);
                if (idx === -1) return;
                if (!isNaN(newQty) && newQty > 0) {
                    if ((currentCart[idx].printedQty || 0) > newQty) {
                        currentCart[idx].printedQty = newQty;
                    }
                    currentCart[idx].qty = newQty;
                } else {
                    currentCart.splice(idx, 1);
                }
                saveLocalCart(currentCart);
                renderCart();
            });
            // Prevent wheel from accidentally changing qty
            input.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
        });

        // Remove button: instant full removal
        document.querySelectorAll('.cart-item-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const idx = currentCart.findIndex(i => i.id === id);
                if (idx !== -1) {
                    currentCart.splice(idx, 1);
                    saveLocalCart(currentCart);
                    renderCart();
                }
            });
        });

        // ✅ CUSTOM MODAL WALA PRICE EDIT — RENDER CART KE ANDAR
        document.querySelectorAll('.editable-price').forEach(span => {
            span.addEventListener('click', (e) => {
                const itemId = e.target.dataset.id;
                let item = currentCart.find(i => i.id === itemId);
                
                const modal = document.getElementById('priceEditModal');
                const itemNameEl = document.getElementById('priceEditItemName');
                const inputEl = document.getElementById('newPriceInput');
                const saveBtn = document.getElementById('savePriceBtn');
                const cancelBtn = document.getElementById('cancelPriceEditBtn');
                
                itemNameEl.textContent = item.name;
                inputEl.value = item.price;
                modal.classList.remove('hidden');
                
                setTimeout(() => inputEl.focus(), 100);
                
                const handleSave = () => {
                    const newPrice = inputEl.value;
                    if (newPrice !== "" && !isNaN(newPrice) && Number(newPrice) > 0) {
                        item.price = Number(newPrice);
                        saveLocalCart(currentCart);
                        renderCart();
                    }
                    modal.classList.add('hidden');
                    cleanup();
                };
                
                const handleCancel = () => {
                    modal.classList.add('hidden');
                    cleanup();
                };
                
                const handleKey = (ev) => {
                    if (ev.key === 'Enter') handleSave();
                    if (ev.key === 'Escape') handleCancel();
                };
                
                const cleanup = () => {
                    saveBtn.removeEventListener('click', handleSave);
                    cancelBtn.removeEventListener('click', handleCancel);
                    inputEl.removeEventListener('keydown', handleKey);
                };
                
                saveBtn.addEventListener('click', handleSave);
                cancelBtn.addEventListener('click', handleCancel);
                inputEl.addEventListener('keydown', handleKey);
            });
        });

        // AI UPDATE [2026-08-01]: Parcel Toggle — flip item.parcel on tap (Table Orders only).
        // Saves immediately to localStorage and re-renders so the badge updates instantly.
        document.querySelectorAll('.parcel-toggle-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.id;
                const idx = currentCart.findIndex(i => i.id === id);
                if (idx === -1) return;
                currentCart[idx].parcel = !(currentCart[idx].parcel === true);
                saveLocalCart(currentCart);
                renderCart();
            });
        });

        // AI UPDATE [2026-08-01]: "Mark as Served" — per-item served status for items
        // that originated from a Customer Panel order (have a cartItemSourceMap entry).
        // Writes itemMeta.<key>.servedAt + itemStatus:'served' to Firestore without
        // touching the order-level status field (covered by isAllowedItemMetaUpdate()
        // in firestore.rules).  Row is re-rendered in a muted "Served" visual state.
        document.querySelectorAll('.mark-served-btn:not([disabled])').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const itemId = e.currentTarget.dataset.id;
                let _sm = {};
                try { _sm = JSON.parse(localStorage.getItem(`cartItemSourceMap_${getCurrentTable()}`) || '{}'); } catch (_) {}
                const orderId = _sm[itemId];
                if (!orderId) return;

                try {
                    await updateDoc(doc(db, 'pending_table_orders', orderId), {
                        [`itemMeta.${itemId}.servedAt`]:   serverTimestamp(),
                        [`itemMeta.${itemId}.itemStatus`]: 'served',
                    });
                    console.log(`[Served] Marked item ${itemId} as served on order ${orderId}`);
                } catch (_e) {
                    console.warn('[Served] updateDoc failed (non-fatal):', _e.message);
                }
                _servedItems.add(itemId);
                renderCart();
            });
        });
    } // renderCart() END

    const holdBtn = document.getElementById('holdBtn');
    const kotBtn = document.getElementById('kotBtn');
    const checkoutBtn = document.getElementById('checkoutBtn');
    const saveExitBtn = document.getElementById('saveExitBtn'); 
    const backToTablesBtn = document.getElementById('backToTablesBtn');

    const getDisplayTitle = () => {
        const tName = getCurrentTable();
        if(tName === 'Direct Entry') return 'Cash Sale';
        return tName; 
    };

    if (holdBtn) holdBtn.addEventListener('click', () => {
        // If the cart is empty and an order was imported via "Open in POS",
        // auto-cancel it so the customer panel clears "Order Confirmed".
        // Fire-and-forget — navigation proceeds immediately regardless.
        if (currentCart.length === 0) {
            // AI UPDATE [2026-09-13]: pass customerSlot — see cancelImportedOrdersOnEmptyCart().
            cancelImportedOrdersOnEmptyCart(getCurrentTable(), getCurrentCustomer());
        }
        backToTablesBtn.click();
    });

    // ── triggerRawBTPrint — original text-based rawbt: transport (KOT + fallback) ──
    // Kept unchanged. Used by KOT printing and as fallback when the ESC/POS
    // encoder is unavailable.
    const triggerRawBTPrint = (text) => {
        const uri = "rawbt:" + encodeURIComponent(text);
        const a = document.createElement('a');
        a.href = uri;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    // ── triggerESCPOSPrint — binary ESC/POS rawbt: transport (bill receipts) ────
    // AI UPDATE [2026-07-30]: New function for sending a Uint8Array ESC/POS buffer
    // through the same rawbt: URI scheme.  The Uint8Array is converted to a binary
    // string before URL-encoding so RawBT receives the exact bytes the encoder
    // produced (including all ESC/POS control sequences for alignment, bold,
    // image raster data, paper cut, etc.).
    // The Bluetooth pairing, connection, and RawBT dispatch are unchanged.
    const triggerESCPOSPrint = (uint8Array) => {
        let binaryStr = '';
        for (let i = 0; i < uint8Array.length; i++) {
            binaryStr += String.fromCharCode(uint8Array[i]);
        }
        const uri = 'rawbt:' + encodeURIComponent(binaryStr);
        const a = document.createElement('a');
        a.href = uri;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    const centerText = (text) => {
        if (text.length >= 32) return text.substring(0, 32);
        const spaces = Math.floor((32 - text.length) / 2);
        return " ".repeat(spaces) + text;
    };

    const getFormattedDate = () => {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yy = String(now.getFullYear()).slice(-2);
        let hours = now.getHours();
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        return `${dd}/${mm}/${yy} ${hours}:${minutes} ${ampm}`;
    };

    const formatBillRow = (name, qty, rate, total) => {
        let nameLines = [];
        let currentLine = "";
        let words = name.split(" ");
        
        for(let w of words) {
            if((currentLine + w).length > 14) {
                if(currentLine) nameLines.push(currentLine.trim());
                currentLine = w + " ";
            } else {
                currentLine += w + " ";
            }
        }
        if(currentLine) nameLines.push(currentLine.trim());

        let res = "";
        for(let i=0; i<nameLines.length; i++) {
            let line = nameLines[i].padEnd(14, " ");
            if(i === 0) {
                let q = String(qty).padStart(3, " ");
                let r = String(rate).padStart(4, " ");
                let t = String(total).padStart(6, " ");
                res += `${line} ${q} ${r}  ${t}\n`;
            } else {
                res += `${line}\n`;
            }
        }
        return res;
    };

    // AI UPDATE [2026-07-31]: Made async — required because the dialog session added
    // await showAlert() inside this function but forgot to make it async first.
    // A non-async arrow function with await inside is a SyntaxError in an ES module,
    // which caused the entire cart.js module to fail to parse — breaking ALL cart
    // functionality (add-to-cart, load-table-cart, KOT, Bill & Settle, Save & Exit,
    // Cancel Order, and incoming-order cart population). Making the function async
    // is the minimal, safe fix: it does not change any other behaviour.
    const printKOT = async (isFullKot = false) => {
        if (!currentCart || currentCart.length === 0) return;
        
        const itemsToPrint = isFullKot 
            ? currentCart.map(item => ({
                id:             item.id,
                name:           item.name,
                printQty:       item.qty,
                extras:         Array.isArray(item.extras) ? item.extras : [],
                specialRequest: item.specialRequest || '',
              }))
            : currentCart
                .filter(item => item.qty > (item.printedQty || 0))
                .map(item => ({
                    id:             item.id,
                    name:           item.name,
                    printQty:       item.qty - (item.printedQty || 0),
                    extras:         Array.isArray(item.extras) ? item.extras : [],
                    specialRequest: item.specialRequest || '',
                }));

        if (itemsToPrint.length === 0) {
            // AI UPDATE [2026-07-30]: Replaced alert() with custom dialog.
            await showAlert(
                "Koi naya item nahi hai! Puraana order print karne ke liye 'PRINT FULL K.O.T' dabayein.",
                'warning',
                'No New Items'
            );
            return;
        }

        const kotTimeKey = getKotTimeKey();
        if (!localStorage.getItem(kotTimeKey)) {
            localStorage.setItem(kotTimeKey, Date.now().toString());
        }

        // ── Sync KOT status to customer panel in real-time ─────────────────────
        // AI UPDATE [2026-08-01]: Replaced the original block that overwrote kotAt on
        // EVERY active order for the table (including already-preparing items), which
        // reset their kitchen timers to zero on every subsequent KOT press.
        //
        // New per-item logic:
        //   1. Read cartItemSourceMap_<table> (resolvedId → firestoreOrderDocId).
        //   2. Group itemsToPrint by source orderId; items with no mapping (manual
        //      POS items) are skipped — they have no pending_table_orders document.
        //   3. For each source order: fetch the doc, then build a selective payload:
        //        - itemMeta.<key>.kotAt set ONLY if currently null (new item).
        //        - Existing kotAt values are NEVER overwritten (timer preserved).
        //        - Order-level status + kotAt written only on first KOT (not 'kot' yet).
        //   Fallback: if cartItemSourceMap is empty/missing (manual session or legacy),
        //   fall back to the original table-wide query but guard against resetting
        //   kotAt on already-'kot' docs.
        (async () => {
            try {
                const _currentTable = getCurrentTable();
                let _sourceMap = {};
                try {
                    _sourceMap = JSON.parse(
                        localStorage.getItem(`cartItemSourceMap_${_currentTable}`) || '{}'
                    );
                } catch (_) {}

                if (Object.keys(_sourceMap).length > 0) {
                    // ── Per-item path: group itemsToPrint by source orderId ──────────
                    const _orderItems = new Map(); // orderId → Set<itemKey>
                    for (const itm of itemsToPrint) {
                        const orderId = _sourceMap[itm.id];
                        if (!orderId) continue; // manual POS item — no Firestore doc
                        if (!_orderItems.has(orderId)) _orderItems.set(orderId, new Set());
                        _orderItems.get(orderId).add(itm.id);
                    }

                    for (const [orderId, itemKeys] of _orderItems) {
                        try {
                            const _docRef  = doc(db, 'pending_table_orders', orderId);
                            const _docSnap = await getDoc(_docRef);
                            if (!_docSnap.exists()) continue;

                            const _data         = _docSnap.data();
                            const _docStatus    = (_data.status || 'pending').toLowerCase();
                            const _existingMeta = _data.itemMeta || {};
                            const _payload      = {};

                            // Per-item kotAt: stamp only items not yet KOT'd
                            for (const itemKey of itemKeys) {
                                const _meta = _existingMeta[itemKey];
                                if (!_meta || !_meta.kotAt) {
                                    // First KOT for this item — stamp it
                                    _payload[`itemMeta.${itemKey}.kotAt`]      = serverTimestamp();
                                    _payload[`itemMeta.${itemKey}.itemStatus`] = 'preparing';
                                }
                                // kotAt already exists → DO NOT overwrite; timer is preserved
                            }

                            // Order-level status + kotAt: only on first KOT for this order
                            if (_docStatus !== 'kot') {
                                _payload.status = 'kot';
                                _payload.kotAt  = serverTimestamp();  // written once only
                            }

                            if (Object.keys(_payload).length > 0) {
                                await updateDoc(_docRef, _payload);
                                console.log(`[KOT] Updated order ${orderId}:`, Object.keys(_payload));
                            }
                        } catch (_e) {
                            console.warn('[KOT] per-item sync failed for order', orderId, _e);
                        }
                    }
                } else {
                    // ── Fallback: no cartItemSourceMap (manual / legacy session) ─────
                    // Guard: never reset kotAt on already-'kot' documents.
                    const _snap = await getDocs(query(
                        collection(db, 'pending_table_orders'),
                        where('tableId', '==', _currentTable)
                    ));
                    _snap.docs.forEach(_d => {
                        const _st = (_d.data().status || 'pending').toLowerCase();
                        if (['pending', 'accepted', 'kot'].includes(_st)) {
                            const _upd = _st === 'kot'
                                ? { status: 'kot' }                            // already KOT'd — no kotAt reset
                                : { status: 'kot', kotAt: serverTimestamp() }; // first KOT — stamp it
                            updateDoc(_d.ref, _upd)
                                .catch(e => console.warn('[KOT] fallback sync failed:', e));
                        }
                    });
                }
            } catch(e) { console.warn('[KOT] sync failed:', e); }
        })();

        const BOLD_ON = '\x1B\x45\x01';
        const BOLD_OFF = '\x1B\x45\x00';
        const now = new Date();
        const timeStr = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getFullYear()).slice(-2)} ${now.getHours()%12||12}:${String(now.getMinutes()).padStart(2,'0')} ${now.getHours()>=12?'PM':'AM'}`;
        
        // AI UPDATE [2026-08-01]: Split itemsToPrint into Dine-In and Parcel groups.
        // Only Table Orders support item-level parcel flags; Parcel / Direct Entry
        // sessions never set item.parcel=true, so this is fully backward compatible.
        const _dineInToPrint  = itemsToPrint.filter(itm => {
            const ci = currentCart.find(i => i.id === itm.id);
            return !ci || ci.parcel !== true;
        });
        const _parcelToPrint  = itemsToPrint.filter(itm => {
            const ci = currentCart.find(i => i.id === itm.id);
            return ci && ci.parcel === true;
        });

        let kotText = BOLD_ON;
        if (isFullKot) kotText += "FULL K.O.T\n";
        kotText += `KOT No: ${Math.floor(Math.random()*900)+100}\n`;
        kotText += `Time: ${timeStr}\n`;
        kotText += `Table: ${getDisplayTitle()}\n\n`;

        // AI UPDATE [2026-09-15]: Large centered "P" marker for Parcel KOTs only.
        // Purpose: make Parcel KOTs instantly recognisable to kitchen staff without
        // manually writing "P" with a pen (see AI_HANDOFF.md for full note).
        // Reuses the SAME raw ESC/POS transport already used for BOLD_ON/BOLD_OFF
        // above (triggerRawBTPrint / rawbt: URI) — no new printing mechanism.
        // ESC a 1  = center justification | GS ! 0x11 = double height + double width
        // Both are reset immediately after the "P" so the item list below prints
        // exactly as it always has (left-aligned, normal size) — no overflow risk.
        const _isParcelKOT = getCurrentTable().includes('Parcel');
        if (_isParcelKOT) {
            const ESC_CENTER     = '\x1B\x61\x01'; // center justification
            const ESC_LEFT       = '\x1B\x61\x00'; // restore left justification
            const GS_DOUBLE_SIZE = '\x1D\x21\x11'; // double height + double width
            const GS_NORMAL_SIZE = '\x1D\x21\x00'; // restore normal text size
            kotText += ESC_CENTER + GS_DOUBLE_SIZE + 'P' + GS_NORMAL_SIZE + ESC_LEFT + '\n\n';
        }

        // Helper: renders one KOT item with its extras and special request
        const _renderKOTItem = (item) => {
            let s = `${item.name} (${item.printQty})\n`;
            if (Array.isArray(item.extras) && item.extras.length > 0) {
                for (const extra of item.extras) {
                    s += `+ ${extra.name}\n`;
                }
            }
            if (item.specialRequest) {
                s += `\nSpecial Request:\n${item.specialRequest}\n`;
            }
            s += `\n`;  // blank line between items
            return s;
        };

        // Dine-In items
        for (const item of _dineInToPrint) {
            kotText += _renderKOTItem(item);
        }

        // Parcel items — printed under a clear separator so kitchen knows to pack them
        if (_parcelToPrint.length > 0) {
            kotText += `----------------------\n`;
            kotText += `[PARCEL]\n`;
            kotText += `----------------------\n`;
            for (const item of _parcelToPrint) {
                kotText += _renderKOTItem(item);
            }
        }

        kotText += "\n\n\n" + BOLD_OFF;

        triggerRawBTPrint(kotText);

        // AI UPDATE [2026-09-14]: Per-item timer support. Build a lookup of which
        // items are actually part of THIS KOT press (itemsToPrint, computed above)
        // so each item can be stamped with its own start time the first time it is
        // ever sent to the kitchen — independent of, and without touching, the
        // existing overall table timer (kotTimeKey, set earlier in this function).
        const _itemsToPrintIds = new Set(itemsToPrint.map(i => i.id));

        setTimeout(() => {
            const _kotNow = Date.now();
            for (const item of currentCart) {
                item.printedQty = item.qty;
                // Stamp this item's own timer start once, on its first KOT press
                // (partial or full). Never overwritten afterward, so re-printing a
                // Full KOT or bumping quantity later does not reset an item's timer.
                if (_itemsToPrintIds.has(item.id) && !item.kotStartTime) {
                    item.kotStartTime = _kotNow;
                }
            }
            saveLocalCart(currentCart);
            renderCart();
        }, 0);
    };

    if (kotBtn) {
        kotBtn.addEventListener('click', () => printKOT(false));
    }

    // ── Custom Instant Discount: modal + Edit / Remove wiring ──────────────────
    // AI UPDATE [2026-09-20]: opens a small modal (₹ amount, CANCEL / APPLY DISCOUNT).
    // All rules live in _validateCustomDiscountInput() / _computePricing() (see the
    // CUSTOM INSTANT DISCOUNT block above) — this section is only DOM plumbing, so
    // there is exactly one validation path and one total calculation.
    (function wireCustomDiscount() {
        const modalEl  = document.getElementById('customDiscountModal');
        const inputEl  = document.getElementById('customDiscountInput');
        const errEl    = document.getElementById('customDiscountError');
        const hintEl   = document.getElementById('customDiscountHint');
        const applyBtn = document.getElementById('applyCustomDiscountBtn');
        const cancelBtn= document.getElementById('cancelCustomDiscountBtn');
        const openBtn  = document.getElementById('customDiscountBtn');
        const editBtn  = document.getElementById('customDiscountEditBtn');
        const removeBtn= document.getElementById('customDiscountRemoveBtn');
        if (!modalEl || !inputEl || !applyBtn || !cancelBtn) return;

        const showError = (msg) => { if (errEl) errEl.textContent = msg || ''; };
        const closeModal = () => { modalEl.classList.add('hidden'); showError(''); };

        function openModal() {
            const rawTotal = _rawCartTotal();
            // Mutually exclusive with coupons (single-discount model).
            if (_appliedCoupon) { renderCart(); return; }
            if (rawTotal <= 0) { renderCart(); return; }
            _customDiscountNotice = '';
            showError('');
            inputEl.value = _customDiscount ? String(_customDiscount.amount) : '';
            if (hintEl) hintEl.textContent = `Order amount: ₹${_fmtMoney(rawTotal)}`;
            modalEl.classList.remove('hidden');
            setTimeout(() => { inputEl.focus(); inputEl.select(); }, 100);
        }

        function applyFromModal() {
            const rawTotal = _rawCartTotal();
            if (_appliedCoupon) { showError('Remove the coupon to use a custom discount.'); return; }
            const result = _validateCustomDiscountInput(inputEl.value, rawTotal);
            if (!result.ok) { showError(result.error); return; }
            _customDiscount = { amount: result.value };
            _customDiscountNotice = '';
            _saveCustomDiscount();
            closeModal();
            renderCart(); // payable updates immediately
        }

        openBtn?.addEventListener('click', openModal);
        editBtn?.addEventListener('click', openModal);
        removeBtn?.addEventListener('click', () => {
            _customDiscount = null;
            _customDiscountNotice = '';
            _saveCustomDiscount();
            renderCart(); // original total restored immediately
        });
        applyBtn.addEventListener('click', applyFromModal);
        cancelBtn.addEventListener('click', closeModal);
        inputEl.addEventListener('input', () => showError(''));
        inputEl.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); applyFromModal(); }
        });
        // Esc closes from anywhere while the modal is open (not only when the input has focus).
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && !modalEl.classList.contains('hidden')) { ev.preventDefault(); closeModal(); }
        });
        modalEl.addEventListener('click', (ev) => { if (ev.target === modalEl) closeModal(); }); // backdrop
    })();
    // ── end Custom Instant Discount wiring ──────────────────────────────────────

    // ── Apply Coupon ───────────────────────────────────────────────────────────
    // AI UPDATE [2026-09-12]: Verifies the code against coupons/{code} in
    // Firestore, checks it hasn't been used, and checks the current cart total
    // meets that coupon's minimum order requirement (default ₹200). Does NOT
    // mark the coupon used yet — that only happens on actual Bill & Settle /
    // Save & Exit, below, so an abandoned/cancelled order never burns it.
    const applyCouponBtn = document.getElementById('applyCouponBtn');
    if (applyCouponBtn) {
        applyCouponBtn.addEventListener('click', async () => {
            const inputEl = document.getElementById('couponCodeInput');
            const msgEl   = document.getElementById('couponMsg');
            const code = (inputEl?.value || '').trim().toUpperCase();
            if (!code) return;

            applyCouponBtn.disabled = true;
            const _origLabel = applyCouponBtn.textContent;
            applyCouponBtn.textContent = '…';

            try {
                const rawTotal = _rawCartTotal();

                // AI UPDATE [2026-09-20]: authoritative single-discount guard — a coupon can't be
                // applied while a Custom Instant Discount is active (the disabled input is only UX).
                if (_customDiscountFor(rawTotal) > 0) {
                    if (msgEl) msgEl.innerHTML =
                        `<span style="color:#f85149;">❌ Remove the Custom Discount to use a coupon</span>`;
                    return; // `finally` below restores the button and re-renders
                }

                // [AI UPDATE 2026-09-12] session 2: authoritative section gate — this is the
                // real enforcement point (the disabled input/button is only the UX layer, see
                // _updateCouponUI). Checked before any Firestore read so a bypassed disabled
                // attribute still cannot redeem a coupon below the minimum subtotal.
                if (rawTotal <= COUPON_SECTION_MIN_SUBTOTAL) {
                    if (msgEl) msgEl.innerHTML =
                        `<span style="color:#f85149;">❌ Order subtotal must be above ₹${COUPON_SECTION_MIN_SUBTOTAL} to use a coupon</span>`;
                    applyCouponBtn.disabled = false;
                    applyCouponBtn.textContent = _origLabel;
                    return;
                }

                const snap = await getDoc(doc(db, 'coupons', code));

                if (!snap.exists()) {
                    if (msgEl) msgEl.innerHTML = `<span style="color:#f85149;">❌ Invalid coupon code</span>`;
                } else {
                    const cp = snap.data();
                    const minOrder = cp.minOrder || 200;

                    // [AI UPDATE 2026-09-12] session 2: personalized-coupon customer binding.
                    // cp.phone is set on every coupon currently issued (loyalty + personalized —
                    // see header comment). If it doesn't match whoever is actually seated in this
                    // table/slot, refuse — this is what stops Customer A's coupon being applied to
                    // Customer B's bill. A coupon with no phone (none exist today) is treated as
                    // usable by anyone, so this stays forward-compatible if a true "global" coupon
                    // type is added later without inventing that feature now.
                    const _slotPhone = localStorage.getItem(getCustomerPhoneKey()) || '';
                    if (cp.phone && cp.phone !== _slotPhone) {
                        if (msgEl) msgEl.innerHTML = `<span style="color:#f85149;">❌ This coupon isn't valid for this customer</span>`;
                    } else if (cp.used) {
                        if (msgEl) msgEl.innerHTML = `<span style="color:#f85149;">❌ Coupon already used</span>`;
                    } else if (rawTotal < minOrder) {
                        if (msgEl) msgEl.innerHTML = `<span style="color:#f85149;">❌ Minimum order ₹${minOrder} required (current ₹${rawTotal.toFixed(0)})</span>`;
                    } else {
                        // [AI UPDATE 2026-09-12] session 2: phone stored alongside the applied
                        // coupon so the redemption handlers (Bill & Settle / Save & Exit) can
                        // re-verify customer binding right before marking it used, not just here.
                        // AI UPDATE [2026-09-20]: re-check after the async Firestore read — a Custom
                        // Instant Discount may have been applied while the lookup was in flight.
                        if (_customDiscountFor(rawTotal) > 0) {
                            if (msgEl) msgEl.innerHTML =
                                `<span style="color:#f85149;">❌ Remove the Custom Discount to use a coupon</span>`;
                        } else {
                            _appliedCoupon = { code, amount: Number(cp.amount) || 0, minOrder, phone: cp.phone || '' };
                            _saveCoupon();
                        }
                    }
                }
            } catch (err) {
                console.error('[Coupon] verify failed:', err);
                if (msgEl) msgEl.innerHTML = `<span style="color:#f85149;">⚠️ Could not verify coupon — check connection</span>`;
            } finally {
                applyCouponBtn.disabled = false;
                applyCouponBtn.textContent = _origLabel;
                renderCart();
            }
        });
    }

    // ── Bill & Settle ──────────────────────────────────────────────────────────
    if (checkoutBtn) {
        checkoutBtn.addEventListener('click', async () => {
            if (currentCart.length === 0) return;

            const tableName    = getCurrentTable();
            const customerName = getCurrentCustomer();

            // [AI UPDATE 2026-09-14] Manual POS customer identification.
            // Only prompt when THIS slot has no existing Customer Panel identity
            // (same key syncCustomerOrderCompletion() already gates on below) —
            // QR customers are never asked for their name/phone again.
            //
            // [AI UPDATE 2026-09-15] BUG FIX: this used to await the popup and then
            // fall straight through into billing/printing/saving in the SAME click —
            // so "Continue"/"Skip" silently settled the bill immediately. That's wrong:
            // the popup must only CAPTURE the customer identity and hand control back
            // to the cart screen. Billing itself only happens on the NEXT press of
            // Bill & Settle, once an identity decision is already on record for this
            // slot (see getManualCustomerIdentityKey()).
            const _hasCustomerIdentity = !!localStorage.getItem(`activeCustomerUid_${tableName}_${customerName}`);
            let _manualCustomer = { name: '', phone: '' };
            if (!_hasCustomerIdentity) {
                const _identityKey = getManualCustomerIdentityKey();
                const _resolvedRaw = localStorage.getItem(_identityKey);
                if (_resolvedRaw) {
                    // Identity already resolved on a previous press — reuse it and
                    // fall through to actually bill.
                    try { _manualCustomer = JSON.parse(_resolvedRaw); } catch (_) { _manualCustomer = { name: '', phone: '' }; }
                } else {
                    // First press for this bill — ask, remember the answer, then STOP.
                    const _picked = await showCustomerDetailsPopup({ onLookupPhone: _lookupManualCustomerByPhone });
                    localStorage.setItem(_identityKey, JSON.stringify(_picked));

                    // If details were given, show the same name badge an online order
                    // gets (getCustomerNameKey()/getCustomerPhoneKey() — read by
                    // renderCart() and the badge's click handler further up this file),
                    // so tapping it opens the identical customer coupons/offers panel.
                    if (_picked.name || _picked.phone) {
                        localStorage.setItem(getCustomerNameKey(), _picked.name || 'Customer');
                        if (_picked.phone) localStorage.setItem(getCustomerPhoneKey(), `+91${_picked.phone}`);
                        renderCart();
                    }

                    // Return to the cart untouched — do NOT bill yet. The operator
                    // presses Bill & Settle again to actually process the bill.
                    return;
                }
            }

            // AI UPDATE [2026-09-12]: rawTotal = pre-discount cart total (unchanged
            // calculation). discount comes from any validly-applied coupon. total is
            // now the final payable amount used for the bill, sales_history, and
            // customer lifetime-spend sync.
            const rawTotal  = currentCart.reduce((sum, item) => {
                const ep = Array.isArray(item.extras) ? item.extras.reduce((s, e) => s + (Number(e.price) || 0), 0) : 0;
                return sum + (item.price + ep) * item.qty;
            }, 0);
            // AI UPDATE [2026-09-20]: the coupon/custom-discount/total split now comes from the ONE
            // authoritative _computePricing() (which internally does the same authoritative
            // _getRedeemableCoupon() re-check as before, and enforces "custom discount and coupon are
            // mutually exclusive"). `discount` keeps its original meaning — the COUPON discount — so
            // every coupon line below is unchanged; `customDiscount` is the new order-level field.
            const _pricing        = _computePricing(rawTotal);
            const _couponToRedeem = _pricing.coupon;
            const discount        = _pricing.couponDiscount;
            const customDiscount  = _pricing.customDiscount;
            const total           = _pricing.total;

            // AI UPDATE [2026-09-16] EDIT HISTORY: if this slot was loaded via
            // "Edit History" (js/order-edit.js), _editMode is non-null and carries
            // the ORIGINAL sales_history/customer_order_history doc ID + total. See
            // the header comment on _getEditMode() above for the full explanation.
            const _editMode = _getEditMode(tableName, customerName);

            // ── Snapshot cart before clearing ─────────────────────────────────
            const cartSnapshot = currentCart.slice();

            // AI UPDATE [2026-09-20] BUG FIX (online-customer Edit History): capture the online
            // customer's identity HERE — before saveLocalCart([]) below, which deletes the
            // customerName_/customerPhone_ badge keys. These three reads used to sit AFTER that call
            // (further down, next to the sales_history write), so they always returned null:
            // sales_history.onlineCustomerName/Phone were saved as null and the History-drawer/details.html
            // customer line was blank for online Bill & Settle bills. Save & Exit already read them in
            // this order. See the BUG FIX note on syncCustomerOrderCompletion().
            // Gated on _onlineUid so a MANUAL customer's badge keys (set by the identity popup) are NOT
            // newly copied into sales_history.onlineCustomerName/Phone — manual Bill & Settle records stay
            // exactly as they were (their identity is stored in manualCustomerName/Phone).
            const _onlineUid   = localStorage.getItem(`activeCustomerUid_${tableName}_${customerName}`) || null;
            const _onlineName  = _onlineUid ? (localStorage.getItem(getCustomerNameKey())  || _editOnlineIdentity(_editMode).name  || null) : null;
            const _onlinePhone = _onlineUid ? (localStorage.getItem(getCustomerPhoneKey()) || _editOnlineIdentity(_editMode).phone || null) : null;

            // ── Build and print bill immediately (no network wait) ────────────
            // AI UPDATE [2026-07-30]: Replace manual string-based bill generation
            // with ESC/POS encoder (esc-pos-encoder library via CDN in index.html).
            // buildBillReceipt() returns a Uint8Array; sent via triggerESCPOSPrint().
            // Falls back to the legacy text receipt if the library is unavailable.
            let shortOrderId = String(Date.now()).slice(-5);
            const escposBuffer = buildBillReceipt(
                currentCart,
                getDisplayTitle(),
                shortOrderId,
                getFormattedDate(),
                // AI UPDATE [2026-09-20]: one discount slot on the bill (single-discount model) — either the
                // coupon (unchanged) or the Custom Instant Discount (label-only entry, see receipt-builder.js).
                customDiscount > 0
                    ? { label: 'Custom Discount', amount: customDiscount }
                    : (discount > 0 ? { code: _couponToRedeem.code, amount: discount } : null)
            );

            if (escposBuffer) {
                // ── ESC/POS path: proper column alignment, logo, bold totals ──
                triggerESCPOSPrint(escposBuffer);
            } else {
                // ── Legacy fallback: plain text (library unavailable) ─────────
                const BOLD_ON  = '\x1B\x45\x01';
                const BOLD_OFF = '\x1B\x45\x00';
                let billText = BOLD_ON;
                billText += centerText("NEW PIZZA HUT AND LIVE CAKE") + "\n";
                billText += centerText("in front of SBI bank ke tik") + "\n";
                billText += centerText("samne salempur Deoria, UP") + "\n";
                billText += centerText("FSSAI: 30230324113093042") + "\n";
                billText += centerText("Phone: 9628548655") + "\n\n";
                billText += `Bill No: ${shortOrderId}\n`;
                billText += `Created On: ${getFormattedDate()}\n`;
                billText += `Bill To: ${getDisplayTitle()}\n\n`;
                billText += "Item Name      Qty Rate  Total\n\n";
                let legacyTotalQty = 0;
                let _legacyTotal = 0;
                currentCart.forEach(item => {
                    const _ep = Array.isArray(item.extras) ? item.extras.reduce((s, e) => s + (Number(e.price) || 0), 0) : 0;
                    const _itemAmt = (item.price + _ep) * item.qty;
                    _legacyTotal += _itemAmt;
                    legacyTotalQty += item.qty;
                    billText += formatBillRow(item.name, item.qty, item.price + _ep, _itemAmt);
                    if (Array.isArray(item.extras) && item.extras.length > 0) {
                        item.extras.forEach(e => { billText += `  + ${e.name}${e.price ? ` (+Rs${e.price})` : ''}\n`; });
                    }
                    if (item.specialRequest) { billText += `  > ${item.specialRequest}\n`; }
                });
                billText += "\n";
                billText += `Total Items: ${currentCart.length}\n`;
                billText += `Total Quantity: ${legacyTotalQty}\n`;
                billText += `Sub Total`.padEnd(25, ' ') + String(_legacyTotal).padStart(7, ' ') + "\n";
                // AI UPDATE [2026-09-12]: coupon discount line in the legacy text bill.
                if (discount > 0) {
                    billText += `Coupon (${_couponToRedeem.code})`.padEnd(25, ' ') + ('-' + discount).padStart(7, ' ') + "\n";
                }
                // AI UPDATE [2026-09-20]: Custom Instant Discount line in the legacy text bill.
                if (customDiscount > 0) {
                    billText += `Custom Discount`.padEnd(25, ' ') + ('-' + _fmtMoney(customDiscount)).padStart(7, ' ') + "\n";
                }
                billText += "\n";
                billText += centerText(`TOTAL: Rs ${_fmtMoney(+(_legacyTotal - discount - customDiscount).toFixed(2))}`) + "\n\n";
                billText += centerText("Thank You! Visit Again!") + "\n\n\n\n" + BOLD_OFF;
                triggerRawBTPrint(billText);
            }

            // ── Clear cart and navigate back immediately ───────────────────────
            saveLocalCart([]);
            currentCart = [];
            renderCart();
            setTimeout(() => { if (backToTablesBtn) backToTablesBtn.click(); }, 300);

            // ── Save sale to Firestore (fire & forget) ────────────────────────
            // AI UPDATE [2026-09-16] EDIT HISTORY: reuse the ORIGINAL doc ID when
            // editing (links sales_history + customer_order_history together, and
            // makes this an update-in-place instead of a duplicate new bill).
            const billId = _editMode ? _editMode.orderId : `SALE_${Date.now()}`;
            // Online-customer identity for this slot, if any (badge keys already
            // set by either a live "Open in POS" import or js/order-edit.js
            // restoring them for an edit) — stored on the sale record so a FUTURE
            // Edit History pass on this same bill can restore it without asking
            // for a phone number again. Purely additive; absent = anonymous/manual.
            // AI UPDATE [2026-09-20]: _onlineUid/_onlineName/_onlinePhone are now captured above the
            // saveLocalCart([]) call (they were read here, after the badge keys had been wiped).

            if (_editMode) {
                // ── Update the EXISTING sale in place — never a new document ───
                updateDoc(doc(db, "sales_history", billId), {
                    items: cartSnapshot,
                    total: total,
                    couponCode:     discount > 0 ? _couponToRedeem.code : null,
                    couponDiscount: discount,
                    // AI UPDATE [2026-09-20]: order-level pricing split — see setDoc branch below.
                    subtotal:       _pricing.subtotal,
                    customDiscount: customDiscount,
                    isEdited:      true,
                    editedAt:      serverTimestamp(),
                    originalTotal: _editMode.originalTotal, // set once, never overwritten on later edits
                    lastEditReason: 'bill_settle',
                }).catch(err => console.error("Bill update (Edit History) failed:", err));
            } else {
                setDoc(doc(db, "sales_history", billId), {
                    orderId: billId, // AI UPDATE [2026-09-16]: shared ID — see EDIT HISTORY header comment above.
                    table: tableName,
                    customer: customerName,
                    items: cartSnapshot,
                    total: total,
                    // AI UPDATE [2026-09-12]: coupon audit trail on the sale record.
                    couponCode:     discount > 0 ? _couponToRedeem.code : null,
                    couponDiscount: discount,
                    // AI UPDATE [2026-09-20]: CUSTOM INSTANT DISCOUNT — order-level fields. `subtotal` is
                    // the pre-discount item total, `customDiscount` the flat ₹ off (0 if none), and
                    // `total` (above) is the final payable. Item prices in `items` are untouched.
                    subtotal:       _pricing.subtotal,
                    customDiscount: customDiscount,
                    // [AI UPDATE 2026-09-14] Optional manual-customer details entered
                    // in the popup, for traceability on the bill record itself.
                    // Purely additive — does not replace the existing `customer` slot field.
                    manualCustomerName:  _manualCustomer.name  || null,
                    manualCustomerPhone: _manualCustomer.phone ? `+91${_manualCustomer.phone}` : null,
                    // AI UPDATE [2026-09-16]: online (QR) customer identity, so a future
                    // Edit History pass can restore it — see notes above.
                    onlineCustomerUid:   _onlineUid,
                    onlineCustomerName:  _onlineName,
                    onlineCustomerPhone: _onlinePhone,
                    timestamp: new Date().toISOString()
                }).catch(err => console.error("Bill save failed:", err));
            }

            if (window.saveToGhostHistory) {
                let orderId = tableName.includes('Parcel') ? tableName : `${tableName} [${customerName}]`;
                // AI UPDATE [2026-09-16] round 2: pass billId + customer identity so
                // the on-device 24h History drawer / details.html can show who this
                // bill belongs to and offer an Edit button for it (see js/order-edit.js).
                window.saveToGhostHistory(orderId, total, cartSnapshot, {
                    billId,
                    customerName:  _onlineName  || _manualCustomer.name || null,
                    customerPhone: _onlinePhone || (_manualCustomer.phone ? `+91${_manualCustomer.phone}` : null),
                    // AI UPDATE [2026-09-20]: so History drawer / details.html / reprint show the discount.
                    subtotal:       _pricing.subtotal,
                    customDiscount: customDiscount,
                });
            }

            // AI UPDATE [2026-09-12]: Mark the redeemed coupon as used (fire & forget).
            if (discount > 0) {
                updateDoc(doc(db, 'coupons', _couponToRedeem.code), {
                    used:       true,
                    usedAt:     serverTimestamp(),
                    usedBillId: shortOrderId,
                    usedTable:  tableName,
                }).catch(e => console.warn('[Coupon] mark-used failed:', e.message));
                _appliedCoupon = null;
                _saveCoupon();
            }

            // ── Sync completed order to Customer Panel (non-blocking) ────────
            // Marks pending_table_orders as 'completed' and writes a record to
            // customer_order_history so the customer's history tab updates.
            // Only runs if this table had a Customer Panel order (no-op for
            // manual/walk-in bills — see syncCustomerOrderCompletion above).
            // AI UPDATE [2026-07-29] session 18: pass shortOrderId as billNumber
            // AI UPDATE [2026-09-13]: pass customerSlot (customerName here holds the
            // C1/C2/... slot id) — see syncCustomerOrderCompletion() header comment.
            // AI UPDATE [2026-09-16]: pass billId + editContext for Edit History —
            // see syncCustomerOrderCompletion() header comment. Both are undefined/
            // null on a normal (non-edit) bill, so behavior there is unchanged.
            syncCustomerOrderCompletion(
                tableName, customerName, cartSnapshot, total, 'bill_settle', shortOrderId,
                billId, _statsEditContext(_editMode),
                { subtotal: _pricing.subtotal, customDiscount }, // AI UPDATE [2026-09-20]
                { name: _onlineName, phone: _onlinePhone }        // AI UPDATE [2026-09-20]: identity captured pre-clear
            );

            // [AI UPDATE 2026-09-14] Manual POS customer identification — only
            // runs if the staff actually entered a phone in the popup above.
            // No-op (and impossible to reach) for QR orders, which never show
            // the popup in the first place.
            if (_manualCustomer.phone) {
                syncManualCustomerProfile(
                    _manualCustomer.name, _manualCustomer.phone, total, shortOrderId, tableName, 'bill_settle', cartSnapshot,
                    billId, _statsEditContext(_editMode),
                    { subtotal: _pricing.subtotal, customDiscount } // AI UPDATE [2026-09-20]
                );
            }

            // AI UPDATE [2026-09-16]: edit finished — clear the flag so this
            // synthetic edit table/slot never carries it into a future session.
            if (_editMode) _clearEditMode(tableName, customerName);

            // ── Release customer table lock in background (non-blocking) ──────
            releaseTableLockInBackground(tableName, 'bill_settle');
        });
    }

    // ── Save & Exit ────────────────────────────────────────────────────────────
    if (saveExitBtn) {
        saveExitBtn.addEventListener('click', async () => {
            const tableName    = getCurrentTable();
            const customerName = getCurrentCustomer();
            const cartSnapshot = currentCart.slice();

            // [AI UPDATE 2026-09-14] Manual POS customer identification.
            // Same identity check as Bill & Settle above. Only prompts when
            // there's actually something to save (an empty-cart Save & Exit is
            // just closing an untouched table — nothing to associate a customer
            // with, so skip the popup entirely rather than interrupt that).
            //
            // [AI UPDATE 2026-09-15] Same two-step fix as Bill & Settle above:
            // the popup only records the identity decision and returns control
            // to the cart. Save & Exit itself only runs on the NEXT press once
            // an identity decision is already on record for this slot.
            const _hasCustomerIdentity = !!localStorage.getItem(`activeCustomerUid_${tableName}_${customerName}`);
            let _manualCustomer = { name: '', phone: '' };
            if (!_hasCustomerIdentity && cartSnapshot.length > 0) {
                const _identityKey = getManualCustomerIdentityKey();
                const _resolvedRaw = localStorage.getItem(_identityKey);
                if (_resolvedRaw) {
                    try { _manualCustomer = JSON.parse(_resolvedRaw); } catch (_) { _manualCustomer = { name: '', phone: '' }; }
                } else {
                    const _picked = await showCustomerDetailsPopup({ onLookupPhone: _lookupManualCustomerByPhone });
                    localStorage.setItem(_identityKey, JSON.stringify(_picked));

                    if (_picked.name || _picked.phone) {
                        localStorage.setItem(getCustomerNameKey(), _picked.name || 'Customer');
                        if (_picked.phone) localStorage.setItem(getCustomerPhoneKey(), `+91${_picked.phone}`);
                        renderCart();
                    }

                    // Return to the cart untouched — do NOT save/exit yet. The
                    // operator presses Save & Exit again to actually process it.
                    return;
                }
            }

            // AI UPDATE [2026-09-12]: same coupon handling as Bill & Settle —
            // rawTotal is the pre-discount amount, total is what's actually saved
            // as revenue/lifetime-spend after any valid applied coupon.
            const rawTotal = cartSnapshot.reduce((sum, item) => {
                const ep = Array.isArray(item.extras) ? item.extras.reduce((s, e) => s + (Number(e.price) || 0), 0) : 0;
                return sum + (item.price + ep) * item.qty;
            }, 0);
            // AI UPDATE [2026-09-20]: same single authoritative pricing calculation as Bill & Settle
            // above (see the note there) — coupon + Custom Instant Discount + final total.
            const _pricing        = _computePricing(rawTotal);
            const _couponToRedeem = _pricing.coupon;
            const discount        = _pricing.couponDiscount;
            const customDiscount  = _pricing.customDiscount;
            const total           = _pricing.total;
            const shortOrderId = String(Date.now()).slice(-5);

            // AI UPDATE [2026-09-16] EDIT HISTORY — see the matching note in the
            // Bill & Settle handler above / _getEditMode() header comment.
            const _editMode = _getEditMode(tableName, customerName);
            const billId    = _editMode ? _editMode.orderId : `SALE_${Date.now()}`;
            const _onlineUid   = localStorage.getItem(`activeCustomerUid_${tableName}_${customerName}`) || null;
            const _onlineName  = localStorage.getItem(getCustomerNameKey())  || _editOnlineIdentity(_editMode).name  || null;
            const _onlinePhone = localStorage.getItem(getCustomerPhoneKey()) || _editOnlineIdentity(_editMode).phone || null;

            // ── Clear cart and navigate back immediately ───────────────────────
            saveLocalCart([]);
            currentCart = [];
            renderCart();
            if (backToTablesBtn) backToTablesBtn.click();

            // ── Save to Firestore in background only if there were items ──────
            if (cartSnapshot.length > 0) {
                if (_editMode) {
                    // ── Update the EXISTING sale in place — never a new document ──
                    updateDoc(doc(db, "sales_history", billId), {
                        items: cartSnapshot,
                        total: total,
                        couponCode:     discount > 0 ? _couponToRedeem.code : null,
                        couponDiscount: discount,
                        // AI UPDATE [2026-09-20]: order-level pricing split.
                        subtotal:       _pricing.subtotal,
                        customDiscount: customDiscount,
                        isEdited:      true,
                        editedAt:      serverTimestamp(),
                        originalTotal: _editMode.originalTotal,
                        lastEditReason: 'save_exit',
                    }).catch(err => console.error("Save & Exit update (Edit History) failed:", err));
                } else {
                    setDoc(doc(db, "sales_history", billId), {
                        orderId: billId, // AI UPDATE [2026-09-16]: shared ID — see EDIT HISTORY header comment.
                        table: tableName,
                        customer: customerName,
                        items: cartSnapshot,
                        total: total,
                        // AI UPDATE [2026-09-12]: coupon audit trail on the sale record.
                        couponCode:     discount > 0 ? _couponToRedeem.code : null,
                        couponDiscount: discount,
                        // AI UPDATE [2026-09-20]: CUSTOM INSTANT DISCOUNT — see Bill & Settle above.
                        subtotal:       _pricing.subtotal,
                        customDiscount: customDiscount,
                        // [AI UPDATE 2026-09-14] Optional manual-customer details — see
                        // Bill & Settle above for the matching field.
                        manualCustomerName:  _manualCustomer.name  || null,
                        manualCustomerPhone: _manualCustomer.phone ? `+91${_manualCustomer.phone}` : null,
                        onlineCustomerUid:   _onlineUid,
                        onlineCustomerName:  _onlineName,
                        onlineCustomerPhone: _onlinePhone,
                        timestamp: new Date().toISOString()
                    }).catch(err => console.error("Save & Exit Firestore failed:", err));
                }

                if (window.saveToGhostHistory) {
                    let orderId = tableName.includes('Parcel') ? tableName : `${tableName} [${customerName}]`;
                    // AI UPDATE [2026-09-16] round 2: see the matching Bill & Settle note above.
                    window.saveToGhostHistory(orderId + " (HOLD)", total, cartSnapshot, {
                        billId,
                        customerName:  _onlineName  || _manualCustomer.name || null,
                        customerPhone: _onlinePhone || (_manualCustomer.phone ? `+91${_manualCustomer.phone}` : null),
                        // AI UPDATE [2026-09-20]: see Bill & Settle.
                        subtotal:       _pricing.subtotal,
                        customDiscount: customDiscount,
                    });
                }

                // AI UPDATE [2026-09-12]: Mark the redeemed coupon as used (fire & forget).
                if (discount > 0) {
                    updateDoc(doc(db, 'coupons', _couponToRedeem.code), {
                        used:       true,
                        usedAt:     serverTimestamp(),
                        usedBillId: shortOrderId,
                        usedTable:  tableName,
                    }).catch(e => console.warn('[Coupon] mark-used failed:', e.message));
                    _appliedCoupon = null;
                    _saveCoupon();
                }
            }

            // ── Sync completed order to Customer Panel (non-blocking) ────────
            // Same as Bill & Settle path above — marks pending_table_orders as
            // 'completed' and writes customer_order_history entry.
            // No-op for manual/walk-in orders (no activeCustomerUid in localStorage).
            if (cartSnapshot.length > 0) {
                // AI UPDATE [2026-09-13]: pass customerSlot (customerName here holds
                // the C1/C2/... slot id) — see syncCustomerOrderCompletion().
                // AI UPDATE [2026-09-16]: pass billId + editContext for Edit History
                // — both null/undefined on a normal (non-edit) save, so unchanged there.
                syncCustomerOrderCompletion(
                    tableName, customerName, cartSnapshot, total, 'save_exit', null,
                    billId, _statsEditContext(_editMode),
                    { subtotal: _pricing.subtotal, customDiscount }, // AI UPDATE [2026-09-20]
                    { name: _onlineName, phone: _onlinePhone }        // AI UPDATE [2026-09-20]: identity captured pre-clear
                );

                // [AI UPDATE 2026-09-14] Manual POS customer identification —
                // only runs if the staff entered a phone in the popup above.
                if (_manualCustomer.phone) {
                    syncManualCustomerProfile(
                        _manualCustomer.name, _manualCustomer.phone, total, shortOrderId, tableName, 'save_exit', cartSnapshot,
                        billId, _statsEditContext(_editMode),
                        { subtotal: _pricing.subtotal, customDiscount } // AI UPDATE [2026-09-20]
                    );
                }

                // AI UPDATE [2026-09-16]: edit finished — clear the flag.
                if (_editMode) _clearEditMode(tableName, customerName);
            } else {
                // Cart is empty — if an order was imported via "Open in POS" but
                // the operator removed every item before saving, auto-cancel it.
                // Reuses "dismissed" status so the customer panel clears
                // "Order Confirmed" immediately (same as operator pressing Dismiss).
                // AI UPDATE [2026-07-29] session 23: missing edge-case fix.
                // AI UPDATE [2026-09-13]: pass customerSlot — see cancelImportedOrdersOnEmptyCart().
                cancelImportedOrdersOnEmptyCart(tableName, customerName);
                // AI UPDATE [2026-09-16]: an edit session emptied out entirely — clear
                // the edit-mode flag too so it never lingers (the original order's
                // sales_history record is left untouched, since nothing was saved).
                if (_editMode) _clearEditMode(tableName, customerName);
            }

            // ── Release customer table lock in background (non-blocking) ──────
            releaseTableLockInBackground(tableName, 'save_exit');
        });
    }

    // ── Cancel Order ───────────────────────────────────────────────────────────
    // AI UPDATE [2026-07-30]: New handler for the CANCEL ORDER button.
    //
    // Flow:
    //   1. confirm() guard — prevents accidental cancellation.
    //   2. Cart wiped instantly (UI + localStorage) — operator sees empty POS.
    //   3. Navigate back to the table grid immediately — UI is unblocked.
    //   4. Firestore: cancelOrderInPOS() sets status='dismissed' on all accepted
    //      order docs (fire-and-forget — navigation already happened).
    //   5. releaseTableLockInBackground() cleans up the customer table lock.
    //
    // Does NOT write to sales_history, customer_order_history, or ghost history.
    // Does NOT affect revenue, statistics, or order counts.
    const cancelOrderBtn = document.getElementById('cancelOrderBtn');
    if (cancelOrderBtn) {
        // AI UPDATE [2026-07-30]: Replaced confirm() with custom dialog.
        cancelOrderBtn.addEventListener('click', async () => {
            const _cancelConfirmed = await showConfirm(
                'All items will be cleared and the customer will immediately lose the active order on their screen.\n\nThis cannot be undone.',
                {
                    title:       'Cancel this entire order?',
                    confirmText: 'Yes, Cancel Order',
                    cancelText:  'Keep Order',
                    type:        'error',
                }
            );
            if (!_cancelConfirmed) return;

            const tableName    = getCurrentTable();
            const customerSlot = getCurrentCustomer();

            // Step 1: Wipe cart immediately (UI + localStorage)
            saveLocalCart([]);
            currentCart = [];
            renderCart();

            // Step 2: Navigate back to the table grid immediately
            if (backToTablesBtn) backToTablesBtn.click();

            // Step 3: Update Firestore + release lock (fire-and-forget)
            // These run after navigation so the UI is never blocked.
            // AI UPDATE [2026-09-13]: pass customerSlot — see cancelOrderInPOS().
            cancelOrderInPOS(tableName, customerSlot);
            releaseTableLockInBackground(tableName, 'cancel_order');

            // AI UPDATE [2026-09-16] EDIT HISTORY: cancelling an edit session leaves
            // the original sales_history record completely untouched (nothing was
            // ever written) — just clear the leftover flag so it doesn't linger.
            _clearEditMode(tableName, customerSlot);
        });
    }
});
