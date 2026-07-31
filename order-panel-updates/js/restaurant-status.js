/**
 * restaurant-status.js  — BRIDGE BUILD
 * ─────────────────────────────────────────────────────────────
 * Global Online Ordering Toggle — Customer Panel module.
 *
 * AI UPDATE [2026-07-31]:
 *   New module added to support the Global Online Ordering Toggle feature.
 *
 *   WHY:
 *     The Billing Panel operator may need to stop accepting online/customer-panel
 *     orders completely (kitchen overload, rush hour, maintenance) without
 *     disabling every menu item individually. A single global switch in Firestore
 *     (settings/restaurant_status.onlineOrderingEnabled) controls this.
 *
 *   HOW IT WORKS:
 *     - This module listens to settings/restaurant_status via onSnapshot.
 *     - When onlineOrderingEnabled === false (or set to OFF by operator), this
 *       module shows a branded full-screen offline overlay (#orderingOfflineScreen)
 *       and hides the main app content (#appRoot or the main content wrapper).
 *     - When the value returns to true (or the document doesn't exist — default ON),
 *       the overlay is hidden and normal content is restored automatically, with no
 *       page refresh required.
 *     - The Firestore settings collection already has `read: if true` rules, so
 *       customers can read without special auth. No rules changes were needed.
 *
 *   DEFAULT BEHAVIOUR:
 *     If settings/restaurant_status does not yet exist, ordering is treated as ON.
 *     This means all existing restaurants continue to work normally after deployment.
 *
 *   REAL-TIME SYNC:
 *     Uses onSnapshot — updates propagate to all customer devices within seconds
 *     of the operator toggling in the Billing Panel. No page refresh needed.
 *
 *   FILES CHANGED (cross-repo):
 *     Billing Panel: js/menu-management.js — toggle UI + writes settings/restaurant_status
 *     Customer Panel (this file): listens to settings/restaurant_status + shows offline screen
 *
 *   CUSTOMER PANEL INTEGRATION REQUIRED — see AI_HANDOFF.md for exact changes:
 *     1. Copy this file to js/restaurant-status.js in teamdovolve-hue/Order-
 *     2. Add #orderingOfflineScreen div to Customer Panel's index.html
 *     3. Add CSS for the offline screen (provided below as a comment block)
 *     4. Import and call initRestaurantStatus() in Customer Panel's app.js
 *
 * ─────────────────────────────────────────────────────────────
 * CSS TO ADD IN CUSTOMER PANEL (index.html or main stylesheet):
 * ─────────────────────────────────────────────────────────────
 *
 *   #orderingOfflineScreen {
 *     position: fixed;
 *     inset: 0;
 *     z-index: 9999;
 *     display: flex;
 *     flex-direction: column;
 *     align-items: center;
 *     justify-content: center;
 *     text-align: center;
 *     padding: 32px 24px;
 *     background: var(--bg, #0f0f1a);
 *     color: var(--text, #f1f5f9);
 *   }
 *   #orderingOfflineScreen.hidden { display: none; }
 *   .oos-icon   { font-size: 4rem; margin-bottom: 16px; }
 *   .oos-title  { font-size: 1.35rem; font-weight: 800; margin-bottom: 10px; color: #ef4444; }
 *   .oos-body   { font-size: 0.95rem; line-height: 1.65; color: rgba(241,245,249,0.65); max-width: 320px; }
 *   .oos-footer { margin-top: 20px; font-size: 0.82rem; color: rgba(241,245,249,0.35); }
 *
 * ─────────────────────────────────────────────────────────────
 * HTML TO ADD IN CUSTOMER PANEL index.html (inside <body>, before </body>):
 * ─────────────────────────────────────────────────────────────
 *
 *   <div id="orderingOfflineScreen" class="hidden">
 *     <div class="oos-icon">🚫</div>
 *     <div class="oos-title">Online Ordering Temporarily Unavailable</div>
 *     <div class="oos-body">
 *       Online ordering is temporarily disabled.<br>
 *       Please place your order directly at the counter.
 *     </div>
 *     <div class="oos-footer">Thank you for your patience.</div>
 *   </div>
 */

