/**
 * order-status.js  — BRIDGE BUILD (no Cloud Functions)
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides real-time Active Orders tracking and Order History for the customer.
 *
 * REPLACED FROM: original order-status.js read `customer_table_sessions`
 *   which is only written by Cloud Functions (Admin SDK). In bridge mode that
 *   collection is never populated, so order tracking showed nothing.
 *
 * THIS VERSION reads:
 *   • pending_table_orders  — filtered by customer.uid + active statuses
 *                             → Active Orders (Preparing / Received / etc.)
 *   • customer_order_history/{uid}/orders  — written by billing panel on
 *                             completion (Bill & Settle / Save & Exit)
 *                             → Order History tab
 *
 * STATUS LIFECYCLE written by billing panel (js/cart.js):
 *   pending   → order placed by customer
 *   accepted  → operator opened in POS
 *   kot       → KOT printed (order is being prepared)
 *   completed → Bill & Settle or Save & Exit pressed (billing panel)
 *   dismissed → operator dismissed the order
 *
 * PUBLIC API (used by app.js):
 *   initOrderStatus()   — start tracking + wire DOM rendering (called after login)
 *   stopOrderStatus()   — stop tracking (called on logout)
 *
 * LOWER-LEVEL API (available if you need custom rendering):
 *   startOrderTracking(callbacks) — start listeners with your own render fns
 *   stopOrderTracking()           — stop listeners
 *   getStatusLabel(status)        — human-readable status string
 *   getStatusColor(status)        — hex colour for status
 *
 * HOW initOrderStatus INTEGRATES WITH app.js:
 *   app.js calls initOrderStatus() with no args after the user logs in.
 *   This function wires startOrderTracking with DOM callbacks that render
 *   into #activeOrdersList / #activeOrdersSection and sync completed orders
 *   into localStorage via saveOrderToHistory (history.js).
 *
 * REQUIRED Firestore rules (see firestore.rules in billing repo):
 *   • pending_table_orders read:  if isOrderOwner() || isOperator()
 *   • customer_order_history/{uid}/orders read: if isSameCustomer(uid)
 *
 * AI UPDATE — 2026-07-28 v2
 * Added initOrderStatus / stopOrderStatus exports so app.js wiring works.
 * These were missing from v1; app.js already imported them but they didn't exist,
 * causing order tracking to silently never start.
 * Also added: DOM render functions for active orders using .aos-* CSS classes,
 * and Firestore→localStorage sync for order history via saveOrderToHistory.
 *
 * AI UPDATE — 2026-07-28 v3 — KOT Timer
 * Root cause: startOrderTracking never forwarded `kotAt` from Firestore into the
 * mapped order objects passed to onActiveOrders callbacks.  _renderActiveOrders
 * therefore had no timestamp to display, so customers saw "Preparing 🍕" with no
 * elapsed time and no live counter.
 *
 * Fix:
 *   1. `kotAt` is now included in every mapped active-order object.
 *   2. _renderActiveOrders computes elapsed minutes from kotAt on every render
 *      and shows "Preparing 🍕 • X min" for kot-status cards.
 *   3. A module-level setInterval (_timerInterval, 30 s cadence) patches the
 *      elapsed-time label directly in the DOM on pre-existing cards via
 *      data-kot-at timestamps — no Firestore round-trips, no full re-render.
 *      The interval starts when the first preparing order appears and is
 *      stopped when there are no more preparing orders or on logout.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db, auth }             from "./firebase-config.js";
import {
  collection, query, where,
  onSnapshot, orderBy,
}                               from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { waitForAuthReady, getLoginInfo } from "./auth.js";
import { saveOrderToHistory }            from "./history.js";

// ── Status display helpers ────────────────────────────────────────────────────

const STATUS_LABEL = {
  pending:   "Order Received ✅",
  accepted:  "Order Confirmed 👨‍🍳",
  kot:       "Preparing 🍕",
  completed: "Ready / Completed 🎉",
  dismissed: "Cancelled",
};

const STATUS_COLOR = {
  pending:   "#f59e0b",
  accepted:  "#3b82f6",
  kot:       "#10b981",
  completed: "#6b7280",
  dismissed: "#ef4444",
};

export function getStatusLabel(status) {
  return STATUS_LABEL[(status || "").toLowerCase()] || status || "Unknown";
}

export function getStatusColor(status) {
  return STATUS_COLOR[(status || "").toLowerCase()] || "#9ca3af";
}

// ── Internal unsubscribe handles ──────────────────────────────────────────────

let _unsubActive  = null;
let _unsubHistory = null;

// ── Preparing-timer state ──────────────────────────────────────────────────────
// A single 30-second interval that updates the elapsed-minutes label on any
// .aos-card[data-kot-at] elements in the DOM.  Only runs while at least one
// order is in "kot" (Preparing) status; automatically stopped otherwise.
let _timerInterval = null;

// Convert a Firestore Timestamp (or plain {seconds,nanoseconds} object) to ms.
function _tsToMs(ts) {
    if (!ts) return null;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (ts.seconds != null) return ts.seconds * 1000;
    return null;
}

// Elapsed minutes since a Firestore Timestamp; returns null if unavailable.
function _elapsedMin(ts) {
    const ms = _tsToMs(ts);
    if (ms === null) return null;
    return Math.max(0, Math.floor((Date.now() - ms) / 60000));
}

// Start the live timer that patches elapsed-time labels every 30 s.
// Safe to call multiple times — only one interval runs at a time.
function _startPreparingTimer() {
    if (_timerInterval) return;
    _timerInterval = setInterval(() => {
        document.querySelectorAll('.aos-card[data-kot-at]').forEach(card => {
            const kotMs = parseInt(card.dataset.kotAt, 10);
            if (!kotMs) return;
            const elapsed = Math.max(0, Math.floor((Date.now() - kotMs) / 60000));
            const label = card.querySelector('.aos-status-label');
            if (label) label.textContent = `Preparing 🍕 • ${elapsed} min`;
        });
    }, 30000);
}

// Stop and clear the preparing timer.
function _stopPreparingTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}

// ── Public API (used by app.js) ───────────────────────────────────────────────

/**
 * initOrderStatus()
 *
 * High-level entry point — called by app.js after the user logs in.
 * Starts both Firestore listeners and wires them to the DOM.
 *
 * Active orders → rendered into #activeOrdersList; #activeOrdersSection shown/hidden.
 * Completed orders → synced into localStorage via saveOrderToHistory (history.js),
 *   which deduplicates by firestoreId so repeated snapshot fires are safe.
 */
