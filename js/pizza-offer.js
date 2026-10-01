// ═══════════════════════════════════════════════════════════════════════════
// pizza-offer.js — [AI UPDATE 2026-10-01] "Any Pizza → 1 Spring Roll FREE"
//
// ONE-TIME, CUSTOMER-SPECIFIC offer.
//
// SOURCE OF TRUTH
//   customers/{+91XXXXXXXXXX}.offerClaims.pizza_spring_roll   (same customer doc that
//   already holds uid / stats / username — NO new customer system, NO new collection).
//   Because the claim lives on the customer doc:
//     • it survives refresh / logout / other devices / future orders,
//     • it travels with the profile on the POS "Edit Customer" phone migration
//       (js/customer-identity.js copies the whole doc by spread),
//     • the Customer Panel reads the very same field (customers is readable by any
//       signed-in client; only operators can write — firestore.rules, unchanged).
//
// CLAIM RECORD SHAPE
//   offerClaims.pizza_spring_roll = {
//     status:       'claimed',          // always 'claimed' — blocks every further claim
//     finalized:    false | true,       // false = taken at POS but bill not settled yet
//     claimToken:   'c_…',              // proves WHICH POS slot/session holds the claim
//     claimedAt:    Timestamp,
//     value:        number,             // menu price of the Spring Roll (₹, display only)
//     itemName:     'Spring Roll',
//     slotKey:      'Table 3_C1',
//     orderId / billNumber / settledAt  // set by finalizeClaim() when the bill is settled
//   }
//
// RACE / DUPLICATE SAFETY
//   claimOffer() / releaseClaim() / finalizeClaim() are Firestore TRANSACTIONS on the
//   customer doc: two POS sessions (or a double click) can never both succeed — the
//   second one reads status 'claimed' and is rejected.
//   releaseClaim() only works while finalized === false AND the claimToken matches, so a
//   settled claim can never be un-claimed by a stale cart/slot.
// ═══════════════════════════════════════════════════════════════════════════
import { db, auth } from './firebase-config.js';
import { signInAnonymously } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import {
    doc, runTransaction, getDoc, setDoc, updateDoc, serverTimestamp, deleteField,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

export const PIZZA_OFFER_ID    = 'pizza_spring_roll';
export const PIZZA_OFFER_LABEL = 'Any Pizza → Spring Roll FREE';
export const FREE_ITEM_ID      = `FREEOFFER_${PIZZA_OFFER_ID}`;

export class OfferError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

/** Firestore rules need a signed-in (operator/anonymous) session — make sure one exists before any write. */
async function _ensureAuth() {
    try { if (typeof auth.authStateReady === 'function') await auth.authStateReady(); } catch (_) {}
    if (!auth.currentUser) await signInAnonymously(auth);
}

/** True when Firestore refused because of quota / outage (NOT a business-rule rejection). */
export function isServerUnavailable(err) {
    const code = String(err?.code || '').replace('firestore/', '');
    return code === 'resource-exhausted' || code === 'unavailable' || code === 'deadline-exceeded' || /offline|quota/i.test(err?.message || '');
}

/** Turn a raw Firebase error into a short message that tells staff what to do. */
export function describeOfferError(err) {
    const code = String(err?.code || '').replace('firestore/', '').replace('auth/', '');
    if (code === 'resource-exhausted') return 'Firebase daily quota is used up — resets automatically (≈12:30 PM IST) or upgrade to Blaze. (resource-exhausted)';
    if (code === 'permission-denied')  return 'Permission denied by Firestore rules — deploy the latest firestore.rules and make sure the POS is signed in. (permission-denied)';
    if (code === 'unavailable' || code === 'deadline-exceeded' || /offline/i.test(err?.message || ''))
        return 'No connection to the server — check internet and try again. (' + (code || 'offline') + ')';
    if (code === 'unauthenticated' || code === 'admin-restricted-operation' || code === 'operation-not-allowed')
        return 'POS is not signed in — enable Anonymous sign-in in Firebase Auth, then reload. (' + code + ')';
    return 'Could not apply the offer: ' + (code || err?.name || 'error') + (err?.message ? ' — ' + String(err.message).slice(0, 120) : '');
}

const _normPhone = (p) => {
    const d = String(p || '').replace(/\D/g, '').slice(-10);
    return d.length === 10 ? `+91${d}` : '';
};

/** Category counts as Pizza when it is just the word (any case / plural / emoji): "Pizza", "Pizzas", "🍕 Pizza". */
const _isPizzaCategory = (c) => /^[^a-z0-9]*pizzas?[^a-z0-9]*$/i.test(String(c || ''));

/** Eligible = a real menu item in the "Pizza" category (same test js/menu.js uses). */
export function isEligiblePizzaItem(cartItem) {
    if (!cartItem || cartItem.freeOffer) return false;
    if (!(Number(cartItem.price) > 0) || !(Number(cartItem.qty) > 0)) return false;
    if (cartItem.category) return _isPizzaCategory(cartItem.category);
    // Cart rows added without a category (stepper / customer-panel merge): look the item up on the
    // live menu by id, then by exact name.
    const menu = Array.isArray(window._posMenuItems) ? window._posMenuItems : [];
    const nm = String(cartItem.name || '').trim().toLowerCase();
    const m = menu.find(x => x.id === cartItem.id) || (nm ? menu.find(x => String(x.name || '').trim().toLowerCase() === nm) : null);
    return !!m && _isPizzaCategory(m.category);
}
export const cartHasEligiblePizza = (cart) => (cart || []).some(isEligiblePizzaItem);

/** Cheapest in-stock "Spring Roll" on the live POS menu (value of the free item). */
export function findSpringRollMenuItem() {
    const menu = Array.isArray(window._posMenuItems) ? window._posMenuItems : [];
    const hits = menu.filter(x => /spring\s*roll/i.test(x.name || '') && !/pizza/i.test(x.name || '') && x.inStock !== false);
    hits.sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
    return hits[0] || null;
}

/** Read the authoritative claim for a phone (null = never claimed / no profile). */
export async function getClaim(phone) {
    const p = _normPhone(phone);
    if (!p) return null;
    const snap = await getDoc(doc(db, 'customers', p));
    return snap.exists() ? (snap.data().offerClaims?.[PIZZA_OFFER_ID] || null) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// QUOTA-PROOF MODE  [AI UPDATE 2026-10-01]
// Firestore's free daily READ quota can run out while WRITES still work. Transactions need reads, so:
//   • DEVICE LEDGER (localStorage): remembers which phones used / reserved the offer on THIS POS device,
//     so staff can still apply it manually without double-giving it to the same customer.
//   • BLIND FINALIZE: settling stamps customers/{phone}.offerClaims with a plain updateDoc/setDoc
//     (no read needed) so Admin + the Customer Panel still see "Claimed".
//   • SYNC QUEUE: if even that write fails, it is queued in localStorage and retried automatically
//     on the next load / when the connection comes back.
// ═══════════════════════════════════════════════════════════════════════════
const _LEDGER_KEY = 'nph_offer_ledger';
const _QUEUE_KEY  = 'nph_offer_sync_queue';
const _PENDING_TTL_MS = 12 * 60 * 60 * 1000; // an unsettled device reservation expires after 12 h
const _p10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const _lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (_) { return d; } };
const _lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

export function ledgerGet(phone) {
    const k = _p10(phone); if (!k) return null;
    const e = _lsGet(_LEDGER_KEY, {})[k];
    if (!e) return null;
    if (e.state === 'pending' && Date.now() - (e.ts || 0) > _PENDING_TTL_MS) return null;
    return e;
}
export function ledgerSet(phone, entry) {
    const k = _p10(phone); if (!k) return;
    const all = _lsGet(_LEDGER_KEY, {}); all[k] = { ...entry, ts: Date.now() }; _lsSet(_LEDGER_KEY, all);
}
export function ledgerClear(phone) {
    const k = _p10(phone); if (!k) return;
    const all = _lsGet(_LEDGER_KEY, {}); if (all[k]) { delete all[k]; _lsSet(_LEDGER_KEY, all); }
}

/** Manual apply while Firestore is unreachable: only the device ledger can say "already used". */
export function claimOfferLocal({ phone, slotKey }) {
    const p = _normPhone(phone);
    if (!p) throw new OfferError('NO_PHONE', 'Enter a valid 10-digit phone number for this customer first.');
    const e = ledgerGet(p);
    if (e && (e.state === 'settled' || (e.state === 'pending' && e.slotKey !== slotKey))) {
        throw new OfferError('ALREADY_CLAIMED', e.state === 'settled'
            ? '❌ This customer already used the free Spring Roll (recorded on this device).'
            : '❌ This customer already has the offer on another open bill on this device.');
    }
    ledgerSet(p, { state: 'pending', slotKey: slotKey || '' });
    return { phone: p };
}

const _withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'deadline-exceeded' })), ms))]);

