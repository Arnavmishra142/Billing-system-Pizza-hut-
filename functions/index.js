/**
 * Firebase Cloud Functions — Pizza Hut Billing System
 *
 * Functions:
 *
 *   operatorSignIn      — Verifies the admin PIN server-side and returns a
 *                         Firebase custom token with { billingOperator: true }.
 *                         Called by the billing panel before any operator action.
 *
 *   customerAuth        — Secure customer authentication bridge.
 *                         Supports two actions:
 *                           action='lookup'  — normalize phone, check existing profile,
 *                                              return { found, name, phone, token } or
 *                                              { found: false }.
 *                           action='create'  — create new customer profile + Auth user
 *                                              after name confirmation in customer panel.
 *                         Identity is always derived server-side; the browser never
 *                         writes to customers or customer_uid_map directly.
 *
 *   createCustomerOrder — Validates Firebase Auth identity (must come from customerAuth
 *                         custom token), acquires or reuses the table lock atomically,
 *                         then creates the pending_table_orders document.  Customer
 *                         identity (phone, name) is derived from server-side profile —
 *                         browser-supplied identity data is ignored.
 *
 *   releaseTableLock    — Called by the Billing Panel (Bill & Settle / SAVE & EXIT
 *                         paths in cart.js).  Verifies the billingOperator claim, then
 *                         atomically releases the session and marks active orders
 *                         completed.
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase deploy --only functions,firestore
 *
 * Secrets / params required before deploy:
 *   firebase functions:secrets:set ADMIN_PIN
 *   firebase functions:params:set REQUIRE_PHONE_VERIFICATION=false
 *   (set to true once DLT/OTP approval is complete)
 *
 * Local emulator:
 *   firebase emulators:start --only functions,firestore,auth
 */

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { initializeApp }       = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth }             = require('firebase-admin/auth');

initializeApp();
const db   = getFirestore();
const auth = getAuth();

// ── Admin PIN (Firebase Secret Manager) ──────────────────────────────────────
// Must be provisioned before deployment:
//   firebase functions:secrets:set ADMIN_PIN
//   (enter your chosen PIN when prompted)
//
// defineSecret() binds the secret to the function at deploy time.  If the
// secret is missing or the function cannot access it, Cloud Functions will
// refuse to start the function — fail closed, never fall back to a default.
const adminPinSecret = defineSecret('ADMIN_PIN');

// ── Phone Verification Gate ───────────────────────────────────────────────────
// Set to 'false' while OTP/DLT approval is pending (temporary phone bridge).
// Set to 'true' once DLT approval is complete; the backend will then reject
// any customer whose profile has phoneVerified !== true.
// The browser cannot influence this check.
//
// Deploy command:
//   firebase functions:params:set REQUIRE_PHONE_VERIFICATION=false
//   firebase functions:params:set REQUIRE_PHONE_VERIFICATION=true   (when ready)
const requirePhoneVerificationParam = defineString('REQUIRE_PHONE_VERIFICATION', {
    default: 'false',
    description: 'Set to true to require phoneVerified:true on customer profiles before allowing orders.',
});

// ── Stable UID constants ──────────────────────────────────────────────────────
// Billing operator uses a single shared UID.
const OPERATOR_UID = 'billing-operator-main';

