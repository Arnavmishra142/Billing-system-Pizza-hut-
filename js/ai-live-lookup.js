/**
 * Live lookup tools for the Smart AI Manager (admin/chat.ai.html).
 *
 * WHY THIS FILE EXISTS:
 * js/ai-data-cache.js builds a compact SUMMARY (totals, top items, last-30-day
 * aggregates) and caches it — that's fast and cheap but, by construction,
 * throws away exact per-record detail (an expense's note, a specific day's
 * sale, a customer's exact profile, a specific staff day's advance/note).
 * No amount of enlarging the summary fixes that — something is always left
 * out. So instead of shoving more into the prompt, we give the AI a small
 * set of on-demand "tools" (Groq/OpenAI-style function calling — see
 * admin/chat.ai.html's askGroq()) that let it fetch the EXACT record it
 * needs, the moment it needs it, straight from Firestore. Summary = fast
 * overview questions ("aaj kitna revenue?"). Tools here = precise questions
 * ("19 August ko expense mein kya note tha?", "Golu ka advance kab liya?").
 *
 * SECURITY: every read here targets a collection already isOperator()-gated
 * in firestore.rules and already readable elsewhere in the Admin Panel by
 * an authenticated operator (js/expense.js, js/customers.js,
 * js/staff-shared.js). This file adds no new collections, no new auth path,
 * and reuses the exact same `db` (see js/firebase-config.js) whose session
 * is already established elsewhere in the admin app — same pattern
 * js/ai-data-cache.js already uses (no signInAnonymously call of its own).
 *
 * PRIVACY: customer phone numbers are never returned (same deliberate
 * exclusion as js/ai-data-cache.js's summarizeCustomers) — this data is
 * sent on to a third-party API (Groq), so only names + business figures
 * ever leave the app.
 *
 * These reads are NOT cached (unlike ai-data-cache.js) — each tool call
 * fetches fresh from the server every time, since the whole point is an
 * exact, current answer to a specific question asked right now.
 */
import { db } from './firebase-config.js';
import {
    collection, collectionGroup, doc, query, where,
    getDocsFromServer, getDocFromServer
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const MAX_RESULTS = 25; // cap what we hand back to the model, keeps token usage sane

function dateKey(iso) {
    const d = new Date(iso);
    return isNaN(d) ? null : d.toISOString().slice(0, 10); // YYYY-MM-DD, same convention as ai-data-cache.js
}

function isValidDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
}

/* ── Tool 1: expenses on an exact date (amount + note) ──────────────── */
async function getExpensesByDate({ date }) {
    if (!isValidDate(date)) return { error: 'date must be YYYY-MM-DD' };
    const snap = await getDocsFromServer(collection(db, 'daily_expenses'));
    const matches = [];
    snap.forEach(d => {
        const e = d.data();
        if (dateKey(e.timestamp) === date) {
            matches.push({ amount: Number(e.amount) || 0, note: e.note || '', time: e.timestamp });
        }
    });
    if (matches.length === 0) return { date, found: false, message: 'No expense recorded on this date.' };
    return {
        date, found: true, count: matches.length,
        totalAmount: Math.round(matches.reduce((s, m) => s + m.amount, 0)),
        expenses: matches.slice(0, MAX_RESULTS),
    };
}

/* ── Tool 2: sales on an exact date (per-order breakdown) ────────────── */
async function getSalesByDate({ date }) {
    if (!isValidDate(date)) return { error: 'date must be YYYY-MM-DD' };
    const snap = await getDocsFromServer(collection(db, 'sales_history'));
    const orders = [];
    snap.forEach(d => {
        const s = d.data();
        if (dateKey(s.timestamp) === date) {
            orders.push({
                time: s.timestamp,
                total: Number(s.total) || 0,
                items: (s.items || []).map(i => ({ name: i.name, qty: Number(i.qty) || 0 })),
            });
        }
    });
    if (orders.length === 0) return { date, found: false, message: 'No sale recorded on this date.' };
    return {
        date, found: true, orderCount: orders.length,
        totalRevenue: Math.round(orders.reduce((s, o) => s + o.total, 0)),
        orders: orders.slice(0, MAX_RESULTS),
    };
}

