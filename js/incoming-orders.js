/**
 * incoming-orders.js
 * ─────────────────────────────────────────────────────────────
 * Listens to pending_table_orders (written by the QR customer panel).
 * Shows a 📦 Incoming Orders button in the home grid.
 * On Accept → merges items into localStorage cart → navigates to table.
 *
 * BUG FIXES vs upstream:
 *   1. Button is ALWAYS touchable (never disabled when no orders).
 *   2. After Accept, fires `cart-updated` event so menu grid badges refresh.
 */

import { db } from './firebase-config.js';
import {
    collection, query, where, onSnapshot,
    doc, updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';

const ORDERS_COL = 'pending_table_orders';
let pendingOrders = [];

// ── BOOT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    injectHTML();
    wireEvents();
    startOrdersListener();
});

// ── FIRESTORE LISTENER ────────────────────────────────────────
function startOrdersListener() {
    const q = query(collection(db, ORDERS_COL), where('status', '==', 'pending'));
    onSnapshot(q, (snap) => {
        pendingOrders = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
        updateBadge();
        if (pendingOrders.length > 0) flashBtn();
        const drawer = document.getElementById('incomingOrdersDrawer');
        if (drawer?.classList.contains('open')) renderOrdersList();
    });
}

// ── BADGE ─────────────────────────────────────────────────────
function updateBadge() {
    const badge = document.getElementById('incOrdersBadge');
    const btn   = document.getElementById('incOrdersBtn');
    const count = pendingOrders.length;
    if (badge) {
        badge.textContent   = count;
        badge.style.display = count > 0 ? 'flex' : 'none';
    }
    // ✅ FIX: Button is ALWAYS visible + touchable — no disabling/hiding.
    // We only toggle a CSS class for the pulse animation.
    if (btn) btn.classList.toggle('has-orders', count > 0);
}

function flashBtn() {
    const btn = document.getElementById('incOrdersBtn');
    if (!btn) return;
    btn.style.transform = 'scale(1.15)';
    setTimeout(() => (btn.style.transform = ''), 300);
}

// ── DRAWER ───────────────────────────────────────────────────
async function openDrawer() {
    await renderOrdersList();
    document.getElementById('incomingOrdersDrawer')?.classList.add('open');
    document.getElementById('incOrdersOverlay')?.classList.add('open');
}
function closeDrawer() {
    document.getElementById('incomingOrdersDrawer')?.classList.remove('open');
    document.getElementById('incOrdersOverlay')?.classList.remove('open');
}

// ── RENDER ORDERS ─────────────────────────────────────────────
async function renderOrdersList() {
    const list = document.getElementById('incOrdersList');
    if (!list) return;

    if (pendingOrders.length === 0) {
        list.innerHTML = `
            <div style="text-align:center;padding:48px 20px;color:#6b7280;">
                <div style="font-size:40px;margin-bottom:12px;">✅</div>
                <p style="font-size:1rem;font-weight:bold;color:#d1d5db;">No pending orders</p>
                <p style="font-size:0.85rem;margin-top:6px;">All caught up! New orders appear here instantly.</p>
            </div>`;
        return;
    }

    list.innerHTML = pendingOrders.map(order => buildOrderCard(order)).join('');
}

function esc(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, '&#39;');
}
function normalizeTableName(id) {
    return (id && id !== 'Unknown') ? id : 'Unknown Table';
}

function buildOrderCard(order) {
    const table   = normalizeTableName(order.tableId);
    const fmt     = (n) => `₹${Number(n || 0).toFixed(0)}`;
    const ts      = order.createdAt?.seconds
        ? new Date(order.createdAt.seconds * 1000) : new Date();
    const timeStr = ts.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const docId   = order._docId;

    return `
    <div class="inc-order-card" id="inc-card-${docId}">
        <div class="inc-order-top">
            <div class="inc-order-left">
                <div class="inc-table-tag">🪑 ${esc(table)}</div>
                <div class="inc-customer">
                    <span>👤 <strong>${esc(order.customer?.name || 'Guest')}</strong></span>
                    <span>📱 ${esc(order.customer?.phone || '—')}</span>
                </div>
            </div>
            <div class="inc-order-right">
                <div class="inc-total">${fmt(order.totalPrice)}</div>
                <div class="inc-time">${timeStr}</div>
            </div>
        </div>
        <ul class="inc-items">
            ${(order.items || []).map(it => `
                <li>
                    <span>${esc(it.name)}</span>
                    <span>×${it.quantity || 1} &nbsp; ${fmt(it.subtotal)}</span>
                </li>`).join('')}
        </ul>
        <div class="inc-actions">
            <button class="inc-btn inc-reject"
                    onclick="window._incReject('${esc(docId)}')">
                ✕ Reject
            </button>
            <button class="inc-btn inc-accept"
                    id="inc-accept-${docId}"
                    onclick="window._incAccept('${esc(docId)}', '${esc(table)}')">
                ✓ Accept → ${esc(table)}
            </button>
        </div>
    </div>`;
}

