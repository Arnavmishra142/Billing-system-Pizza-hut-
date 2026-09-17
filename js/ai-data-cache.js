/**
 * Historical data cache for the Smart AI Manager.
 *
 * Why: the AI chat previously only saw "today"/live dashboard numbers
 * scraped from the DOM, plus sales/expense/menu history. It couldn't
 * reason about customers, staff, or coupons at all. Pulling all of these
 * collections on every chat open is wasteful (Firestore reads + prompt
 * tokens), so we fetch once, summarize into a compact object, and cache
 * it in localStorage for 24 hours. On the next open within that window we
 * reuse the cache; after 24h we refetch once (that also naturally rolls
 * yesterday's live numbers into the history).
 *
 * AI UPDATE [2026-09-17]: Expanded from Sales+Expenses-only to cover the
 * full existing Admin Panel — Customers, Coupons, and Staff were added.
 * No new collections were created; every read below reuses collections
 * that already exist and are already isOperator()-gated in
 * firestore.rules (see js/customers.js, js/staff-shared.js). Since the
 * summarized data here is sent to the third-party Groq API (see
 * admin/chat.ai.html), customer/staff PII (phone numbers, exact daily
 * records) is deliberately left OUT of the summary — only names and
 * aggregate business stats are included, mirroring how sales data was
 * already aggregated rather than sent as raw rows.
 */
import { db } from './firebase-config.js';
import {
    collection, collectionGroup, getDocsFromServer
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const LS_KEY   = 'ai_history_cache_v2'; // v2: bumped — schema now includes customers/coupons/staff
const TTL_MS   = 24 * 60 * 60 * 1000; // 24 hours
const MAX_DAYS = 120;                 // cap how many days of history we keep/send
const RECENT_DAYS_MS = 30 * 24 * 60 * 60 * 1000; // used for staff-record + customer-activity windows

function dateKey(iso) {
    const d = new Date(iso);
    return isNaN(d) ? null : d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function readLS() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

function writeLS(payload) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(payload)); } catch (_) { /* storage full/blocked — ignore */ }
}

/** Build the compact summary from raw Firestore docs. */
function summarize(sales, expenses, menuItems) {
    const byDay = {}; // date -> { revenue, orders, expenses }
    const dayBucket = (key) => {
        if (!byDay[key]) {
            byDay[key] = { date: key, revenue: 0, orders: 0, expenses: 0 };
        }
        return byDay[key];
    };

    const itemTotals = {}; // name -> { qty, rev }

    sales.forEach(sale => {
        const key = dateKey(sale.timestamp);
        if (!key) return;
        const bucket = dayBucket(key);
        const total  = Number(sale.total) || 0;

        // Sales are reported as one combined business total — the AI
        // should not distinguish Table vs Quick Sale/Cash Sale.
        bucket.revenue += total;
        bucket.orders  += 1;

        (sale.items || []).forEach(item => {
            const n = item.name || 'Unknown';
            if (!itemTotals[n]) itemTotals[n] = { qty: 0, rev: 0 };
            itemTotals[n].qty += Number(item.qty) || 0;
            itemTotals[n].rev += (Number(item.qty) || 0) * (Number(item.price) || 0);
        });
    });

    expenses.forEach(exp => {
        const key = dateKey(exp.timestamp);
        if (!key) return;
        dayBucket(key).expenses += Number(exp.amount) || 0;
    });

    const dailyHistory = Object.values(byDay)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, MAX_DAYS)
        .map(d => ({
            date: d.date,
            revenue: Math.round(d.revenue),
            orders: d.orders,
            expenses: Math.round(d.expenses),
        }));

    const allTimeTotals = {
        totalRevenueEver:  Math.round(sales.reduce((s, x) => s + (Number(x.total) || 0), 0)),
        totalOrdersEver:   sales.length,
        totalExpensesEver: Math.round(expenses.reduce((s, x) => s + (Number(x.amount) || 0), 0)),
        daysTracked:       Object.keys(byDay).length,
    };

    const topItemsAllTime = Object.entries(itemTotals)
        .map(([name, s]) => ({ name, qty: s.qty, rev: Math.round(s.rev) }))
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 15);

    const menu = menuItems.map(m => ({
        name: m.name,
        price: Number(m.price) || 0,
        category: m.category || 'Uncategorized',
    }));

    return { dailyHistory, allTimeTotals, topItemsAllTime, menu };
}

/**
 * Summarize the `customers` collection (same fast-path fields the
 * Customer Management panel reads — see js/customers.js _fetchCustomers).
 * PRIVACY: phone numbers are intentionally never included — only names
 * and aggregate/lifetime stats, since this goes to a third-party AI API.
 */
