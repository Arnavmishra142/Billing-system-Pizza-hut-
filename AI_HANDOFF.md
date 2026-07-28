# AI_HANDOFF.md — Project State Document
> Auto-maintained by AI agent. Update this file after every implementation.
> Last updated: 2026-07-28 (session 2)

---

## Project Overview

**Name:** New Pizza Hut & Live Cake — Billing & Customer System  
**Stack:** Vanilla HTML/CSS/JS · Firebase (Firestore + Auth + Storage) · PWA  
**Two repos:**
- **This repo** (`Billing-system-Pizza-hut`) — Billing/Admin Panel + `customer.html`
- **Separate repo** (`teamdovolve-hue/Order-`, Netlify) — Customer Order Panel

---

## Architecture Summary

| Panel | URL / Path | Auth Method |
|-------|-----------|-------------|
| Billing / Admin | This repo, `index.html` | PIN 1414 → `signInAnonymously()` in background |
| Customer (this repo) | `customer.html` | `signInAnonymously()` → phone+name stored in Firestore |
| Customer Order Panel | Netlify (`teamdovolve-hue/Order-`) | `signInAnonymously()` + phone lookup in Firestore |

**Firestore collections used:**
- `pending_table_orders` — live orders from customers, read by billing panel
- `customers/{+91…}` — customer profiles (phone, name, phoneVerified: false)
- `menu_items` — menu catalog; toggled by Menu Management
- `settings/pizza_sizes` — pizza size availability flags
- `sales_history` — completed/billed orders
- `daily_expenses` — expense tracking
- `tables` — table state
- `customer_order_history/{uid}/orders` — completed order records, written by billing panel, read by Customer Panel

---

## Features Completed ✅ (session 3 additions)

- **Expense Save — Auth Fix** — `expense.html` is a standalone page that never called `signInAnonymously()`. Every `addDoc`/`updateDoc`/`deleteDoc` returned `permission-denied` silently (optimistic UI hid it). Fix: `js/expense.js` now imports `signInAnonymously` + `onAuthStateChanged`, bootstraps anonymous auth at module top-level, and gates all three write paths (add / update / delete) + the server-side read (`getDocsFromServer`) behind `_waitForAuth()` — same pattern used by `incoming-orders.js` and `menu-management.js`.

## Features Completed ✅ (session 2 additions)

- **Menu Management — Individual pizza variant toggles** — Pizza variant items (e.g. "Paneer Pizza (Large)") now have their own `inStock` toggle in a dedicated "Individual Pizza Availability" section, independently of the whole-size toggle. Previously they were permanently excluded from the list.
- **Menu Management — Listener error recovery** — Firestore `onSnapshot` errors now set `_unsubItems`/`_unsubPizzaSizes = null` and schedule a 5 s auto-retry. `initMenuManagement()` detects dropped listeners (null refs) and restarts them without a loading flash. The permanent-until-reload error state is fixed.
- **Incoming Orders — visibilitychange no longer recreates listener** — `visibilitychange` now only calls `enableNetwork()` to re-open the network channel. The existing live listener is preserved, eliminating the stale-IndexedDB-cache delay on every tab focus.
- **Incoming Orders — order-count caching** — `getCustomerOrderCount()` now caches results in `_countCache` (Map keyed by phone). No more N Firestore round-trips per render; cache is cleared on listener restart.
- **KOT Timer — customer sees elapsed time** — `startOrderTracking` now forwards `kotAt` from Firestore into mapped order objects. `_renderActiveOrders` computes elapsed minutes from `kotAt` and renders "Preparing 🍕 • X min". A 30 s `setInterval` patches labels in the DOM on pre-existing cards — no Firestore round-trips. Timer starts automatically when a preparing order appears and stops when all preparing orders are gone or on logout.

## Features Completed ✅

- Admin PIN login (1414), decoupled from Firebase Auth — dashboard shows immediately
- PWA stale-cache fix — `sw.js` bumped v7→v8, cache busted
- `customer.html` full rewrite — 3-screen phone flow, direct Firestore reads/writes, no Cloud Functions
- Firestore rules updated — anonymous create/read for `customers` and `pending_table_orders`
- Bridge build for Order Panel (`order-panel-updates/js/auth.js` and `order.js`) — bypasses Cloud Functions
- **Incoming Orders listener auth-race fix** — listener starts only after `onAuthStateChanged` confirms a signed-in user
- **Menu Management toggle fix** — writes guarded by `auth.currentUser`; waits up to 5s for auth before failing
- **Root cause auth fix** — `incoming-orders.js` now bootstraps `signInAnonymously` at module top-level so `index.html` has a Firebase session (previously only `admin/index.html` did this)
- **Customer Order Status updates** — real-time status shown on Customer Panel:
  - `pending` → "Order Received ✅"
  - `accepted` → "Order Confirmed 👨‍🍳"
  - `kot` → "Preparing 🍕" (set when KOT is printed in billing panel)
  - `completed` → order removed from Active Orders, saved to Order History
