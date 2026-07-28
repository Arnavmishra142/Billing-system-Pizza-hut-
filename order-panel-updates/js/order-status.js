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
 *   completed → Bill & Settle or Save & Exit pressed (billing panel, 2026-07-28)
 *   dismissed → operator dismissed the order
 *
 * HOW TO USE IN index.html / app.js:
 *   import { startOrderTracking, stopOrderTracking } from "./order-status.js";
 *
 *   // Start tracking when the customer is logged in:
 *   startOrderTracking(auth, db, {
 *     onActiveOrders: (orders) => renderActiveOrders(orders),
 *     onHistory:      (orders) => renderOrderHistory(orders),
 *   });
 *
 *   // Stop tracking when the customer logs out:
 *   stopOrderTracking();
 *
 * REQUIRED Firestore rules (see firestore.rules in billing repo):
 *   • pending_table_orders read:  if isOrderOwner() || isOperator()
 *   • customer_order_history/{uid}/orders read: if isSameCustomer(uid)
 *
 * AI UPDATE — 2026-07-28
 * Added to fix: Order History not being written after billing panel completed orders.
 * Corresponding billing-panel change: js/cart.js → syncCustomerOrderCompletion()
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db, auth }             from "./firebase-config.js";
import {
  collection, query, where,
  onSnapshot, orderBy,
}                               from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { waitForAuthReady }     from "./auth.js";

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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * startOrderTracking(auth, db, callbacks)
 *
 * Starts two real-time Firestore listeners:
 *   1. Active orders  — pending_table_orders where customer.uid == current UID
 *                       and status is NOT completed/dismissed.
 *   2. Order history  — customer_order_history/{uid}/orders ordered by completedAt desc.
 *
 * Calls callbacks.onActiveOrders(orders[]) whenever active orders change.
 * Calls callbacks.onHistory(orders[])      whenever order history changes.
 *
 * Each `orders` element shape:
 *   Active:  { id, tableId, status, statusLabel, statusColor, items[], total, createdAt }
 *   History: { id, orderId, tableId, items[], total, completedAt, orderedAt, completionReason }
 */
export async function startOrderTracking(callbacks = {}) {
  // Stop any existing listeners first
  stopOrderTracking();

  await waitForAuthReady();
  const uid = auth.currentUser?.uid;
  if (!uid) {
    console.warn("[order-status] Cannot start tracking — user not signed in.");
    return;
  }

  // ── Listener 1: Active orders ───────────────────────────────────────────────
  // We query all docs where customer.uid matches, then filter in JS because
  // Firestore array/map field queries require a composite index on nested fields.
  // The result set is tiny (1-3 docs per customer at most) so client-side
  // filtering is acceptable.
  const activeQuery = query(
    collection(db, "pending_table_orders"),
    where("customer.uid", "==", uid),
    orderBy("createdAt", "desc")
  );

  _unsubActive = onSnapshot(
    activeQuery,
    (snap) => {
      const active = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(o => !["completed", "dismissed"].includes((o.status || "").toLowerCase()));

      const mapped = active.map(o => ({
        id:          o.id,
        tableId:     o.tableId    || "",
        status:      o.status     || "pending",
        statusLabel: getStatusLabel(o.status),
        statusColor: getStatusColor(o.status),
        items:       o.items      || [],
        total:       o.totalPrice || 0,
        createdAt:   o.createdAt  || null,
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
 * Detaches both Firestore listeners. Call on logout or page unload.
 */
export function stopOrderTracking() {
  if (_unsubActive)  { _unsubActive();  _unsubActive  = null; }
  if (_unsubHistory) { _unsubHistory(); _unsubHistory = null; }
}
