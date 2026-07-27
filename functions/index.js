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
 *                           action='lookup'  — normalize phone, check existing
 *                                              profile, return { found, name, phone,
 *                                              token } or { found: false }.
 *                           action='create'  — create new customer profile + Auth
 *                                              user after name confirmation.
 *                         Identity is always derived server-side.
 *
 *   createCustomerOrder — Validates Firebase Auth identity (must come from
 *                         customerAuth custom token), acquires or reuses the table
 *                         lock atomically, creates the pending_table_orders document.
 *                         Customer identity is derived from server-side profile only.
 *
 *   releaseTableLock    — Called by the Billing Panel (Bill & Settle / SAVE & EXIT).
 *                         Verifies the billingOperator claim, atomically releases the
 *                         session and marks active orders completed.
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase deploy --only functions,firestore
 *
 * Secrets required before deploy:
 *   firebase functions:secrets:set ADMIN_PIN
 *   (enter your chosen PIN when prompted)
 *
 * OTP gate — to enable phone verification once DLT approval is complete:
 *   Change REQUIRE_PHONE_VERIFICATION below from false → true and redeploy.
 *   No database migration needed; existing profiles have phoneVerified: false
 *   and will be prompted to verify on their next order attempt.
 *
 * Local emulator:
 *   firebase emulators:start --only functions,firestore,auth
 */

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { defineSecret }        = require('firebase-functions/params');
const { initializeApp }       = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth }             = require('firebase-admin/auth');

initializeApp();
const db   = getFirestore();
const auth = getAuth();

// ── Admin PIN (Firebase Secret Manager) ──────────────────────────────────────
// Must be provisioned before deployment:
//   firebase functions:secrets:set ADMIN_PIN
// defineSecret() binds the secret to the function at deploy time.  If the
// secret is missing the function refuses to start — fail closed, no default.
const adminPinSecret = defineSecret('ADMIN_PIN');

// ── Phone Verification Gate ───────────────────────────────────────────────────
// Controls whether customers must have phoneVerified: true to place orders.
//
// Currently: false  (OTP/DLT approval is pending — temporary phone bridge)
// When ready: change to true and run: firebase deploy --only functions
//
// No database migration is needed when you flip this — existing profiles that
// have phoneVerified: false will simply be rejected and prompted to verify.
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRE_PHONE_VERIFICATION = false;  // ← change to true when DLT/OTP is approved

// ── Stable UID constants ──────────────────────────────────────────────────────
// Billing operator uses a single shared UID.
const OPERATOR_UID = 'billing-operator-main';