async function _blindFinalize({ phone, orderId, billNumber, value, itemName }) {
    const p = _normPhone(phone);
    if (!p) return;
    await _ensureAuth();
    const ref = doc(db, 'customers', p);
    const claim = {
        status: 'claimed', finalized: true, claimToken: '', slotKey: '', manual: true,
        claimedAt: serverTimestamp(), settledAt: serverTimestamp(),
        orderId: orderId || null, billNumber: billNumber || null,
        value: Number(value) || 0, itemName: itemName || 'Spring Roll',
    };
    try {
        await _withTimeout(updateDoc(ref, { [`offerClaims.${PIZZA_OFFER_ID}`]: claim }), 8000);
    } catch (e) {
        if (e?.code !== 'not-found') throw e;
        await _withTimeout(setDoc(ref, {              // walk-in with no profile yet — same shape the POS creates
            phone: p, name: 'Customer', uid: p, phoneVerified: false,
            createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
            totalOrders: 0, lifetimeSpend: 0, lastOrderAt: null, source: 'manual_pos',
            offerClaims: { [PIZZA_OFFER_ID]: claim },
        }), 8000);
    }
}

function _queueFinalize(entry) {
    const q = _lsGet(_QUEUE_KEY, []);
    if (!q.some(x => _p10(x.phone) === _p10(entry.phone))) { q.push(entry); _lsSet(_QUEUE_KEY, q); }
}

