# AI_HANDOFF.md — Project State Document
> Auto-maintained by AI agent. Update this file after every implementation.
> Last updated: 2026-07-28

---

## Project Overview

**Name:** New Pizza Hut & Live Cake — Billing & Customer System  
**Stack:** Vanilla HTML/CSS/JS · Firebase (Firestore + Auth + Storage) · PWA  
**Two repos:**
- **This repo** (`Billing-system-Pizza-hut`) — Admin/Billing Panel + `customer.html`
- **Separate repo** (`teamdovolve-hue/Order-`, Netlify) — Customer Order Panel

---

## Architecture Summary

| Panel | URL / Path | Auth Method |
|-------|-----------|-------------|
| Billing / Admin | This repo, `index.html` | PIN 1414 → `signInAnonymously()` in background |
| Customer (this repo) | `customer.html` | `signInAnonymously()` → phone+name stored in Firestore |
| Customer Order Panel | Netlify (`teamdovolve-hue/Order-`) | Same as above (BRIDGE build pending push) |

**Firestore collections used:**
- `pending_table_orders` — live orders from customers, read by billing panel
- `customers/{+91…}` — customer profiles (phone, name, phoneVerified: false)
- `menu_items` — menu catalog; toggled by Menu Management
- `settings/pizza_sizes` — pizza size availability flags
- `sales_history` — completed/billed orders
- `daily_expenses` — expense tracking
- `tables` — table state

---

## Features Completed ✅

- Admin PIN login (1414), decoupled from Firebase Auth — dashboard shows immediately
- PWA stale-cache fix — `sw.js` bumped v7→v8, cache busted
- `customer.html` full rewrite — 3-screen phone flow, direct Firestore reads/writes, no Cloud Functions
- Firestore rules updated — anonymous create/read for `customers` and `pending_table_orders`
- Bridge build for Order Panel (`order-panel-updates/js/auth.js` and `order.js`) — bypasses Cloud Functions
- **[2026-07-28] Incoming Orders listener auth-race fix** — listener now starts only after `onAuthStateChanged` confirms a signed-in user, eliminating `permission-denied` on page load
- **[2026-07-28] Menu Management toggle fix** — writes now guarded by `auth.currentUser` check; clear user message shown if auth not yet ready
- **[2026-07-28 v2] Incoming Orders + Menu Management — Root Cause Fixed** — `index.html` never called `signInAnonymously` (only `admin/index.html` loads `admin.js` which does). `incoming-orders.js` now bootstraps anonymous auth for the billing panel; `menu-management.js` toggles now wait up to 5 s for auth before failing. See details below.
- **[2026-07-28 v3] Customer Order History Sync** — `js/cart.js` now writes completed orders to `customer_order_history/{uid}/orders/` and marks `pending_table_orders` as `status:'completed'` when Bill & Settle or Save & Exit is pressed for a Customer Panel order. Manual/walk-in orders are completely unaffected. See full details below.

---

## Bugs Fixed 🐛

| Date | Bug | Fix |
|------|-----|-----|
| Previous | Admin PIN login broken (`auth/operation-not-allowed` blocked dashboard) | Decoupled login from Firebase Auth; auth runs in background |
| Previous | PWA serving stale JS | Bumped `sw.js` cache version v7→v8 |
| Previous | Order panel calling Cloud Functions (fails without billing) | Rewrote `auth.js` + `order.js` in `order-panel-updates/` to use direct Firestore |
| 2026-07-28 | Incoming Orders not appearing in Billing Panel (attempt 1) | Fixed auth race in `incoming-orders.js` — now waits for `onAuthStateChanged` |
| 2026-07-28 | Menu Management toggle failing with "Could not update…" (attempt 1) | Added `auth.currentUser` guard in `menu-management.js` before `updateDoc`/`setDoc` |
| 2026-07-28 | **Incoming Orders + Menu Toggles still broken after attempt 1** | **Root cause found: `index.html` never called `signInAnonymously` (only `admin/index.html` loads `admin.js`). `auth.currentUser` was always `null` on the billing panel. Fix: `incoming-orders.js` now calls `signInAnonymously` at module top-level; `menu-management.js` now waits up to 5 s for auth instead of failing immediately.** |
| 2026-07-28 | **Customer order history not updated after Bill & Settle / Save & Exit** | **`js/cart.js` now calls `syncCustomerOrderCompletion()` (fire-and-forget) after each completion event. It marks `pending_table_orders` docs as `status:'completed'` (removes from Active Orders in real time) and writes a full order record to `customer_order_history/{uid}/orders/ORDER_{ts}`. Manual/walk-in orders are unaffected (gate: `activeCustomerUid_<table>` localStorage key must exist).** |

