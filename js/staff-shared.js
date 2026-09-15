// js/staff-shared.js
// AI UPDATE [2026-09-15]: NEW FILE — Staff Management feature.
//
// Single Firestore data layer shared by BOTH access points:
//   • POS / Manager screen  → staff.html + js/staff-pos.js
//   • Admin Panel           → js/staff-admin.js (admin/index.html "Staff" tab)
//
// Per the task spec there must be ONE source of truth — no "adminStaff" /
// "posStaff" split collections. Both UIs import this module and read/write
// the exact same Firestore documents.
//
// Firestore shape (documented in ARCHITECTURE_LOCK.md §5):
//   staff/{staffId}
//     { name, workType, active, joinedAt, createdAt, updatedAt, deletedAt?,
//       profileImageUrl?, profileImagePublicId? }
//   staff/{staffId}/dailyRecords/{YYYY-MM-DD}
//     { date, holiday, advance, note, updatedAt }
//
// AI UPDATE [2026-09-15] session 3: Staff profile photo support.
// profileImageUrl / profileImagePublicId live on the staff/{staffId} PROFILE
// document only — never inside dailyRecords/{date}. This is permanent
// staff-profile data (like name/workType), not daily history, so changing a
// staff member's photo can never affect any daily Holiday/Advance record.
// Images are uploaded through the EXISTING Cloudinary unsigned-upload system
// (js/cloudinary-upload.js) — no new upload provider, no new config.
//
// ONE STAFF MEMBER + ONE DATE = ONE DAILY RECORD (dailyRecords doc ID is the
// date key itself, so saveDailyRecord() can never create a second record for
// the same staff+date, and updating one date's record can never touch any
// other date's record — see saveDailyRecord()).
//
// Auth: follows the mandatory anonymous-auth bootstrap pattern used by every
// other Firestore-writing module in this app (expense.js, customers.js,
// admin-menu.js) — see ARCHITECTURE_LOCK.md §6 "Realtime listener pattern"
// and §7 rule 15. Firestore rules restrict staff/* and its dailyRecords
// subcollection to isOperator() only (see firestore.rules) — customers can
// never read staff data.

import { db, auth } from './firebase-config.js';
import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { onAuthStateChanged, signInAnonymously }
    from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// ── Auth bootstrap (mandatory pattern — mirrors js/customers.js) ───────────
signInAnonymously(auth).catch(() => {});

let _authReady = false;
const _authQueue = [];
onAuthStateChanged(auth, user => {
    if (user && !_authReady) {
        _authReady = true;
        _authQueue.splice(0).forEach(r => r());
    }
});
export const waitForStaffAuth = () =>
    _authReady ? Promise.resolve() : new Promise(r => _authQueue.push(r));

// ── Date helpers ────────────────────────────────────────────────────────────
// Local calendar date (NOT UTC) so "today" matches the operator's own clock,
// not a server/UTC day boundary — a manager entering data at 11:45pm or
// 12:15am must land on the day they actually mean.
export function dateKey(d = new Date()) {
    const y   = d.getFullYear();
    const m   = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// "2026-09-15" -> "15 Sep 2026"
export function formatDateLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function addDaysToKey(key, delta) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta);
    return dateKey(dt);
}

export function isFutureKey(key) {
    return key > dateKey();
}

// ── Staff profile CRUD ──────────────────────────────────────────────────────
const STAFF_COL = 'staff';

// Reads the whole (small, restaurant-scale) staff collection. `includeInactive`
// is used only by the Admin panel's own logic if it ever needs deleted staff;
// both the POS list and the default Admin list hide soft-deleted staff.
export async function fetchStaffList({ includeInactive = false } = {}) {
    await waitForStaffAuth();
    const snap = await getDocs(collection(db, STAFF_COL));
    let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!includeInactive) list = list.filter(s => s.active !== false);
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return list;
}

