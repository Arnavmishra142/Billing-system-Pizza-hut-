/**
 * Smart AI Manager — admin-only feature
 * Gemini-powered chat with live dashboard context injection.
 */
(function () {
    'use strict';

    const GEMINI_ENDPOINT =
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-latest:generateContent';
    const GEMINI_KEY = 'AQ.Ab8RN6KCu_7z5VrWP5UxnnspZthp52IBthKXi9Sgct28y2nmKg';

    /* ─── Wait for DOM ─────────────────────────────────────────── */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        const fab = document.getElementById('aiManagerFab');
        const chatWin = document.getElementById('aiChatWindow');
        const closeBtn = document.getElementById('aiChatClose');
        const sendBtn = document.getElementById('aiSendBtn');
        const input = document.getElementById('aiInputField');
        const messages = document.getElementById('aiMessages');

        if (!fab || !chatWin) return;

        /* ── FAB drag logic (mouse + touch) ──────────────────────── */
        let isDragging = false;
        let hasDragged = false;
        let startX, startY, fabX, fabY;

        // Initialise FAB position from bottom-right corner
        const NAV_HEIGHT = 72; // bottom nav + gap
        const MARGIN = 20;
        fab.style.right = MARGIN + 'px';
        fab.style.bottom = (NAV_HEIGHT + MARGIN) + 'px';

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
                // Switch from right/bottom anchoring to left/top so we can move freely
                fab.style.right = 'auto';
                fab.style.bottom = 'auto';
                fab.style.left = fabX + 'px';
                fab.style.top = fabY + 'px';
            }
            if (hasDragged) {
                let newLeft = fabX + dx;
                let newTop = fabY + dy;
                // Clamp inside viewport
                const s = fab.offsetWidth;
                newLeft = Math.max(0, Math.min(window.innerWidth - s, newLeft));
                newTop = Math.max(0, Math.min(window.innerHeight - s, newTop));
                fab.style.left = newLeft + 'px';
                fab.style.top = newTop + 'px';
            }
        }

        function onDragEnd() {
            if (!isDragging) return;
            isDragging = false;
            fab.classList.remove('ai-fab--dragging');
            if (!hasDragged) {
                toggleChat();
            }
        }

        // Mouse
        fab.addEventListener('mousedown', e => {
            e.preventDefault();
            onDragStart(e.clientX, e.clientY);
        });
        document.addEventListener('mousemove', e => onDragMove(e.clientX, e.clientY));
        document.addEventListener('mouseup', () => onDragEnd());

        // Touch
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

        /* ── Chat window toggle ───────────────────────────────────── */
        function toggleChat() {
            const open = chatWin.classList.toggle('ai-chat--open');
            fab.classList.toggle('ai-fab--active', open);
            if (open) {
                input.focus();
                positionChatWindow();
                if (messages.children.length === 0) {
                    appendMsg('ai', '👋 Hello! Main hoon aapka **Smart AI Manager**. Aaj ka revenue, orders ya expenses ke baare mein kuch poochho!');
                }
            }
        }

        function positionChatWindow() {
            // Position chat window near FAB but always on screen
            const fabRect = fab.getBoundingClientRect();
            const winW = window.innerWidth;
            const winH = window.innerHeight;
            const chatW = Math.min(340, winW - 24);
            const chatH = Math.min(480, winH - 120);

            chatWin.style.width = chatW + 'px';
            chatWin.style.maxHeight = chatH + 'px';

            // Default: anchor bottom-right
            chatWin.style.right = (winW - fabRect.right) + 'px';
            chatWin.style.bottom = (winH - fabRect.top + 8) + 'px';
            chatWin.style.left = 'auto';
            chatWin.style.top = 'auto';

            // If window would overflow top, flip to show below FAB
            const chatTop = fabRect.top - chatH - 8;
            if (chatTop < 8) {
                chatWin.style.bottom = 'auto';
                chatWin.style.top = (fabRect.bottom + 8) + 'px';
            }

            // If window would overflow left side
            const chatLeft = fabRect.right - chatW;
            if (chatLeft < 8) {
                chatWin.style.right = 'auto';
                chatWin.style.left = '8px';
            }
        }

        closeBtn.addEventListener('click', () => {
            chatWin.classList.remove('ai-chat--open');
            fab.classList.remove('ai-fab--active');
        });

        /* ── Send message ─────────────────────────────────────────── */
        sendBtn.addEventListener('click', sendMessage);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        async function sendMessage() {
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
            sendBtn.disabled = true;

            appendMsg('user', text);
            const thinkingEl = appendThinking();

            const prompt = buildPrompt(text);

            try {
                const res = await fetch(GEMINI_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-goog-api-key': GEMINI_KEY,
                    },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }]
                    })
                });

                if (!res.ok) {
                    const err = await res.text();
                    throw new Error(`API Error ${res.status}: ${err}`);
                }

                const data = await res.json();
                const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text
                    || '⚠️ Koi response nahi mila. Dobara try karo.';

                thinkingEl.remove();
                appendMsg('ai', reply);
            } catch (err) {
                thinkingEl.remove();
                appendMsg('ai', `❌ Error: ${err.message}`);
            } finally {
                sendBtn.disabled = false;
                input.focus();
            }
        }

        /* ── Context scraper ──────────────────────────────────────── */
        function scrapeContext() {
            const get = id => document.getElementById(id)?.innerText?.trim() || 'N/A';

            const totalRevenue = get('totalRevenueBox');
            const totalOrders = get('totalOrdersBox');
            const tableRevenue = get('tableRevenueBox');
            const tableOrders = get('tableOrdersBox');
            const qsRevenue = get('qsRevenueBox');
            const qsOrders = get('qsOrdersBox');
            const totalExpenses = get('totalExpenseBox');

            // Top items from Table/Parcel breakdown
            const tableRows = document.querySelectorAll('#tableSalesTableBody tr');
            const topTableItems = [];
            tableRows.forEach((row, i) => {
                if (i >= 3) return;
                const cells = row.querySelectorAll('td');
                if (cells.length >= 3) {
                    topTableItems.push(
                        `${cells[0].innerText.trim()} (Qty: ${cells[1].innerText.trim()}, Rev: ${cells[2].innerText.trim()})`
                    );
                }
            });

            // Top items from Quick Sale breakdown
            const qsRows = document.querySelectorAll('#qsSalesTableBody tr');
            const topQsItems = [];
            qsRows.forEach((row, i) => {
                if (i >= 3) return;
                const cells = row.querySelectorAll('td');
                if (cells.length >= 3) {
                    topQsItems.push(
                        `${cells[0].innerText.trim()} (Qty: ${cells[1].innerText.trim()}, Rev: ${cells[2].innerText.trim()})`
                    );
                }
            });

            return {
                totalRevenue, totalOrders,
                tableRevenue, tableOrders,
                qsRevenue, qsOrders,
                totalExpenses,
                topTableItems, topQsItems
            };
        }

        /* ── Prompt builder ───────────────────────────────────────── */
        function buildPrompt(userMessage) {
            const ctx = scrapeContext();

            const topTableStr = ctx.topTableItems.length
                ? ctx.topTableItems.join('; ')
                : 'No data';
            const topQsStr = ctx.topQsItems.length
                ? ctx.topQsItems.join('; ')
                : 'No data';

            return `You are the Smart AI Manager for "New Pizza Hut & Live Cake", a restaurant business. You have access to the live dashboard stats shown below. Be concise, smart, and friendly. Reply in Hinglish (mix of Hindi and English) with practical business insights. Keep answers short (under 120 words unless a detailed breakdown is asked). Use emojis where it feels natural.

LIVE DASHBOARD STATS:
- Total Revenue (selected period): ${ctx.totalRevenue}
- Total Orders: ${ctx.totalOrders}
- Table/Parcel Revenue: ${ctx.tableRevenue} | Orders: ${ctx.tableOrders}
- Quick Sale Revenue: ${ctx.qsRevenue} | Orders: ${ctx.qsOrders}
- Total Expenses: ${ctx.totalExpenses}
- Top Selling Items (Table/Parcel): ${topTableStr}
- Top Selling Items (Quick Sale): ${topQsStr}

Admin's Question: ${userMessage}`;
        }

        /* ── Message rendering ────────────────────────────────────── */
        function appendMsg(role, text) {
            const wrap = document.createElement('div');
            wrap.className = `ai-msg ai-msg--${role}`;

            const bubble = document.createElement('div');
            bubble.className = 'ai-bubble';
            bubble.innerHTML = formatText(text);

            wrap.appendChild(bubble);
            messages.appendChild(wrap);
            messages.scrollTop = messages.scrollHeight;
            return wrap;
        }

        function appendThinking() {
            const wrap = document.createElement('div');
            wrap.className = 'ai-msg ai-msg--ai';
            wrap.innerHTML = `<div class="ai-bubble ai-thinking"><span></span><span></span><span></span></div>`;
            messages.appendChild(wrap);
            messages.scrollTop = messages.scrollHeight;
            return wrap;
        }

        function formatText(text) {
            // Bold: **text**
            return text
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\n/g, '<br>');
        }
    }

})();