export function initOrderStatus() {
  startOrderTracking({
    onActiveOrders: _renderActiveOrders,
    onHistory:      _syncHistoryToLocalStorage,
  });
}

/**
 * stopOrderStatus()
 *
 * Called by app.js on logout. Detaches listeners and clears the active orders UI.
 */
export function stopOrderStatus() {
  stopOrderTracking();
  _renderActiveOrders([]);   // hide the section and clear the list
}

// ── Lower-level API ───────────────────────────────────────────────────────────

/**
 * startOrderTracking(callbacks)
 *
 * Starts two real-time Firestore listeners:
 *   1. Active orders  — pending_table_orders where customer.uid == current UID
 *                       and status is NOT completed/dismissed.
 *   2. Order history  — customer_order_history/{uid}/orders ordered by completedAt desc.
 *
 * callbacks.onActiveOrders(orders[]) — fired whenever active orders change.
 * callbacks.onHistory(orders[])      — fired whenever order history changes.
 * callbacks.onActiveOrdersError(err) — optional error handler.
 * callbacks.onHistoryError(err)      — optional error handler.
 *
 * Each `orders` element shape:
 *   Active:  { id, tableId, status, statusLabel, statusColor, items[], total, createdAt }
 *   History: { id, orderId, tableId, items[], total, completedAt, orderedAt, completionReason }
 */
