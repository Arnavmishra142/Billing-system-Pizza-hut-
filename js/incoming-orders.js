// incoming-orders.js
// Listens to Firestore `pending_table_orders` for new customer orders.
// Shows badge on #btn-orders and a toast notification — NO SOUND.

import { db } from './firebase-config.js';
import {
    collection,
    onSnapshot,
    query,
    orderBy,
    doc,
    updateDoc,
    Timestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnOrders   = document.getElementById('btn-orders');
const badge       = document.getElementById('orders-badge');
const drawer      = document.getElementById('ordersDrawer');
const overlay     = document.getElementById('ordersOverlay');
const drawerList  = document.getElementById('ordersDrawerList');

// Track order IDs we've already notified about so we don't re-toast on re-render
const _notified = new Set();

// ── Badge counter ─────────────────────────────────────────────────────────────
function setBadge(count) {
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'flex';
        btnOrders && btnOrders.classList.add('btn-pulse');
    } else {
        badge.style.display = 'none';
        btnOrders && btnOrders.classList.remove('btn-pulse');
    }
}

// ── Toast notification ────────────────────────────────────────────────────────
function showToast(tableName, itemCount) {
    const existing = document.getElementById('order-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'order-toast';
    toast.innerHTML = `
        <span style="font-size:1.3rem;">🔔</span>
        <div>
            <strong>New Order!</strong>
            <div style="font-size:0.85rem;opacity:0.9;">${tableName} · ${itemCount} item${itemCount !== 1 ? 's' : ''}</div>
        </div>
    `;
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999;
        background: linear-gradient(135deg, #f59e0b, #fbbf24);
        color: #1a1a1a;
        border-radius: 14px;
        padding: 14px 20px;
        display: flex;
        align-items: center;
        gap: 12px;
        font-family: inherit;
        font-weight: 600;
        box-shadow: 0 8px 30px rgba(0,0,0,0.35);
        cursor: pointer;
        animation: toastIn 0.35s ease;
    `;

    // Add animation keyframes once
    if (!document.getElementById('toast-style')) {
        const s = document.createElement('style');
        s.id = 'toast-style';
        s.textContent = `
            @keyframes toastIn  { from { opacity:0; transform:translateY(-16px); } to { opacity:1; transform:translateY(0); } }
            @keyframes toastOut { from { opacity:1; transform:translateY(0); }     to { opacity:0; transform:translateY(-16px); } }
            @keyframes badgePop { 0%{transform:scale(1)} 50%{transform:scale(1.4)} 100%{transform:scale(1)} }
            .btn-pulse { animation: badgePop 0.5s ease 3; }
            #orders-badge {
                position: absolute;
                top: -8px;
                right: -8px;
                background: #ef4444;
                color: #fff;
                border-radius: 999px;
                min-width: 22px;
                height: 22px;
                font-size: 0.72rem;
                font-weight: 700;
                display: none;
                align-items: center;
                justify-content: center;
                padding: 0 5px;
                pointer-events: none;
                z-index: 10;
                box-shadow: 0 2px 6px rgba(0,0,0,0.4);
            }
            .orders-drawer {
                position: fixed;
                bottom: 0; left: 0; right: 0;
                background: var(--card-bg, #1e1e2e);
                border-radius: 20px 20px 0 0;
                z-index: 5000;
                transform: translateY(100%);
                transition: transform 0.3s ease;
                max-height: 80vh;
                display: flex;
                flex-direction: column;
            }
            .orders-drawer.open { transform: translateY(0); }
            .orders-overlay {
                position: fixed; inset: 0;
                background: rgba(0,0,0,0.55);
                z-index: 4999;
                display: none;
                opacity: 0;
                transition: opacity 0.3s ease;
            }
            .orders-overlay.open { display: block; opacity: 1; }
            .order-card-item {
                background: var(--input-bg, #2a2a3e);
                border-radius: 12px;
                padding: 14px 16px;
                margin-bottom: 12px;
                border-left: 4px solid #f59e0b;
            }
            .order-card-item .oc-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
            }
            .order-card-item .oc-table {
                font-weight: 700;
                font-size: 1rem;
            }
            .order-card-item .oc-time {
                font-size: 0.75rem;
                opacity: 0.6;
            }
            .order-card-item .oc-items {
                font-size: 0.85rem;
                opacity: 0.85;
                margin-bottom: 10px;
                line-height: 1.5;
            }
            .order-card-item .oc-actions {
                display: flex;
                gap: 8px;
            }
            .oc-btn-accept {
                flex: 1;
                background: linear-gradient(135deg, #10b981, #34d399);
                color: #fff;
                border: none;
                border-radius: 8px;
                padding: 9px;
                font-weight: 600;
                font-size: 0.9rem;
                cursor: pointer;
            }
            .oc-btn-dismiss {
                background: rgba(255,255,255,0.08);
                color: inherit;
                border: none;
                border-radius: 8px;
                padding: 9px 14px;
                font-size: 0.85rem;
                cursor: pointer;
                opacity: 0.7;
            }
        `;
        document.head.appendChild(s);
    }

    document.body.appendChild(toast);
    toast.addEventListener('click', openDrawer);

    // Auto-dismiss after 6s
    setTimeout(() => {
        toast.style.animation = 'toastOut 0.35s ease forwards';
        setTimeout(() => toast.remove(), 350);
    }, 6000);
}

// ── Drawer open / close ───────────────────────────────────────────────────────
function openDrawer()  {
    drawer && drawer.classList.add('open');
    overlay && overlay.classList.add('open');
}
function closeDrawer() {
    drawer && drawer.classList.remove('open');
    overlay && overlay.classList.remove('open');
}

// ── Render orders inside the drawer ──────────────────────────────────────────
let _pendingOrders = [];

function renderDrawer(orders) {
    if (!drawerList) return;

    if (orders.length === 0) {
        drawerList.innerHTML = `<p style="text-align:center;opacity:0.5;padding:30px 0;">No pending orders right now 🎉</p>`;
        return;
    }

    drawerList.innerHTML = '';

    orders.forEach(order => {
        const { id, tableName = 'Unknown Table', items = [], createdAt } = order;

        const timeLabel = createdAt
            ? new Date(createdAt.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';

        const itemsText = items.map(i => `${i.name} ×${i.qty}`).join(', ') || 'No item details';

        const card = document.createElement('div');
        card.className = 'order-card-item';
        card.innerHTML = `
            <div class="oc-head">
                <span class="oc-table">🔔 ${tableName}</span>
                <span class="oc-time">${timeLabel}</span>
            </div>
            <div class="oc-items">${itemsText}</div>
            <div class="oc-actions">
                <button class="oc-btn-accept">✅ Open in POS</button>
                <button class="oc-btn-dismiss">Dismiss</button>
            </div>
        `;

        // Accept → open the table in POS
        card.querySelector('.oc-btn-accept').addEventListener('click', async () => {
            // Mark as accepted in Firestore
            try {
                await updateDoc(doc(db, 'pending_table_orders', id), { status: 'accepted' });
            } catch(e) { console.warn('Could not update order status:', e); }

            closeDrawer();

            // Open POS for the table if function is exposed
            if (typeof window._posOpenTable === 'function') {
                // Navigate to table grid first, then open POS
                if (typeof window._posLoadGrid === 'function') {
                    const isParcel = tableName.toLowerCase().includes('parcel');
                    window._posLoadGrid(isParcel ? 'parcel' : 'table');
                }
                setTimeout(() => window._posOpenTable(tableName), 100);
            }
        });

        // Dismiss → just mark as accepted (hides from list)
        card.querySelector('.oc-btn-dismiss').addEventListener('click', async () => {
            try {
                await updateDoc(doc(db, 'pending_table_orders', id), { status: 'dismissed' });
            } catch(e) {}
        });

        drawerList.appendChild(card);
    });
}

// ── Firestore listener ────────────────────────────────────────────────────────
function startListening() {
    const q = query(
        collection(db, 'pending_table_orders'),
        orderBy('createdAt', 'desc')
    );

    onSnapshot(q, (snapshot) => {
        const pending = [];

        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            // Only show pending orders (not yet accepted/dismissed)
            if (data.status !== 'pending') return;

            const order = { id: docSnap.id, ...data };
            pending.push(order);

            // Toast only for truly new orders we haven't seen yet
            if (!_notified.has(docSnap.id)) {
                _notified.add(docSnap.id);
                const itemCount = (data.items || []).reduce((s, i) => s + (i.qty || 1), 0);
                showToast(data.tableName || 'Unknown Table', itemCount || 1);
            }
        });

        _pendingOrders = pending;
        setBadge(pending.length);
        renderDrawer(pending);
    }, (err) => {
        console.error('incoming-orders listener error:', err);
    });
}

// ── Wire up button & overlay ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    if (btnOrders) {
        // Make btn position:relative so the badge positions correctly
        btnOrders.style.position = 'relative';
        btnOrders.addEventListener('click', openDrawer);
    }
    if (overlay) overlay.addEventListener('click', closeDrawer);

    startListening();
});