// Customer Auth UIDs are deterministically derived from the normalised phone
// so the same customer always gets the same UID across sessions:
//   uid = 'cust_' + e164_digits   e.g. 'cust_919876543210'
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
    let s = raw.trim().replace(/[\s\-().]/g, '');
    if (s.startsWith('00')) s = '+' + s.slice(2);
    if (/^0\d{10}$/.test(s))  s = '+91' + s.slice(1);
    if (/^\d{10}$/.test(s))   s = '+91' + s;
    if (/^91\d{10}$/.test(s)) s = '+' + s;
    if (!/^\+\d{10,15}$/.test(s)) {
        throw new HttpsError('invalid-argument',
            `Invalid phone number: "${raw}". Use format +91XXXXXXXXXX.`);
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
        console.log(`[ensureCustomerAuthUser] existing user found: ${uid}`);
    } catch (e) {
        if (e.code === 'auth/user-not-found') {
            await auth.createUser({ uid, displayName: displayName || '' });
            console.log(`[ensureCustomerAuthUser] created new user: ${uid}`);
        } else {
            console.error(`[ensureCustomerAuthUser] auth.getUser failed for ${uid}:`, e);
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
        throw new HttpsError('permission-denied',
            'Caller is not an authorized billing operator.');
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

        const expectedPin = adminPinSecret.value();
        if (!expectedPin) {
            throw new HttpsError('internal',
                'Server configuration error: ADMIN_PIN secret is not set.');
        }
        if (!pin || pin !== expectedPin) {
            throw new HttpsError('unauthenticated', 'Invalid PIN.');
        }

        await ensureOperatorAccount();
        const token = await auth.createCustomToken(OPERATOR_UID, { billingOperator: true });
        return { token };
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// customerAuth
//
// Secure customer authentication bridge.  The Customer Order Panel calls this
// instead of reading/writing Firestore directly.  All identity decisions happen
// server-side; the browser cannot supply or forge customer UID, phone, or name.
//
// ── action: 'lookup' ──────────────────────────────────────────────────────────
// Request:  { action: 'lookup', phone: '+91XXXXXXXXXX' }
// Response (exists):    { found: true, name, phone, token }
// Response (not found): { found: false, phone }
//
// Phone is normalised server-side.  If the profile exists a custom token is
// returned; lastLoginAt is updated.  Existing profiles missing authUid or
// phoneVerified are backfilled non-destructively.
//
// ── action: 'create' ──────────────────────────────────────────────────────────
// Request:  { action: 'create', phone: '+91XXXXXXXXXX', name: 'Rahul' }
// Response: { token, uid, name, phone }
//
// Called after the customer confirms their name.  If a race condition produces
// an already-existing profile the function falls back to lookup behaviour.
// New profiles are written with phoneVerified: false.
//
// Error codes the caller should handle:
//   invalid-argument  — bad phone format or missing name
//   internal          — log message included; surface it for debugging
// ─────────────────────────────────────────────────────────────────────────────
exports.customerAuth = onCall({ region: 'asia-south1' }, async (request) => {
    const { action, phone: rawPhone, name: rawName } = request.data || {};

    console.log(`[customerAuth] action=${action} rawPhone=${rawPhone}`);

    // ── Input validation ──────────────────────────────────────────────────────
    if (!action || !['lookup', 'create'].includes(action)) {
        throw new HttpsError('invalid-argument', "action must be 'lookup' or 'create'.");
    }

    let phone;
    try {
        phone = normalizePhone(rawPhone);
    } catch (e) {
        // normalizePhone already throws HttpsError; just re-throw
        throw e;
    }

    const uid        = customerUidFromPhone(phone);
    const profileRef = db.collection('customers').doc(phone);
    const uidMapRef  = db.collection('customer_uid_map').doc(uid);

    console.log(`[customerAuth] normalised phone=${phone} uid=${uid}`);

    // ── lookup ────────────────────────────────────────────────────────────────
    if (action === 'lookup') {
        let snap;
        try {
            snap = await profileRef.get();
        } catch (e) {
            console.error('[customerAuth:lookup] Firestore get failed:', e);
            throw new HttpsError('internal',
                `Firestore read failed: ${e.message}`);
        }

        if (!snap.exists) {
            console.log(`[customerAuth:lookup] no profile for ${phone}`);
            return { found: false, phone };
        }

        console.log(`[customerAuth:lookup] profile found for ${phone}`);
        const profile = snap.data();

        // Backfill legacy profiles — non-destructive, preserves all existing fields
        const backfill = {};
        if (!profile.authUid)                   backfill.authUid = uid;
        if (profile.phoneVerified === undefined)  backfill.phoneVerified = false;

        try {
            await profileRef.update({
                lastLoginAt: FieldValue.serverTimestamp(),
                ...backfill,
            });
        } catch (e) {
            // Non-fatal — profile read succeeded; continue with login
            console.warn('[customerAuth:lookup] profile update failed (non-fatal):', e);
        }

        try {
            await uidMapRef.set(
                { phone, updatedAt: FieldValue.serverTimestamp() },
                { merge: true }
            );
        } catch (e) {
            console.warn('[customerAuth:lookup] uidMapRef.set failed (non-fatal):', e);
        }

        try {
            await ensureCustomerAuthUser(uid, profile.name || '');
        } catch (e) {
            console.error('[customerAuth:lookup] ensureCustomerAuthUser failed:', e);
            throw new HttpsError('internal',
                `Auth user creation failed: ${e.message}`);
        }

        let token;
        try {
            token = await auth.createCustomToken(uid, { customerPhone: phone });
        } catch (e) {
            // Most common cause: the service account is missing the
            // "Service Account Token Creator" IAM role in Google Cloud Console.
            // Go to: IAM & Admin → IAM → find the App Engine / Firebase service
            // account → add role "Service Account Token Creator".
            console.error('[customerAuth:lookup] createCustomToken failed:', e);
            throw new HttpsError('internal',
                `Custom token creation failed: ${e.message}. ` +
                'Ensure the service account has the "Service Account Token Creator" IAM role.'
            );
        }

        console.log(`[customerAuth:lookup] success for ${phone}`);
        return {
            found: true,
            name:  profile.name  || '',
            phone: profile.phone || phone,
            token,
        };
    }

    // ── create ────────────────────────────────────────────────────────────────
    if (action === 'create') {
        const name = (rawName || '').trim();
        if (!name) {
            throw new HttpsError('invalid-argument',
                'Customer name is required for account creation.');
        }

        let snap;
        try {
            snap = await profileRef.get();
        } catch (e) {
            console.error('[customerAuth:create] Firestore get failed:', e);
            throw new HttpsError('internal', `Firestore read failed: ${e.message}`);
        }

        if (snap.exists) {
            // Race condition — profile already created; treat as lookup
            console.log(`[customerAuth:create] profile already exists, treating as lookup`);
            const profile = snap.data();
            const backfill = {};
            if (!profile.authUid)                   backfill.authUid = uid;
            if (profile.phoneVerified === undefined)  backfill.phoneVerified = false;
            try {
                await profileRef.update({
                    lastLoginAt: FieldValue.serverTimestamp(),
                    ...backfill,
                });
            } catch (e) {
                console.warn('[customerAuth:create] profile update failed (non-fatal):', e);
            }
            try {
                await uidMapRef.set(
                    { phone, updatedAt: FieldValue.serverTimestamp() },
                    { merge: true }
                );
            } catch (e) {
                console.warn('[customerAuth:create] uidMapRef.set failed (non-fatal):', e);
            }
            try {
                await ensureCustomerAuthUser(uid, profile.name || name);
            } catch (e) {
                console.error('[customerAuth:create] ensureCustomerAuthUser failed:', e);
                throw new HttpsError('internal',
                    `Auth user creation failed: ${e.message}`);
            }
            let token;
            try {
                token = await auth.createCustomToken(uid, { customerPhone: phone });
            } catch (e) {
                console.error('[customerAuth:create] createCustomToken failed:', e);
                throw new HttpsError('internal',
                    `Custom token creation failed: ${e.message}. ` +
                    'Ensure the service account has the "Service Account Token Creator" IAM role.'
                );
            }
            return {
                found: true,
                name:  profile.name || name,
                phone: profile.phone || phone,
                token,
                uid,
            };
        }

        // New customer — write profile, UID map, and Auth user
        console.log(`[customerAuth:create] creating new profile for ${phone}`);
        const now = FieldValue.serverTimestamp();
        try {
            await Promise.all([
                profileRef.set({
                    phone,
                    name,
                    phoneVerified: false,
                    authUid:       uid,
                    createdAt:     now,
                    updatedAt:     now,
                    lastLoginAt:   now,
                }),
                uidMapRef.set({ phone, createdAt: now }),
            ]);
        } catch (e) {
            console.error('[customerAuth:create] Firestore write failed:', e);
            throw new HttpsError('internal', `Profile creation failed: ${e.message}`);
        }

        try {
            await ensureCustomerAuthUser(uid, name);
        } catch (e) {
            console.error('[customerAuth:create] ensureCustomerAuthUser failed:', e);
            throw new HttpsError('internal',
                `Auth user creation failed: ${e.message}`);
        }

        let token;
        try {
            token = await auth.createCustomToken(uid, { customerPhone: phone });
        } catch (e) {
            console.error('[customerAuth:create] createCustomToken failed:', e);
            throw new HttpsError('internal',
                `Custom token creation failed: ${e.message}. ` +
                'Ensure the service account has the "Service Account Token Creator" IAM role.'
            );
        }

        console.log(`[customerAuth:create] success for ${phone}`);
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
// OTP gate: controlled by the REQUIRE_PHONE_VERIFICATION constant at the top
// of this file.  Set it to true and redeploy to enable enforcement.
// The browser cannot influence this check.
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
//     tableId:   "Table 1",   // authoritative — may differ from request
//     sessionId: "<customerUid>",
//     lockId:    "<string>"
//   }
//
// Error codes:
//   unauthenticated   — not signed in via customerAuth
//   permission-denied — phoneVerified check failed (when gate is enabled)
//   not-found         — customer profile not found for this UID
//   already-exists    — table occupied by a different customer
//   invalid-argument  — missing/invalid request fields
// ─────────────────────────────────────────────────────────────────────────────
exports.createCustomerOrder = onCall({ region: 'asia-south1' }, async (request) => {
    if (!request.auth?.uid) {
        throw new HttpsError('unauthenticated',
            'Customer must be signed in with Firebase Auth.');
    }

    const customerUid = request.auth.uid;

    // ── Derive phone from the server-issued token claim (not request.data) ────
    const customerPhone = request.auth.token?.customerPhone || '';
    if (!customerPhone) {
        throw new HttpsError('unauthenticated',
            'Session was not established via customerAuth. ' +
            'Please sign in through the customer login flow.');
    }

    // ── Look up the server-side customer profile ──────────────────────────────
    const profileSnap = await db.collection('customers').doc(customerPhone).get();
    if (!profileSnap.exists) {
        throw new HttpsError('not-found',
            'Customer profile not found. ' +
            'Please complete registration through the customer panel.');
    }
    const profile = profileSnap.data();

    // ── OTP verification gate (server-controlled, cannot be bypassed) ─────────
    if (REQUIRE_PHONE_VERIFICATION && profile.phoneVerified !== true) {
        throw new HttpsError('permission-denied',
            'Phone number verification is required to place orders. ' +
            'Please complete OTP verification.');
    }

    // ── Authoritative customer identity (server-side only) ────────────────────
    const customerName = profile.name || '';

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
            // Customer already holds a lock — honour it; ignore requested table.
            assignedTableId = existingSession.activeTableId;
            lockId          = existingSession.lockId;

        } else if (existingTableLock && existingTableLock.status === 'active') {
            if (existingTableLock.customerUid !== customerUid) {
                throw new HttpsError('already-exists',
                    `Table "${requestedTableId}" is currently occupied by another customer.`);
            }
            // Same customer — recover from partial state
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

        const orderId    = `ORD_${Date.now()}_${customerUid.slice(0, 10)}`;
        const orderRef   = db.collection('pending_table_orders').doc(orderId);
        const totalPrice = items.reduce(
            (s, i) => s + (Number(i.price) * (Number(i.quantity) || 1)), 0
        );

        tx.set(orderRef, {
            tableId: assignedTableId,
            customer: {
                uid:   customerUid,
                name:  customerName,   // from server-side profile
                phone: customerPhone,  // from server-issued token claim
            },
            customerSessionId: customerUid,
            tableLockId:       lockId,
            status:            'pending',
            items,
            totalPrice,
            createdAt: FieldValue.serverTimestamp(),
        });

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

    // Update lastLoginAt outside the transaction (non-critical)
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
//   { released: true,  tableId, releaseReason }
//   { released: false, reason: "no_active_session" }
//
// On any error throws HttpsError — the caller must NOT proceed with clear/navigate.
// Uses composite index on customer_table_sessions (activeTableId + lockStatus)
// — deployed via: firebase deploy --only firestore:indexes
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

    // Composite index on (activeTableId ASC, lockStatus ASC) required.
    // Deploy with: firebase deploy --only firestore:indexes
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
        // Only orders tracked by this session are touched.
        // Never complete orders by tableId alone — would risk affecting
        // another customer's concurrent orders on a different session.
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

        tx.update(sessDoc.ref, {
            lockStatus:     'released',
            activeTableId:  null,
            activeOrderIds: [],
            releaseReason,
            releasedAt:     FieldValue.serverTimestamp(),
        });

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
