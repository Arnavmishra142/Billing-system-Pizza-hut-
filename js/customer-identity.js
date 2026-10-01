// ═══════════════════════════════════════════════════════════════════════════
// customer-identity.js — [AI UPDATE 2026-10-01] POS "Edit Customer" (name + phone)
//
// SOURCE OF TRUTH
//   customers/{+91XXXXXXXXXX}  — the doc ID *is* the phone (see ARCHITECTURE_LOCK.md §5).
//   Every other UI (Admin Customers list/detail, POS badge, coupons panel, Customer
//   Panel greeting/session/offers) reads name/phone from this document, so this module
//   edits THAT document and nothing else is "the customer".
//
// WHAT NEVER CHANGES ON A PHONE CHANGE (so history stays attached)
//   • customers.uid (or legacy authUid)  → customer_order_history/{uid}/orders is keyed
//     by it. It is copied verbatim to the new doc. For walk-in profiles created by
//     POS billing, uid == the ORIGINAL phone string; that is just an opaque ID and
//     stays as-is. If a legacy doc has neither uid nor authUid we pin uid = old phone
//     so history keeps resolving (readers fall back to phone otherwise → would split).
//   • totalOrders / lifetimeSpend / lastOrderAt / milestoneCouponIssued / createdAt /
//     passwordHash / username / every other field — copied via spread.
//
// WHAT MOVES ON A PHONE CHANGE (one atomic transaction — all or nothing)
//   1. customers/{new}  ← full copy of customers/{old} with new phone + name
//   2. customers/{old}  ← deleted
//   3. usernames/{username}.phone → new   (registry link back to the profile)
//   4. coupons/*  where phone == old → phone = new (name refreshed on UNUSED coupons only)
//   5. customer_phone_redirects/{old} ← { newPhone, uid, name }  (lets a Customer Panel
//      session that still holds the old phone find the profile; see auth.js there)
//   6. customer_phone_redirects/{new} deleted if present (that number is live again)
//
// PASSWORD
//   passwordHash = SHA-256(password + ":" + phone). Staff can't know the password, so
//   the hash can't be recomputed. We record `passwordHashPhone` (the phone the hash was
//   made with) and the Customer Panel login also tries that salt. Recovery-reset (Worker)
//   writes a hash using the CURRENT phone, which the login tries first — no Worker change.
//
// NOT REWRITTEN (immutable snapshots, per ARCHITECTURE_LOCK.md)
//   sales_history.onlineCustomerName/Phone, manualCustomerName/Phone,
//   customer_order_history/*/orders/*.customerName/customerPhone, pending_table_orders.customer.
//
// COLLISION
//   If customers/{new} exists the transaction aborts with code PHONE_IN_USE. Nothing is
//   overwritten or merged.
// ═══════════════════════════════════════════════════════════════════════════

import { db } from './firebase-config.js';
import {
    doc, getDoc, getDocs, collection, query, where,
    runTransaction, updateDoc, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

export class CustomerIdentityError extends Error {
    constructor(code, message) { super(message); this.name = 'CustomerIdentityError'; this.code = code; }
}

// ── Validation ───────────────────────────────────────────────────────────────
// Phone: the project's existing rule everywhere (Customer Panel auth.js, POS dialog.js,
// customer.html) is "exactly 10 digits", stored as "+91" + 10 digits. No other rule
// exists, so none is invented here.
// Name: existing rule is trim + at least 2 chars + maxlength 40 (Customer Panel
// registration). We additionally require a letter and reject < > (names are rendered
// into HTML in several drawers).
export function validateCustomerIdentity({ name, phone }) {
    const cleanName = String(name ?? '').replace(/\s+/g, ' ').trim();
    if (cleanName.length < 2)  return { ok: false, field: 'name',  error: 'Enter the customer\u2019s name (at least 2 characters).' };
    if (cleanName.length > 40) return { ok: false, field: 'name',  error: 'Name is too long (max 40 characters).' };
    if (!/\p{L}/u.test(cleanName)) return { ok: false, field: 'name', error: 'Name must contain letters.' };
    if (/[<>]/.test(cleanName)) return { ok: false, field: 'name',  error: 'Name contains invalid characters.' };

    const digits = String(phone ?? '').replace(/\D/g, '');
    if (digits.length !== 10) return { ok: false, field: 'phone', error: 'Enter a valid 10-digit mobile number.' };

    return { ok: true, name: cleanName, phone10: digits, phone: `+91${digits}` };
}

const _last10 = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);

