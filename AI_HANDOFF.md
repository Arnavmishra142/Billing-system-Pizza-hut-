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

---

## Bugs Fixed 🐛

| Date | Bug | Fix |
|------|-----|-----|
| Previous | Admin PIN login broken (`auth/operation-not-allowed` blocked dashboard) | Decoupled login from Firebase Auth; auth runs in background |
| Previous | PWA serving stale JS | Bumped `sw.js` cache version v7→v8 |
| Previous | Order panel calling Cloud Functions (fails without billing) | Rewrote `auth.js` + `order.js` in `order-panel-updates/` to use direct Firestore |
| 2026-07-28 | Incoming Orders not appearing in Billing Panel | Fixed auth race in `incoming-orders.js` — now waits for `onAuthStateChanged` |
| 2026-07-28 | Menu Management toggle failing with "Could not update…" | Added `auth.currentUser` guard in `menu-management.js` before `updateDoc`/`setDoc` |

---

## Features Pending / Known Issues ⚠️

### CRITICAL — Order Panel (teamdovolve-hue/Order-) Not Updated
The rewritten bridge files have NOT been pushed to GitHub yet:
- `order-panel-updates/js/auth.js` → must replace `js/auth.js` in the Order- repo
- `order-panel-updates/js/order.js` → must replace `js/order.js` in the Order- repo

**Until these are pushed, the Netlify-hosted Order Panel still calls Cloud Functions and shows "Login service error: internal".** The `customer.html` in this repo works correctly.

### How to push:
1. Go to https://github.com/teamdovolve-hue/Order-/edit/main/js/auth.js → paste content of `order-panel-updates/js/auth.js` → Commit
2. Go to https://github.com/teamdovolve-hue/Order-/edit/main/js/order.js → paste content of `order-panel-updates/js/order.js` → Commit

### Other pending items:
- `order-status.js` in Order Panel reads `customer_table_sessions` — in bridge mode this collection is never written (no Cloud Functions), so order tracking tab shows nothing
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
