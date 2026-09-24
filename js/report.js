// js/report.js
// ==========================================================================
// AI UPDATE [2026-09-23]: DOWNLOAD REPORT FEATURE (new, isolated module)
// --------------------------------------------------------------------------
// Adds a "📥 Download Report" button to the Admin top bar. Opens a small
// date-range modal (Today / Yesterday / Last 7 Days / Custom), fetches the
// SAME Firestore collections the rest of the Admin dashboard already uses
// (sales_history, daily_expenses, customers) filtered to the chosen
// business-day range in Asia/Kolkata (IST) time, renders a printable report
// into an off-screen container, draws charts with Chart.js, then captures it
// with html2canvas and builds a multi-page A4 PDF with jsPDF.
//
// IMPORTANT — architecture notes for future agents (see AI_HANDOFF.md /
// ARCHITECTURE_LOCK.md for the long version):
//   - This file does NOT introduce a second revenue/order calculation
//     system. It reads the exact same fields the Admin dashboard reads
//     (see js/admin.js loadSalesData / js/expense.js / js/customers.js):
//       sales_history:  timestamp (ISO string, UTC), total, table, items[],
//                        couponDiscount, customDiscount, subtotal
//       daily_expenses: timestamp (ISO string, UTC), amount, note
//       customers:      createdAt (Firestore Timestamp)
//     sales_history is only ever written when a bill is settled (see
//     js/cart.js) — there is no separate "status" field to filter on, so
//     every doc in sales_history is already a completed/valid sale. This
//     matches "only count valid/completed orders" without inventing a
//     status filter that doesn't exist in the schema.
//   - table === 'Direct Entry' means a Quick/Cash Sale (no dine-in table).
//     A table value containing "Parcel" is a parcel order. Anything else is
//     a dine-in table order. Same convention as js/admin.js.
//   - No payment-method field exists anywhere in this schema, so this report
//     intentionally does NOT show a payment-method breakdown (would be an
//     invented metric).
//   - Firestore range queries use the fact that sales_history/daily_expenses
//     timestamps are ISO-8601 UTC strings, which sort correctly with plain
//     string >=/<= comparisons — so a single-field range query (no new
//     composite index needed) can filter server-side instead of pulling the
//     whole collection.
//   - This module never writes to Firestore. It is read-only and fully
//     isolated: it does not import from or modify js/admin.js, js/cart.js,
//     js/expense.js, js/customers.js, POS/KOT/coupon/staff code, or the
//     existing Admin PIN/auth flow.
//   - Recharts was requested in the original spec, but this project is a
//     static vanilla-JS site (ES module scripts, no React/bundler) — see
//     js/firebase-config.js and admin/index.html <script type="module">
//     tags. Chart.js (loaded via CDN <script> in admin/index.html) is used
//     instead; it needs no React runtime and renders straight onto a
//     <canvas>, which html2canvas captures natively.
// ==========================================================================