// ── ACCEPT ───────────────────────────────────────────────────
window._incAccept = async function(docId, tableName) {
    const order = pendingOrders.find(o => o._docId === docId);
    if (!order) return;

    const btn = document.getElementById(`inc-accept-${docId}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }

    // 1. Merge items into localStorage cart  (Table X → C1)
    const cartKey = `cart_${tableName}_C1`;
    let cart = [];
    try { cart = JSON.parse(localStorage.getItem(cartKey)) || []; } catch(e) {}

    for (const ni of (order.items || [])) {
        const match = cart.find(e => e.name === ni.name && e.price === ni.price);
        if (match) {
            match.qty = (match.qty || 1) + (ni.quantity || 1);
        } else {
            cart.push({
                id:         ni.itemId || `qr_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                name:       ni.name,
                price:      ni.price,
                qty:        ni.quantity || 1,
                printedQty: 0,
            });
        }
    }
    localStorage.setItem(cartKey, JSON.stringify(cart));

    // ✅ FIX: Fire cart-updated so syncItemBadges() in menu.js refreshes
    // the menu grid badges immediately when POS screen is open.
    window.dispatchEvent(new Event('cart-updated'));

    // 2. Mark accepted in Firestore
    try {
        await updateDoc(doc(db, ORDERS_COL, docId), {
            status:     'accepted',
            acceptedAt: new Date().toISOString(),
        });
    } catch(e) { console.error('Firestore accept failed:', e); }

    // 3. Close drawer → navigate to that table
    closeDrawer();
    if (typeof window._posOpenTable === 'function') {
        window._posOpenTable(tableName, 'C1');
    } else {
        alert(`Order added to ${tableName}! Open that table to see it.`);
    }
};

// ── REJECT ───────────────────────────────────────────────────
window._incReject = async function(docId) {
    if (!confirm('Reject this order?')) return;
    try {
        await updateDoc(doc(db, ORDERS_COL, docId), {
            status:     'rejected',
            rejectedAt: new Date().toISOString(),
        });
    } catch(e) { console.error('Reject failed:', e); }
};

// ── HTML INJECTION ───────────────────────────────────────────
function injectHTML() {
    // ── Button (adopt existing or create new) ──
    let btn = document.getElementById('incOrdersBtn');
    if (!btn) {
        const all = Array.from(document.querySelectorAll('button, .menu-big-btn'));
        btn = all.find(b =>
            b.textContent.toLowerCase().includes('incoming') ||
            b.textContent.includes('📦 Orders'));
    }
    if (btn) {
        btn.id = 'incOrdersBtn';
        if (!btn.querySelector('#incOrdersBadge')) {
            const badge = document.createElement('span');
            badge.id            = 'incOrdersBadge';
            badge.className     = 'inc-badge';
            badge.style.display = 'none';
            badge.textContent   = '0';
            btn.style.position  = 'relative';
            btn.prepend(badge);
        }
    } else {
        btn           = document.createElement('button');
        btn.id        = 'incOrdersBtn';
        btn.className = 'menu-big-btn';
        btn.innerHTML = `
            <span id="incOrdersBadge" class="inc-badge" style="display:none;">0</span>
            <span class="icon">📦</span>
            <span class="title">Incoming Orders</span>`;
        const homeGrid = document.querySelector('.home-grid');
        if (homeGrid) homeGrid.appendChild(btn);
    }

    // ── Drawer + overlay ──
    if (!document.getElementById('incomingOrdersDrawer')) {
        document.body.insertAdjacentHTML('beforeend', `
        <div id="incOrdersOverlay" class="inc-overlay"></div>
        <div id="incomingOrdersDrawer" class="inc-drawer">
            <div class="inc-drawer-header">
                <h3 style="margin:0;color:#f9fafb;font-size:1.1rem;">📦 Incoming Orders</h3>
                <button id="incOrdersClose">✕</button>
            </div>
            <div class="inc-drawer-body" id="incOrdersList"></div>
        </div>`);
    }
}

