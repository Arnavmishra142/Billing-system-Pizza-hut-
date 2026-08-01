/**
 * order.js  — BRIDGE BUILD (no Cloud Functions)
 * ─────────────────────────────────────────────────────────────
 * Reads Table ID from URL, handles order submission to Firestore.
 * History is written by order-status.js when billing panel marks "completed".
 *
 * BRIDGE: orders are written directly to pending_table_orders via addDoc.
 * createCustomerOrder Cloud Function is intentionally bypassed while
 * Firebase billing is not enabled.
 *
 * When Cloud Functions are restored (billing added):
 *   1. Uncomment the httpsCallable block below
 *   2. Remove the addDoc block marked "BRIDGE"
 *   3. No data-structure changes needed
 */

// AI UPDATE [2026-08-01] Architecture migration: notification trigger moved here.
// Billing Panel is now a pure Firestore viewer — it no longer calls notifyOrder.
// Customer Panel triggers the Worker immediately after addDoc succeeds, ensuring
// notifications fire even when the Billing Panel is closed or disconnected.
import { db, auth, functions }            from "./firebase-config.js";
import {
  collection, addDoc, getDoc, doc,
  serverTimestamp,
}                                         from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { httpsCallable }                  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";
import { cart, clearCart }                from "./cart.js";
import { getCustomer }                    from "./customer.js";
import { waitForAuthReady, getLoginInfo } from "./auth.js";

// ── Read table number from the URL ────────────────────────────────────────────
//
//   Two environments:
//
//   1. Replit / Node.js (dev + self-hosted):
//      The server validates /t/:n and injects window.__TABLE_ID__ = <int>
//      into the HTML before serving it.  We prefer that value.
//
//   2. Netlify (production CDN):
//      Netlify rewrites /t/* → index.html (see _redirects).  No server
//      injection happens, so we parse window.location.pathname instead.
//
//   In both cases the validation rule is the same: table must be 1–10.
//   Returns "Table N" on success, null on invalid/missing table.

const VALID_TABLES = 10;
const SESSION_KEY  = "qrmenu_locked_table";
let _activeTableId = null;

export function getTableId() {
  if (_activeTableId) return _activeTableId;

  if (typeof window.__TABLE_ID__ === "number") {
    const n = window.__TABLE_ID__;
    if (Number.isInteger(n) && n >= 1 && n <= VALID_TABLES) {
      const tableId = `Table ${n}`;
      try { sessionStorage.setItem(SESSION_KEY, tableId); } catch (_) {}
      return tableId;
    }
    return null;
  }

  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) return stored;
  } catch (_) {}

  const match = window.location.pathname.match(/^\/t\/(\d+)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  if (n < 1 || n > VALID_TABLES) return null;
  const tableId = `Table ${n}`;
  try { sessionStorage.setItem(SESSION_KEY, tableId); } catch (_) {}
  return tableId;
}

// BRIDGE: customer_table_sessions is only written by Cloud Functions (Admin SDK).
// In bridge mode there are no active sessions in Firestore, so this always
// returns null — the URL table ID is always used.
// When Cloud Functions are restored this will auto-resume reading real sessions.
export async function loadActiveTableAssignment() {
  await waitForAuthReady();
  const uid = auth.currentUser?.uid;
  if (!uid) return null;
  try {
    const snap = await getDoc(doc(db, "customer_table_sessions", uid));
    const data = snap.exists() ? snap.data() : null;
    _activeTableId = data?.lockStatus === "active" && data.activeTableId
      ? data.activeTableId
      : null;
    _updateTableBadge();
    return _activeTableId;
  } catch (err) {
    // permission-denied is expected in bridge mode (rules deny reads without CF)
    console.info("[table-lock] Bridge mode — no active session:", err.code || err.message);
    return null;
  }
}

export function setActiveTableId(tableId) {
  _activeTableId = tableId || null;
  _updateTableBadge();
}

// ── Submit order ──────────────────────────────────────────────────────────────