import { db } from './firebase-config.js';
import {
    collection, query, where, getDocs, Timestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // Asia/Kolkata is fixed UTC+5:30, no DST
const BUSINESS_NAME = 'New Pizza Hut & Live Cake';

// --------------------------------------------------------------------------
// AI UPDATE [2026-09-24]: SELF-LOADING DEPENDENCIES
// --------------------------------------------------------------------------
// Root cause of "Chart is not defined": the CDN <script> tags for Chart.js /
// html2canvas / jsPDF live in admin/index.html, not in this file. If the
// deployed admin/index.html doesn't have those three <script> tags (e.g. only
// this file got redeployed, or a different copy of admin/index.html is live),
// window.Chart never exists and the bare `Chart` reference throws a
// ReferenceError. To make this feature work regardless of what's in the HTML,
// report.js now loads its own dependencies on demand and only proceeds once
// they're confirmed present.
const CDN_URLS = {
    Chart: 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js',
    html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
};

function loadScriptOnce(url) {
    return new Promise((resolve, reject) => {
        // Already present (e.g. admin/index.html already loaded it) — skip.
        const existing = document.querySelector(`script[src="${url}"]`);
        if (existing) {
            if (existing.dataset.loaded === 'true') return resolve();
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${url}`)));
            return;
        }
        const s = document.createElement('script');
        s.src = url;
        s.async = false; // preserve execution order relative to other calls
        s.onload = () => { s.dataset.loaded = 'true'; resolve(); };
        s.onerror = () => reject(new Error(`Failed to load ${url} (blocked by network/ad-blocker?)`));
        document.head.appendChild(s);
    });
}

async function ensureReportLibsLoaded() {
    const tasks = [];
    if (typeof window.Chart === 'undefined') tasks.push(loadScriptOnce(CDN_URLS.Chart));
    if (typeof window.html2canvas === 'undefined') tasks.push(loadScriptOnce(CDN_URLS.html2canvas));
    if (typeof window.jspdf === 'undefined') tasks.push(loadScriptOnce(CDN_URLS.jspdf));
    if (tasks.length) await Promise.all(tasks);

    // Final check — surface a clear, specific error rather than a bare
    // "Chart is not defined" ReferenceError further down the pipeline.
    const missing = [];
    if (typeof window.Chart === 'undefined') missing.push('Chart.js');
    if (typeof window.html2canvas === 'undefined') missing.push('html2canvas');
    if (typeof window.jspdf === 'undefined') missing.push('jsPDF');
    if (missing.length) {
        throw new Error(`Could not load: ${missing.join(', ')}. Check your internet connection or ad-blocker.`);
    }
}

// --------------------------------------------------------------------------
// IST DATE HELPERS
// --------------------------------------------------------------------------

// Returns the IST calendar date ('YYYY-MM-DD') for a given JS Date instant.
function istDateKey(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
}

// Given an IST calendar date string 'YYYY-MM-DD', returns the UTC epoch ms
// for 00:00:00.000 IST and 23:59:59.999 IST on that business day.
function istDayBoundsMs(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const startUTCms = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS;
    const endUTCms = Date.UTC(y, m - 1, d, 23, 59, 59, 999) - IST_OFFSET_MS;
    return { startUTCms, endUTCms };
}

function addDaysToKey(dateKey, deltaDays) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const ms = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
    const nd = new Date(ms);
    return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-${String(nd.getUTCDate()).padStart(2, '0')}`;
}

function formatDisplayDate(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
    });
}

// Resolves the selected range option into { startMs, endMs, startKey, endKey }.
// startMs/endMs are UTC epoch ms boundaries used to query Firestore.
function resolveRange(rangeType, customStart, customEnd) {
    const nowMs = Date.now();
    const todayKey = istDateKey(new Date(nowMs));

    if (rangeType === 'today') {
        const { startUTCms } = istDayBoundsMs(todayKey);
        return { startMs: startUTCms, endMs: nowMs, startKey: todayKey, endKey: todayKey };
    }
    if (rangeType === 'yesterday') {
        const yKey = addDaysToKey(todayKey, -1);
        const { startUTCms, endUTCms } = istDayBoundsMs(yKey);
        return { startMs: startUTCms, endMs: endUTCms, startKey: yKey, endKey: yKey };
    }
    if (rangeType === '7days') {
        const startKey = addDaysToKey(todayKey, -6);
        const { startUTCms } = istDayBoundsMs(startKey);
        return { startMs: startUTCms, endMs: nowMs, startKey, endKey: todayKey };
    }
    // custom
    const { startUTCms } = istDayBoundsMs(customStart);
    const { endUTCms } = istDayBoundsMs(customEnd);
    return { startMs: startUTCms, endMs: endUTCms, startKey: customStart, endKey: customEnd };
}

// --------------------------------------------------------------------------
// FIRESTORE READS (isolated — read-only, reuses existing schema/fields)
// --------------------------------------------------------------------------

async function fetchRangeData(startMs, endMs) {
    const startISO = new Date(startMs).toISOString();
    const endISO = new Date(endMs).toISOString();
    const startTs = Timestamp.fromMillis(startMs);
    const endTs = Timestamp.fromMillis(endMs);

    const salesQ = query(
        collection(db, 'sales_history'),
        where('timestamp', '>=', startISO),
        where('timestamp', '<=', endISO)
    );
    const expQ = query(
        collection(db, 'daily_expenses'),
        where('timestamp', '>=', startISO),
        where('timestamp', '<=', endISO)
    );
    const custQ = query(
        collection(db, 'customers'),
        where('createdAt', '>=', startTs),
        where('createdAt', '<=', endTs)
    );

    const [salesSnap, expSnap, custSnap] = await Promise.all([
        getDocs(salesQ), getDocs(expQ), getDocs(custQ)
    ]);

    const sales = [];
    salesSnap.forEach(d => sales.push({ ...d.data(), id: d.id }));
    const expenses = [];
    expSnap.forEach(d => expenses.push({ ...d.data(), id: d.id }));

    return { sales, expenses, newCustomers: custSnap.size };
}

// --------------------------------------------------------------------------
// AGGREGATION — mirrors the exact rules in js/admin.js loadSalesData()
// --------------------------------------------------------------------------

function buildReportData(sales, expenses, newCustomers, range) {
    let totalSales = 0;
    let totalDiscount = 0;
    const itemStats = {};      // name -> { qty, rev }
    const segment = { table: { revenue: 0, orders: 0 }, parcel: { revenue: 0, orders: 0 }, quick: { revenue: 0, orders: 0 } };
    const byDay = {};          // 'YYYY-MM-DD' (IST) -> { sales, expenses, orders }

    sales.forEach(sale => {
        const total = Number(sale.total) || 0;
        totalSales += total;
        totalDiscount += (Number(sale.couponDiscount) || 0) + (Number(sale.customDiscount) || 0);

        const tableVal = sale.table || '';
        let seg = 'table';
        if (tableVal === 'Direct Entry') seg = 'quick';
        else if (tableVal.includes('Parcel')) seg = 'parcel';
        segment[seg].revenue += total;
        segment[seg].orders += 1;

        (sale.items || []).forEach(item => {
            const n = item.name || 'Unknown';
            if (!itemStats[n]) itemStats[n] = { qty: 0, rev: 0 };
            itemStats[n].qty += Number(item.qty) || 0;
            itemStats[n].rev += (Number(item.qty) || 0) * (Number(item.price) || 0);
        });

        const dayKey = sale.timestamp ? istDateKey(new Date(sale.timestamp)) : null;
        if (dayKey) {
            if (!byDay[dayKey]) byDay[dayKey] = { sales: 0, expenses: 0, orders: 0 };
            byDay[dayKey].sales += total;
            byDay[dayKey].orders += 1;
        }
    });

    let totalExpenses = 0;
    expenses.forEach(exp => {
        const amt = Number(exp.amount) || 0;
        totalExpenses += amt;
        const dayKey = exp.timestamp ? istDateKey(new Date(exp.timestamp)) : null;
        if (dayKey) {
            if (!byDay[dayKey]) byDay[dayKey] = { sales: 0, expenses: 0, orders: 0 };
            byDay[dayKey].expenses += amt;
        }
    });

    // Ensure every day in the range has a bucket (even if zero), in order.
    const dayKeys = [];
    let cursor = range.startKey;
    // Guard against runaway loops on malformed input.
    for (let i = 0; i < 400 && cursor <= range.endKey; i++) {
        dayKeys.push(cursor);
        if (cursor === range.endKey) break;
        cursor = addDaysToKey(cursor, 1);
    }
    dayKeys.forEach(k => { if (!byDay[k]) byDay[k] = { sales: 0, expenses: 0, orders: 0 }; });

    const topItems = Object.entries(itemStats)
        .map(([name, s]) => ({ name, qty: s.qty, rev: s.rev }))
        .sort((a, b) => b.rev - a.rev)
        .slice(0, 8);

    return {
        totalSales,
        totalOrders: sales.length,
        totalExpenses,
        netAmount: totalSales - totalExpenses,
        newCustomers,
        totalDiscount,
        segment,
        topItems,
        dayKeys,
        byDay
    };
}

// --------------------------------------------------------------------------
// REPORT RENDERING (off-screen DOM → charts → html2canvas → jsPDF)
// --------------------------------------------------------------------------

function fmtINR(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function renderReportHTML(data, range) {
    const periodLabel = range.startKey === range.endKey
        ? formatDisplayDate(range.startKey)
        : `${formatDisplayDate(range.startKey)} → ${formatDisplayDate(range.endKey)}`;

    const netNegative = data.netAmount < 0;

    const segRows = [
        ['Table Orders', data.segment.table],
        ['Parcel Orders', data.segment.parcel],
        ['Quick / Cash Sales', data.segment.quick]
    ].filter(([, s]) => s.orders > 0);

    const itemRows = data.topItems.map(it => `
        <tr>
            <td>${escapeHTML(it.name)}</td>
            <td class="rpt-num">${it.qty}</td>
            <td class="rpt-num">${fmtINR(it.rev)}</td>
        </tr>
    `).join('');

    return `
    <div class="rpt-page">
        <div class="rpt-header">
            <div>
                <h1>📊 ${escapeHTML(BUSINESS_NAME)}</h1>
                <div class="rpt-sub">Business Report</div>
            </div>
            <div class="rpt-period">
                Report period
                <strong>${periodLabel}</strong>
            </div>
        </div>

        <div class="rpt-cards">
            <div class="rpt-card"><div class="rpt-card-label">💰 Total Sales</div><div class="rpt-card-value">${fmtINR(data.totalSales)}</div></div>
            <div class="rpt-card"><div class="rpt-card-label">🧾 Total Orders</div><div class="rpt-card-value">${data.totalOrders}</div></div>
            <div class="rpt-card"><div class="rpt-card-label">💸 Total Expenses</div><div class="rpt-card-value">${fmtINR(data.totalExpenses)}</div></div>
            <div class="rpt-card rpt-card--net ${netNegative ? 'rpt-card--negative' : ''}"><div class="rpt-card-label">📈 Net Amount</div><div class="rpt-card-value">${fmtINR(data.netAmount)}</div></div>
            <div class="rpt-card"><div class="rpt-card-label">👥 New Customers</div><div class="rpt-card-value">${data.newCustomers}</div></div>
            <div class="rpt-card"><div class="rpt-card-label">🏷️ Total Discounts</div><div class="rpt-card-value">${fmtINR(data.totalDiscount)}</div></div>
        </div>

        <div class="rpt-section-title">Sales vs Expenses</div>
        <div class="rpt-chart-box"><canvas id="rptChartSalesExp" height="220"></canvas></div>

        <div class="rpt-section-title">Orders Trend</div>
        <div class="rpt-chart-box"><canvas id="rptChartOrders" height="200"></canvas></div>

        ${data.topItems.length ? `
        <div class="rpt-section-title">Top-Selling Items</div>
        <div class="rpt-chart-box"><canvas id="rptChartItems" height="${Math.max(160, data.topItems.length * 34)}"></canvas></div>
        ` : ''}

        ${segRows.length ? `
        <div class="rpt-section-title">Table / Parcel Breakdown</div>
        <table class="rpt-table">
            <thead><tr><th>Segment</th><th class="rpt-num">Orders</th><th class="rpt-num">Revenue</th></tr></thead>
            <tbody>
                ${segRows.map(([label, s]) => `<tr><td>${label}</td><td class="rpt-num">${s.orders}</td><td class="rpt-num">${fmtINR(s.revenue)}</td></tr>`).join('')}
            </tbody>
        </table>
        ` : ''}

        ${itemRows ? `
        <div class="rpt-section-title">Item Breakdown (Top ${data.topItems.length})</div>
        <table class="rpt-table">
            <thead><tr><th>Item</th><th class="rpt-num">Qty Sold</th><th class="rpt-num">Revenue</th></tr></thead>
            <tbody>${itemRows}</tbody>
        </table>
        ` : ''}

        <div class="rpt-footer">Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST · All figures based on completed sales &amp; recorded expenses.</div>
    </div>`;
}

function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let _charts = [];
function destroyCharts() {
    _charts.forEach(c => { try { c.destroy(); } catch (e) {} });
    _charts = [];
}

function drawCharts(data) {
    const labels = data.dayKeys.map(k => formatDisplayDate(k).replace(/, \d{4}$/, ''));
    const salesArr = data.dayKeys.map(k => data.byDay[k].sales);
    const expArr = data.dayKeys.map(k => data.byDay[k].expenses);
    const ordersArr = data.dayKeys.map(k => data.byDay[k].orders);

    const commonOpts = {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#374151' } } },
        scales: {
            x: { ticks: { color: '#6b7280' }, grid: { color: '#eef0f2' } },
            y: { ticks: { color: '#6b7280' }, grid: { color: '#eef0f2' }, beginAtZero: true }
        }
    };

    const salesExpCanvas = document.getElementById('rptChartSalesExp');
    if (salesExpCanvas) {
        _charts.push(new Chart(salesExpCanvas, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { label: 'Sales', data: salesArr, backgroundColor: '#238636' },
                    { label: 'Expenses', data: expArr, backgroundColor: '#da3633' }
                ]
            },
            options: commonOpts
        }));
    }

    const ordersCanvas = document.getElementById('rptChartOrders');
    if (ordersCanvas) {
        _charts.push(new Chart(ordersCanvas, {
            type: 'line',
            data: { labels, datasets: [{ label: 'Orders', data: ordersArr, borderColor: '#1f6feb', backgroundColor: 'rgba(31,111,235,0.15)', fill: true, tension: 0.25 }] },
            options: commonOpts
        }));
    }

    const itemsCanvas = document.getElementById('rptChartItems');
    if (itemsCanvas && data.topItems.length) {
        _charts.push(new Chart(itemsCanvas, {
            type: 'bar',
            data: {
                labels: data.topItems.map(i => i.name),
                datasets: [{ label: 'Revenue', data: data.topItems.map(i => i.rev), backgroundColor: '#6e40c9' }]
            },
            options: { ...commonOpts, indexAxis: 'y' }
        }));
    }
}