function summarizeCustomers(customers) {
    const now = Date.now();
    let neverOrdered = 0, newCustomers = 0, returning = 0, inactive = 0;

    const enriched = customers.map(c => {
        const orderCount = typeof c.totalOrders === 'number' ? c.totalOrders : 0;
        const spending    = Number(c.lifetimeSpend) || 0;
        const lastOrderTs = c.lastOrderAt?.toMillis?.() ?? 0;
        const recentlyActive = lastOrderTs > 0 && (now - lastOrderTs) < RECENT_DAYS_MS;

        if (orderCount === 0) neverOrdered++;
        else if (orderCount === 1) newCustomers++;
        else if (recentlyActive) returning++;
        else inactive++;

        return { name: c.name || 'Unknown', orderCount, spending, lastOrderTs };
    });

    const topSpenders = enriched
        .filter(c => c.spending > 0)
        .sort((a, b) => b.spending - a.spending)
        .slice(0, 8)
        .map(c => ({ name: c.name, spending: Math.round(c.spending), orders: c.orderCount }));

    return {
        totalCustomers: customers.length,
        statusCounts: { neverOrdered, new: newCustomers, returning, inactive },
        topSpenders,
    };
}

/** Summarize the `coupons` collection — aggregate only, no phone numbers. */
function summarizeCoupons(coupons) {
    let used = 0, active = 0, valueIssued = 0, valueRedeemed = 0;
    coupons.forEach(cp => {
        const amount = Number(cp.amount) || 0;
        valueIssued += amount;
        if (cp.used) { used++; valueRedeemed += amount; }
        else active++;
    });
    return {
        totalCoupons: coupons.length,
        active,
        used,
        valueIssued: Math.round(valueIssued),
        valueRedeemed: Math.round(valueRedeemed),
    };
}

/**
 * Summarize `staff` (roster) + the `dailyRecords` subcollection (fetched
 * in one shot via a collectionGroup query). Only aggregate advance/holiday
 * counts for the last 30 days are kept per staff member — individual daily
 * notes are left out of what's sent to the third-party AI.
 */
function summarizeStaff(staffList, dailyRecords) {
    const byStaffId = {};
    staffList.forEach(s => {
        byStaffId[s.id] = { name: s.name || 'Unknown', workType: s.workType || '', active: s.active !== false, last30DaysAdvance: 0, last30DaysHolidays: 0 };
    });

    const cutoff = Date.now() - RECENT_DAYS_MS;
    dailyRecords.forEach(({ staffId, date, holiday, advance }) => {
        const entry = byStaffId[staffId];
        if (!entry) return; // record for a deleted/unknown staff doc — skip
        const d = new Date(date);
        if (isNaN(d) || d.getTime() < cutoff) return;
        if (holiday) entry.last30DaysHolidays += 1;
        entry.last30DaysAdvance += Number(advance) || 0;
    });

    const roster = Object.values(byStaffId).filter(s => s.active);

    return {
        totalStaff: roster.length,
        roster: roster.map(s => ({
            name: s.name,
            workType: s.workType,
            last30DaysAdvance: Math.round(s.last30DaysAdvance),
            last30DaysHolidays: s.last30DaysHolidays,
        })),
    };
}

/**
 * Returns the cached historical summary if it's fresh (<24h old),
 * otherwise fetches everything fresh from Firestore, summarizes,
 * caches it, and returns it. Never throws — falls back to stale
 * cache (if any) on fetch failure so the AI still has *something*.
 */
export async function getAiHistoricalContext() {
    const cached = readLS();
    const isFresh = cached && (Date.now() - cached.fetchedAt) < TTL_MS;
    if (isFresh) return cached.data;

    try {
        const [salesSnap, expenseSnap, menuSnap, customersSnap, couponsSnap, staffSnap, dailyRecordsSnap] = await Promise.all([
            getDocsFromServer(collection(db, "sales_history")),
            getDocsFromServer(collection(db, "daily_expenses")),
            getDocsFromServer(collection(db, "menu_items")),
            getDocsFromServer(collection(db, "customers")),
            getDocsFromServer(collection(db, "coupons")),
            getDocsFromServer(collection(db, "staff")),
            // One query for every staff member's dailyRecords subcollection,
            // instead of one read per staff doc (see js/staff-shared.js §5).
            getDocsFromServer(collectionGroup(db, "dailyRecords")),
        ]);

        const sales     = []; salesSnap.forEach(d => sales.push(d.data()));
        const expenses  = []; expenseSnap.forEach(d => expenses.push(d.data()));
        const menuItems = []; menuSnap.forEach(d => menuItems.push(d.data()));
        const customers = []; customersSnap.forEach(d => customers.push({ id: d.id, ...d.data() }));
        const coupons   = []; couponsSnap.forEach(d => coupons.push(d.data()));
        const staffList = []; staffSnap.forEach(d => staffList.push({ id: d.id, ...d.data() }));
        const dailyRecords = [];
        dailyRecordsSnap.forEach(d => {
            // Parent of a dailyRecords doc is the staff/{staffId} doc.
            dailyRecords.push({ staffId: d.ref.parent.parent?.id, ...d.data() });
        });

        const data = {
            ...summarize(sales, expenses, menuItems),
            customers: summarizeCustomers(customers),
            coupons:   summarizeCoupons(coupons),
            staff:     summarizeStaff(staffList, dailyRecords),
        };
        writeLS({ fetchedAt: Date.now(), data });
        return data;
    } catch (e) {
        console.error('AI history fetch failed, falling back to cache if any:', e);
        return cached ? cached.data : null;
    }
}