export async function startOrderTracking(callbacks = {}) {
  // Stop any existing listeners first
  stopOrderTracking();

  await waitForAuthReady();
  // AI UPDATE [2026-07-29] session 20: Use the stable stored profile uid from
  // getLoginInfo() instead of auth.currentUser?.uid.  auth.currentUser.uid is
  // a new anonymous uid after every logout+re-login (signOut clears the auth
  // session), causing history queries to target an empty Firestore path.
  // getLoginInfo().uid is the uid stored in customers/{phone}.uid at account
  // creation — the permanent key for customer_order_history/{uid}/orders.
  const loginInfo = getLoginInfo();
  const uid = loginInfo?.uid || auth.currentUser?.uid;
  if (!uid) {
    console.warn("[order-status] Cannot start tracking — user not signed in.");
    return;
  }

  // ── Listener 1: Active orders ───────────────────────────────────────────────
  // NOTE: No orderBy here — combining where("customer.uid") with orderBy("createdAt")
  // requires a Firestore composite index that is not guaranteed to exist.
  // Sorting is done client-side below instead; result set is tiny (1-3 docs max).
  const activeQuery = query(
    collection(db, "pending_table_orders"),
    where("customer.uid", "==", uid)
  );

  _unsubActive = onSnapshot(
    activeQuery,
    (snap) => {
      const active = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(o => !["completed", "dismissed"].includes((o.status || "").toLowerCase()))
        // Sort newest-first client-side (avoids composite index on customer.uid + createdAt)
        .sort((a, b) => {
          const tA = a.createdAt?.seconds ?? 0;
          const tB = b.createdAt?.seconds ?? 0;
          return tB - tA;
        });

      const mapped = active.map(o => ({
        id:          o.id,
        tableId:     o.tableId    || "",
        status:      o.status     || "pending",
        statusLabel: getStatusLabel(o.status),
        statusColor: getStatusColor(o.status),
        items:       o.items      || [],
        total:       o.totalPrice || 0,
        createdAt:   o.createdAt  || null,
        kotAt:       o.kotAt      || null,   // forwarded so the UI can show elapsed time
      }));

      if (typeof callbacks.onActiveOrders === "function") {
        callbacks.onActiveOrders(mapped);
      }
    },
    (err) => {
      console.warn("[order-status] Active orders listener error:", err.code || err.message);
      if (typeof callbacks.onActiveOrdersError === "function") {
        callbacks.onActiveOrdersError(err);
      }
    }
  );

  // ── Listener 2: Order history ───────────────────────────────────────────────
  // Written by billing panel (js/cart.js → syncCustomerOrderCompletion) whenever
  // Bill & Settle or Save & Exit is pressed for a Customer Panel order.
  const historyQuery = query(
    collection(db, "customer_order_history", uid, "orders"),
    orderBy("completedAt", "desc")
  );

  _unsubHistory = onSnapshot(
    historyQuery,
    (snap) => {
      const history = snap.docs.map(d => ({
        id:               d.id,
        orderId:          d.data().orderId          || d.id,
        tableId:          d.data().tableId          || "",
        items:            d.data().items            || [],
        total:            d.data().total            || 0,
        completedAt:      d.data().completedAt      || null,
        orderedAt:        d.data().orderedAt        || "",
        completionReason: d.data().completionReason || "",
      }));

      if (typeof callbacks.onHistory === "function") {
        callbacks.onHistory(history);
      }
    },
    (err) => {
      console.warn("[order-status] History listener error:", err.code || err.message);
      if (typeof callbacks.onHistoryError === "function") {
        callbacks.onHistoryError(err);
      }
    }
  );

  console.log("[order-status] Tracking started for UID:", uid);
}

/**
 * stopOrderTracking()
 * Detaches both Firestore listeners and stops the preparing timer.
 * Call on logout or page unload.
 */
export function stopOrderTracking() {
  if (_unsubActive)  { _unsubActive();  _unsubActive  = null; }
  if (_unsubHistory) { _unsubHistory(); _unsubHistory = null; }
  _stopPreparingTimer();
}

// ── DOM rendering (used by initOrderStatus) ───────────────────────────────────

const _fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n || 0);

function _esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * _renderActiveOrders(orders)
 *
 * Renders active order cards into #activeOrdersList.
 * Shows #activeOrdersSection when there are orders; hides it when empty.
 * Uses the .aos-* CSS classes already defined in css/style.css.
 *
 * Status → CSS modifier mapping (only classes that exist in style.css):
 *   pending   → .aos-pending  (amber, .aos-dot-pend animated pulse)
 *   accepted  → .aos-pending  (reuse amber — no .aos-accepted class in CSS)
 *   kot       → .aos-preparing (green, .aos-dot-prep animated pulse)
 *
 * Items: rendered as <ul class="aos-items"> with .aos-item-name / .aos-item-qty per row.
 */
