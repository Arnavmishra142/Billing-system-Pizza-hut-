# ARCHITECTURE_LOCK.md — Permanent Architectural Contract

> **READ THIS FIRST.** This document is the permanent source of truth for all future AI agents working on this repository.
> Created: 2026-07-28. Update this file only when architecture genuinely changes — never delete sections.

---

## MANDATORY READING ORDER FOR AI AGENTS

1. **Read `ARCHITECTURE_LOCK.md` first** (this file) — architecture rules and frozen contracts.
2. **Read `AI_HANDOFF.md` second** — current implementation state, bugs fixed, pending tasks.
3. **Summarize the current architecture** before touching any code.
4. **Only then** make the smallest possible change needed.

---

## 1. Project Overview

### Purpose of the Billing Panel

This repository (`Billing-system-Pizza-hut`) is the **operator-facing POS and billing system** for "New Pizza Hut & Live Cake". It allows restaurant operators to:

- Receive live customer orders placed from the Customer Order Panel.
- Manage dine-in tables and walk-in/takeaway orders manually.
- Print KOTs (Kitchen Order Tickets) and track preparation.
- Bill and settle orders, calculate totals with taxes/discounts.
- Manage menu items and their availability in real time.
- View sales history, daily expenses, and admin reports.
- Chat with an AI manager (Groq-powered) for sales analysis.

### Relationship with the Customer Panel

This Billing Panel and the Customer Panel together form **one single production application**. They are **not** independent projects.

| Panel | Repository | Host |
|-------|-----------|------|
| Billing / Admin | `Billing-system-Pizza-hut` (this repo) | Replit Static |
| Customer Order Panel | `teamdovolve-hue/Order-` | Netlify |

Both panels share the **same Firebase project**, the same Firestore database, and the same anonymous Firebase Auth session space. A change to any shared contract (collection name, field name, status value, document shape) in one panel **breaks the other panel**.

### High-Level Architecture

```
┌─────────────────────────────────┐        ┌──────────────────────────────────┐
│  BILLING PANEL (this repo)      │        │  CUSTOMER ORDER PANEL            │
│  Replit Static · index.html     │        │  Netlify · teamdovolve-hue/Order-│
│                                 │        │                                  │
│  js/admin.js         (reports)  │        │  js/auth.js      (anon auth)     │
│  js/cart.js          (billing)  │◄──────►│  js/order.js     (place order)   │
│  js/incoming-orders.js (live)   │        │  js/order-status.js (tracking)   │
│  js/menu-management.js (menu)   │        │  js/menu.js      (browse menu)   │
│  js/tables.js        (tables)   │        │  js/history.js   (order history) │
│  js/expense.js       (expenses) │        │                                  │
│  customer.html       (CRM)      │        └──────────────────────────────────┘
└─────────────────────────────────┘
             │                  ▲
             ▼                  │
     ┌───────────────────────────────┐
     │       FIREBASE (Shared)       │
     │  Firestore · Auth · Storage   │
     └───────────────────────────────┘
```

### Shared Backend Services

| Service | Usage |
|---------|-------|
| **Firebase Auth** | `signInAnonymously()` — both panels use anonymous auth |
| **Firestore** | All data: orders, menu, customers, history, tables, expenses |
| **Firebase Storage** | Menu item images (uploaded via `upload-menu.html`) |
| **Groq API** | AI Manager chat (`admin/chat.ai.html`) — key injected at build time |

All Cloud Functions are **bypassed** (Spark plan, no billing). Direct Firestore reads/writes are used everywhere.

---

## 2. Frozen Core Architecture

The following systems are **production-stable**. Future AI agents **MUST NOT** modify these systems unless the user explicitly instructs it. Do not refactor, redesign, rename, or restructure any of these.

