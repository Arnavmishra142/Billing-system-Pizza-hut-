/**
 * Historical data cache for the Smart AI Manager.
 *
 * Why: the AI chat previously only saw "today"/live dashboard numbers
 * scraped from the DOM. It couldn't reason about trends, compare days,
 * or know the full menu/expense history. Pulling the FULL sales_history +
 * daily_expenses + menu_items collections on every chat open is wasteful
 * (Firestore reads + prompt tokens), so we fetch once, summarize into a
 * compact object, and cache it in localStorage for 24 hours. On the next
 * open within that window we reuse the cache; after 24h we refetch once
 * (that also naturally rolls yesterday's live numbers into the history).
 */
import { db } from './firebase-config.js';
import {
    collection, getDocsFromServer
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const LS_KEY   = 'ai_history_cache_v1';
const TTL_MS   = 24 * 60 * 60 * 1000; // 24 hours
const MAX_DAYS = 120;                 // cap how many days of history we keep/send

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
        const [salesSnap, expenseSnap, menuSnap] = await Promise.all([
            getDocsFromServer(collection(db, "sales_history")),
            getDocsFromServer(collection(db, "daily_expenses")),
            getDocsFromServer(collection(db, "menu_items")),
        ]);

        const sales     = []; salesSnap.forEach(d => sales.push(d.data()));
        const expenses  = []; expenseSnap.forEach(d => expenses.push(d.data()));
        const menuItems = []; menuSnap.forEach(d => menuItems.push(d.data()));

        const data = summarize(sales, expenses, menuItems);
        writeLS({ fetchedAt: Date.now(), data });
        return data;
    } catch (e) {
        console.error('AI history fetch failed, falling back to cache if any:', e);
        return cached ? cached.data : null;
    }
}
