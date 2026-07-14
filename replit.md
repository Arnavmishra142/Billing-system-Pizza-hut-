# Pizza Hut Billing System

A browser-based POS and billing system for "New Pizza Hut & Live Cake". Built with vanilla HTML/CSS/JS, backed by Firebase (Firestore + Storage).

## Pages

- `/index.html` — Main billing dashboard (Dine-In, Takeaway, Quick Sale, Expenses)
- `/admin/index.html` — Admin panel (sales reports, menu management)
- `/expense.html` — Expense tracker
- `/upload-menu.html` — Menu item uploader (connects to Firebase Storage)

## How to run

The workflow `Start application` runs a small Node/Express server (`server.js`) on port 5000:

```
node server.js
```

It serves the static site files and also exposes `POST /api/chat`, which proxies the admin panel's Smart AI Manager chat to Groq. This exists so `GROQ_API_KEY` stays server-side and is never sent to the browser.

## AI Chat (Smart AI Manager)

- Provider: **Groq** (`GROQ_API_KEY` secret), not Gemini — switched because Gemini's free tier only allows 20 requests/day.
- Primary model: `llama-3.3-70b-versatile` (1,000 req/day free limit, better quality).
- Fallback model: `llama-3.1-8b-instant` (14,400 req/day free limit) — `server.js` automatically retries with this model if the primary hits a 429.
- The AI always reports one combined sales total; it never distinguishes Table vs Quick Sale in its responses (the underlying billing feature itself is unchanged, this only affects AI reporting).
- `admin/chat.ai.html` calls `/api/chat` with `{ prompt }` and reads back `{ reply, model }` — no API key or model logic lives client-side anymore.

## Firebase

Firebase credentials are in `js/firebase-config.js`. The project uses:
- **Firestore** — bills, menu items, tables, expenses
- **Firebase Storage** — menu item images

No Firebase credentials need to be added to Replit secrets; they are already in the config file.

## Stack

- HTML / CSS / Vanilla JS (ES modules via CDN)
- Firebase JS SDK v10 (loaded via CDN)
- PWA-ready (manifest.json + service worker)

## User preferences

- Keep the existing file structure and stack (no frameworks, no build step)