---

## Order Completion Flow (added 2026-07-28) 🔄

### How a Customer Panel order completes end-to-end:

| Step | Actor | Action | Firestore write |
|------|-------|--------|-----------------|
| 1 | Customer | Places order via Customer Panel | `pending_table_orders` doc created, `status: 'pending'` |
| 2 | Billing Panel | "Open in POS" button → `incoming-orders.js` | `status: 'accepted'` + stores `activeCustomerUid_<table>` in `localStorage` |
| 3 | Billing Panel | KOT printed → `cart.js printKOT()` | `status: 'kot', kotAt: <Timestamp>` |
| 4 | Billing Panel | **Bill & Settle** or **Save & Exit** | `status: 'completed', completedAt: <Timestamp>` on all active `pending_table_orders` docs for this table + new doc in `customer_order_history/{uid}/orders/ORDER_{ts}` |
| 5 | Customer Panel | Real-time listener (`order-status.js`) | Active Orders view removes completed order; Order History tab shows new entry |

### Key function: `syncCustomerOrderCompletion()` in `js/cart.js`
- **Fire-and-forget**: billing workflow never waits on it
- **Guard**: only runs when `activeCustomerUid_<table>` is in `localStorage` (set by `incoming-orders.js` on order accept)
- **Manual order safety**: walk-in / manual orders never set that localStorage key → function returns immediately, zero Firestore writes
- **What it writes**:
  1. `updateDoc` on all `pending_table_orders` where `tableId == table` and status in `[pending, accepted, kot]` → `{ status: 'completed', completedAt: serverTimestamp() }`
  2. `setDoc` on `customer_order_history/{customerUid}/orders/ORDER_{timestamp}` → `{ orderId, tableId, customerName, customerPhone, items[], total, completedAt, orderedAt, completionReason }`
  3. Removes `activeOrderDocId_*`, `activeCustomerUid_*`, `activeSessionId_*`, `activeLockId_*` from `localStorage`

### Customer Order History record shape:
```json
{
  "orderId": "ORDER_1722196800000",
  "tableId": "Table 3",
  "customerName": "Ramesh",
  "customerPhone": "+919876543210",
  "items": [{ "name": "...", "price": 0, "quantity": 1, "subtotal": 0 }],
  "total": 0,
  "completedAt": "<ServerTimestamp>",
  "completionReason": "bill_settle | save_exit",
  "orderedAt": "2026-07-28T10:00:00.000Z"
}
```

---

## Features Pending / Known Issues ⚠️

### CRITICAL — Order Panel (teamdovolve-hue/Order-) Not Updated
Three files must be pushed to the Order Panel GitHub repo for the full flow to work end-to-end:
- `order-panel-updates/js/auth.js` → replace `js/auth.js` in Order- repo
- `order-panel-updates/js/order.js` → replace `js/order.js` in Order- repo
- **`order-panel-updates/js/order-status.js`** → replace `js/order-status.js` in Order- repo *(added 2026-07-28 — provides Active Orders + Order History real-time listeners)*

**Until these are pushed, the Netlify-hosted Order Panel still calls Cloud Functions and shows "Login service error: internal".** The `customer.html` in this repo works correctly.

### How to push:
1. Go to https://github.com/teamdovolve-hue/Order-/edit/main/js/auth.js → paste content of `order-panel-updates/js/auth.js` → Commit
2. Go to https://github.com/teamdovolve-hue/Order-/edit/main/js/order.js → paste content of `order-panel-updates/js/order.js` → Commit
3. Go to https://github.com/teamdovolve-hue/Order-/edit/main/js/order-status.js → paste content of `order-panel-updates/js/order-status.js` → Commit

### Order Panel index.html wiring needed (for order-status.js):
After pushing `order-status.js` to the Order Panel, the index.html of that repo must call:
```javascript
import { startOrderTracking } from "./order-status.js";

// After the customer logs in (in auth.js onAuthReady callback):
startOrderTracking({
  onActiveOrders: (orders) => renderActiveOrders(orders),
  onHistory:      (orders) => renderOrderHistory(orders),
});
```
Where `renderActiveOrders` and `renderOrderHistory` are functions that update the UI. Each `orders` element has the shape documented in `order-panel-updates/js/order-status.js`.

### Firestore rules must be deployed:
Run: `firebase deploy --only firestore:rules`
The rules file (`firestore.rules`) now includes:
- `'completed'` added to `isAllowedStatusUpdate()` — required for billing panel to mark orders complete
- `customer_order_history/{uid}/orders/{orderId}` — operator write, customer read