export async function getStaffMember(staffId) {
    await waitForStaffAuth();
    const snap = await getDoc(doc(db, STAFF_COL, staffId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function addStaffMember({ name, workType }) {
    await waitForStaffAuth();
    const ref = await addDoc(collection(db, STAFF_COL), {
        name: (name || '').trim(),
        workType: (workType || '').trim(),
        active: true,
        joinedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
    return ref.id;
}

export async function updateStaffMember(staffId, { name, workType }) {
    await waitForStaffAuth();
    await updateDoc(doc(db, STAFF_COL, staffId), {
        name: (name || '').trim(),
        workType: (workType || '').trim(),
        updatedAt: serverTimestamp(),
    });
}

// Set/replace a staff member's profile photo. Kept as its own function
// (separate from updateStaffMember) so a photo change is a small, isolated
// write that never touches name/workType, and — just as importantly — an
// unrelated name/workType edit via updateStaffMember() never touches the
// photo fields either, since Firestore updateDoc() only writes the keys it
// is given. The Cloudinary upload itself must already have succeeded before
// this is called; this function only persists the resulting reference.
export async function updateStaffPhoto(staffId, { url, publicId }) {
    await waitForStaffAuth();
    await updateDoc(doc(db, STAFF_COL, staffId), {
        profileImageUrl: url || null,
        profileImagePublicId: publicId || null,
        updatedAt: serverTimestamp(),
    });
}

// Soft delete. The task spec explicitly warns against destroying historical
// daily records just because a staff member is removed ("Do NOT blindly
// delete historical daily records if doing so would destroy useful business
// history"). This mirrors the existing `active` soft-hide convention already
// used on menu_items/products/categories: the profile is marked inactive and
// disappears from both the POS and Admin staff lists, but the document (and
// its full dailyRecords history) is left intact in Firestore.
export async function deleteStaffMember(staffId) {
    await waitForStaffAuth();
    await updateDoc(doc(db, STAFF_COL, staffId), {
        active: false,
        deletedAt: serverTimestamp(),
    });
}

// ── Daily records ────────────────────────────────────────────────────────────
function dailyCol(staffId) {
    return collection(db, STAFF_COL, staffId, 'dailyRecords');
}

// Returns null when no record exists for this staff+date. IMPORTANT: a null
// return is NOT an error or "unknown" state — every caller (POS and Admin)
// MUST interpret it as the default: Working (holiday:false), Advance ₹0, no
// note. This is intentional — see "DEFAULT STATUS MUST BE WORKING" in the
// task spec (2026-09-15 session 2): we do not pre-create a "Working, ₹0"
// document for every staff+date just to avoid ever returning null.
export async function getDailyRecord(staffId, key) {
    await waitForStaffAuth();
    const snap = await getDoc(doc(dailyCol(staffId), key));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// setDoc(..., {merge:true}) on a doc ID equal to the date key guarantees
// "one staff + one date = one daily record": saving 15 Sep can never create a
// second doc for 15 Sep, and can never touch the 14 Sep or 16 Sep documents.
export async function saveDailyRecord(staffId, key, { holiday, advance, note }) {
    await waitForStaffAuth();
    await setDoc(doc(dailyCol(staffId), key), {
        date: key,
        holiday: !!holiday,
        advance: Number(advance) || 0,
        note: (note || '').trim(),
        updatedAt: serverTimestamp(),
    }, { merge: true });
}

// All daily records for one staff member, newest first. Used for the Admin
// "complete history" view and for all-time totals. A restaurant's per-staff
// record count is small (at most ~1 doc/day since the staff member joined),
// so a single getDocs (no composite index required) is the simplest safe
// approach — matches the "keep it simple" instruction in the task spec.
export async function fetchAllDailyRecords(staffId) {
    await waitForStaffAuth();
    const snap = await getDocs(dailyCol(staffId));
    return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => b.id.localeCompare(a.id));
}

// Records within [fromKey, toKey] inclusive. Date keys are zero-padded
// YYYY-MM-DD strings, so lexical string comparison is exactly chronological
// comparison — no Date parsing needed. Only dates that actually have a saved
// record are returned; no synthetic empty-day rows are invented for gaps.
export function filterRecordsInRange(records, fromKey, toKey) {
    return records.filter(r => r.id >= fromKey && r.id <= toKey);
}

// Aggregate helper shared by both the "All Time" and "Selected Range" totals
// in the Admin detail view.
export function summarizeRecords(records) {
    let holidayDays = 0;
    let totalAdvance = 0;
    records.forEach(r => {
        if (r.holiday) holidayDays++;
        totalAdvance += Number(r.advance) || 0;
    });
    return { holidayDays, totalAdvance, count: records.length };
}