function _renderActiveOrders(orders) {
  const section = document.getElementById("activeOrdersSection");
  const list    = document.getElementById("activeOrdersList");
  if (!section || !list) return;

  if (!orders || orders.length === 0) {
    section.classList.add("hidden");
    list.innerHTML = "";
    _stopPreparingTimer();   // no preparing orders — timer not needed
    return;
  }

  section.classList.remove("hidden");

  let hasPreparingOrder = false;

  list.innerHTML = orders.map(order => {
    const status      = (order.status || "pending").toLowerCase();
    const itemCount   = (order.items || []).reduce((s, i) => s + (i.quantity || 1), 0);

    // Status row modifier — .aos-preparing for kot, .aos-pending for all others
    const isPrepping = status === "kot";
    const statusMod  = isPrepping ? "aos-preparing" : "aos-pending";
    const dotMod     = isPrepping ? "aos-dot-prep"  : "aos-dot-pend";

    // ── KOT elapsed-time label ─────────────────────────────────────────────────
    // When status is 'kot', show "Preparing 🍕 • X min" using kotAt timestamp.
    // data-kot-at stores the epoch-ms so the live timer interval can patch the
    // label directly in the DOM without a full Firestore round-trip.
    let displayLabel;
    let kotAtMs = null;
    if (isPrepping) {
      hasPreparingOrder = true;
      kotAtMs = _tsToMs(order.kotAt);
      const elapsed = kotAtMs !== null ? _elapsedMin(order.kotAt) : null;
      displayLabel = elapsed !== null
        ? `Preparing 🍕 • ${elapsed} min`
        : "Preparing 🍕";
    } else {
      displayLabel = order.statusLabel || getStatusLabel(status);
    }

    // ── Items list ─────────────────────────────────────────────────────────────
    const itemsHtml = (order.items || []).map(it => `
      <li>
        <span class="aos-item-name">${_esc(it.name || "")}</span>
        <span class="aos-item-qty">×${it.quantity || 1} &nbsp; ${_fmt((it.price || 0) * (it.quantity || 1))}</span>
      </li>`).join("");

    // data-kot-at is only set on preparing cards so the interval can target them.
    const kotAtAttr = (isPrepping && kotAtMs !== null)
      ? ` data-kot-at="${kotAtMs}"`
      : "";

    return `
      <div class="aos-card" data-order-id="${_esc(order.id)}"${kotAtAttr}>
        <div class="aos-card-top">
          <div class="aos-card-left">
            <span class="aos-table-tag">${_esc(order.tableId || "—")}</span>
            <span class="aos-item-count">${itemCount} item${itemCount !== 1 ? "s" : ""}</span>
          </div>
          <span class="aos-total">${_fmt(order.total)}</span>
        </div>

        <div class="aos-status ${statusMod}">
          <span class="aos-dot ${dotMod}"></span>
          <span class="aos-status-label">${_esc(displayLabel)}</span>
        </div>

        <ul class="aos-items">
          ${itemsHtml}
        </ul>
      </div>`;
  }).join("");

  // ── Start / stop preparing timer ───────────────────────────────────────────
  // Start a 30-second interval that patches elapsed-time labels in the DOM.
  // Stop it when there are no more preparing orders (saves CPU and avoids
  // querying stale DOM nodes after a full re-render clears the cards).
  if (hasPreparingOrder) {
    _startPreparingTimer();
  } else {
    _stopPreparingTimer();
  }
}

/**
 * _syncHistoryToLocalStorage(orders)
 *
 * Syncs completed orders from Firestore into localStorage so the history
 * drawer (history.js) shows them. saveOrderToHistory deduplicates by
 * firestoreId — calling it for all orders on every snapshot is safe.
 *
 * Field mapping:
 *   Firestore (order-status)  → history.js saveOrderToHistory
 *   id                        → firestoreId  (deduplication key)
 *   total                     → totalPrice   (history.js uses .totalPrice)
 *   orderedAt                 → placedAt     (history.js uses .placedAt)
 */
function _syncHistoryToLocalStorage(orders) {
  for (const order of (orders || [])) {
    saveOrderToHistory({
      firestoreId:  order.id,
      orderId:      order.orderId || order.id,
      tableId:      order.tableId,
      items:        order.items,
      totalPrice:   order.total,        // history.js reads .totalPrice
      placedAt:     order.orderedAt || null,
      completedAt:  order.completedAt,
      completionReason: order.completionReason || "",
      status:       "completed",
    });
  }
}