/* ── Tool 3: one customer's exact profile by name (no phone number) ──── */
async function getCustomerDetails({ name }) {
    if (!name || typeof name !== 'string') return { error: 'name is required' };
    const q = name.trim().toLowerCase();
    const snap = await getDocsFromServer(collection(db, 'customers'));
    const matches = [];
    snap.forEach(d => {
        const c = d.data();
        if ((c.name || '').toLowerCase().includes(q)) {
            matches.push({
                name: c.name || 'Unknown',
                totalOrders: c.totalOrders || 0,
                lifetimeSpend: Math.round(c.lifetimeSpend || 0),
                lastOrderAt: c.lastOrderAt?.toDate?.()?.toISOString?.().slice(0, 10) || null,
            });
        }
    });
    if (matches.length === 0) return { found: false, message: `No customer matching "${name}".` };
    return { found: true, count: matches.length, customers: matches.slice(0, MAX_RESULTS) };
}

/* ── Tool 4: one staff member's daily record(s) — advance/holiday/note ─ */
async function getStaffRecord({ name, date }) {
    if (!name || typeof name !== 'string') return { error: 'name is required' };
    if (date && !isValidDate(date)) return { error: 'date must be YYYY-MM-DD if provided' };

    const q = name.trim().toLowerCase();
    const staffSnap = await getDocsFromServer(collection(db, 'staff'));
    let staffId = null, staffName = null;
    staffSnap.forEach(d => {
        if (staffId) return; // keep first match
        const s = d.data();
        if ((s.name || '').toLowerCase().includes(q)) { staffId = d.id; staffName = s.name; }
    });
    if (!staffId) return { found: false, message: `No staff member matching "${name}".` };

    if (date) {
        // dailyRecords doc ID IS the date (see js/staff-shared.js) — direct doc read, no query needed.
        try {
            const recSnap = await getDocFromServer(doc(db, 'staff', staffId, 'dailyRecords', date));
            if (!recSnap.exists()) {
                return { found: true, staff: staffName, date, recordExists: false, message: 'No record saved for this date — default is Working, ₹0 advance, no note.' };
            }
            const r = recSnap.data();
            return { found: true, staff: staffName, date, recordExists: true, holiday: !!r.holiday, advance: Number(r.advance) || 0, note: r.note || '' };
        } catch (e) {
            return { error: e?.code || e?.message || String(e) };
        }
    }

    // No date given — return recent records so the AI can find "kab liya" itself.
    const recSnap = await getDocsFromServer(collection(db, 'staff', staffId, 'dailyRecords'));
    const records = [];
    recSnap.forEach(d => {
        const r = d.data();
        if (r.holiday || (Number(r.advance) || 0) > 0 || r.note) {
            records.push({ date: r.date || d.id, holiday: !!r.holiday, advance: Number(r.advance) || 0, note: r.note || '' });
        }
    });
    records.sort((a, b) => b.date.localeCompare(a.date));
    if (records.length === 0) return { found: true, staff: staffName, message: 'No holiday/advance/note recorded for this staff member on any date.' };
    return { found: true, staff: staffName, recordCount: records.length, records: records.slice(0, MAX_RESULTS) };
}