// Customer Auth UIDs are deterministically derived from the normalized phone
// number so the same customer always gets the same UID across sessions:
//   uid = 'cust_' + e164_digits   e.g. 'cust_919876543210'
// This prevents duplicate Auth accounts for the same customer.
function customerUidFromPhone(normalizedPhone) {
    return 'cust_' + normalizedPhone.replace(/^\+/, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: normalize a raw phone input to E.164 format for India.
// Accepts: 10-digit local, 0XXXXXXXXXX, +91XXXXXXXXXX, 91XXXXXXXXXX.
// Throws HttpsError('invalid-argument') on unrecognisable input.
// ─────────────────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
    if (!raw || typeof raw !== 'string') {
        throw new HttpsError('invalid-argument', 'Phone number is required.');
    }
    // Strip whitespace, dashes, dots, parentheses
    let s = raw.trim().replace(/[\s\-().]/g, '');
    // Convert legacy '00' prefix
    if (s.startsWith('00')) s = '+' + s.slice(2);
    // Indian local: leading '0'
    if (/^0\d{10}$/.test(s)) s = '+91' + s.slice(1);
    // Bare 10-digit Indian local
    if (/^\d{10}$/.test(s)) s = '+91' + s;
    // Numeric E.164 without '+'
    if (/^91\d{10}$/.test(s)) s = '+' + s;
    // Validate E.164
    if (!/^\+\d{10,15}$/.test(s)) {
        throw new HttpsError('invalid-argument', `Invalid phone number: "${raw}". Use format +91XXXXXXXXXX.`);
    }
    return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: ensure a customer Firebase Auth account exists with the stable UID.
// Idempotent — safe to call on every login.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureCustomerAuthUser(uid, displayName) {
    try {
        await auth.getUser(uid);
    } catch (e) {
        if (e.code === 'auth/user-not-found') {
            await auth.createUser({ uid, displayName: displayName || '' });
        } else {
            throw e;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: ensure the shared operator Firebase Auth account exists and carries
// the billingOperator custom claim.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureOperatorAccount() {
    try {
        await auth.getUser(OPERATOR_UID);
    } catch (e) {
        if (e.code === 'auth/user-not-found') {
            await auth.createUser({ uid: OPERATOR_UID, displayName: 'Billing Operator' });
        } else {
            throw e;
        }
    }
    // Idempotent — safe to call on every sign-in
    await auth.setCustomUserClaims(OPERATOR_UID, { billingOperator: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: verify that the calling Firebase Auth user holds billingOperator claim.
// ─────────────────────────────────────────────────────────────────────────────
function requireBillingOperator(authContext) {
    if (!authContext?.uid) {
        throw new HttpsError('unauthenticated', 'Caller must be authenticated.');
    }
    if (!authContext.token?.billingOperator) {
        throw new HttpsError('permission-denied', 'Caller is not an authorized billing operator.');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// operatorSignIn
//
// Verifies the admin PIN server-side and returns a Firebase custom token.
// The billing panel signs in with this token via signInWithCustomToken().
//
// Request:  { pin: "1414" }
// Response: { token: "<firebase-custom-token>" }
// ─────────────────────────────────────────────────────────────────────────────
exports.operatorSignIn = onCall(
    { region: 'asia-south1', secrets: [adminPinSecret] },
    async (request) => {
    const { pin } = request.data || {};

    // Fail closed: if the secret is unavailable (misconfigured deployment),
    // reject all attempts rather than accepting any default value.
    const expectedPin = adminPinSecret.value();
    if (!expectedPin) {
        throw new HttpsError('internal', 'Server configuration error: ADMIN_PIN secret is not set.');
    }

    if (!pin || pin !== expectedPin) {
        throw new HttpsError('unauthenticated', 'Invalid PIN.');
    }

    await ensureOperatorAccount();

    // Custom token carries the claim directly so the client has it immediately
    // (before the token is exchanged with Firebase Auth servers).
    const token = await auth.createCustomToken(OPERATOR_UID, { billingOperator: true });
    return { token };
});

// ─────────────────────────────────────────────────────────────────────────────
// customerAuth
//
// Secure customer authentication bridge.  The Customer Order Panel calls this
// instead of reading/writing Firestore directly.  All identity decisions happen
// server-side; the browser cannot supply or forge customer UID, phone, or name.
//
// ── action: 'lookup' ──────────────────────────────────────────────────────────
// Check whether a customer profile exists for the given phone number.
//
// Request:
//   { action: 'lookup', phone: '+91XXXXXXXXXX' }
//
// Response (customer exists):
//   { found: true, name: 'Rahul', phone: '+91XXXXXXXXXX', token: '<custom-token>' }
//
// Response (customer not found):
//   { found: false, phone: '+91XXXXXXXXXX' }
//
// Behaviour:
//   - Phone is normalised and validated server-side.
//   - If the profile exists, a stable Firebase Auth user is created/reused
//     (UID = 'cust_' + digits) and a custom token is returned.
//   - lastLoginAt is updated on the profile.
//   - No account is created for new customers at this stage.
//   - Existing profiles without authUid or phoneVerified are handled safely
//     (authUid is backfilled, phoneVerified defaults to false).
//
// ── action: 'create' ──────────────────────────────────────────────────────────
// Create a new customer profile after the customer confirms their name.
// Must only be called after a 'lookup' that returned found:false.
//
// Request:
//   { action: 'create', phone: '+91XXXXXXXXXX', name: 'Rahul' }
//
// Response:
//   { token: '<custom-token>', uid: 'cust_91XXXXXXXXXX', name: 'Rahul', phone: '+91XXXXXXXXXX' }
//
// Behaviour:
//   - Phone is normalised server-side.
//   - If a profile already exists (race condition), falls back to lookup behaviour.
//   - Creates the Firestore profile with phoneVerified: false.
//   - Creates/reuses the Firebase Auth user with the stable UID.
//   - Writes customer_uid_map/{uid} → { phone } for efficient reverse lookup.
//   - Never creates a duplicate Auth account for the same phone number.
//
// ── OTP compatibility note ─────────────────────────────────────────────────────
// New customers are created with phoneVerified: false.  When DLT/OTP approval is
// complete, set REQUIRE_PHONE_VERIFICATION=true and implement an OTP-success
// handler that updates phoneVerified: true on the customer profile.
// Existing accounts continue working; no migration or recreation is required.
// ─────────────────────────────────────────────────────────────────────────────
exports.customerAuth = onCall({ region: 'asia-south1' }, async (request) => {
    const { action, phone: rawPhone, name: rawName } = request.data || {};

    if (!action || !['lookup', 'create'].includes(action)) {
        throw new HttpsError('invalid-argument', "action must be 'lookup' or 'create'.");
    }

    const phone = normalizePhone(rawPhone);
    const uid   = customerUidFromPhone(phone);

    const profileRef    = db.collection('customers').doc(phone);
    const uidMapRef     = db.collection('customer_uid_map').doc(uid);

    if (action === 'lookup') {
        const snap = await profileRef.get();

        if (!snap.exists) {
            return { found: false, phone };
        }

        const profile = snap.data();

        // Backfill authUid and phoneVerified on legacy profiles that predate this flow.
        // This is a safe, non-destructive write — existing fields are preserved.
        const backfill = {};
        if (!profile.authUid)                  backfill.authUid = uid;
        if (profile.phoneVerified === undefined) backfill.phoneVerified = false;

        const updatePayload = {
            lastLoginAt: FieldValue.serverTimestamp(),
            ...backfill,
        };
        await profileRef.update(updatePayload);

        // Ensure reverse-lookup map exists
        await uidMapRef.set({ phone, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

        // Ensure Auth user exists with the stable UID
        await ensureCustomerAuthUser(uid, profile.name || '');

        // Issue custom token; customerPhone claim is read by createCustomerOrder
        // so identity is always derived from the server-issued token.
        const token = await auth.createCustomToken(uid, { customerPhone: phone });

        return {
            found: true,
            name:  profile.name  || '',
            phone: profile.phone || phone,
            token,
        };
    }

    if (action === 'create') {
        const name = (rawName || '').trim();
        if (!name) {
            throw new HttpsError('invalid-argument', 'Customer name is required for account creation.');
        }

        // Check for race condition — profile already exists
        const snap = await profileRef.get();
        if (snap.exists) {
            // Treat as lookup: return existing profile
            const profile = snap.data();
            const backfill = {};
            if (!profile.authUid)                  backfill.authUid = uid;
            if (profile.phoneVerified === undefined) backfill.phoneVerified = false;
            await profileRef.update({ lastLoginAt: FieldValue.serverTimestamp(), ...backfill });
            await uidMapRef.set({ phone, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
            await ensureCustomerAuthUser(uid, profile.name || name);
            const token = await auth.createCustomToken(uid, { customerPhone: phone });
            return {
                found: true,   // signals caller that account already existed
                name:  profile.name || name,
                phone: profile.phone || phone,
                token,
                uid,
            };
        }

        // New customer — create profile, Auth user, and UID map atomically.
        const now = FieldValue.serverTimestamp();
        await Promise.all([
            profileRef.set({
                phone,
                name,
                phoneVerified: false,   // upgraded to true when OTP flow completes
                authUid:       uid,
                createdAt:     now,
                updatedAt:     now,
                lastLoginAt:   now,
            }),
            uidMapRef.set({ phone, createdAt: now }),
        ]);

        await ensureCustomerAuthUser(uid, name);

        const token = await auth.createCustomToken(uid, { customerPhone: phone });

        return { token, uid, name, phone };
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// createCustomerOrder
//
// Called by the customer browser (Customer Order Panel) via httpsCallable.
// The customer must be signed in with a custom token issued by customerAuth.
//
// Identity is derived entirely from the server-side Firebase Auth token and the
// Firestore customer profile.  Browser-supplied customer name/phone/UID values
// are ignored — the backend is the sole authority for customer identity.
//
// OTP gate: if REQUIRE_PHONE_VERIFICATION=true, customers with
//   phoneVerified !== true are rejected before any lock is acquired.
//   This check cannot be bypassed from the browser.
//
// Lock strategy — double-booking prevention:
//   A per-table sentinel document `table_locks/{tableId}` is both READ and
//   WRITTEN in the same Firestore transaction.  Because a transaction retries
//   on write-write conflicts, two concurrent requests for the same table will
//   never both succeed: one will retry, find the lock already taken, and throw
//   `already-exists`.
//
// Request:
//   {
//     requestedTableId: "Table 1",
//     items: [{ itemId, name, price, quantity }, ...]
//     // customer field is accepted but ignored — identity comes from Auth token
//   }
//
// Response:
//   {
//     orderId:   "<doc ID>",
//     tableId:   "Table 1",   // authoritative — may differ from request if
//                             // customer already holds a lock on another table
//     sessionId: "<customerUid>",
//     lockId:    "<string>"
//   }
//
// Error codes:
//   unauthenticated  — not signed in, or not signed in via customerAuth
//   permission-denied — phoneVerified check failed (when gate is enabled)
//   not-found        — customer profile not found for this UID
//   already-exists   — table is occupied by a different customer
//   invalid-argument — missing or invalid request fields
// ─────────────────────────────────────────────────────────────────────────────
exports.createCustomerOrder = onCall({ region: 'asia-south1' }, async (request) => {
    if (!request.auth?.uid) {
        throw new HttpsError('unauthenticated', 'Customer must be signed in with Firebase Auth.');
    }

    const customerUid = request.auth.uid;

    // ── Derive phone from the server-issued token claim (not from request.data) ──
    const customerPhone = request.auth.token?.customerPhone || '';
    if (!customerPhone) {
        throw new HttpsError(
            'unauthenticated',
            'Session was not established via customerAuth. Please sign in through the customer login flow.'
        );
    }

    // ── Look up the server-side customer profile ──────────────────────────────
    const profileSnap = await db.collection('customers').doc(customerPhone).get();
    if (!profileSnap.exists) {
        throw new HttpsError(
            'not-found',
            'Customer profile not found. Please complete registration through the customer panel.'
        );
    }
    const profile = profileSnap.data();

    // ── OTP verification gate ─────────────────────────────────────────────────
    // Reads the server-controlled parameter; the browser cannot influence this.
    const requireVerification = requirePhoneVerificationParam.value() === 'true';
    if (requireVerification && profile.phoneVerified !== true) {
        throw new HttpsError(
            'permission-denied',
            'Phone number verification is required to place orders. Please complete OTP verification.'
        );
    }

    // ── Authoritative customer identity (server-side only) ────────────────────
    const customerName = profile.name || '';
    // phone is already validated in customerPhone

    // ── Parse and validate request payload ───────────────────────────────────
    const { requestedTableId, items = [] } = request.data || {};

    if (!requestedTableId || typeof requestedTableId !== 'string') {
        throw new HttpsError('invalid-argument', 'requestedTableId is required.');
    }
    if (!Array.isArray(items) || items.length === 0) {
        throw new HttpsError('invalid-argument', 'items must be a non-empty array.');
    }

    // ── Atomic lock acquisition ───────────────────────────────────────────────
    const tableLockRef = db.collection('table_locks').doc(requestedTableId);
    const sessionRef   = db.collection('customer_table_sessions').doc(customerUid);

    const result = await db.runTransaction(async (tx) => {
        const [tableLockSnap, sessionSnap] = await Promise.all([
            tx.get(tableLockRef),
            tx.get(sessionRef),
        ]);

        const existingTableLock = tableLockSnap.exists ? tableLockSnap.data() : null;
        const existingSession   = sessionSnap.exists   ? sessionSnap.data()   : null;

        let assignedTableId;
        let lockId;
        let isNewLock = false;

        if (existingSession && existingSession.lockStatus === 'active') {
            // This customer already holds a lock on a table — honour it.
            // The requested table is ignored; the customer is always redirected
            // to their locked table so they cannot silently switch mid-session.
            assignedTableId = existingSession.activeTableId;
            lockId          = existingSession.lockId;

        } else if (existingTableLock && existingTableLock.status === 'active') {
            if (existingTableLock.customerUid !== customerUid) {
                // Table is held by a different customer — reject.
                throw new HttpsError('already-exists',
                    `Table "${requestedTableId}" is currently occupied by another customer.`);
            }
            // Same customer — table lock active but session doc was cleared
            // (edge case recovery).
            assignedTableId = requestedTableId;
            lockId          = existingTableLock.lockId;

        } else {
            // Table is free — atomically acquire the lock.
            assignedTableId = requestedTableId;
            lockId          = `lock_${customerUid}_${Date.now()}`;
            isNewLock       = true;

            tx.set(tableLockRef, {
                customerUid,
                lockId,
                lockedAt: FieldValue.serverTimestamp(),
                status:   'active',
            });
        }

        // ── Create order document ─────────────────────────────────────────────
        const orderId    = `ORD_${Date.now()}_${customerUid.slice(0, 10)}`;
        const orderRef   = db.collection('pending_table_orders').doc(orderId);
        const totalPrice = items.reduce((s, i) => s + (Number(i.price) * (Number(i.quantity) || 1)), 0);

        tx.set(orderRef, {
            tableId: assignedTableId,
            customer: {
                uid:   customerUid,
                name:  customerName,   // from server-side profile, not request.data
                phone: customerPhone,  // from server-issued token claim, not request.data
            },
            customerSessionId: customerUid,
            tableLockId:       lockId,
            status:            'pending',
            items,
            totalPrice,
            createdAt: FieldValue.serverTimestamp(),
        });

        // ── Update customer session ───────────────────────────────────────────
        const newOrderIds = (existingSession?.activeOrderIds || []).concat(orderId);
        const sessionData = {
            customerUid,
            phone:          customerPhone,
            activeTableId:  assignedTableId,
            lockStatus:     'active',
            lockId,
            activeOrderIds: newOrderIds,
            releasedAt:     null,
        };
        if (isNewLock) sessionData.lockedAt = FieldValue.serverTimestamp();
        tx.set(sessionRef, sessionData, { merge: true });

        return { orderId, tableId: assignedTableId, sessionId: customerUid, lockId };
    });

    // Update profile lastLoginAt outside the transaction (non-critical)
    db.collection('customers').doc(customerPhone).update({
        lastLoginAt: FieldValue.serverTimestamp(),
    }).catch(e => console.warn('[createCustomerOrder] lastLoginAt update failed:', e));

    return result;
});

// ─────────────────────────────────────────────────────────────────────────────
// releaseTableLock
//
// Called by the Billing Panel (cart.js) on Bill & Settle or SAVE & EXIT.
// Requires the caller to be authenticated as a billing operator.
// cart.js MUST await this call before clearing the cart or navigating away.
//
// Request:
//   { tableId: "Table 1", releaseReason: "bill_settle" | "save_exit" }
//
// Response:
//   { released: true,  tableId, releaseReason }   — session found and released
//   { released: false, reason: "no_active_session" } — no active session (safe, not an error)
//
// On any error (auth failure, invalid args, Firestore error), throws HttpsError.
// The caller must treat a thrown error as "table still locked" and not proceed.
// ─────────────────────────────────────────────────────────────────────────────
exports.releaseTableLock = onCall({ region: 'asia-south1' }, async (request) => {
    requireBillingOperator(request.auth);

    const { tableId, releaseReason } = request.data || {};
    if (!tableId) throw new HttpsError('invalid-argument', 'tableId is required.');

    const valid = ['bill_settle', 'save_exit'];
    if (!valid.includes(releaseReason)) {
        throw new HttpsError('invalid-argument',
            `releaseReason must be one of: ${valid.join(', ')}`);
    }

    // Query the session by table — uses the composite index on
    // (activeTableId ASC, lockStatus ASC) in firestore.indexes.json.
    const sessSnap = await db.collection('customer_table_sessions')
        .where('activeTableId', '==', tableId)
        .where('lockStatus',    '==', 'active')
        .get();

    if (sessSnap.empty) {
        console.log(`[releaseTableLock] No active session for "${tableId}".`);
        return { released: false, reason: 'no_active_session' };
    }

    const sessDoc  = sessSnap.docs[0];
    const orderIds = Array.isArray(sessDoc.data().activeOrderIds)
        ? sessDoc.data().activeOrderIds : [];

    await db.runTransaction(async (tx) => {
        // Mark all tracked orders as completed.
        // Only orders that belong to this session are touched — identified by
        // activeOrderIds on the session document.  We never complete orders by
        // tableId alone, which would risk completing another customer's orders.
        for (const orderId of orderIds) {
            const ref  = db.collection('pending_table_orders').doc(orderId);
            const snap = await tx.get(ref);
            if (snap.exists) {
                const st = (snap.data().status || 'pending').toLowerCase();
                if (['pending', 'accepted', 'kot'].includes(st)) {
                    tx.update(ref, { status: 'completed' });
                }
            }
        }

        // Release the customer session
        tx.update(sessDoc.ref, {
            lockStatus:     'released',
            activeTableId:  null,
            activeOrderIds: [],
            releaseReason,
            releasedAt:     FieldValue.serverTimestamp(),
        });

        // Clear the per-table sentinel so the table becomes available again.
        // Written by Admin SDK — Firestore rules deny all browser writes to table_locks.
        const tableLockRef = db.collection('table_locks').doc(tableId);
        tx.set(tableLockRef, {
            customerUid: null,
            lockId:      null,
            status:      'released',
            releasedAt:  FieldValue.serverTimestamp(),
        });
    });

    console.log(`[releaseTableLock] Released "${tableId}", reason: ${releaseReason}`);
    return { released: true, tableId, releaseReason };
});