// ── WIRE EVENTS ──────────────────────────────────────────────
function wireEvents() {
    window._incOpenDrawer  = openDrawer;
    window._incCloseDrawer = closeDrawer;

    // Re-attach after injectHTML (elements may not exist at module load)
    const attach = () => {
        const btn     = document.getElementById('incOrdersBtn');
        const overlay = document.getElementById('incOrdersOverlay');
        const close   = document.getElementById('incOrdersClose');
        if (btn && !btn._incWired) {
            btn.addEventListener('click', openDrawer);
            btn._incWired = true;
        }
        if (overlay) overlay.addEventListener('click', closeDrawer);
        if (close)   close.addEventListener('click', closeDrawer);
    };
    attach();
    // Also attach after a tick in case injectHTML ran after wireEvents
    setTimeout(attach, 100);
}

// ── STYLES ───────────────────────────────────────────────────
function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
    /* ── Incoming Orders button ── */
    #incOrdersBtn {
        position: relative;
        background: linear-gradient(135deg, #b91c1c, #ef4444) !important;
        /* ✅ Never pointer-events:none — always touchable */
    }
    #incOrdersBtn.has-orders {
        animation: incPulse 2s ease-in-out infinite;
    }
    @keyframes incPulse {
        0%, 100% { box-shadow: 0 0 0 0   rgba(239,68,68,0.55); }
        50%       { box-shadow: 0 0 0 14px rgba(239,68,68,0);   }
    }

    /* ── Badge ── */
    .inc-badge {
        position: absolute;
        top: -8px; right: -8px;
        background: #fbbf24;
        color: #000;
        font-weight: 900;
        font-size: 0.78rem;
        min-width: 22px; height: 22px;
        border-radius: 11px;
        display: flex; align-items: center; justify-content: center;
        padding: 0 5px;
        z-index: 10;
        box-shadow: 0 2px 6px rgba(0,0,0,0.35);
    }

    /* ── Overlay ── */
    .inc-overlay {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.65);
        z-index: 8000;
        backdrop-filter: blur(3px);
    }
    .inc-overlay.open { display: block; }

    /* ── Drawer ── */
    .inc-drawer {
        position: fixed;
        bottom: 0; left: 0; right: 0;
        background: #1f2937;
        border-radius: 20px 20px 0 0;
        z-index: 8001;
        max-height: 85dvh;
        display: flex;
        flex-direction: column;
        transform: translateY(100%);
        transition: transform 0.3s cubic-bezier(0.32,0.72,0,1);
        box-shadow: 0 -8px 32px rgba(0,0,0,0.5);
    }
    .inc-drawer.open { transform: translateY(0); }

    .inc-drawer-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px 14px;
        border-bottom: 1px solid #374151;
        flex-shrink: 0;
    }
    #incOrdersClose {
        background: #374151; border: none;
        color: #9ca3af; width: 32px; height: 32px;
        border-radius: 50%; font-size: 1rem;
        cursor: pointer; display: flex;
        align-items: center; justify-content: center;
    }
    #incOrdersClose:hover { background: #ef4444; color: #fff; }

    .inc-drawer-body {
        overflow-y: auto; flex: 1;
        padding: 14px 16px 32px;
        -webkit-overflow-scrolling: touch;
    }

    /* ── Order card ── */
    .inc-order-card {
        background: #111827;
        border: 1px solid #374151;
        border-radius: 14px;
        padding: 14px;
        margin-bottom: 12px;
    }
    .inc-order-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 10px;
        gap: 10px;
    }
    .inc-order-left  { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .inc-table-tag   { font-size: 0.78rem; font-weight: 800; color: #60a5fa; text-transform: uppercase; letter-spacing: 0.6px; }
    .inc-customer    { display: flex; flex-direction: column; gap: 2px; font-size: 0.88rem; color: #d1d5db; }
    .inc-order-right { text-align: right; flex-shrink: 0; }
    .inc-total       { font-size: 1.2rem; font-weight: 900; color: #34d399; }
    .inc-time        { font-size: 0.78rem; color: #6b7280; margin-top: 2px; }

    .inc-items {
        list-style: none; padding: 8px 0; margin: 0 0 12px;
        border-top: 1px solid #374151; border-bottom: 1px solid #374151;
    }
    .inc-items li {
        display: flex; justify-content: space-between;
        font-size: 0.88rem; color: #d1d5db; padding: 4px 0;
    }

    .inc-actions { display: flex; gap: 10px; }
    .inc-btn {
        flex: 1; padding: 12px 8px;
        border: none; border-radius: 10px;
        font-weight: 800; font-size: 0.92rem; cursor: pointer;
        transition: opacity 0.15s, transform 0.1s;
    }
    .inc-btn:active  { transform: scale(0.96); opacity: 0.85; }
    .inc-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
    .inc-reject { background: transparent; color: #ef4444; border: 1.5px solid #ef4444; }
    .inc-accept { background: #059669; color: #fff; }
    `;
    document.head.appendChild(style);
}