import { db }        from "./firebase-config.js";
import {
  doc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ── Module state ───────────────────────────────────────────────────────────────

let _unsubStatus    = null;
let _initialized    = false;
let _orderingOnline = true; // optimistic default — matches absent-document default

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * initRestaurantStatus()
 *
 * Call once on app startup (e.g. in app.js after Firebase is ready).
 * Starts a real-time listener on settings/restaurant_status and wires up
 * the offline overlay so it shows/hides automatically without page reload.
 *
 * Safe to call multiple times — only one listener is ever active.
 */
export function initRestaurantStatus() {
  if (_initialized) return;
  _initialized = true;
  _startListener();
}

/**
 * isOnlineOrderingEnabled()
 *
 * Returns the current cached value of onlineOrderingEnabled.
 * Defaults to true before the first snapshot arrives (optimistic).
 * Use this if you need to guard a specific action (e.g. "Place Order" click).
 */
export function isOnlineOrderingEnabled() {
  return _orderingOnline;
}

// ── Firestore listener ─────────────────────────────────────────────────────────

function _startListener() {
  if (_unsubStatus) { _unsubStatus(); _unsubStatus = null; }

  _unsubStatus = onSnapshot(
    doc(db, "settings", "restaurant_status"),
    (snap) => {
      const wasOnline = _orderingOnline;
      _orderingOnline = snap.exists()
        ? (snap.data().onlineOrderingEnabled !== false)
        : true; // absent document → default ON (backward compatible)

      if (wasOnline !== _orderingOnline) {
        console.log(`[restaurant-status] Online ordering changed → ${_orderingOnline ? "ON" : "OFF"}`);
      }

      _applyStatus();
    },
    (err) => {
      console.error("[restaurant-status] Listener error:", err.code || err.message);
      // On error treat ordering as ON to avoid incorrectly blocking customers.
      // The listener marks itself null and auto-retries after 5 s.
      _orderingOnline = true;
      _applyStatus();
      _unsubStatus = null;
      setTimeout(() => {
        if (!_unsubStatus && _initialized) _startListener();
      }, 5000);
    }
  );
}

// ── Apply status to DOM ────────────────────────────────────────────────────────

/**
 * _applyStatus()
 *
 * Shows or hides the #orderingOfflineScreen overlay based on _orderingOnline.
 *
 * When offline:
 *   - Adds class "hidden" to the main content wrapper so customers cannot
 *     scroll/interact with the menu.
 *   - Removes class "hidden" from #orderingOfflineScreen.
 *
 * When online:
 *   - Removes class "hidden" from the main content wrapper.
 *   - Adds class "hidden" to #orderingOfflineScreen.
 *
 * The main content wrapper is looked up by ID in priority order:
 *   #appRoot → #main → #menuSection → <main> → first <body> child that is a div
 * Adjust this list if the Customer Panel's root element has a different ID.
 */
function _applyStatus() {
  const offlineScreen = document.getElementById("orderingOfflineScreen");
  if (!offlineScreen) {
    // Offline screen element not yet in DOM — retry on next snapshot
    console.warn("[restaurant-status] #orderingOfflineScreen not found in DOM.");
    return;
  }

  // Find the main content wrapper to hide/show
  const contentRoot = (
    document.getElementById("appRoot") ||
    document.getElementById("main") ||
    document.getElementById("menuSection") ||
    document.querySelector("main") ||
    null
  );

  if (_orderingOnline) {
    // Restore normal ordering
    offlineScreen.classList.add("hidden");
    if (contentRoot) contentRoot.style.display = "";
  } else {
    // Block ordering — show offline screen, hide main content
    if (contentRoot) contentRoot.style.display = "none";
    offlineScreen.classList.remove("hidden");
    // Scroll to top so the offline message is fully visible
    window.scrollTo(0, 0);
  }
}