export async function placeOrder() {
  if (cart.size === 0) return;

  await loadActiveTableAssignment();
  const tableId = getTableId();
  if (!tableId) {
    _showError("Could not detect your active table. Please rescan your table QR.");
    return;
  }

  const btn = document.getElementById("placeOrderBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Placing…"; }

  const customer   = getCustomer();
  const items      = [];
  let   totalItems = 0;
  let   totalPrice = 0;

  for (const item of cart.values()) {
    items.push({
      itemId:   item.id,
      name:     item.name,
      price:    item.price,
      quantity: item.qty,
      subtotal: +(item.price * item.qty).toFixed(2),
    });
    totalItems += item.qty;
    totalPrice += item.price * item.qty;
  }

  try {
    // BRIDGE: write order directly to Firestore.
    // Requires Firestore rule:
    //   allow create on pending_table_orders if request.auth != null
    //     && request.resource.data.customer.uid == request.auth.uid
    //
    // TO RESTORE Cloud Function path:
    //   import { functions } from "./firebase-config.js";
    //   import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";
    //   const createCustomerOrder = httpsCallable(functions, "createCustomerOrder");
    //   const result = await createCustomerOrder({ requestedTableId: tableId, items });
    //   const assignedTable = result.data?.tableId || tableId;
    //   setActiveTableId(assignedTable);
    //   clearCart();
    //   _showSuccess(assignedTable, totalItems, totalPrice, customer);

    // AI UPDATE [2026-07-29] session 20: Use stored profile uid from getLoginInfo()
    // so new orders are written under the same uid as the customer's existing history.
    // auth.currentUser.uid is a fresh anonymous uid after every re-login and would
    // cause syncCustomerOrderCompletion() to write history to a different path than
    // where all previous orders live.
    const _loginInfo = getLoginInfo();
    const _stableUid = _loginInfo?.uid || auth.currentUser?.uid || "";
    const _docRef = await addDoc(collection(db, "pending_table_orders"), {
      tableId,
      customer: {
        uid:   _stableUid,
        name:  customer?.name  || "",
        phone: customer?.phone || "",
      },
      status:     "pending",
      items,
      totalPrice: +totalPrice.toFixed(2),
      createdAt:  serverTimestamp(),
    });

    // AI UPDATE [2026-08-01] Architecture migration: trigger notification from Customer Panel.
    // Fire-and-forget — never blocks or delays the success UI. All errors are caught internally.
    // Only fires after Firestore write confirms success (docRef received = write accepted).
    _triggerOrderNotification(_docRef.id, tableId, customer, items, totalItems).catch(() => {});

    setActiveTableId(tableId);
    clearCart();
    _showSuccess(tableId, totalItems, totalPrice, customer);

  } catch (err) {
    console.error("[order] Submission failed:", err);
    _showError(
      err.code === "permission-denied"
        ? "Permission denied. Please ask restaurant staff for assistance."
        : err.message || "Order failed. Please check your connection."
    );
    if (btn) { btn.disabled = false; btn.textContent = "Place Order →"; }
  }
}

function _updateTableBadge() {
  const badge = document.getElementById("tableBadge");
  if (badge) badge.textContent = _activeTableId || _getTableIdFromUrl() || "—";
}

function _getTableIdFromUrl() {
  if (typeof window.__TABLE_ID__ === "number") {
    const n = window.__TABLE_ID__;
    return (Number.isInteger(n) && n >= 1 && n <= VALID_TABLES) ? `Table ${n}` : null;
  }
  const match = window.location.pathname.match(/^\/t\/(\d+)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return (n >= 1 && n <= VALID_TABLES) ? `Table ${n}` : null;
}

// ── Success overlay ───────────────────────────────────────────────────────────

function _showSuccess(tableId, totalItems, totalPrice, customer) {
  const fmt = (n) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);
  const overlay = document.getElementById("successOverlay");
  const msg     = document.getElementById("overlayMsg");
  if (msg) {
    msg.innerHTML = `
      <strong>Table ${_esc(tableId)}</strong> —
      ${totalItems} item${totalItems !== 1 ? "s" : ""} · ${fmt(totalPrice)}<br/>
      <span style="color:var(--text-3);font-size:13px;">
        Track your order in <em>Active Orders</em> above.
      </span>`;
  }
  overlay?.classList.remove("hidden");
}

// ── Error overlay ─────────────────────────────────────────────────────────────

function _showError(detail = "") {
  const overlay = document.getElementById("errorOverlay");
  const msg     = document.getElementById("errorOverlayMsg");
  if (msg && detail) msg.textContent = detail;
  overlay?.classList.remove("hidden");
}

function _esc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Notification trigger ──────────────────────────────────────────────────────
// AI UPDATE [2026-08-01] Architecture migration.
//
// Called fire-and-forget immediately after addDoc succeeds. Never throws — all
// errors are caught so a notification failure can never break the order flow.
//
// Flow:
//   1. Read settings/system.notificationEnabled from Firestore (one-time getDoc).
//      Default: ON if the document is absent (backward compatible).
//   2. If OFF: log and return — order creation, history, KOT all continue normally.
//   3. If ON: call Worker httpsCallable('notifyOrder') with full order payload.
//      Worker: sends Pushover (priority=2, emergency) + writes notifyReceipt to
//              the order document so Billing Panel shows the Acknowledge button.
//
// Requires functions.customDomain = Worker URL in firebase-config.js (already set).
async function _triggerOrderNotification(orderId, tableId, customer, items, itemCount) {
  try {
    // Check global notification setting — one-time read (not a listener)
    const snap    = await getDoc(doc(db, 'settings', 'system'));
    const enabled = snap.exists() ? snap.data().notificationEnabled !== false : true;

    if (!enabled) {
      console.log('[order] Pushover notification skipped — globally disabled via Billing Panel toggle');
      return;
    }

    const fn = httpsCallable(functions, 'notifyOrder');
    await fn({
      orderId,
      tableId,
      customerName:  customer?.name  || '',
      customerPhone: customer?.phone || '',
      items,
      itemCount,
    });

    console.log('[order] Pushover notification sent ✓ for order', orderId);
  } catch (err) {
    // Non-fatal: notification failure must never affect order placement
    console.warn('[order] Pushover notification failed (non-fatal):', err.code || err.message);
  }
}