| System | Files | Status |
|--------|-------|--------|
| **Admin Authentication** | `js/admin.js` (PIN 1414 → `signInAnonymously`) | 🔒 FROZEN |
| **Billing Workflow** | `js/cart.js`, `index.html` | 🔒 FROZEN |
| **Incoming Orders** | `js/incoming-orders.js` | 🔒 FROZEN |
| **Menu Management** | `js/menu-management.js`, `admin/index.html` | 🔒 FROZEN |
| **Menu Availability** | `inStock` field on `menu_items` documents | 🔒 FROZEN |
| **KOT Workflow** | `js/cart.js` `printKOT()` | 🔒 FROZEN |
| **Save & Exit** | `js/cart.js` | 🔒 FROZEN |
| **Bill & Settle** | `js/cart.js` | 🔒 FROZEN |
| **Billing Calculations** | `js/cart.js` (subtotals, tax, discount, total) | 🔒 FROZEN |
| **Manual Billing** | `index.html` quick-sale / takeaway flows | 🔒 FROZEN |
| **Walk-in Orders** | `index.html` walk-in flow | 🔒 FROZEN |
| **Customer Order Synchronization** | `js/cart.js` `syncCustomerOrderCompletion()` | 🔒 FROZEN |
| **Customer Order History Synchronization** | `js/cart.js` → `customer_order_history` | 🔒 FROZEN |
| **Realtime Listeners** | `onSnapshot` in `incoming-orders.js`, `menu-management.js`, `admin.js` | 🔒 FROZEN |
| **Firestore Integration** | `js/firebase-config.js`, all collection references | 🔒 FROZEN |
| **Firebase Integration** | `js/firebase-config.js` | 🔒 FROZEN |
| **Firestore Collections** | All collection names (see Section 5) | 🔒 FROZEN |
| **Customer Synchronization** | `customer.html`, `customers/` collection | 🔒 FROZEN |

**Rule:** If you are unsure whether a system is frozen, treat it as frozen and ask the user instead.

---

## 3. Frozen Order Lifecycle

This is the complete production order workflow. It is **frozen** and must remain backward-compatible in all future changes.

```
Customer places order (Customer Order Panel)
    │
    ▼
pending_table_orders doc created
    status: "pending"
    │
    ▼
Billing Panel: Incoming Orders drawer receives live order (onSnapshot)
    │
    ▼
Operator clicks "Open in POS"
    status: "accepted"
    localStorage key set: activeCustomerUid_<table>
    │
    ▼
KOT printed (js/cart.js printKOT())
    status: "kot"
    kotAt: <ServerTimestamp>
    │
    ▼
Live Timer Starts
    Customer Panel shows: "Preparing 🍕 • X min"
    Timer ticks every 30 s via setInterval (no Firestore reads)
    │
    ▼
Operator: Save & Exit  ──OR──  Bill & Settle
    status: "completed"
    completedAt: <ServerTimestamp>
    syncCustomerOrderCompletion() called (fire-and-forget)
    New doc written to: customer_order_history/{uid}/orders/ORDER_{ts}
    │
    ▼
Active order removed from Billing Panel
    │
    ▼
Customer Panel: Active Orders view clears
    Order History tab shows new entry
    │
    ▼
Order Completed ✅
```

**This workflow is frozen. Any change that breaks any step of this lifecycle is a regression.**

Status value progression (these strings are shared with the Customer Panel — never change them):
- `"pending"` → `"accepted"` → `"kot"` → `"completed"`

---

## 4. Cross-Repository Contract (CRITICAL)

This repository depends on: **https://github.com/teamdovolve-hue/Order-**

Before modifying any of the items below, a future AI agent **must verify** that the change is backward-compatible with the Customer Panel. If a change in the Customer Panel is required, **do not assume it already exists** — document the required change instead (file name, reason, exact modification).

### Shared contracts that require cross-repo verification:

