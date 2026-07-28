# AI_HANDOFF.md — Project State Document
> Auto-maintained by AI agent. Update this file after every implementation.
> Last updated: 2026-07-28 (session 7)

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

## Files Modified (2026-07-28 — session 7)

| File | Repo | Change |
|------|------|--------|
| `js/order-notify.js` | Billing Panel | **Bug fix (v2)** — rewrote `_unlockAudio()` to check `_alertActive` before deciding whether to pause. When a pending alert exists, it now plays WITHOUT pausing (resuming the queued alert). Added `_pendingTableId` variable to track the waiting table. Added console.log checkpoints at every step of the chain for diagnosability. |

### Root cause — why notification sound was not playing

**The failure chain (step-by-step):**

1. `signInAnonymously()` runs at **module load time** in `incoming-orders.js` — no user gesture needed. Firebase returns a cached anonymous session from IndexedDB almost immediately.
2. `onAuthStateChanged` fires → `startListening()` → Firestore `onSnapshot` fires → finds existing pending order(s) → `triggerAlert('Table X')` called.
3. Inside `triggerAlert`: `_alertActive = true`, `_audio.currentTime = 0`, `_audio.play()` → **FAILS** — browser autoplay policy blocks play because no user gesture has occurred yet. Error is caught and logged; `_alertActive` stays `true`.
4. Admin clicks a PIN digit (first gesture on the page) → `_unlockAudio()` fires → **old code:** `_audio.play().then(() => { _audio.pause(); _audio.currentTime = 0; })` → plays and **immediately pauses and resets** — audio goes silent.
5. `_alertActive` is still `true` but the audio is paused. Nothing ever restarts it.

**The fix:** `_unlockAudio()` now checks `_alertActive` before deciding what to do after play:
- If `_alertActive === true` (pending alert): play WITHOUT pausing — the loop starts immediately.
- If `_alertActive === false` (no pending alert): play then pause (AudioContext warmup only).

Additionally, `triggerAlert()` now has an explicit early-return path when `_audioUnlocked` is false, logging the queued state clearly. The audio will start when `_unlockAudio()` fires on the next gesture.

**No Customer Panel changes required.** The bug was entirely in the Billing Panel's audio unlock logic.

---

## Files Modified (2026-07-28 — session 6)

| File | Repo | Change |
|------|------|--------|
| `js/order-notify.js` | Billing Panel | **NEW FILE** — Standalone looping audio + browser notification alert module. Exports `triggerAlert(tableId)` and `stopAlert()`. Handles autoplay unlock, single-loop guard, browser Notification API permission request, and notification click → open-drawer event dispatch. |
| `js/incoming-orders.js` | Billing Panel | **Minimal additions only** — imported `triggerAlert`/`stopAlert` from `order-notify.js`; called `triggerAlert()` inside the existing `_notified` new-order guard; called `stopAlert()` at the top of `openDrawer()`; added `window 'orders-open-drawer'` listener to open drawer on notification click. No existing logic changed. |

### How the notification system works

1. **New order detected** — `startListening()`'s `onSnapshot` fires. The existing `_notified.has(id)` guard ensures the block runs only once per new order (not on every re-render). `triggerAlert(tableId)` is called inside that block.
2. **`triggerAlert`** — requests notification permission (lazily, first time only), shows/replaces a browser `Notification` with `tag:'incoming-order'` (so multiple orders don't stack), starts `notification.mp3` looping. If an alert is already active, only the browser notification is refreshed — no second audio loop.
3. **Alert stops** when either:
   - Admin **opens the Incoming Orders drawer** → `openDrawer()` calls `stopAlert()`.
   - Admin **clicks the browser notification** → `notification.onclick` calls `stopAlert()`, dispatches `window 'orders-open-drawer'` event, which `incoming-orders.js` listens for and calls `openDrawer()`.
4. **Autoplay unlock** — on the admin's first click/touch/keydown, `_unlockAudio()` calls `play().then(pause())` to warm the AudioContext. Registered once, removed after first fire.

### Browser limitations

- **Audio autoplay**: Browsers block `audio.play()` until a user gesture. The first time the admin clicks anything on the page, audio is unlocked for the session. If an order arrives before any interaction, the browser notification still shows but the sound starts on next interaction.
- **Background tab notifications**: Browser notifications appear even when the tab is minimised (requires `Notification.permission === 'granted'`). The notification click re-focuses the window and opens the drawer.
- **`requireInteraction: true`**: Supported on Chrome/Edge desktop — notification stays on screen until dismissed. On mobile/Firefox it may auto-dismiss after a few seconds; the looping audio continues regardless.

> ⚠️ **Audio file required:** `sounds/notification.mp3` must exist in the repo. The user confirmed they added `notification.mp3` — place it in the `sounds/` folder (alongside `cash.sfx.mp3` and `pop.sfx.mp3`). If the file is at the repo root instead, update the path in `js/order-notify.js` line: `new Audio('sounds/notification.mp3')` → `new Audio('notification.mp3')`.

---

## Files Modified (2026-07-28 — session 5)

| File | Repo | Change |
|------|------|--------|
| `firestore.rules` | Billing Panel | **`customer_order_history` write rule:** Changed `allow write: if isOperator()` → `allow write: if isOperator() \|\| isSameCustomer(uid)`. Customers can now write only their own order history (`request.auth.uid == uid`). `isOperator()` is preserved because `syncCustomerOrderCompletion()` in `js/cart.js` writes from the billing panel's own anonymous auth session (whose UID differs from the customer's UID) — removing it would break order completion. |

> ⚠️ **Deployment required:** `firestore.rules` has been updated but not yet deployed. Run `firebase deploy --only firestore:rules` for this change to take effect. Until deployed, customer order history writes will continue to fail with permission-denied.

