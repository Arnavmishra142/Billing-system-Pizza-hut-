/**
 * Firebase Cloud Functions — Pizza Hut Billing System
 *
 * Functions:
 *
 *   operatorSignIn      — Verifies the admin PIN server-side and returns a
 *                         Firebase custom token with { billingOperator: true }.
 *                         Called by the billing panel before any operator action.
 *
 *   createCustomerOrder — Validates Firebase Auth identity, acquires or reuses
 *                         the table lock atomically, then creates the
 *                         pending_table_orders document.  The customer browser
 *                         must never write directly to pending_table_orders.
 *
 *   releaseTableLock    — Called by the Billing Panel (Bill & Settle / SAVE &
 *                         EXIT paths in cart.js).  Verifies the billingOperator
 *                         claim, then atomically releases the session and marks
 *                         active orders completed.
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase deploy --only functions
 *
 * Local emulator:
 *   firebase emulators:start --only functions,firestore,auth
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const { initializeApp }      = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth }            = require('firebase-admin/auth');

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

// Stable Firebase Auth UID used for all billing operator sessions.
// This UID is created on first sign-in and reused for every subsequent login.
const OPERATOR_UID = 'billing-operator-main';

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
// Request: { pin: "1414" }
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
// createCustomerOrder
//
// Called by the customer browser (customer.html) via httpsCallable instead of
// writing directly to pending_table_orders.
//
// Lock strategy — double-booking prevention:
//   A per-table sentinel document `table_locks/{tableId}` is both READ and
//   WRITTEN in the same Firestore transaction.  Because a transaction retries
//   on write-write conflicts, two concurrent requests for the same table will
//   never both succeed: one will retry, find the lock already taken, and throw
//   `already-exists`.  Query-based checks (which do NOT block concurrent writes)
//   are intentionally avoided for this purpose.
//
// Request:
//   {
//     requestedTableId: "Table 1",
//     customer: { name: "Rahul", phone: "+91..." },  // optional
//     items: [{ itemId, name, price, quantity }, ...]
//   }
//
// Response:
//   {
//     orderId:   "<doc ID>",
//     tableId:   "Table 1",   // authoritative — may differ from request
//     sessionId: "<customerUid>",
//     lockId:    "<uuid>"
//   }
// ─────────────────────────────────────────────────────────────────────────────
exports.createCustomerOrder = onCall({ region: 'asia-south1' }, async (request) => {
    if (!request.auth?.uid) {
        throw new HttpsError('unauthenticated', 'Customer must be signed in with Firebase Auth.');
    }

    const customerUid   = request.auth.uid;
    const customerPhone = request.auth.token?.phone_number || '';
    const { requestedTableId, customer = {}, items = [] } = request.data || {};

    if (!requestedTableId) {
        throw new HttpsError('invalid-argument', 'requestedTableId is required.');
    }
    if (!Array.isArray(items) || items.length === 0) {
        throw new HttpsError('invalid-argument', 'items must be a non-empty array.');
    }

    // Sentinel doc: one doc per table, read+written atomically in the transaction.
    const tableLockRef = db.collection('table_locks').doc(requestedTableId);
    const sessionRef   = db.collection('customer_table_sessions').doc(customerUid);

    const result = await db.runTransaction(async (tx) => {
        // Read both docs atomically.  Firestore will abort & retry if either
        // doc is concurrently modified by another transaction — this is what
        // prevents double-booking without needing a separate index query.
        const [tableLockSnap, sessionSnap] = await Promise.all([
            tx.get(tableLockRef),
            tx.get(sessionRef)
        ]);

        const existingTableLock  = tableLockSnap.exists ? tableLockSnap.data() : null;
        const existingSession    = sessionSnap.exists   ? sessionSnap.data()   : null;

        let assignedTableId;
        let lockId;
        let isNewLock = false;

        if (existingSession && existingSession.lockStatus === 'active') {
            // This customer already holds a lock on another table — honour it.
            // The requested table is ignored; the customer is redirected to their
            // locked table so they cannot silently switch tables mid-session.
            assignedTableId = existingSession.activeTableId;
            lockId          = existingSession.lockId;

        } else if (existingTableLock && existingTableLock.status === 'active') {
            if (existingTableLock.customerUid !== customerUid) {
                // Table is held by a different customer — reject.
                throw new HttpsError('already-exists',
                    `Table "${requestedTableId}" is currently occupied by another customer.`);
            }
            // Same customer, table lock still active (edge case: session doc cleared
            // but table_locks doc wasn't — recover gracefully).
            assignedTableId = requestedTableId;
            lockId          = existingTableLock.lockId;

        } else {
            // Table is free — atomically acquire the lock.
            assignedTableId = requestedTableId;
            lockId          = `lock_${customerUid}_${Date.now()}`;
            isNewLock       = true;

            // Write the per-table sentinel.  If two transactions reach here
            // simultaneously, Firestore will detect the write-write conflict
            // and abort one of them, causing it to retry the whole transaction
            // where it will now find the lock taken and throw already-exists.
            tx.set(tableLockRef, {
                customerUid,
                lockId,
                lockedAt: FieldValue.serverTimestamp(),
                status:   'active'
            });
        }

        // Create the order document.
        const orderId    = `ORD_${Date.now()}_${customerUid.slice(0, 6)}`;
        const orderRef   = db.collection('pending_table_orders').doc(orderId);
        const totalPrice = items.reduce((s, i) => s + (i.price * (i.quantity || 1)), 0);

        tx.set(orderRef, {
            tableId: assignedTableId,
            customer: {
                uid:   customerUid,
                name:  customer.name  || '',
                phone: customerPhone  || customer.phone || ''
            },
            customerSessionId: customerUid,
            tableLockId:       lockId,
            status:            'pending',
            items,
            totalPrice,
            createdAt: FieldValue.serverTimestamp()
        });

        // Update the customer session.
        const newOrderIds = (existingSession?.activeOrderIds || []).concat(orderId);
        const sessionData = {
            customerUid,
            phone:          customerPhone || customer.phone || '',
            activeTableId:  assignedTableId,
            lockStatus:     'active',
            lockId,
            activeOrderIds: newOrderIds,
            releasedAt:     null
        };
        if (isNewLock) sessionData.lockedAt = FieldValue.serverTimestamp();
        tx.set(sessionRef, sessionData, { merge: true });

        return { orderId, tableId: assignedTableId, sessionId: customerUid, lockId };
    });

    return result;
});

// ─────────────────────────────────────────────────────────────────────────────
// releaseTableLock
//
// Called by the Billing Panel (cart.js) on Bill & Settle or SAVE & EXIT.
//
// Request: { tableId: "Table 1", releaseReason: "bill_settle" | "save_exit" }
// Response: { released: true, tableId, releaseReason }
//        or { released: false, reason: "no_active_session" }
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
            releasedAt:     FieldValue.serverTimestamp()
        });

        // Clear the per-table sentinel so the table becomes available again
        const tableLockRef = db.collection('table_locks').doc(tableId);
        tx.set(tableLockRef, {
            customerUid: null,
            lockId:      null,
            status:      'released',
            releasedAt:  FieldValue.serverTimestamp()
        });
    });

    console.log(`[releaseTableLock] Released "${tableId}", reason: ${releaseReason}`);
    return { released: true, tableId, releaseReason };
});