/* ── Tool 5: keyword search across expense notes + staff daily notes ─── */
async function searchNotes({ keyword }) {
    if (!keyword || typeof keyword !== 'string') return { error: 'keyword is required' };
    const kw = keyword.trim().toLowerCase();
    if (!kw) return { error: 'keyword is required' };

    const [expSnap, staffSnap, recSnap] = await Promise.all([
        getDocsFromServer(collection(db, 'daily_expenses')),
        getDocsFromServer(collection(db, 'staff')),
        getDocsFromServer(collectionGroup(db, 'dailyRecords')),
    ]);

    const staffNameById = {};
    staffSnap.forEach(d => { staffNameById[d.id] = d.data().name || 'Unknown'; });

    const matches = [];
    expSnap.forEach(d => {
        const e = d.data();
        if ((e.note || '').toLowerCase().includes(kw)) {
            matches.push({ source: 'expense', date: dateKey(e.timestamp), amount: Number(e.amount) || 0, note: e.note });
        }
    });
    recSnap.forEach(d => {
        const r = d.data();
        if ((r.note || '').toLowerCase().includes(kw)) {
            const staffId = d.ref.parent.parent?.id;
            matches.push({ source: 'staff', staff: staffNameById[staffId] || 'Unknown', date: r.date || d.id, advance: Number(r.advance) || 0, note: r.note });
        }
    });

    if (matches.length === 0) return { found: false, message: `No note contains "${keyword}".` };
    matches.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return { found: true, count: matches.length, matches: matches.slice(0, MAX_RESULTS) };
}

/* ── OpenAI/Groq tool schema — passed as `tools` in the chat/completions call ── */
export const AI_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_expenses_by_date',
            description: 'Get the EXACT expense entries (amount + note) recorded on one specific date. Use whenever the admin asks about an expense on a specific date, or what note was written for an expense.',
            parameters: {
                type: 'object',
                properties: { date: { type: 'string', description: 'Date in YYYY-MM-DD format' } },
                required: ['date'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_sales_by_date',
            description: 'Get the EXACT sales/orders (with items) recorded on one specific date. Use for questions about a specific day\'s sale, older than what the cached daily history summary covers, or when order-level item detail is needed.',
            parameters: {
                type: 'object',
                properties: { date: { type: 'string', description: 'Date in YYYY-MM-DD format' } },
                required: ['date'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_customer_details',
            description: 'Get one customer\'s exact profile (total orders, lifetime spend, last order date) by name. Use when the admin asks about a specific customer who may not be in the cached "top spenders" list.',
            parameters: {
                type: 'object',
                properties: { name: { type: 'string', description: 'Customer name (or part of it) to search for' } },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_staff_record',
            description: 'Get a staff member\'s exact daily record(s) — holiday status, advance amount, and note. Pass a specific date to check that one day, or omit date to get all days that have a holiday/advance/note for that person (so the AI can itself find e.g. "when did X take an advance"). Use this instead of guessing from the 30-day aggregate summary.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Staff member name (or part of it)' },
                    date: { type: 'string', description: 'Optional: specific date in YYYY-MM-DD format' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_notes',
            description: 'Full-text search across ALL expense notes and ALL staff daily-record notes for a keyword, when the exact date or staff name isn\'t known. Returns every matching note with its date/source.',
            parameters: {
                type: 'object',
                properties: { keyword: { type: 'string', description: 'Word or phrase to search for inside notes' } },
                required: ['keyword'],
            },
        },
    },
];

const HANDLERS = {
    get_expenses_by_date: getExpensesByDate,
    get_sales_by_date: getSalesByDate,
    get_customer_details: getCustomerDetails,
    get_staff_record: getStaffRecord,
    search_notes: searchNotes,
};

/**
 * Executes one tool call by name. Never throws — always resolves to a
 * plain object (or {error}) that's safe to JSON.stringify() straight back
 * into the tool-result message sent to Groq.
 */
export async function executeAiTool(name, args) {
    const handler = HANDLERS[name];
    if (!handler) return { error: `Unknown tool: ${name}` };
    try {
        return await handler(args || {});
    } catch (e) {
        console.error(`[ai-live-lookup] "${name}" failed:`, e);
        return { error: e?.code || e?.message || String(e) };
    }
}