| Contract | Billing Panel file | Customer Panel file |
|----------|--------------------|---------------------|
| `pending_table_orders` document shape | `js/incoming-orders.js`, `js/cart.js` | `js/order.js`, `js/order-status.js` |
| Status values: `pending/accepted/kot/completed` | `js/cart.js`, `js/incoming-orders.js` | `js/order-status.js` |
| `customer_order_history/{uid}/orders` shape | `js/cart.js` | `js/history.js`, `js/order-status.js` |
| `customers/{phone}` document shape | `customer.html` | `js/auth.js` |
| `menu_items.inStock` field | `js/menu-management.js` | `js/menu.js` |
| Anonymous Firebase Auth pattern | `js/incoming-orders.js`, `js/admin.js` | `js/auth.js` |
| QR table ID format (`"Table N"`) | `js/tables.js`, `index.html` | `js/order.js` |
| `kotAt` field on `pending_table_orders` | `js/cart.js` | `js/order-status.js` |

### If a Customer Panel change is required, document:
1. **File name** in `teamdovolve-hue/Order-`
2. **Reason** the change is needed
3. **Exact modification** (show old code and new code)
4. Add to `AI_HANDOFF.md` under "Customer Panel Integration Status"

---

## 5. Database Contract

Schema changes require **explicit user approval**. Never rename collections, rename required fields, or remove fields without approval.

### Collections

#### `pending_table_orders` — Live orders from Customer Panel
```
{
  tableId:    string         // "Table 3" — must match QR table format exactly
  customer: {
    uid:      string         // Firebase anonymous UID
    name:     string         // Customer's display name
    phone:    string         // "+91XXXXXXXXXX"
  }
  status:     string         // "pending" | "accepted" | "kot" | "completed"
  items: [{
    itemId:   string
    name:     string
    price:    number
    quantity: number
    subtotal: number
  }]
  totalPrice: number
  createdAt:  Timestamp      // ServerTimestamp
  kotAt:      Timestamp      // ServerTimestamp — set when KOT printed (optional until KOT)
  completedAt:Timestamp      // ServerTimestamp — set on Bill & Settle / Save & Exit
}
```

#### `customers/{+91XXXXXXXXXX}` — Customer profiles
```
{
  name:          string      // Customer display name
  phone:         string      // "+91XXXXXXXXXX" (also the document ID)
  phoneVerified: boolean     // Always false in bridge mode (OTP bypassed)
  uid:           string      // Firebase anonymous UID (optional, set by Customer Panel)
}
```

#### `menu_items/{itemId}` — Menu catalog
```
{
  name:      string
  price:     number
  category:  string
  inStock:   boolean         // true or absent = available; false = out of stock
  imageUrl:  string          // Firebase Storage URL (optional)
  // Pizza variants include size in name, e.g. "Paneer Pizza (Large)"
}
```

#### `settings/pizza_sizes` — Pizza size availability flags
```
{
  regular: boolean
  medium:  boolean
  large:   boolean
}
```

#### `sales_history/{docId}` — Completed/billed orders
```
{
  tableId:      string
  items:        array
  total:        number
  billedAt:     Timestamp
  paymentMode:  string       // e.g. "cash", "upi"
  // Additional billing fields written by js/cart.js
}
```

#### `customer_order_history/{uid}/orders/{orderId}` — History (written by Billing, read by Customer)
```
{
  orderId:          string   // "ORDER_{timestamp}"
  tableId:          string   // "Table 3"
  customerName:     string
  customerPhone:    string   // "+91XXXXXXXXXX"
  items: [{
    name:     string
    price:    number
    quantity: number
    subtotal: number
  }]
  total:            number
  completedAt:      Timestamp
  completionReason: string   // "bill_settle" | "save_exit"
  orderedAt:        string   // ISO 8601 string
}
```

#### `daily_expenses/{docId}` — Expense tracking
```
{
  description: string
  amount:      number
  date:        Timestamp
  category:    string        // optional
}
```

#### `tables/{tableId}` — Table state
```
{
  tableId:  string           // "Table 3"
  status:   string           // "free" | "occupied"
  // Additional table state fields managed by js/tables.js
}
```

