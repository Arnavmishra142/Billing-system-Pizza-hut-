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
import { db } from './firebase-config.js';
import {
    doc, runTransaction, getDoc, serverTimestamp, deleteField,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

export const PIZZA_OFFER_ID    = 'pizza_spring_roll';
export const PIZZA_OFFER_LABEL = 'Any Pizza → Spring Roll FREE';
export const FREE_ITEM_ID      = `FREEOFFER_${PIZZA_OFFER_ID}`;

export class OfferError extends Error {
    constructor(code, message) { super(message); this.code = code; }
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

/** Atomically claim. Throws OfferError('ALREADY_CLAIMED' | 'PENDING' | 'NO_PHONE'). */
export async function claimOffer({ phone, name, slotKey, value, itemName }) {
    const p = _normPhone(phone);
    if (!p) throw new OfferError('NO_PHONE', 'Enter a valid 10-digit phone number for this customer first.');
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
    return { claimToken, phone: p };
}

/** Undo a NOT-yet-settled claim (Pizza removed / box unticked / order cancelled). */
export async function releaseClaim({ phone, claimToken }) {
    const p = _normPhone(phone);
    if (!p || !claimToken) return false;
    const ref = doc(db, 'customers', p);
    return runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const c = snap.exists() ? snap.data().offerClaims?.[PIZZA_OFFER_ID] : null;
        if (!c || c.finalized === true || c.claimToken !== claimToken) return false;
        tx.update(ref, { [`offerClaims.${PIZZA_OFFER_ID}`]: deleteField() });
        return true;
    });
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
    const ref = doc(db, 'customers', p);
    return runTransaction(db, async (tx) => {
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