function waitFrames(n) {
    return new Promise(resolve => {
        let count = 0;
        function step() { count++; if (count >= n) resolve(); else requestAnimationFrame(step); }
        requestAnimationFrame(step);
    });
}

async function buildPdf(range) {
    const printArea = document.getElementById('reportPrintArea');

    const libsLoaded = window.html2canvas && window.jspdf;
    if (!libsLoaded) throw new Error('PDF libraries failed to load. Check your connection.');

    const canvas = await html2canvas(printArea, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
        throw new Error('Report render was empty.');
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'pt', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    const imgData = canvas.toDataURL('image/png');

    if (imgHeight <= pageHeight) {
        pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
    } else {
        // Multi-page: slice the tall canvas into page-height chunks.
        let heightLeft = imgHeight;
        let position = 0;
        let firstPage = true;
        while (heightLeft > 0) {
            if (!firstPage) pdf.addPage();
            pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
            heightLeft -= pageHeight;
            position -= pageHeight;
            firstPage = false;
        }
    }

    const filename = range.startKey === range.endKey
        ? `Business-Report-${range.startKey}.pdf`
        : `Business-Report-${range.startKey}-to-${range.endKey}.pdf`;

    pdf.save(filename);
}

// --------------------------------------------------------------------------
// UI WIRING
// --------------------------------------------------------------------------

let _selectedRange = 'today';
let _generating = false;

function setStatus(msg, kind) {
    const el = document.getElementById('reportStatusMsg');
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden', 'report-status--error', 'report-status--success');
    if (kind) el.classList.add(`report-status--${kind}`);
    el.textContent = msg;
}

function validateCustomRange() {
    const startEl = document.getElementById('reportStartDate');
    const endEl = document.getElementById('reportEndDate');
    const errEl = document.getElementById('reportRangeError');
    const genBtn = document.getElementById('reportGenerateBtn');
    if (_selectedRange !== 'custom') { errEl.classList.add('hidden'); return true; }

    const invalid = !startEl.value || !endEl.value || endEl.value < startEl.value;
    errEl.classList.toggle('hidden', !invalid);
    if (genBtn) genBtn.disabled = invalid || _generating;
    return !invalid;
}

function openModal() {
    document.getElementById('reportModalOverlay').classList.remove('hidden');
    setStatus('');
}
function closeModal() {
    if (_generating) return; // don't allow closing mid-generation
    document.getElementById('reportModalOverlay').classList.add('hidden');
}

async function handleGenerate() {
    if (_generating) return;

    const customStart = document.getElementById('reportStartDate').value;
    const customEnd = document.getElementById('reportEndDate').value;
    if (_selectedRange === 'custom' && !validateCustomRange()) return;

    const genBtn = document.getElementById('reportGenerateBtn');
    _generating = true;
    genBtn.disabled = true;
    genBtn.textContent = 'Preparing…';
    setStatus('Preparing report...', null);

    const printArea = document.getElementById('reportPrintArea');

    try {
        await ensureReportLibsLoaded();

        const range = resolveRange(_selectedRange, customStart, customEnd);
        const { sales, expenses, newCustomers } = await fetchRangeData(range.startMs, range.endMs);
        const data = buildReportData(sales, expenses, newCustomers, range);

        destroyCharts();
        printArea.innerHTML = renderReportHTML(data, range);

        // Let the DOM paint before Chart.js measures canvas sizes.
        await waitFrames(2);
        drawCharts(data);
        await waitFrames(3); // charts are drawn with animation:false, but give layout a moment to settle

        await buildPdf(range);

        setStatus('Report downloaded successfully.', 'success');
    } catch (err) {
        console.error('[Report] generation failed:', err);
        // AI UPDATE [2026-09-24]: surface the real error text in the modal itself
        // (not just console.error) — most people testing this on a phone have no
        // easy way to open devtools, so a silent generic message makes the actual
        // cause (permission-denied, missing index, blocked CDN script, etc.)
        // impossible to diagnose. Still falls back to a friendly line if the
        // error has no message.
        const detail = (err && err.message) ? err.message : 'Please try again.';
        setStatus(`Unable to generate report: ${detail}`, 'error');
    } finally {
        _generating = false;
        genBtn.disabled = false;
        genBtn.textContent = 'Generate PDF';
        printArea.innerHTML = '';
        destroyCharts();
    }
}

function initReportFeature() {
    const openBtn = document.getElementById('downloadReportBtn');
    const closeBtn = document.getElementById('reportModalCloseBtn');
    const cancelBtn = document.getElementById('reportCancelBtn');
    const genBtn = document.getElementById('reportGenerateBtn');
    const customWrap = document.getElementById('reportCustomDates');
    const startEl = document.getElementById('reportStartDate');
    const endEl = document.getElementById('reportEndDate');

    if (!openBtn) return; // markup not present — nothing to wire up

    // Default custom dates to today, capped so end can't precede start.
    const todayKey = istDateKey(new Date());
    startEl.value = todayKey;
    endEl.value = todayKey;
    endEl.min = '';

    openBtn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);

    document.querySelectorAll('.report-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.report-range-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _selectedRange = btn.dataset.range;
            customWrap.classList.toggle('hidden', _selectedRange !== 'custom');
            validateCustomRange();
            setStatus('');
        });
    });

    startEl.addEventListener('change', () => { endEl.min = startEl.value; validateCustomRange(); });
    endEl.addEventListener('change', validateCustomRange);

    genBtn.addEventListener('click', handleGenerate);
}

document.addEventListener('DOMContentLoaded', initReportFeature);