### Other pending items:
- `GROQ_API_KEY` secret not set → AI chat in `admin/chat.ai.html` won't work
- OTP / Fast2SMS DLT approval pending — when approved, restore `customerAuth` Cloud Function path (marked with "BRIDGE" comments in code, no DB migration needed)
- Firebase billing not enabled → still on Spark plan → Cloud Functions not deployable

---

## Files Modified (this session — 2026-07-28)

| File | Repo | Change |
|------|------|--------|
| `js/incoming-orders.js` | Billing Panel | Imported `auth` + `onAuthStateChanged`; listener now starts after auth is confirmed |
| `js/menu-management.js` | Billing Panel | Imported `auth`; added `auth.currentUser` guard before `updateDoc`/`setDoc` |
| `AI_HANDOFF.md` | Billing Panel | Created this file |
| **`js/incoming-orders.js` (v2)** | Billing Panel | **Root fix: added `signInAnonymously` import + call at module top-level; moved `onAuthStateChanged` to module top-level (outside DOMContentLoaded) so auth bootstraps immediately on `index.html` load** |
| **`js/menu-management.js` (v2)** | Billing Panel | **Added `onAuthStateChanged` import + `_waitForAuth()` helper; toggles now wait up to 5 s for auth instead of immediately failing** |
| **`js/cart.js` (v3)** | Billing Panel | **Added `syncCustomerOrderCompletion()` at module top-level; called fire-and-forget from Bill & Settle and Save & Exit. Marks `pending_table_orders` docs as `completed`; writes `customer_order_history/{uid}/orders/` entry. No-op for manual orders.** |
| **`firestore.rules` (v3)** | Billing Panel | **Added `'completed'` to `isAllowedStatusUpdate()`; added `customer_order_history/{uid}/orders/{orderId}` rule (operator write, customer read own).** |
| **`order-panel-updates/js/order-status.js`** | Billing Panel (staging) | **New file: real-time listeners for Active Orders (`pending_table_orders` by UID) and Order History (`customer_order_history/{uid}/orders`). Must replace `js/order-status.js` in teamdovolve-hue/Order- repo.** |

---

## Files Modified (previous sessions)

| File | Repo | Change |
|------|------|--------|
| `js/admin.js` | Billing Panel | PIN login decoupled from Firebase Auth; `signInAnonymously` runs in background |
| `customer.html` | Billing Panel | Full rewrite — 3-screen auth, direct Firestore, no Cloud Functions |
| `firestore.rules` | Firebase Console | Bridge rules: anon read/create for `customers`; anon create for `pending_table_orders` |
| `sw.js` | Billing Panel | Cache version v7→v8 |
| `order-panel-updates/js/auth.js` | Billing Panel (staging) | Rewrote for direct Firestore — NOT yet pushed to Order- repo |
| `order-panel-updates/js/order.js` | Billing Panel (staging) | Rewrote for direct Firestore — NOT yet pushed to Order- repo |

---

## Database / Schema Notes

- `pending_table_orders` document shape:
  ```json
  {
    "tableId": "Table 3",
    "customer": { "uid": "<anon-uid>", "name": "...", "phone": "+91..." },
    "status": "pending",
    "items": [{ "itemId": "...", "name": "...", "price": 0, "quantity": 1, "subtotal": 0 }],
    "totalPrice": 0,
    "createdAt": "<ServerTimestamp>"
  }
  ```
- `customers/{+91…}` always created with `phoneVerified: false` (bridge build)
- `settings/pizza_sizes` shape: `{ "regular": true, "medium": true, "large": true }`

---

## API / Cloud Function Status

All Cloud Functions are **bypassed** (no Firebase billing plan). Direct Firestore reads/writes are used instead.

| Function | Status | Bridge |
|----------|--------|--------|
| `operatorSignIn` | ❌ Not deployed | PIN check local + `signInAnonymously` |
| `customerAuth` | ❌ Not deployed | Direct Firestore getDoc/setDoc |
| `createCustomerOrder` | ❌ Not deployed | Direct `addDoc` to `pending_table_orders` |
| `releaseTableLock` | ❌ Not deployed | Not needed in bridge mode |

---

## Next Recommended Steps

1. **Push Order Panel changes** to `teamdovolve-hue/Order-` on GitHub (see Critical section above)
2. **Set `GROQ_API_KEY`** in Replit Secrets to enable AI chat
3. **Fast2SMS DLT approval** → restore OTP flow (no DB migration, just flip flags in code)
4. **Firebase billing** → deploy Cloud Functions → restore full secure flow