/** Retry queued claim writes (safe to call any time; each entry is removed only after its write succeeds). */
export async function flushOfferQueue() {
    let q = _lsGet(_QUEUE_KEY, []);
    if (!q.length) return 0;
    let done = 0;
    for (const entry of q.slice()) {
        try {
            await _blindFinalize(entry);
            _lsSet(_QUEUE_KEY, _lsGet(_QUEUE_KEY, []).filter(x => _p10(x.phone) !== _p10(entry.phone)));
            done++;
        } catch (e) { break; } // still unreachable — try again next time
    }
    return done;
}
setTimeout(() => { flushOfferQueue().catch(() => {}); }, 5000);
if (typeof window !== 'undefined') window.addEventListener('online', () => { flushOfferQueue().catch(() => {}); });

/** Atomically claim. Throws OfferError('ALREADY_CLAIMED' | 'PENDING' | 'NO_PHONE'). */
export async function claimOffer({ phone, name, slotKey, value, itemName }) {
    const p = _normPhone(phone);
    if (!p) throw new OfferError('NO_PHONE', 'Enter a valid 10-digit phone number for this customer first.');
    await _ensureAuth();
    const ref = doc(db, 'customers', p);
    let claimToken = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const claim = {
            status: 'claimed', finalized: false, claimToken,
            claimedAt: serverTimestamp(),
            value: Number(value) || 0, itemName: itemName || 'Spring Roll',
            slotKey: slotKey || '',
        };
        if (!snap.exists()) {
            // Walk-in typed at the POS whose profile is normally created at settlement
            // (syncManualCustomerProfile). Create the SAME shape it would, so there is still ONE
            // customer record per phone (that function reuses it as-is when it exists).
            tx.set(ref, {
                phone: p, name: (name || '').trim() || 'Customer', uid: p, phoneVerified: false,
                createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
                totalOrders: 0, lifetimeSpend: 0, lastOrderAt: null, source: 'manual_pos',
                offerClaims: { [PIZZA_OFFER_ID]: claim },
            });
            return;
        }
        const existing = snap.data().offerClaims?.[PIZZA_OFFER_ID];
        if (existing) {
            if (existing.finalized === true) {
                ledgerSet(p, { state: 'settled' });
                throw new OfferError('ALREADY_CLAIMED', 'This customer has already used the free Spring Roll offer.');
            }
            // Unsettled claim made from THIS SAME table/slot (e.g. the browser storage marker was lost
            // after a refresh / cache clear) → take it over instead of locking the operator out.
            if (slotKey && existing.slotKey === slotKey && existing.claimToken) {
                claimToken = existing.claimToken;
                return;
            }
            throw new OfferError('PENDING', 'This customer already has the offer reserved on another open bill. Settle/cancel that bill, or release it from Admin → Customers.');
        }
        tx.update(ref, { [`offerClaims.${PIZZA_OFFER_ID}`]: claim });
    });
    ledgerSet(p, { state: 'pending', slotKey: slotKey || '' });
    return { claimToken, phone: p };
}

