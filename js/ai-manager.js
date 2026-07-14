/**
 * Smart AI Manager — FAB only.
 * Tap = scrape live context + cached history → sessionStorage → navigate to chat.ai.html
 * Drag = move FAB freely around screen (mouse + touch).
 */
import { getAiHistoricalContext } from './ai-data-cache.js';

(function () {
    'use strict';

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        const fab = document.getElementById('aiManagerFab');
        if (!fab) return;

        /* ── FAB drag logic ──────────────────────────────────────── */
        let isDragging = false;
        let hasDragged = false;
        let startX, startY, fabX, fabY;

        function onDragStart(cx, cy) {
            isDragging = true;
            hasDragged = false;
            startX = cx;
            startY = cy;
            const rect = fab.getBoundingClientRect();
            fabX = rect.left;
            fabY = rect.top;
            fab.classList.add('ai-fab--dragging');
        }

        function onDragMove(cx, cy) {
            if (!isDragging) return;
            const dx = cx - startX;
            const dy = cy - startY;
            if (!hasDragged && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
                hasDragged = true;
                fab.style.right  = 'auto';
                fab.style.bottom = 'auto';
                fab.style.left   = fabX + 'px';
                fab.style.top    = fabY + 'px';
            }
            if (hasDragged) {
                const s = fab.offsetWidth;
                const newLeft = Math.max(0, Math.min(window.innerWidth  - s, fabX + dx));
                const newTop  = Math.max(0, Math.min(window.innerHeight - s, fabY + dy));
                fab.style.left = newLeft + 'px';
                fab.style.top  = newTop  + 'px';
            }
        }

        function onDragEnd() {
            if (!isDragging) return;
            isDragging = false;
            fab.classList.remove('ai-fab--dragging');
            if (!hasDragged) {
                openAIChat();   // simple tap → navigate (async, fire-and-forget)
            }
        }

        // Mouse events
        fab.addEventListener('mousedown', e => { e.preventDefault(); onDragStart(e.clientX, e.clientY); });
        document.addEventListener('mousemove', e => onDragMove(e.clientX, e.clientY));
        document.addEventListener('mouseup',   () => onDragEnd());

        // Touch events
        fab.addEventListener('touchstart', e => {
            const t = e.touches[0];
            onDragStart(t.clientX, t.clientY);
        }, { passive: true });
        document.addEventListener('touchmove', e => {
            if (!isDragging) return;
            const t = e.touches[0];
            onDragMove(t.clientX, t.clientY);
        }, { passive: true });
        document.addEventListener('touchend', () => onDragEnd());

        /* ── Navigate to chat page ───────────────────────────────── */
        async function openAIChat() {
            // Scrape live ("today"/current filter) stats from admin DOM
            const get = id => document.getElementById(id)?.innerText?.trim() || 'N/A';

            // Note: the dashboard still splits Table vs Quick Sale internally,
            // but the AI should only ever see one combined business total —
            // it must not distinguish or mention Table vs Quick Sale.
            const ctx = {
                totalRevenue  : get('totalRevenueBox'),
                totalOrders   : get('totalOrdersBox'),
                totalExpenses : get('totalExpenseBox'),
                topItems      : mergeItemLists(
                    scrapeTableItems('#tableSalesTableBody'),
                    scrapeTableItems('#qsSalesTableBody')
                ),
            };

            // Full sales/expense/menu history — cached 24h so this doesn't
            // re-read the whole Firestore history on every tap (see ai-data-cache.js)
            try {
                ctx.history = await getAiHistoricalContext();
            } catch (_) { ctx.history = null; }

            try { sessionStorage.setItem('ai_dashboard_ctx', JSON.stringify(ctx)); } catch (_) {}
            
            // ✅ FIX: Use relative path for GitHub Pages compatibility
            window.location.href = './chat.ai.html';
        }

        // Returns raw { name, qty, rev } rows (unformatted) so callers can
        // merge multiple panels together before rendering as text.
        function scrapeTableItems(selector) {
            const rows = document.querySelectorAll(selector + ' tr');
            const items = [];
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 3) {
                    const name = cells[0].innerText.trim();
                    const qty  = parseFloat(cells[1].innerText.replace(/[^\d.]/g, '')) || 0;
                    const rev  = parseFloat(cells[2].innerText.replace(/[^\d.]/g, '')) || 0;
                    if (name) items.push({ name, qty, rev });
                }
            });
            return items;
        }

        // Combines Table + Quick Sale item breakdowns into one list per item
        // name, sorted by quantity, so the AI sees a single business-wide
        // top-sellers list instead of two separate ones.
        function mergeItemLists(...lists) {
            const merged = {};
            lists.forEach(list => {
                list.forEach(({ name, qty, rev }) => {
                    if (!merged[name]) merged[name] = { name, qty: 0, rev: 0 };
                    merged[name].qty += qty;
                    merged[name].rev += rev;
                });
            });
            return Object.values(merged)
                .sort((a, b) => b.qty - a.qty)
                .slice(0, 5)
                .map(i => `${i.name} (Qty: ${i.qty}, Rev: ₹${i.rev})`);
        }
    }

})();