---

## 6. Public Interfaces

Future AI agents may improve implementations but **MUST NOT** change these interfaces or shared contracts without explicit approval.

### `js/firebase-config.js` — Shared Firebase exports
```js
export const db       // Firestore instance (offline persistence enabled)
export const storage  // Firebase Storage instance
export const auth     // Firebase Auth instance
export const functions // Cloud Functions instance (asia-south1) — unused, no billing
```
**Do not change the export names. All other modules import from this file.**

### `js/menu-management.js` — Menu management public API
```js
export function initMenuManagement()    // Called by admin.js when Menu tab is opened
export function destroyMenuManagement() // Called by admin.js when Menu tab is closed
```
These are called from `js/admin.js`. Changing their signatures breaks the admin panel.

### `js/cart.js` — Key internal functions (called cross-module)
```js
async function syncCustomerOrderCompletion(tableName, cartSnapshot, total, completionReason)
// Fire-and-forget. Called by Bill & Settle and Save & Exit.
// completionReason: "bill_settle" | "save_exit"
// Guard: returns immediately if activeCustomerUid_<tableName> is not in localStorage
// DO NOT make this function block the billing workflow
```

### `js/incoming-orders.js` — Incoming orders listener
```js
// Module auto-initializes on import (bootstraps signInAnonymously, starts onSnapshot)
// No public exports — the module manages its own DOM and Firestore lifecycle
// DO NOT add direct calls into this module from other modules
```

### `order-panel-updates/js/order-status.js` — Customer Panel bridge (staging)
```js
export function initOrderStatus()   // Called by Customer Panel app.js after login
export function stopOrderStatus()   // Called by Customer Panel app.js on logout
// This file is the source of truth for the bridge version.
// The live version in teamdovolve-hue/Order- must match this file.
```

### `sw.js` — Service Worker
```
Current cache version: v10
// If JS files are updated, bump the cache version string.
// Failure to do so causes the browser to serve stale cached JS.
// See memory: sw-stale-cache.md
// order-notify.js and notification.mp3 removed in session 9 (Pushover migration).
```

### `build.js` — Build-time key injection
```
Reads: process.env.GROQ_API_KEY
Writes: admin/groq-key.generated.js  (git-ignored)
// This file must run before serving the static site.
// The generated file exposes window.GROQ_API_KEY to the browser.
// Known tradeoff: key is visible in page source — accepted by owner (see replit.md).
```

### Realtime listener pattern (used by all modules)
All Firestore `onSnapshot` listeners follow this pattern:
1. Bootstrap `signInAnonymously()` at module top-level.
2. Start listener only after `onAuthStateChanged` confirms a signed-in user.
3. Store unsubscribe function; check if alive before recreating.
4. On error: set unsubscribe ref to `null`, schedule 5 s retry.

**Do not change this pattern. It prevents auth-race conditions that break all live listeners.**

---

## 7. AI Engineering Rules

Every future AI agent working on this repository MUST follow all of these rules:

1. **Read `ARCHITECTURE_LOCK.md` first** (this file), then `AI_HANDOFF.md`.

2. **Summarize the current architecture** in your internal reasoning before editing any code.

3. **Modify only the required files.** Do not touch files unrelated to the task.

4. **Never rewrite working code.** Fix the specific bug or add the specific feature.

5. **Never refactor stable systems.** Do not "clean up", "simplify", or "modernize" frozen systems.

6. **Never redesign working UI.** Do not change layout, colors, or component structure unless explicitly asked.

7. **Never rename Firestore collections.** Collection names are shared contracts — renaming breaks the Customer Panel immediately.

8. **Never rename shared status values.** The strings `"pending"`, `"accepted"`, `"kot"`, `"completed"` are read by both panels. Changing them breaks the Customer Panel's real-time tracking.

9. **Never introduce breaking changes.** If a change breaks backward compatibility, it is not acceptable.

