// js/pos-customer-history.js
// AI UPDATE [2026-09-21]: NEW FILE — "📜 View History" button in the POS
// Billing Panel's Customer Offers modal (#customerCouponsModal, opened by
// tapping the online-customer name badge — see js/cart.js
// _openCustomerCouponsPanel()) opens THIS customer's complete order
// history, "similar to the Admin Customer Details view" per the task spec.
//
// ── Reuse, not duplication ───────────────────────────────────────────────
// - Data fetch: fetchCustomerHistoryData() is js/customers.js's own new
//   export — reads the exact same `customers/{phone}` profile doc and
//   `customer_order_history/{uid}/orders` subcollection the Admin Panel's
//   Customer Details overlay reads (same uid/authUid resolution, same
//   totalOrders/lifetimeSpend/lastOrderAt fast-path fields, same
//   completedAt sort). No new collection, no new customer-stats logic.
// - Order-list markup: buildOrdersHtml() is js/customers.js's own
//   _buildOrdersHtml, re-exported unchanged — identical bill cards, item
//   rows, and "Custom Discount" line as the Admin Panel's history list.
// (Same re-export pattern already used by js/incoming-orders-customers.js
// for `callRecoveryFn` — see the comment block at the top of that file.)
//
// This file only adds its OWN small profile/stat header (name, phone,
// avatar, Total Orders, Lifetime Spend, Date Joined, Last Order) using
// those same imported helpers, plus its own POS-scoped modal
// (#custHistoryModalPOS, markup + scoped CSS in index.html) — deliberately
// WITHOUT the Admin Panel's password-hash row or its account-management
// actions (Send Coupon / Generate Recovery Code / Delete Customer), since
// those are Admin-only account actions, not "history".
//
// Untouched by this file: the Offers/Coupons modal and its coupon logic
// (js/cart.js), js/customers.js's own Admin Panel UI/exports beyond the one
// new export block, admin/index.html, and admin.css.

import {
    fetchCustomerHistoryData, buildOrdersHtml, escHtml, fmtDate, fmtRupee, avatarLetter,
} from './customers.js';

function _summaryHtml(c) {
    const joined = c.joinedTs ? fmtDate(c.joinedTs) : '—';
    return `
<div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #30363d;">
    <div class="cust-av cust-av-lg">${avatarLetter(c.name)}</div>
    <div style="min-width:0;flex:1;">
        <div style="font-size:1.15rem;font-weight:800;color:#e6edf3;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(c.name || 'Unknown')}</div>
        <div style="font-size:0.92rem;color:#58a6ff;letter-spacing:0.2px;">${escHtml(c.phone || c.id)}</div>
    </div>
</div>
<div class="stats-row">
    <div class="stat-card blue">
        <div class="stat-label">Total Orders</div>
        <div class="stat-value">${c.orderCount}</div>
    </div>
    <div class="stat-card green">
        <div class="stat-label">Lifetime Spend</div>
        <div class="stat-value" style="font-size:1.3rem;">${fmtRupee(c.totalSpending)}</div>
    </div>
</div>
<div class="stats-row" style="margin-top:-6px;">
    <div class="stat-card" style="border-left:4px solid #6e40c9;flex:1 1 100%;">
        <div class="stat-label">Date Joined</div>
        <div class="stat-value" style="font-size:1.05rem;color:#c9d1d9;">${joined}</div>
    </div>
    ${c.lastOrderTs ? `
    <div class="stat-card" style="border-left:4px solid #8b949e;flex:1 1 100%;">
        <div class="stat-label">Last Order</div>
        <div class="stat-value" style="font-size:1.05rem;color:#c9d1d9;">${fmtDate(c.lastOrderTs)}</div>
    </div>` : ''}
</div>
<div class="list-title" style="margin-top:16px;margin-bottom:12px;">Order History</div>`;
}

// Tracks the phone currently loading/loaded so a slow fetch from a
// previous tap can never overwrite the view after the operator has since
// opened a DIFFERENT customer's history (or closed the modal).
let _requestToken = 0;

export async function openCustomerHistoryModal(phone, name) {
    const overlay = document.getElementById('custHistoryModalPOS');
    const body    = document.getElementById('custHistoryBodyPOS');
    if (!overlay || !body || !phone) return;

    const myToken = ++_requestToken;
    body.innerHTML = `<div class="loading-state">Loading ${escHtml(name || 'customer')}'s history… ☁️</div>`;
    overlay.classList.remove('hidden');

    let c;
    try {
        c = await fetchCustomerHistoryData(phone);
    } catch (err) {
        console.error('[pos-customer-history] Failed to load:', err);
        if (myToken === _requestToken) {
            body.innerHTML = `<div class="empty-state">⚠️ Could not load history. Please try again.</div>`;
        }
        return;
    }
    if (myToken !== _requestToken) return; // a newer request/close has since happened

    if (!c) {
        body.innerHTML = `<div class="empty-state">No profile found for this customer.</div>`;
        return;
    }
    body.innerHTML = _summaryHtml(c) + buildOrdersHtml(c.orders);
}

export function closeCustomerHistoryModal() {
    _requestToken++; // invalidate any in-flight fetch for the closed view
    document.getElementById('custHistoryModalPOS')?.classList.add('hidden');
}

document.getElementById('closeCustHistoryBtnPOS')?.addEventListener('click', closeCustomerHistoryModal);
document.getElementById('custHistoryModalPOS')?.addEventListener('click', (e) => {
    if (e.target.id === 'custHistoryModalPOS') closeCustomerHistoryModal(); // backdrop click
});

// "📜 View History" button inside the existing Offers/Coupons modal (index.html
// #customerCouponsModal). Reads the phone/name js/cart.js's _openCustomerCouponsPanel()
// already stashed on that same modal's dataset — so this always opens history for the
// EXACT SAME customer the Offers modal is currently showing, with zero changes to any
// coupon/offer code. The Offers modal itself stays open underneath (Back/Close on this
// view just hides it again, returning to the Offers modal/POS normally).
document.getElementById('viewCustHistoryBtnPOS')?.addEventListener('click', () => {
    const offersModal = document.getElementById('customerCouponsModal');
    const phone = offersModal?.dataset.phone;
    const name  = offersModal?.dataset.name;
    if (!phone) return; // Offers modal was never opened for a customer — nothing to show
    openCustomerHistoryModal(phone, name);
});
