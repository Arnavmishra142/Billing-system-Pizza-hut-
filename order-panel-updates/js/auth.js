/**
 * auth.js  — BRIDGE BUILD (no Cloud Functions)
 * ─────────────────────────────────────────────────────────────
 * Customer authentication via direct Firestore reads/writes.
 * Cloud Function (customerAuth) is intentionally bypassed while
 * Firebase billing / Fast2SMS DLT approval is pending.
 *
 * Flow (session 21 — password + username):
 *   Phone → lookup customers/{+91…} in Firestore
 *     found + passwordHash  → login step (password verification)
 *     found + no passwordHash → registration step (password migration)
 *     not found             → registration step (new account)
 *
 * Registration collects: Full Name, @username (auto-generated, editable),
 * Password (×2). Username uniqueness is enforced via usernames/{username}.
 *
 * Password storage: SHA-256(password + ":" + phone). Client-side hash.
 * Acceptable for a local restaurant POS (owner accepted the tradeoff;
 * easily rotated, no financial data exposed).
 *
 * Session key: "qrmenu_user" — { name, phone, uid, username }
 * Previously only stored name/phone/uid; username added in session 21.
 *
 * OTP readiness:
 *   When Fast2SMS DLT is approved and Cloud Functions are restored:
 *   1. Restore customerAuth callable calls in _onPhoneSubmit and _onCreateAccount
 *   2. Restore signInWithCustomToken calls
 *   3. Remove direct Firestore read/write blocks marked "BRIDGE"
 *   4. No DB migration needed — passwordHash + phoneVerified fields already present
 *
 * Public API (unchanged — app.js / customer.js / order.js see the same surface):
 *   initAuth()         — wire DOM events, start onAuthStateChanged
 *   requireLogin(cb)   — ensure session, then call cb()
 *   isLoggedIn()       — true if session exists in localStorage
 *   getLoginInfo()     — { name, phone, uid, username } | null
 *   waitForAuthReady() — Promise resolving when Firebase Auth state is known
 *   onAuthReady(cb)    — call cb with locally cached session
 *   updateGreeting()   — refresh customer chip in header
 *
 * ─────────────────────────────────────────────────────────────
 * CUSTOMER PANEL HTML CHANGES REQUIRED (teamdovolve-hue/Order-)
 * ─────────────────────────────────────────────────────────────
 * The following DOM elements must be added to the otpModal in index.html:
 *
 * 1. NEW LOGIN STEP — add inside #otpModal after #otpPhoneStep:
 *    <div id="otpLoginStep" class="hidden">
 *      <p id="otpLoginName"></p>          <!-- "Welcome back, {name}!" -->
 *      <p id="otpLoginPhone"></p>         <!-- phone display -->
 *      <div id="otpLoginError" class="hidden"></div>
 *      <input id="otpLoginPasswordInput" type="password" placeholder="Your password">
 *      <button type="button" id="otpLoginToggleBtn">Show</button>
 *      <button id="otpLoginBtn">Login</button>
 *    </div>
 *
 * 2. EXPAND #otpProfileStep — add username + password fields after #otpNameInput:
 *    <div class="username-row">
 *      <span>@</span>
 *      <input id="otpUsernameInput" type="text" maxlength="20"
 *             placeholder="username" autocomplete="off">
 *    </div>
 *    <div id="otpUsernameStatus"></div>
 *    <input id="otpPasswordInput2" type="password"
 *           placeholder="Create a password (min 6 chars)">
 *    <input id="otpPasswordConfirm" type="password"
 *           placeholder="Confirm password">
 *
 * 3. EXPAND #otpConfirmStep — add username to the confirmation summary:
 *    <span id="otpConfirmUsername"></span>
 *
 * AI UPDATE [2026-07-29] session 21:
 *   Added password-based authentication and username system.
 *   hashPassword(), generateUsername(), username availability check.
 *   _onPhoneSubmit: branches to login vs register based on passwordHash.
 *   New _showLoginStep() / _onLoginSubmit() for returning customers.
 *   _onProfileSubmit(): now collects username + password + confirm.
 *   _onCreateAccount(): writes username to usernames/{username} + passwordHash.
 *   _completeLogin(): username added to session.
 *   Session username persists across reloads via localStorage.
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
const SESSION_KEY = "qrmenu_user"; // { name, phone, uid, username }

// ── Module state ──────────────────────────────────────────────────────────────
let _currentUser         = _loadSession();  // { name, phone, uid, username } | null
let _pendingCb           = null;            // callback to run after login
let _pendingPhone        = "";              // normalised +91… phone across steps
let _pendingName         = "";
let _pendingLoginProfile = null;            // Firestore profile for login step
let _usernameCheckTimer  = null;
let _usernameAvailable   = false;
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
  // Return stable stored uid and username as-is.
  // Do NOT override uid with _firebaseUser.uid — the anonymous auth uid
  // may differ after session reset; the stored profile uid is canonical.
  return { ..._currentUser };
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

  // Profile form (registration step) — includes username + password now
  document.getElementById("otpProfileForm")
    ?.addEventListener("submit", _onProfileSubmit);

  document.getElementById("otpChangeDetails")
    ?.addEventListener("click", _showProfileStep);

  document.getElementById("otpCreateAccountBtn")
    ?.addEventListener("click", _onCreateAccount);

  document.getElementById("headerLogoutBtn")
    ?.addEventListener("click", _onLogout);

  // Login step buttons (new in session 21)
  document.getElementById("otpLoginBtn")
    ?.addEventListener("click", _onLoginSubmit);

  // Username input: live availability check
  document.getElementById("otpUsernameInput")
    ?.addEventListener("input", _onUsernameInput);

  // Name input: auto-generate username
  document.getElementById("otpNameInput")
    ?.addEventListener("input", _onNameInput);

  // Password toggle button in login step
  document.getElementById("otpLoginToggleBtn")
    ?.addEventListener("click", () => {
      const inp = document.getElementById("otpLoginPasswordInput");
      if (!inp) return;
      inp.type = inp.type === "password" ? "text" : "password";
    });

  onAuthStateChanged(auth, (user) => {
    _firebaseUser = user;
    _authReadyResolve(user);
    if (!user && _currentUser) {
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
  document.getElementById("otpLoginStep")?.classList.add("hidden");
  _clearError("otpNameError");
  _clearError("otpPhoneError");
  _clearError("otpLoginError");
  document.getElementById("otpPhoneInput")?.focus();
}

function _showLoginStep() {
  document.getElementById("otpPhoneStep")?.classList.add("hidden");
  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  document.getElementById("otpLoginStep")?.classList.remove("hidden");
  _clearError("otpLoginError");

  // Show customer's name so they know whose account this is
  const nameEl  = document.getElementById("otpLoginName");
  const phoneEl = document.getElementById("otpLoginPhone");
  if (nameEl)  nameEl.textContent  = `Welcome back, ${_pendingLoginProfile?.name || ""}! 👋`;
  if (phoneEl) phoneEl.textContent = _pendingPhone;

  const passInput = document.getElementById("otpLoginPasswordInput");
  if (passInput) { passInput.value = ""; passInput.focus(); }
}

function _showProfileStep() {
  document.getElementById("otpPhoneStep")?.classList.add("hidden");
  document.getElementById("otpProfileStep")?.classList.remove("hidden");
  document.getElementById("otpConfirmStep")?.classList.add("hidden");
  document.getElementById("otpLoginStep")?.classList.add("hidden");
  _clearError("otpNameError");

  const nameInput = document.getElementById("otpNameInput");
  if (nameInput) nameInput.value = "";
  const usernameInput = document.getElementById("otpUsernameInput");
  if (usernameInput) usernameInput.value = "";
  const passInput = document.getElementById("otpPasswordInput2");
  if (passInput) passInput.value = "";
  const confirmInput = document.getElementById("otpPasswordConfirm");
  if (confirmInput) confirmInput.value = "";
  const statusEl = document.getElementById("otpUsernameStatus");
  if (statusEl) statusEl.textContent = "";
  _usernameAvailable = false;

  nameInput?.focus();
}

// ── Step 1: Phone lookup ──────────────────────────────────────────────────────
// BRIDGE: reads Firestore directly instead of calling customerAuth Cloud Fn.

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
    if (!_firebaseUser) {
      await signInAnonymously(auth);
    }

    // BRIDGE: direct Firestore lookup
    const snap = await getDoc(doc(db, "customers", normalised));

    if (snap.exists()) {
      const profile = snap.data();

      if (!profile.passwordHash) {
        // Old account without password (pre-session-21) — treat as new registration.
        // This migrates old accounts into the new password-based system.
        _pendingLoginProfile = null;
        _showProfileStep();
      } else {
        // Returning customer with password → login step
        _pendingLoginProfile = profile;
        _showLoginStep();
      }
    } else {
      // New customer → registration
      _pendingLoginProfile = null;
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

// ── Step 2a: Login (returning customer, password) ─────────────────────────────

async function _onLoginSubmit() {
  _clearError("otpLoginError");

  const passEl = document.getElementById("otpLoginPasswordInput");
  const password = passEl?.value || "";
  if (!password) {
    _setError("otpLoginError", "Please enter your password.");
    return;
  }

  _setLoadingBtn("otpLoginBtn", true, "Logging in…");

  try {
    const hash = await _hashPassword(password, _pendingPhone);

    if (hash !== _pendingLoginProfile.passwordHash) {
      _setError("otpLoginError", "Incorrect password. Please try again.");
      if (passEl) { passEl.value = ""; passEl.focus(); }
      return;
    }

    // Password correct — use stable stored uid (not auth.currentUser.uid)
    const p         = _pendingLoginProfile;
    const storedUid = p.uid || p.authUid || "";
    await _completeLogin(p.name || "Customer", p.phone || _pendingPhone, storedUid, p.username || "");

  } catch (err) {
    console.error("[auth] Login failed:", err);
    _setError("otpLoginError", "Login failed. Please check your connection.");
  } finally {
    _setLoadingBtn("otpLoginBtn", false, "Login");
  }
}

// ── Step 2b: Collect name + username + password ───────────────────────────────

function _onNameInput(e) {
  const name = (e.target?.value || "").trim();
  if (name.length >= 2) {
    const generated = _generateUsername(name);
    const usernameInput = document.getElementById("otpUsernameInput");
    if (usernameInput) usernameInput.value = generated;
    _scheduleUsernameCheck(generated);
  } else {
    clearTimeout(_usernameCheckTimer);
    const usernameInput = document.getElementById("otpUsernameInput");
    if (usernameInput) usernameInput.value = "";
    const statusEl = document.getElementById("otpUsernameStatus");
    if (statusEl) statusEl.textContent = "";
    _usernameAvailable = false;
  }
}

function _onUsernameInput(e) {
  const cleaned = (e.target?.value || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (e.target) e.target.value = cleaned;
  if (cleaned.length >= 1) {
    _scheduleUsernameCheck(cleaned);
  } else {
    clearTimeout(_usernameCheckTimer);
    const statusEl = document.getElementById("otpUsernameStatus");
    if (statusEl) statusEl.textContent = "";
    _usernameAvailable = false;
  }
}

function _scheduleUsernameCheck(username) {
  clearTimeout(_usernameCheckTimer);
  const statusEl = document.getElementById("otpUsernameStatus");
  if (statusEl) {
    statusEl.textContent = "Checking availability…";
    statusEl.className   = "username-status checking";
  }
  _usernameAvailable = false;

  _usernameCheckTimer = setTimeout(async () => {
    if (!_isValidUsername(username)) {
      if (statusEl) {
        statusEl.textContent = "3–20 chars: letters, numbers, underscore only";
        statusEl.className   = "username-status invalid";
      }
      return;
    }
    try {
      const snap = await getDoc(doc(db, "usernames", username));
      if (!snap.exists()) {
        if (statusEl) {
          statusEl.textContent = `✓  @${username} is available`;
          statusEl.className   = "username-status available";
        }
        _usernameAvailable = true;
      } else {
        if (statusEl) {
          statusEl.textContent = `✗  @${username} is already taken`;
          statusEl.className   = "username-status taken";
        }
        _usernameAvailable = false;
      }
    } catch (_) {
      if (statusEl) {
        statusEl.textContent = "Could not check availability";
        statusEl.className   = "username-status checking";
      }
    }
  }, 500);
}

async function _onProfileSubmit(e) {
  e.preventDefault();
  _clearError("otpNameError");

  const name     = (document.getElementById("otpNameInput")?.value  || "").trim();
  const username = (document.getElementById("otpUsernameInput")?.value || "").trim();
  const password = document.getElementById("otpPasswordInput2")?.value || "";
  const confirm  = document.getElementById("otpPasswordConfirm")?.value || "";

  if (name.length < 2) {
    _setError("otpNameError", "Please enter your name.");
    document.getElementById("otpNameInput")?.focus();
    return;
  }
  if (!_isValidUsername(username)) {
    _setError("otpNameError", "Username must be 3–20 characters: letters, numbers, underscore.");
    document.getElementById("otpUsernameInput")?.focus();
    return;
  }
  if (!_usernameAvailable) {
    _setError("otpNameError", "Please choose an available username.");
    document.getElementById("otpUsernameInput")?.focus();
    return;
  }
  if (password.length < 6) {
    _setError("otpNameError", "Password must be at least 6 characters.");
    document.getElementById("otpPasswordInput2")?.focus();
    return;
  }
  if (password !== confirm) {
    _setError("otpNameError", "Passwords do not match.");
    document.getElementById("otpPasswordConfirm")?.value && (document.getElementById("otpPasswordConfirm").value = "");
    document.getElementById("otpPasswordConfirm")?.focus();
    return;
  }

  if (!_pendingPhone) {
    _setError("otpNameError", "Session expired. Please enter your phone again.");
    _showPhoneStep();
    return;
  }

  _pendingName = name;

  // Fill confirm step
  const confirmName     = document.getElementById("otpConfirmName");
  const confirmPhone    = document.getElementById("otpConfirmPhone");
  const confirmUsername = document.getElementById("otpConfirmUsername");
  if (confirmName)     confirmName.textContent     = name;
  if (confirmPhone)    confirmPhone.textContent    = _formatPhone(_pendingPhone);
  if (confirmUsername) confirmUsername.textContent = `@${username}`;

  document.getElementById("otpProfileStep")?.classList.add("hidden");
  document.getElementById("otpConfirmStep")?.classList.remove("hidden");
}

// ── Step 3: Create account ────────────────────────────────────────────────────
// BRIDGE: writes Firestore directly instead of calling customerAuth Cloud Fn.

async function _onCreateAccount() {
  _clearError("otpNameError");

  if (!_pendingName || !_pendingPhone) {
    _showPhoneStep();
    return;
  }

  const username = (document.getElementById("otpUsernameInput")?.value || "").trim();
  const password = document.getElementById("otpPasswordInput2")?.value || "";

  if (!_isValidUsername(username) || !_usernameAvailable) {
    document.getElementById("otpConfirmStep")?.classList.add("hidden");
    document.getElementById("otpProfileStep")?.classList.remove("hidden");
    _setError("otpNameError", "Please choose an available username before continuing.");
    return;
  }

  _setLoadingBtn("otpCreateAccountBtn", true, "Creating…");

  try {
    if (!_firebaseUser) {
      await signInAnonymously(auth);
    }

    // Final availability check (guards against race condition)
    const snap = await getDoc(doc(db, "usernames", username));
    if (snap.exists()) {
      document.getElementById("otpConfirmStep")?.classList.add("hidden");
      document.getElementById("otpProfileStep")?.classList.remove("hidden");
      _setError("otpNameError", `@${username} was just taken. Please choose another.`);
      _usernameAvailable = false;
      const statusEl = document.getElementById("otpUsernameStatus");
      if (statusEl) {
        statusEl.textContent = `✗  @${username} is already taken`;
        statusEl.className   = "username-status taken";
      }
      return;
    }

    const uid          = auth.currentUser?.uid || "";
    const passwordHash = await _hashPassword(password, _pendingPhone);
    const now          = serverTimestamp();

    // Write username uniqueness registry first
    await setDoc(doc(db, "usernames", username), { phone: _pendingPhone });

    // Write customer profile
    await setDoc(doc(db, "customers", _pendingPhone), {
      phone:         _pendingPhone,
      name:          _pendingName,
      username,
      uid,
      passwordHash,
      phoneVerified: false,
      createdAt:     now,
      updatedAt:     now,
      lastLoginAt:   now,
      totalOrders:   0,
      lifetimeSpend: 0,
      lastOrderAt:   null,
    });

    await _completeLogin(_pendingName, _pendingPhone, uid, username);
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
// profileUid: the stable stored uid from customers/{phone}.uid — must be
// used instead of auth.currentUser.uid to keep customer_order_history stable.
// username: @handle stored in the session for display purposes.

async function _completeLogin(name, phone, profileUid = "", username = "") {
  if (!_firebaseUser) {
    await signInAnonymously(auth);
  }
  const uid = profileUid || auth.currentUser?.uid || "";
  _currentUser = { name, phone, uid, username };
  _saveSession(_currentUser);
  _updateGreeting();
  _dispatchAuthChange(_currentUser);
  _hideModal();

  // Update lastLoginAt only — do NOT touch uid or passwordHash.
  if (phone) {
    setDoc(doc(db, "customers", phone), { lastLoginAt: serverTimestamp() }, { merge: true })
      .catch(() => {});
  }

  const cb = _pendingCb;
  _pendingCb           = null;
  _pendingPhone        = "";
  _pendingName         = "";
  _pendingLoginProfile = null;
  _usernameAvailable   = false;
  if (cb) cb();
}

// ── Ensure Firebase session on page reload ────────────────────────────────────

async function _ensureFirebaseSession() {
  await _authReady;
  if (auth.currentUser) return auth.currentUser;
  await signInAnonymously(auth);
  return auth.currentUser;
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function _onLogout() {
  // AI UPDATE [2026-07-30]: Replaced confirm() with custom dialog if available; native fallback for safety.
  // AI UPDATE [2026-07-30]: Replaced native confirm() with custom dialog.
  // When deployed to Customer Panel, js/dialog.js must also be deployed so
  // window.BillingDialog is available (see AI_HANDOFF.md for deployment note).
  const _logoutConfirmed = window.BillingDialog
    ? await window.BillingDialog.showConfirm("You'll need to enter your phone number and password again.", {
        title: 'Log out?', confirmText: 'Log Out', cancelText: 'Stay', type: 'warning'
      })
    : true; // dialog.js not loaded → auto-confirm; see AI_HANDOFF.md deployment note.
  if (!_logoutConfirmed) return;
  _currentUser         = null;
  _pendingPhone        = "";
  _pendingName         = "";
  _pendingLoginProfile = null;
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

// ── Password & username utilities ─────────────────────────────────────────────

// SHA-256(password + ":" + phone). Phone acts as a per-user salt.
async function _hashPassword(password, phone) {
  const encoder = new TextEncoder();
  const data    = encoder.encode(password + ":" + phone);
  const buf     = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

// "Arnav Mishra" → "arnavmishra"
function _generateUsername(name) {
  return (name || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20) || "user";
}

function _isValidUsername(u) {
  return /^[a-z0-9_]{3,20}$/.test(u);
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