/** Undo a NOT-yet-settled claim (Pizza removed / box unticked / order cancelled). */
export async function releaseClaim({ phone, claimToken }) {
    const p = _normPhone(phone);
    if (!p) return false;
    const e = ledgerGet(p);
    if (!claimToken) {                       // manual (device-only) reservation — nothing on the server to undo
        if (e && e.state === 'pending') ledgerClear(p);
        return false;
    }
    await _ensureAuth();
    const ref = doc(db, 'customers', p);
    const ok = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const c = snap.exists() ? snap.data().offerClaims?.[PIZZA_OFFER_ID] : null;
        if (!c || c.finalized === true || c.claimToken !== claimToken) return false;
        tx.update(ref, { [`offerClaims.${PIZZA_OFFER_ID}`]: deleteField() });
        return true;
    });
    if (ok && e && e.state === 'pending') ledgerClear(p);
    return ok;
}

/** Operator-only: release a stuck unsettled claim from Admin (never touches finalized ones). */
export async function adminReleasePending(phone) {
    const p = _normPhone(phone);
    if (!p) return false;
    const ref = doc(db, 'customers', p);
    return runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const c = snap.exists() ? snap.data().offerClaims?.[PIZZA_OFFER_ID] : null;
        if (!c || c.finalized === true) return false;
        tx.update(ref, { [`offerClaims.${PIZZA_OFFER_ID}`]: deleteField() });
        return true;
    });
}

/**
 * Settle: stamp order/bill onto the claim. Idempotent (re-settle of an Edit-History order
 * is a no-op once finalized). If the profile has no claim record at all (legacy/migrated
 * edge) a finalized one is written so the offer can never be claimed again.
 */
export async function finalizeClaim({ phone, orderId, billNumber, value, itemName }) {
    const p = _normPhone(phone);
    if (!p) return false;
    ledgerSet(p, { state: 'settled', orderId: orderId || null });   // device memory first — works with no network
    try {
        await _ensureAuth();
        const ref = doc(db, 'customers', p);
        return await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists()) return false;
            const c = snap.data().offerClaims?.[PIZZA_OFFER_ID];
            if (c && c.finalized === true) return false;
            tx.update(ref, {
                [`offerClaims.${PIZZA_OFFER_ID}`]: {
                    ...(c || { claimToken: '', claimedAt: serverTimestamp(), slotKey: '' }),
                    status: 'claimed', finalized: true,
                    orderId: orderId || null, billNumber: billNumber || null,
                    value: Number(value) || Number(c?.value) || 0,
                    itemName: itemName || c?.itemName || 'Spring Roll',
                    settledAt: serverTimestamp(),
                },
            });
            return true;
        });
    } catch (err) {
        // Reads exhausted / offline → plain write (needs no read); if that fails too, queue it for later.
        if (!isServerUnavailable(err)) throw err;
        const entry = { phone: p, orderId: orderId || null, billNumber: billNumber || null, value: Number(value) || 0, itemName: itemName || 'Spring Roll' };
        try { await _blindFinalize(entry); return true; }
        catch (e2) { _queueFinalize(entry); console.warn('[PizzaOffer] claim queued for later sync:', e2?.code || e2?.message); return false; }
    }
}

/** Build the cart item for the free Spring Roll (price 0, qty locked to 1, flagged). */
export function buildFreeCartItem({ itemName, value, claimToken }) {
    return {
        id: FREE_ITEM_ID, name: itemName || 'Spring Roll', price: 0, qty: 1,
        printedQty: 0, parcel: false, extras: [], specialRequest: '',
        freeOffer: PIZZA_OFFER_ID, offerLabel: PIZZA_OFFER_LABEL,
        offerValue: Number(value) || 0, claimToken: claimToken || '',
    };
}

/** Order-level offer record to persist beside the order (null when none). */
export function offerRecordFromCart(cart) {
    const it = (cart || []).find(i => i && i.freeOffer === PIZZA_OFFER_ID);
    if (!it) return null;
    return { offerId: PIZZA_OFFER_ID, label: PIZZA_OFFER_LABEL, status: 'Claimed',
             itemName: it.name, value: Number(it.offerValue) || 0 };
}
