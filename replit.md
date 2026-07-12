# Pizza Hut Billing System

A browser-based POS and billing system for "New Pizza Hut & Live Cake". Built with vanilla HTML/CSS/JS, backed by Firebase (Firestore + Storage).

## Pages

- `/index.html` — Main billing dashboard (Dine-In, Takeaway, Quick Sale, Expenses)
- `/admin/index.html` — Admin panel (sales reports, menu management)
- `/expense.html` — Expense tracker
- `/upload-menu.html` — Menu item uploader (connects to Firebase Storage)

## How to run

The workflow `Start application` serves the project with `serve` (static file server) on port 5000:

```
npx serve . -l 5000
```

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