---

## Files Modified (2026-07-28 — session 4)

| File | Repo | Change |
|------|------|--------|
| `customer.html` | Billing Panel | **Phone input UX:** Added `name="tel"` attribute (required for browser autofill field identification) and changed `autocomplete="tel"` → `autocomplete="tel-national"` (correct value when a static `+91` prefix is already displayed — `tel` would autofill the full international number including country code into the 10-digit field). No JS, auth, or layout changes. |

---

## Features Completed ✅ (session 3 — Bug Fixes Only)

### Bugs Fixed in `js/admin.js`

- **Login Session Persistence** — Admin was prompted for PIN on every browser close/reopen.
  - **Root cause:** `sessionStorage` was used for `operatorLoggedIn`; it is tab-scoped and cleared whenever the browser or tab closes.
  - **Fix:** Changed all three `sessionStorage` references to `localStorage`. Session now persists until the admin explicitly logs out or clears browser data. Security unchanged — PIN still required on first login.

- **Menu tab: listener torn down on every switch** — Opening the Menu tab always showed "Loading menu…" then a stale-cache flash, then the live data — a two-step flicker on every visit.
  - **Root cause:** `loadMenuData()` always called `_menuUnsub()` then created a brand-new `onSnapshot`, even when the existing listener was healthy.
  - **Fix:** `loadMenuData()` now checks `_menuUnsub`; if the listener is alive it calls `renderMenuCards()` instantly from the in-memory `allMenuItems` array. The listener is only (re)created on first call or after it drops due to an error.

- **Menu tab: `deleteMenuItem()` and `saveItemBtn` triggered unnecessary listener recreation**
  - **Root cause:** Both handlers called `loadMenuData()` after a Firestore write. Since the live `onSnapshot` already fires automatically on any write, this tore down and recreated the listener for no reason, causing the two-step flicker described above.
  - **Fix:** Both handlers no longer call `loadMenuData()`. The existing listener handles the update automatically.

- **Sales data: full Firestore server fetch on every tab switch** — Switching away from and back to the Sales tab always triggered a round-trip `getDocsFromServer`, even seconds after the previous fetch.
  - **Root cause:** `fetchAllSales()` unconditionally called `getDocsFromServer()` on every invocation with no throttle.
  - **Fix:** Added `_salesServerFetchedAt` timestamp. The server fetch is skipped if it ran within the last 30 seconds. The IndexedDB cache read still happens every call for instant local data. The Refresh (↻) button resets `_salesServerFetchedAt = 0` to force an immediate server fetch.

- **Expense listener: torn down on every filter change and every tab switch** — Switching expense filters (Today / 7 Days / 30 Days) or switching away and back to the Expense tab always cancelled and recreated the Firestore listener.
  - **Root cause:** Filtering was done inside the `onSnapshot` closure, so the filter was baked into the listener — changing it required a new one.
  - **Fix:** Filtering is now done in `_renderExpensesFromDocs()` which reads from the module-level `_expenseAllDocs` array. `loadAdminExpenses()` updates the filter variables and re-renders instantly from cached docs without touching the live listener. The Refresh button explicitly passes `forceRefresh=true` to recreate the listener and force a server sync. `deleteExpense()` no longer calls `loadAdminExpenses()` — the live listener handles it.

---

## Features Completed ✅ (session 3 additions)

- **Expense Save — Auth Fix** — `expense.html` is a standalone page that never called `signInAnonymously()`. Every `addDoc`/`updateDoc`/`deleteDoc` returned `permission-denied` silently (optimistic UI hid it). Fix: `js/expense.js` now imports `signInAnonymously` + `onAuthStateChanged`, bootstraps anonymous auth at module top-level, and gates all three write paths (add / update / delete) + the server-side read (`getDocsFromServer`) behind `_waitForAuth()` — same pattern used by `incoming-orders.js` and `menu-management.js`.

- **Order Status + History — Two Bug Fixes**
  - **Bug 1 (Customer Panel `order-status.js`)**: The active-orders query combined `where("customer.uid", "==", uid)` with `orderBy("createdAt", "desc")`. Firestore requires a composite index for this combination — without it the `onSnapshot` fires an error immediately and no orders ever show. Fix: removed `orderBy` from the query; sort is now done client-side (`.sort()` on the mapped array). No index needed.
  - **Bug 2 (`js/cart.js` `syncCustomerOrderCompletion`)**: History sync was 100% gated on `localStorage.getItem("activeCustomerUid_<table>")`, set only when operator clicks "Open in POS". If the page was refreshed after that click, or the operator opened the table a different way, the key was missing and the function returned immediately without writing anything. Fix: the function now queries `pending_table_orders` first regardless, and if localStorage is empty it recovers the UID directly from `activeDocs[0].data().customer?.uid`.

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

## Files Modified (2026-07-28 — session 3)

| File | Repo | Change |
|------|------|--------|
| `js/admin.js` | Billing Panel | **Login:** `sessionStorage` → `localStorage` for `operatorLoggedIn` (3 occurrences) — session now persists across browser restarts. **Menu:** `loadMenuData()` preserves live `onSnapshot` on repeated tab switches; `deleteMenuItem()` and `saveItemBtn` no longer call `loadMenuData()`. **Sales:** `fetchAllSales()` throttles server fetch to 30 s via `_salesServerFetchedAt`; Refresh button resets throttle. **Expenses:** refactored to `_expenseAllDocs` + `_renderExpensesFromDocs()`; listener preserved across filter changes; `deleteExpense()` no longer recreates listener. |
| `AI_HANDOFF.md` | Billing Panel | Updated with session 3 state, root-cause documentation, bugs fixed |

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
