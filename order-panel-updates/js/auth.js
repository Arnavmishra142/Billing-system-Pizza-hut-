/**
 * auth.js  — BRIDGE BUILD (no Cloud Functions)
 * ─────────────────────────────────────────────────────────────
 * Customer authentication via direct Firestore reads/writes.
 * Cloud Function (customerAuth) is intentionally bypassed while
 * Firebase billing / Fast2SMS DLT approval is pending.
 *
 * Flow (unchanged UX):
 *   Phone → lookup customers/{+91…} in Firestore
 *     found  → signInAnonymously → session saved → login complete
 *     not found → name step → confirm step → setDoc → login complete
 *
 * All accounts are created with phoneVerified: false.
 * When Fast2SMS DLT is approved and Cloud Functions are restored:
 *   1. Restore customerAuth callable calls in _onPhoneSubmit and _onCreateAccount
 *   2. Restore signInWithCustomToken calls
 *   3. Remove direct Firestore read/write blocks marked "BRIDGE"
 *   4. No DB migration needed — phoneVerified field is already present
 *
 * Public API (unchanged — app.js / customer.js / order.js see the same surface):
 *   initAuth()         — wire DOM events, start onAuthStateChanged
 *   requireLogin(cb)   — ensure session, then call cb()
 *   isLoggedIn()       — true if session exists in localStorage
 *   getLoginInfo()     — { name, phone, uid } | null
 *   waitForAuthReady() — Promise resolving when Firebase Auth state is known
 *   onAuthReady(cb)    — call cb with locally cached session
 *   updateGreeting()   — refresh customer chip in header
 */

import { auth, db }      from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInAnonymously,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ── One-time cleanup: purge old localStorage-based login data ────────────────
const _OLD_KEYS = ["qrmenu_login", "qrmenu_moved_to_history", "qrmenu_orders"];
_OLD_KEYS.forEach((k) => {
  if (localStorage.getItem(k) !== null) {
    localStorage.removeItem(k);
    console.info("[auth] Removed legacy key:", k);
  }
});

// ── Session storage key ───────────────────────────────────────────────────────
const SESSION_KEY = "qrmenu_user"; // stores { name, phone, uid }

// ── Module state ──────────────────────────────────────────────────────────────
let _currentUser         = _loadSession();  // { name, phone, uid } | null
let _pendingCb           = null;            // callback to run after login
let _pendingPhone        = "";              // normalised +91… phone across steps
let _pendingName         = "";
let _firebaseUser        = null;
let _authReadyResolve;
const _authReady         = new Promise((resolve) => { _authReadyResolve = resolve; });

// ── Public API ────────────────────────────────────────────────────────────────

export function isAuthReady() { return true; }

export function waitForAuthReady() {
  return _authReady;
}

export function isLoggedIn() { return !!_currentUser; }

export function getLoginInfo() {
  if (!_currentUser) return null;
  return {
    ..._currentUser,
    uid: _firebaseUser?.uid || _currentUser.uid || "",
  };
}

export function requireLogin(cb) {
  if (_currentUser) {
    _ensureFirebaseSession()
      .then(() => cb())
      .catch((err) => {
        console.error("[auth] Firebase session restore failed:", err);
        _currentUser = null;
        _saveSession(null);
        _showModal();
      });
    return;
  }
  _pendingCb = cb;
  _showModal();
}

export function initAuth() {
  document.getElementById("otpPhoneForm")
    ?.addEventListener("submit", _onPhoneSubmit);
  document.getElementById("otpProfileForm")
    ?.addEventListener("submit", _onProfileSubmit);
  document.getElementById("otpChangeDetails")
    ?.addEventListener("click", _showProfileStep);
  document.getElementById("otpCreateAccountBtn")
    ?.addEventListener("click", _onCreateAccount);
  document.getElementById("headerLogoutBtn")
    ?.addEventListener("click", _onLogout);

  onAuthStateChanged(auth, (user) => {
    _firebaseUser = user;
    _authReadyResolve(user);
    if (!user && _currentUser) {
      // Firebase session expired but local session exists — re-auth silently
      signInAnonymously(auth).catch(() => {});
    } else if (user && _currentUser) {
      _dispatchAuthChange(_currentUser);
    }
  });
  _updateGreeting();
}

export function onAuthReady(cb) {
  cb(_currentUser);
}