// ── Main entry ───────────────────────────────────────────────────────────────
// oldPhone: "+91XXXXXXXXXX" currently attached to the POS slot.
// Returns { mode: 'updated'|'migrated'|'local', phone, name, oldPhone }.
// Throws CustomerIdentityError (message is safe to show to staff).
export async function updateCustomerIdentity({ oldPhone, name, phone }) {
    const v = validateCustomerIdentity({ name, phone });
    if (!v.ok) throw new CustomerIdentityError('INVALID', v.error);
    if (!oldPhone) throw new CustomerIdentityError('NO_CUSTOMER', 'No customer is attached to this order.');

    try {
        if (v.phone === oldPhone) return await _updateNameOnly(oldPhone, v.name);
        return await _migratePhone(oldPhone, v.phone, v.name);
    } catch (err) {
        throw _friendly(err);
    }
}

function _friendly(err) {
    if (err instanceof CustomerIdentityError) return err;
    const c = err && err.code;
    if (c === 'permission-denied') return new CustomerIdentityError('PERMISSION',
        'Not allowed by database rules. Deploy the updated firestore.rules (see AI_HANDOFF.md) and try again.');
    if (c === 'unavailable' || c === 'deadline-exceeded' || (c === 'failed-precondition' && /offline/i.test(err.message || '')))
        return new CustomerIdentityError('OFFLINE', 'No connection. Nothing was changed — please try again when online.');
    console.error('[customer-identity] unexpected failure:', err);
    return new CustomerIdentityError('UNKNOWN', 'Could not save the change. Nothing was changed. Please try again.');
}

// Same phone → just the name on the profile (doc ID unchanged, so no migration).
async function _updateNameOnly(phone, name) {
    const ref = doc(db, 'customers', phone);
    try {
        await updateDoc(ref, { name, updatedAt: serverTimestamp() });
    } catch (err) {
        if (err && err.code === 'not-found') {
            // No profile yet (walk-in picked in the POS popup but not billed): the identity
            // lives only in this POS slot, so only the local slot is updated by the caller.
            return { mode: 'local', phone, name, oldPhone: phone };
        }
        throw err;
    }
    _syncCouponNames(phone, name).catch(e => console.warn('[customer-identity] coupon name sync (non-fatal):', e));
    return { mode: 'updated', phone, name, oldPhone: phone };
}

async function _syncCouponNames(phone, name) {
    const snap = await getDocs(query(collection(db, 'coupons'), where('phone', '==', phone)));
    const batch = writeBatch(db);
    let n = 0;
    snap.forEach(d => { const c = d.data(); if (!c.used && c.name !== name) { batch.update(d.ref, { name }); n++; } });
    if (n) await batch.commit();
}

async function _migratePhone(oldPhone, newPhone, name) {
    const oldRef = doc(db, 'customers', oldPhone);
    const newRef = doc(db, 'customers', newPhone);

    // Coupon IDs must be known before the transaction (client transactions can't run queries).
    // Failing here aborts the whole change rather than risking orphaned coupons.
    const couponSnap = await getDocs(query(collection(db, 'coupons'), where('phone', '==', oldPhone)));

    const result = await runTransaction(db, async (tx) => {
        const peek = await tx.get(oldRef);
        const oldData = peek.exists() ? peek.data() : null;
        const username = oldData && oldData.username ? String(oldData.username) : '';
        const unameRef = username ? doc(db, 'usernames', username) : null;
        const redirNewRef = doc(db, 'customer_phone_redirects', newPhone);

        const [newSnap, unameSnap, redirNewSnap] = await Promise.all([
            tx.get(newRef),
            unameRef ? tx.get(unameRef) : Promise.resolve(null),
            tx.get(redirNewRef),
        ]);

        if (!oldData) return { mode: 'local' };   // no profile yet — handled below

        if (newSnap.exists()) {
            const other = newSnap.data() || {};
            throw new CustomerIdentityError('PHONE_IN_USE',
                `This number (${newPhone.replace(/^\+91/, '')}) already belongs to another customer` +
                `${other.name ? ` (${other.name})` : ''}. Nothing was changed.`);
        }

        const previousPhones = Array.isArray(oldData.previousPhones) ? oldData.previousPhones.slice() : [];
        if (!previousPhones.includes(oldPhone)) previousPhones.push(oldPhone);

        const migrated = {
            ...oldData,
            phone: newPhone,
            name,
            phoneVerified: false,                       // required by the customers create rule (bridge mode: always false)
            uid: oldData.uid || oldData.authUid || oldPhone,   // never changes; pin if legacy doc had none
            previousPhones,
            phoneChangedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        };
        if (oldData.passwordHash && !oldData.passwordHashPhone) migrated.passwordHashPhone = oldPhone;

        tx.set(newRef, migrated);
        tx.delete(oldRef);

        if (unameRef && unameSnap && unameSnap.exists() && unameSnap.data().phone === oldPhone) {
            tx.update(unameRef, { phone: newPhone });
        }
        if (redirNewSnap.exists()) tx.delete(redirNewRef);
        tx.set(doc(db, 'customer_phone_redirects', oldPhone), {
            newPhone, uid: migrated.uid, name, movedAt: serverTimestamp(),
        });

        couponSnap.forEach(cd => {
            const c = cd.data();
            tx.update(cd.ref, c.used ? { phone: newPhone } : { phone: newPhone, name });
        });

        return { mode: 'migrated' };
    });

    if (result.mode === 'local') {
        // No customers/{old} doc. Still never attach this slot to someone else's profile.
        const clash = await getDoc(newRef);
        if (clash.exists()) {
            const other = clash.data() || {};
            throw new CustomerIdentityError('PHONE_IN_USE',
                `This number (${newPhone.replace(/^\+91/, '')}) already belongs to another customer` +
                `${other.name ? ` (${other.name})` : ''}. Nothing was changed.`);
        }
        return { mode: 'local', phone: newPhone, name, oldPhone };
    }

    // Best-effort sweep for a coupon issued between our query and the commit.
    _sweepCoupons(oldPhone, newPhone).catch(e => console.warn('[customer-identity] coupon sweep (non-fatal):', e));
    return { mode: 'migrated', phone: newPhone, name, oldPhone };
}