- **Order completion sync** — `js/cart.js` calls `syncCustomerOrderCompletion()` (fire-and-forget) when Bill & Settle or Save & Exit is pressed for a Customer Panel order
- **Customer Panel `order-status.js`** — bridge version already pushed to `teamdovolve-hue/Order-` repo; `auth.js` and `order.js` also already pushed
- **`initOrderStatus`/`stopOrderStatus` exports added** — `order-panel-updates/js/order-status.js` now exports these functions that `app.js` imports; missing wrappers were the last integration gap

---

## Bugs Fixed 🐛

| Date | Bug | Fix |
|------|-----|-----|
| Previous | Admin PIN login broken (`auth/operation-not-allowed` blocked dashboard) | Decoupled login from Firebase Auth; auth runs in background |
| Previous | PWA serving stale JS | Bumped `sw.js` cache version v7→v8 |
| Previous | Order panel calling Cloud Functions (fails without billing) | Rewrote `auth.js` + `order.js` in `order-panel-updates/` to use direct Firestore |
| 2026-07-28 | Incoming Orders not appearing in Billing Panel | Fixed auth race in `incoming-orders.js` — now bootstraps `signInAnonymously` at module top-level; listener waits for `onAuthStateChanged` |
| 2026-07-28 | Menu Management toggle failing with "Could not update…" | `menu-management.js` now waits up to 5s for auth before timing out |
| 2026-07-28 | Customer order history not updated after Bill & Settle / Save & Exit | `js/cart.js` now calls `syncCustomerOrderCompletion()` fire-and-forget |
| 2026-07-28 | Customer Panel order tracking silently broken | `order-status.js` was missing `initOrderStatus`/`stopOrderStatus` exports — `app.js` imported them but they didn't exist, so tracking never started |

---

## Order Completion Flow 🔄

### How a Customer Panel order completes end-to-end:

| Step | Actor | Action | Firestore write |
|------|-------|--------|-----------------|
| 1 | Customer | Places order via Customer Panel | `pending_table_orders` doc created, `status: 'pending'` |
| 2 | Billing Panel | "Open in POS" button → `incoming-orders.js` | `status: 'accepted'` + stores `activeCustomerUid_<table>` in `localStorage` |
| 3 | Billing Panel | KOT printed → `cart.js printKOT()` | `status: 'kot', kotAt: <Timestamp>` |
| 4 | Billing Panel | **Bill & Settle** or **Save & Exit** | `status: 'completed', completedAt: <Timestamp>` on all active `pending_table_orders` docs for this table + new doc in `customer_order_history/{uid}/orders/ORDER_{ts}` |
| 5 | Customer Panel | Real-time listener (`order-status.js → initOrderStatus`) | Active Orders view removes completed order; Order History tab shows new entry |

### Key function: `syncCustomerOrderCompletion()` in `js/cart.js`
- **Fire-and-forget**: billing workflow never waits on it
- **Guard**: only runs when `activeCustomerUid_<table>` is in `localStorage` (set by `incoming-orders.js` on order accept)
- **Manual order safety**: walk-in / manual orders never set that localStorage key → function returns immediately, zero Firestore writes

---

## Customer Panel Integration Status

### ✅ Already pushed to `teamdovolve-hue/Order-` repo:
- `js/auth.js` — bridge build (direct Firestore, no Cloud Functions)
- `js/order.js` — bridge build (direct `addDoc` to `pending_table_orders`)
- `js/order-status.js` — bridge build with real-time listeners

### ⚠️ ONE FILE STILL NEEDS UPDATING in Customer Panel repo:

**`js/order-status.js`** — the version in the repo is missing `initOrderStatus` and `stopOrderStatus` exports.

`app.js` (already correct in the Customer Panel repo) imports:
```js
import { initOrderStatus, stopOrderStatus } from "./order-status.js";
```