export function updateGreeting() { _updateGreeting(); }

// ── Modal lifecycle ───────────────────────────────────────────────────────────

function _showModal() {
  const modal = document.getElementById("otpModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  _showPhoneStep();
}

function _hideModal() {
  document.getElementById("otpModal")?.classList.add("hidden");
  document.body.style.overflow = "";
}

function _showPhoneStep() {
  document.getElementById("otpPhoneStep")?.classList.remove("hidden");
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  _clearError("otpNameError");
  _clearError("otpPhoneError");
  document.getElementById("otpPhoneInput")?.focus();
}

function _showProfileStep() {
  document.getElementById("otpPhoneStep")?.classList.add("hidden");
  document.getElementById("otpProfileStep")?.classList.remove("hidden");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  _clearError("otpNameError");
  const nameInput = document.getElementById("otpNameInput");
  if (nameInput) nameInput.value = "";
  nameInput?.focus();
}

// ── Step 1: Phone lookup ──────────────────────────────────────────────────────
// BRIDGE: reads Firestore directly instead of calling customerAuth Cloud Fn.
// When Cloud Functions are restored, replace the getDoc block with:
//   const customerAuth = httpsCallable(functions, "customerAuth");
//   const result = await customerAuth({ action: "lookup", phone: `+91${phone}` });
//   const profile = result.data || {};
//   if (profile.found) {
//     await signInWithCustomToken(auth, profile.token);
//     await _completeLogin(profile.name, profile.phone || `+91${phone}`);
//   } else { _pendingPhone = profile.phone || `+91${phone}`; _showProfileStep(); }

async function _onPhoneSubmit(e) {
  e.preventDefault();
  _clearError("otpPhoneError");

  const raw   = document.getElementById("otpPhoneInput")?.value || "";
  const phone = raw.replace(/\D/g, "");
  if (phone.length !== 10) {
    _setError("otpPhoneError", "Enter a valid 10-digit mobile number.");
    return;
  }

  const normalised = `+91${phone}`;
  _pendingPhone = normalised;
  _setLoadingBtn("otpSendBtn", true, "Checking…");

  try {
    // BRIDGE: ensure anonymous Firebase Auth UID before Firestore read
    if (!_firebaseUser) {
      await signInAnonymously(auth);
    }

    // BRIDGE: direct Firestore lookup
    const snap = await getDoc(doc(db, "customers", normalised));

    if (snap.exists()) {
      const profile = snap.data();
      await _completeLogin(profile.name || "Customer", profile.phone || normalised);
    } else {
      _showProfileStep();
    }
  } catch (err) {
    console.error("[auth] Phone lookup failed:", err);
    _setError(
      "otpPhoneError",
      err.code === "permission-denied"
        ? "Permission denied. Please ask restaurant staff for help."
        : "Could not check your number. Please check your connection and try again."
    );
  } finally {
    _setLoadingBtn("otpSendBtn", false, "Continue");
  }
}

// ── Step 2: Collect name ──────────────────────────────────────────────────────

async function _onProfileSubmit(e) {
  e.preventDefault();
  _clearError("otpNameError");

  const name = (document.getElementById("otpNameInput")?.value || "").trim();
  if (name.length < 2) {
    _setError("otpNameError", "Please enter your name.");
    document.getElementById("otpNameInput")?.focus();
    return;
  }
  if (!_pendingPhone) {
    _setError("otpNameError", "Session expired. Please enter your phone again.");
    _showPhoneStep();
    return;
  }

  _pendingName = name;
  const confirmName  = document.getElementById("otpConfirmName");
  const confirmPhone = document.getElementById("otpConfirmPhone");
  if (confirmName)  confirmName.textContent  = name;
  if (confirmPhone) confirmPhone.textContent = _formatPhone(_pendingPhone);
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpConfirmStep")?.classList.remove("hidden");
}

// ── Step 3: Create account ────────────────────────────────────────────────────
// BRIDGE: writes Firestore directly instead of calling customerAuth Cloud Fn.
// When Cloud Functions are restored, replace the setDoc block with:
//   const customerAuth = httpsCallable(functions, "customerAuth");
//   const result = await customerAuth({ action: "create", phone: _pendingPhone, name: _pendingName });
//   await signInWithCustomToken(auth, result.data.token);
//   await _completeLogin(result.data.name || _pendingName, result.data.phone || _pendingPhone);

async function _onCreateAccount() {
  _clearError("otpNameError");
  if (!_pendingName || !_pendingPhone) {
    _showPhoneStep();
    return;
  }
  _setLoadingBtn("otpCreateAccountBtn", true, "Creating…");

  try {
    if (!_firebaseUser) {
      await signInAnonymously(auth);
    }

    const uid = auth.currentUser?.uid || "";
    const now = serverTimestamp();

    // BRIDGE: write customer profile directly to Firestore.
    // phoneVerified: false — ready for OTP gate when Fast2SMS DLT is approved.
    // DO NOT change to true here; only OTP verification should set this.
    await setDoc(doc(db, "customers", _pendingPhone), {
      phone:         _pendingPhone,
      name:          _pendingName,
      authUid:       uid,
      phoneVerified: false,
      createdAt:     now,
      updatedAt:     now,
      lastLoginAt:   now,
    });

    await _completeLogin(_pendingName, _pendingPhone);
  } catch (err) {
    console.error("[auth] Account creation failed:", err);
    _setError(
      "otpNameError",
      err.code === "permission-denied"
        ? "Permission denied. Please ask restaurant staff for help."
        : "Account creation failed. Please check your connection and try again."
    );
    document.getElementById("otpConfirmStep")?.classList.add("hidden");
    document.getElementById("otpProfileStep")?.classList.remove("hidden");
  } finally {
    _setLoadingBtn("otpCreateAccountBtn", false, "Create Account");
  }
}

// ── Complete login (shared by all sign-in paths) ──────────────────────────────

async function _completeLogin(name, phone) {
  // Ensure Firebase anonymous session exists
  if (!_firebaseUser) {
    await signInAnonymously(auth);
  }
  _currentUser = { name, phone, uid: auth.currentUser?.uid || "" };
  _saveSession(_currentUser);
  _updateGreeting();
  _dispatchAuthChange(_currentUser);
  _hideModal();

  // Update lastLoginAt non-critically
  if (phone) {
    setDoc(doc(db, "customers", phone), { lastLoginAt: serverTimestamp() }, { merge: true })
      .catch(() => {});
  }

  const cb = _pendingCb;
  _pendingCb    = null;
  _pendingPhone = "";
  _pendingName  = "";
  if (cb) cb();
}

// ── Ensure Firebase session on page reload ────────────────────────────────────
// BRIDGE: uses signInAnonymously instead of calling customerAuth to get a token.

async function _ensureFirebaseSession() {
  await _authReady;
  if (auth.currentUser) return auth.currentUser;
  await signInAnonymously(auth);
  return auth.currentUser;
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function _onLogout() {
  if (!confirm("Log out? You'll need to enter your phone number again before placing the next order.")) return;
  _currentUser  = null;
  _pendingPhone = "";
  _pendingName  = "";
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem("qrmenu_history");
  localStorage.removeItem("qrmenu_moved_to_history");
  await signOut(auth).catch(() => {});
  _dispatchAuthChange(null);
  location.reload();
}

// ── Custom auth-state event ───────────────────────────────────────────────────

function _dispatchAuthChange(user) {
  window.dispatchEvent(new CustomEvent("customAuthStateChanged", { detail: { user } }));
}

// ── Greeting chip ─────────────────────────────────────────────────────────────

function _updateGreeting() {
  const chip      = document.getElementById("customerChip");
  const logoutBtn = document.getElementById("headerLogoutBtn");
  if (_currentUser?.name) {
    if (chip) { chip.textContent = `👤 ${_currentUser.name}`; chip.classList.remove("hidden"); }
    logoutBtn?.classList.remove("hidden");
  } else {
    chip?.classList.add("hidden");
    logoutBtn?.classList.add("hidden");
  }
}

// ── Session helpers ───────────────────────────────────────────────────────────

function _loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (_) { return null; }
}
function _saveSession(user) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); } catch (_) {}
}
function _formatPhone(phone) {
  const digits = String(phone || "").replace(/^\+91/, "");
  return `+91 ${digits}`;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function _setError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}
function _clearError(id) {
  const el = document.getElementById(id);
  if (el) { el.textContent = ""; el.classList.add("hidden"); }
}
function _setLoadingBtn(id, loading, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled    = loading;
  btn.textContent = text;
}
