# Pizza Hut Billing System

A browser-based POS and billing system for "New Pizza Hut & Live Cake". Built with vanilla HTML/CSS/JS, backed by Firebase (Firestore + Storage).

## Pages

- `/index.html` — Main billing dashboard (Dine-In, Takeaway, Quick Sale, Expenses)
- `/admin/index.html` — Admin panel (sales reports, menu management)
- `/expense.html` — Expense tracker
- `/upload-menu.html` — Menu item uploader (connects to Firebase Storage)

## How to run

The workflow `Start application` runs:

```
node server.js
```

`server.js` is an Express server that:
1. Injects the `GROQ_API_KEY` secret into `admin/groq-key.generated.js` at startup (previously done by `build.js`).
2. Exposes `POST /api/notify-order` — a server-side Pushover notification proxy.
3. Serves all static project files from the root directory.

`build.js` is no longer used and can be ignored.

## AI Chat (Smart AI Manager)

- Provider: **Groq** (`GROQ_API_KEY` secret), not Gemini — switched because Gemini's free tier only allows 20 requests/day.
- Primary model: `llama-3.3-70b-versatile` (1,000 req/day free limit, better quality).
- Fallback model: `llama-3.1-8b-instant` (14,400 req/day free limit) — `admin/chat.ai.html` automatically retries with this model if the primary hits a 429.
- The AI always reports one combined sales total; it never distinguishes Table vs Quick Sale in its responses (the underlying billing feature itself is unchanged, this only affects AI reporting).
- **Architecture note (deliberate tradeoff):** there is no server proxy. `admin/chat.ai.html` calls Groq directly from the browser using `window.GROQ_API_KEY`, which `build.js` injects at build/publish time from the `GROQ_API_KEY` secret into the git-ignored `admin/groq-key.generated.js`. This means the key is visible to anyone who views the published page's source — accepted deliberately because (a) this project uses a **Static** deployment, which is free forever with no 30-day expiry (unlike the free Autoscale app, which expires after 30 days and then needs a paid plan), and (b) the owner considers the key low-risk/easily rotated. If this tradeoff ever changes, reintroducing a small server proxy (there's a git history of one) restores key secrecy but requires Autoscale/VM hosting instead of Static.

## Firebase

Firebase credentials are in `js/firebase-config.js`. The project uses:
- **Firestore** — bills, menu items, tables, expenses
- **Firebase Storage** — menu item images

No Firebase credentials need to be added to Replit secrets; they are already in the config file.

## Menu Management (Admin)

Inside the **Incoming Orders** drawer there is now a **📋 Menu** tab alongside the existing 🔔 Orders tab.

- **Real-time list** — all `menu_items` documents, grouped by category, with name and price
- **Search bar** — filter items by name instantly
- **Category pills** — filter by category
- **ON/OFF toggle** per item — writes `inStock: true/false` to Firestore
- **Optimistic UI** — toggle flips immediately; rolls back if the write fails
- **Live stats** — each category header shows item count and how many are currently off

`js/menu-management.js` owns this feature; it is lazy-loaded on first tab open.

### Availability field: `inStock`

The canonical field is `inStock` (boolean) on each `menu_items` document:
- `true` or absent → available (shown normally to customers)
- `false` → out of stock (shown greyed-out with "Out of Stock" label, not orderable)

`customer.html` now uses `onSnapshot` (real-time) so changes appear on the customer screen within seconds of toggling in the admin panel.

### GitHub customer-panel repo change needed

The separate repo at `teamdovolve-hue/Order-` has its own `js/menu.js` that filters items using the `available` field:
```js
.filter((item) => item.available !== false)
```
Change `available` → `inStock` in that line so it respects the same field this admin toggle writes to:
```js
.filter((item) => item.inStock !== false)
```
Only that one line in `js/menu.js` needs to change.

## Pushover Notifications

When a genuinely new customer order arrives in the Incoming Orders drawer, `js/incoming-orders.js` calls `POST /api/notify-order` on the Express server. The server forwards a push notification to the operator's phone via the [Pushover](https://pushover.net) API. Credentials are stored in `server.js`.

Notifications are NOT triggered for:
- Orders that already exist when the page first loads.
- Firestore reconnects or listener restarts.

## Stack

- HTML / CSS / Vanilla JS (ES modules via CDN)
- Firebase JS SDK v10 (loaded via CDN)
- Express.js (Node 20) — backend server + Pushover proxy
- PWA-ready (manifest.json + service worker)

## User preferences

- Keep the existing file structure and stack (no frameworks, no build step)

## Housekeeping notes

- Removed unused files that weren't referenced anywhere: root `script.js` (superseded by the modular `js/*.js` files), `qr.png`, and `attached_assets/` (dev screenshots).
- Fixed root `manifest.json` — it pointed at a non-existent `admin-logo.png` (that file only exists under `admin/`), causing a 404 on every page load. Now points at `pos-logo.png` with correct app name.
- `GROQ_API_KEY` secret is set; the AI chat (`admin/chat.ai.html`) already uses Groq (`llama-3.3-70b-versatile` primary, `llama-3.1-8b-instant` fallback) — no Gemini code remains in the app.