10. **Treat the Billing Panel and Customer Panel as one connected production application.** A change here may require a change in `teamdovolve-hue/Order-`. Document it — do not guess.

11. **If another repository requires changes, document them** in `AI_HANDOFF.md` under "Customer Panel Integration Status". Never assume the Customer Panel already has a change.

12. **Before modifying any core workflow**, identify every Firestore collection, every status value, and every other module that depends on it.

13. **If uncertain, preserve the existing implementation.** The cost of an outage is higher than the cost of asking.

14. **The `syncCustomerOrderCompletion()` function must remain fire-and-forget.** The billing operator must never wait on Customer Panel sync. If the sync fails, billing must still succeed.

15. **Auth bootstrapping is mandatory.** Any new module that reads from or writes to Firestore must call `signInAnonymously()` at module top-level and gate all Firestore operations behind `onAuthStateChanged`.

---

## 8. Regression Checklist

Before considering any task complete, verify every item on this list:

| Feature | What to verify |
|---------|---------------|
| ✓ Admin Login | PIN 1414 accepts, dashboard loads, session persists across browser restart (localStorage) |
| ✓ Incoming Orders | Customer orders appear in the drawer in real time; badge count is correct |
| ✓ Manual Billing | Operator can add items manually, calculate totals, and settle without a customer order |
| ✓ Walk-in Orders | Walk-in flow works independently of Customer Panel; no Firestore writes to customer history |
| ✓ Menu Management | Menu tab loads without flicker; items appear grouped; category pills filter correctly |
| ✓ Out of Stock Synchronization | Toggling `inStock` in admin panel reflects on Customer Panel within seconds |
| ✓ Customer Order Synchronization | Customer Panel orders appear in Billing Panel; operator can open them in POS |
| ✓ KOT | KOT prints, `status` updates to `"kot"`, `kotAt` timestamp is set |
| ✓ Preparing Status | Customer Panel shows "Preparing 🍕 • X min" with ticking timer after KOT |
| ✓ Live Timer | Timer increments on Customer Panel without Firestore reads |
| ✓ Save & Exit | Order saved, table freed, `syncCustomerOrderCompletion` fires |
| ✓ Bill & Settle | Order billed, settled, `syncCustomerOrderCompletion` fires |
| ✓ Billing Calculations | Subtotals, taxes, discounts, and final total are correct |
| ✓ Customer Order History | After Bill & Settle / Save & Exit, order appears in Customer Panel history tab |
| ✓ Realtime Updates | All `onSnapshot` listeners continue working without page reload after any operation |
| ✓ Customer Panel Compatibility | No shared Firestore field or status value was changed |

**If any item fails, the implementation is NOT complete.**

---

## 9. Documentation Rules

After every implementation session, before marking the task complete:

1. **Update `AI_HANDOFF.md`** — add a "Features Completed" or "Bugs Fixed" section for the session.
2. **Update `ARCHITECTURE_LOCK.md`** — only if architecture genuinely changed (new collection, new public interface, new frozen system). Do not add implementation details here.
3. **Add a comment in every modified file** with format:
   ```js
   // AI UPDATE [YYYY-MM-DD]: <what changed and why>
   ```
4. Document in `AI_HANDOFF.md`:
   - Files modified (table: File | Repo | Change)
   - Root cause of any bug fixed
   - What changed
   - Remaining known issues
   - Customer Panel changes required (if any), with file path and exact modification

---

## 10. Important

This document is the **permanent source of truth** for all future AI agents.

**The objective:** Keep the Billing Panel architecture stable while allowing only small, isolated, backward-compatible improvements.

**The rule:** Extend the existing architecture. Do not replace it.

**The test:** If a change risks breaking compatibility with the Customer Panel at `https://github.com/teamdovolve-hue/Order-`, document it first. Implement only after explicit user approval.

**When in doubt:** Preserve the existing implementation and ask the user.