But the current `order-status.js` in the repo only exports `startOrderTracking` / `stopOrderTracking`. This means order tracking **silently never starts** after login.

**Fix:** Replace `js/order-status.js` in the Customer Panel repo with the content of `order-panel-updates/js/order-status.js` from this repo.

**How to update:**
1. Go to https://github.com/teamdovolve-hue/Order-/edit/main/js/order-status.js
2. Replace the entire file content with the content of `order-panel-updates/js/order-status.js` from this repo
3. Commit

**What the new version adds (over the current one):**
- `export function initOrderStatus()` — called by `app.js` after login; starts tracking with DOM rendering callbacks
- `export function stopOrderStatus()` — called by `app.js` on logout; stops tracking and clears UI
- `_renderActiveOrders(orders)` — renders `.aos-card` elements into `#activeOrdersList`; shows/hides `#activeOrdersSection`
- `_syncHistoryToLocalStorage(orders)` — syncs completed orders from Firestore into localStorage via `saveOrderToHistory` (from `history.js`), so they appear in the history drawer
- Import of `saveOrderToHistory` from `./history.js`

**No other files need changing in the Customer Panel repo.**

---

## `initOrderStatus` DOM Integration Details

| DOM Element | ID | Behavior |
|---|---|---|
| Active orders section | `#activeOrdersSection` | Hidden by default; shown when `orders.length > 0` |
| Active orders list | `#activeOrdersList` | Populated with `.aos-card` elements per order |
| History list | `#historyList` | Managed by `history.js`; synced via `saveOrderToHistory` |
| History panel | `#historyPanel` | Opened via `#historyBtn` → `history.js openHistory()` |

**CSS classes used for active order cards** (all exist in Customer Panel `css/style.css`):
- `.aos-card`, `.aos-card-top`, `.aos-card-left` — card layout
- `.aos-table-tag` — table name pill
- `.aos-item-count` — "N items" label
- `.aos-total` — total price
- `.aos-status` — status row container
- `.aos-pending` — amber background (used for `pending` and `accepted` statuses)
- `.aos-preparing` — green background (used for `kot` status)
- `.aos-dot`, `.aos-dot-pend`, `.aos-dot-prep` — animated status dot
- `.aos-status-label` — status text
- `.aos-items` — `<ul>` item list
- `.aos-item-name`, `.aos-item-qty` — per-item name and quantity

---

## Firestore Rules Status

`firestore.rules` in this repo is **up to date** but **not yet deployed**.

**Must deploy before order completion flow works end-to-end:**
```bash
firebase deploy --only firestore:rules
```

**Key rules that were added (not yet deployed):**
1. `'completed'` added to `isAllowedStatusUpdate()` — without this, billing panel cannot mark orders as completed (Firestore write will be denied)
2. `customer_order_history/{uid}/orders/{orderId}` rule — operator can write, customer can read their own history

Until these rules are deployed:
- Bill & Settle / Save & Exit will silently fail to update `pending_table_orders` status → customer sees order stuck in Active Orders forever
- `customer_order_history` writes will be denied → Order History tab stays empty

---

## Files Modified (2026-07-28 — session 2)

| File | Repo | Change |
|------|------|--------|
| `order-panel-updates/js/order-status.js` | Billing Panel (staging) | KOT timer: added `_tsToMs`, `_elapsedMin`, `_startPreparingTimer`, `_stopPreparingTimer`; added `kotAt` to mapped order objects; `_renderActiveOrders` now renders "Preparing 🍕 • X min" and manages the interval; `stopOrderTracking` now calls `_stopPreparingTimer` |
| `AI_HANDOFF.md` | Billing Panel | Updated with session 2 state, root-cause documentation, remaining known issues |

## Files Modified (2026-07-28 — session 1)

| File | Repo | Change |
|------|------|--------|
| `order-panel-updates/js/order-status.js` | Billing Panel (staging) | Added `initOrderStatus` + `stopOrderStatus` exports with DOM rendering; added import of `saveOrderToHistory` from `history.js`; fixed active orders renderer to use correct `.aos-*` CSS classes |
| `AI_HANDOFF.md` | Billing Panel | Updated with full current state, integration gap details, Firestore rules deployment instructions |

---

## Files Modified (previous sessions — 2026-07-28)

