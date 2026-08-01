/**
 * firebase-config.js  — Customer Panel (teamdovolve-hue/Order-)
 * ─────────────────────────────────────────────────────────────
 * Firebase initialisation — exports db, auth, and functions.
 *
 * AI UPDATE [2026-08-01] Architecture migration:
 *   Added functions.customDomain so httpsCallable routes through the Cloudflare
 *   Worker (pizza-billing-functions.mishrarnav142.workers.dev) instead of real
 *   Firebase Cloud Functions (which don't exist on the Spark / no-billing plan).
 *   This is required for the notification trigger added to order.js — without
 *   customDomain, httpsCallable('notifyOrder') would fail with a network error.
 *
 * DEPLOY NOTE: Replace js/firebase-config.js in teamdovolve-hue/Order- with this file.
 */

import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore }   from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFunctions }   from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";

const firebaseConfig = {
  apiKey:            "AIzaSyBLzGd0DlItKShk0eJoQR4CjRx1sP3-o-w",
  authDomain:        "billing-system-f8531.firebaseapp.com",
  projectId:         "billing-system-f8531",
  storageBucket:     "billing-system-f8531.firebasestorage.app",
  messagingSenderId: "921228841270",
  appId:             "1:921228841270:web:9013d59b3ef96dda40e397",
  measurementId:     "G-JMPEJCCBHZ",
};

const app = initializeApp(firebaseConfig);

export const db        = getFirestore(app);
export const auth      = getAuth(app);
export const functions = getFunctions(app, "asia-south1");

// AI UPDATE [2026-08-01]: Route httpsCallable through the Cloudflare Worker.
// Required for notifyOrder — Firebase Cloud Functions are not enabled on Spark plan.
functions.customDomain = "https://pizza-billing-functions.mishrarnav142.workers.dev";