async function _sweepCoupons(oldPhone, newPhone) {
    const snap = await getDocs(query(collection(db, 'coupons'), where('phone', '==', oldPhone)));
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.forEach(d => batch.update(d.ref, { phone: newPhone }));
    await batch.commit();
}

// ── POS local state (localStorage) ───────────────────────────────────────────
// The POS keeps the attached customer per table/slot in localStorage. Every slot that
// held the old phone (this table or any other open table) is switched to the new
// identity so Bill & Settle / Save & Exit / coupons / "Open in POS" slot matching all
// use the corrected values. Synchronous — call right after a successful save.
export function applyIdentityToLocalSlots(oldPhone, newPhone, name) {
    const old10 = _last10(oldPhone);
    const new10 = _last10(newPhone);
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));

    for (const key of keys) {
        if (!key) continue;
        try {
            if (key.startsWith('customerPhone_') && _last10(localStorage.getItem(key)) === old10) {
                const suffix = key.slice('customerPhone_'.length);
                localStorage.setItem(key, newPhone);
                localStorage.setItem(`customerName_${suffix}`, name);

                const mKey = `manualCustomerIdentity_${suffix}`;
                const raw = localStorage.getItem(mKey);
                if (raw) {
                    const m = JSON.parse(raw);
                    if (m && _last10(m.phone) === old10) localStorage.setItem(mKey, JSON.stringify({ ...m, name, phone: new10 }));
                }
            } else if (key.startsWith('customerSlotMap_')) {
                const map = JSON.parse(localStorage.getItem(key) || '{}');
                let changed = false;
                for (const slot of Object.keys(map)) {
                    if (map[slot] && map[slot].phone && _last10(map[slot].phone) === old10) { map[slot].phone = newPhone; changed = true; }
                }
                if (changed) localStorage.setItem(key, JSON.stringify(map));
            }
        } catch (e) { console.warn('[customer-identity] local slot sync skipped for', key, e); }
    }
}

// ── Live profile resolver ────────────────────────────────────────────────────
// Used when a QR order arrives carrying a phone/name snapshot taken before staff edited
// the customer. Follows customer_phone_redirects (max 5 hops) to the current profile.
// Returns { phone, name, uid } or null (caller keeps the snapshot). When `uid` is given
// and the found profile belongs to a different uid, returns null (never adopt a stranger).
export async function resolveLiveCustomer(phone, uid = '') {
    if (!phone) return null;
    let current = phone;
    for (let hop = 0; hop < 5; hop++) {
        const snap = await getDoc(doc(db, 'customers', current));
        if (snap.exists()) {
            const d = snap.data();
            const docUid = d.uid || d.authUid || '';
            if (uid && docUid && docUid !== uid) return null;
            return { phone: d.phone || current, name: d.name || '', uid: docUid };
        }
        const r = await getDoc(doc(db, 'customer_phone_redirects', current));
        if (!r.exists() || !r.data().newPhone) return null;
        current = r.data().newPhone;
    }
    return null;
}