| File | Repo | Change |
|------|------|--------|
| `js/incoming-orders.js` | Billing Panel | Added `signInAnonymously` bootstrap at module top-level; listener starts after `onAuthStateChanged` |
| `js/menu-management.js` | Billing Panel | Added `onAuthStateChanged` guard; toggles wait up to 5s for auth |
| `js/cart.js` | Billing Panel | Added `syncCustomerOrderCompletion()` fire-and-forget; called from Bill & Settle and Save & Exit |
| `firestore.rules` | Billing Panel | Added `'completed'` to `isAllowedStatusUpdate()`; added `customer_order_history` read/write rules |
| `order-panel-updates/js/auth.js` | Billing Panel (staging) | Bridge build — direct Firestore auth, no Cloud Functions |
| `order-panel-updates/js/order.js` | Billing Panel (staging) | Bridge build — direct `addDoc` to `pending_table_orders` |

---

## Files Modified (previous sessions — earlier)

| File | Repo | Change |
|------|------|--------|
| `js/admin.js` | Billing Panel | PIN login decoupled from Firebase Auth; `signInAnonymously` runs in background |
| `customer.html` | Billing Panel | Full rewrite — 3-screen auth, direct Firestore, no Cloud Functions |
| `sw.js` | Billing Panel | Cache version v7→v8 |

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
- `customer_order_history/{uid}/orders/ORDER_{ts}` shape:
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

## API / Cloud Function Status

All Cloud Functions are **bypassed** (no Firebase billing plan). Direct Firestore reads/writes are used instead.

| Function | Status | Bridge |
|----------|--------|--------|
| `operatorSignIn` | ❌ Not deployed | PIN check local + `signInAnonymously` |
| `customerAuth` | ❌ Not deployed | Direct Firestore getDoc/setDoc |
| `createCustomerOrder` | ❌ Not deployed | Direct `addDoc` to `pending_table_orders` |
| `releaseTableLock` | ❌ Not deployed | Not needed in bridge mode |

---

## Pending Tasks ⚠️

### CRITICAL — 1. Deploy Firestore Rules

```bash
firebase deploy --only firestore:rules
```

Without this:
- Bill & Settle / Save & Exit cannot mark orders as `completed` (Firestore denies the write)
- `customer_order_history` writes will be denied — Order History stays empty

### CRITICAL — 2. Push updated `order-status.js` to Customer Panel

Replace `js/order-status.js` in `teamdovolve-hue/Order-` with `order-panel-updates/js/order-status.js` from this repo.

Go to: https://github.com/teamdovolve-hue/Order-/edit/main/js/order-status.js

**After this change, `inStock` field compatibility:**  
The Customer Panel's `js/menu.js` may still filter on `available` field instead of `inStock`. Check that file:
```js
.filter((item) => item.available !== false)   // ← old
.filter((item) => item.inStock !== false)      // ← correct
```

### Non-critical pending items:
- `GROQ_API_KEY` secret — AI chat in `admin/chat.ai.html` won't work without it (set in Replit Secrets)
- OTP / Fast2SMS DLT approval pending — when approved, restore `customerAuth` Cloud Function path (marked with "BRIDGE" comments, no DB migration needed)
- Firebase billing not enabled → still on Spark plan → Cloud Functions not deployable

---

## Remaining Known Issues ⚠️

| Issue | Impact | Fix |
|-------|--------|-----|
| Firestore rules not yet deployed | Bill & Settle / Save & Exit cannot mark orders `completed`; `customer_order_history` writes denied | Run `firebase deploy --only firestore:rules` from the billing repo root |
| `order-panel-updates/js/order-status.js` not yet pushed to Customer Panel repo | KOT timer, `initOrderStatus`/`stopOrderStatus`, and order history sync will not work on the live Customer Panel | Replace `js/order-status.js` in `teamdovolve-hue/Order-` with the file from this repo (see instructions below) |
| `GROQ_API_KEY` secret not set | AI chat in `admin/chat.ai.html` shows no response | Set `GROQ_API_KEY` in Replit Secrets |

---

## Next Steps for Next AI Agent

1. **Deploy Firestore rules**: `firebase deploy --only firestore:rules` — required before order completion flow works end-to-end.
2. **Push updated `order-status.js` to Customer Panel** (see "Customer Panel Integration Status" section).
3. **End-to-end test**: Customer places order → billing panel accepts → KOT printed → customer sees "Preparing 🍕 • X min" with ticking timer → Bill & Settle → customer sees order move to history.
4. If `GROQ_API_KEY` is available, verify AI chat in `admin/chat.ai.html` works.
