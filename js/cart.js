import { db, functions } from './firebase-config.js';
import { doc, setDoc, updateDoc, serverTimestamp, getDocs, getDoc, query, where, collection, increment } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";
// AI UPDATE [2026-07-30]: Import receipt builder for ESC/POS bill printing.
import { initReceiptPrinter, buildBillReceipt } from './receipt-builder.js';
// AI UPDATE [2026-07-30]: Import custom dialog system — replaces alert()/confirm().
import { showAlert, showConfirm } from './dialog.js';

// ===== AI UPDATE =====
// Date: 2026-07-28
// Feature: Customer Order History Sync — Order Completion
// Summary:
// When the operator presses "Bill & Settle" or "Save & Exit", if the current
// table had an order from the Customer Panel (identified by the
// activeCustomerUid_<table> key that incoming-orders.js writes to localStorage
// when an order is accepted), this module:
//   1. Marks all active pending_table_orders docs for that table as 'completed'
//      → the customer's Active Orders view (which filters on status) updates in
//      real time without a page refresh.
//   2. Writes a completed-order record to:
//        customer_order_history/{customerUid}/orders/ORDER_{timestamp}
//      → the customer's Order History tab reads this subcollection.
//   3. Clears the localStorage convenience-cache keys for that table so the
//      next manual order on the same table starts clean.
//
// IMPORTANT — does NOT affect manual/walk-in orders:
//   The sync is gated on activeCustomerUid_<table> being present in
//   localStorage.  Manual bills (no Customer Panel order) never set that key,
//   so syncCustomerOrderCompletion() returns immediately without any Firestore
//   write.  All existing billing logic is untouched.
//
// Firestore collections written:
//   - pending_table_orders/{orderId}  update  { status:'completed', completedAt }
//   - customer_order_history/{uid}/orders/{orderId}  set  { full order record }
//
// Corresponding Firestore rules (see firestore.rules):
//   - pending_table_orders update: 'completed' added to isAllowedStatusUpdate()
//   - customer_order_history: operator can write, customer can read their own
//
// Customer Panel (Order- repo) changes needed:
//   - Replace js/order-status.js with the version in order-panel-updates/
//     (see that file for the full active-orders + history listener implementation)
// =====================

// ===== AI UPDATE =====
// Date: 2026-07-28 (v2)
// Bug fix: Issue 2 — Two pending cards from same table; accepting one caused the other to disappear.
//
// Root cause:
//   syncCustomerOrderCompletion queried ALL pending/active orders for the table
//   (where('tableId', '==', tableName)) and marked EVERY active one as 'completed'.
//   When the operator accepted Card A and then billed it, the sync function also
//   marked Card B (still pending, never imported) as 'completed' — removing it
//   from the incoming-orders drawer permanently.
//
// Fix:
//   incoming-orders.js v9 now writes the specific Firestore document IDs that
//   were imported via "Open in POS" to localStorage key:
//     acceptedOrderIds_<tableName>  (JSON array, accumulates across multiple accepts)
//   This function now reads that list and marks ONLY those specific orders as
//   'completed'.  Other pending cards for the same table are left untouched so
//   the operator can process them independently.
//   Fallback: if the key is absent (manual/walk-in billing, or pre-fix sessions),
//   the original behavior (mark all active docs) is preserved for safety.
//   acceptedOrderIds_<tableName> is cleared in Step 3 alongside other keys.
// =====================

// ── Customer order completion sync (best-effort, non-blocking) ───────────────
//
// Called by both "Bill & Settle" and "Save & Exit" handlers after the sale is
// saved.  Only has any effect when the table has an active Customer Panel order
// (i.e. incoming-orders.js stored activeCustomerUid_<table> in localStorage
// when the operator pressed "Open in POS").
//
// What it does when a Customer Panel order IS present:
//   1. Queries pending_table_orders for all active docs on this table.
//   2. Marks ONLY the specific orders imported via "Open in POS" as 'completed'
//      (tracked in acceptedOrderIds_<table>; falls back to all active docs if
//      the key is absent so manual billing is unaffected).
//   3. Writes one completed-order record to
//        customer_order_history/{customerUid}/orders/ORDER_{timestamp}
//      so the customer's Order History tab can display it.
//   4. Clears the localStorage convenience-cache keys for this table.
//
// What it does for manual/walk-in orders (NO Customer Panel order):
//   Returns immediately without any Firestore write.  All existing billing
//   logic is completely unaffected.
// ─────────────────────────────────────────────────────────────────────────────
// AI UPDATE [2026-07-29] session 18:
// Added optional billNumber parameter (passed from Bill & Settle shortOrderId).
// After writing history, also updates customers/{phone} stats atomically using
// increment() so the admin CRM can read pre-computed totals without re-scanning history.
async function syncCustomerOrderCompletion(tableName, cartSnapshot, total, completionReason, billNumber = null) {
    // ── Step 1: Find all still-active pending_table_orders for this table ──
    // Do this first so we can also recover the customerUid from Firestore
    // if localStorage doesn't have it (e.g. after a page refresh, or if the
    // operator opened the table directly without clicking "Open in POS").
    let customerUid = localStorage.getItem(`activeCustomerUid_${tableName}`);

    try {
        const q = query(
            collection(db, 'pending_table_orders'),
            where('tableId', '==', tableName)
        );
        const snap = await getDocs(q);
        const activeDocs = snap.docs.filter(d =>
            ['pending', 'accepted', 'kot'].includes((d.data().status || '').toLowerCase())
        );

        // AI UPDATE [2026-07-28] v2 — Issue 2 fix:
        // Only complete the specific orders imported via "Open in POS".
        // incoming-orders.js writes the accepted IDs to acceptedOrderIds_<table>.
        // Fallback: if the key is absent, complete all active docs (original behavior
        // — safe for manual/walk-in billing where no tracking key is written).
        const _acceptedIds = JSON.parse(
            localStorage.getItem(`acceptedOrderIds_${tableName}`) || '[]'
        );
        const docsToComplete = _acceptedIds.length > 0
            ? activeDocs.filter(d => _acceptedIds.includes(d.id))
            : activeDocs;

        // Recover customerUid from the imported orders first; fall back to any active doc.
        if (!customerUid && docsToComplete.length > 0) {
            customerUid = docsToComplete[0].data().customer?.uid || '';
            if (customerUid) {
                console.log(`[OrderSync] Recovered customerUid from Firestore for table "${tableName}"`);
            }
        }
        if (!customerUid && activeDocs.length > 0) {
            customerUid = activeDocs[0].data().customer?.uid || '';
        }

        if (!customerUid) {
            // No Customer Panel UID anywhere — manual/walk-in bill, nothing to sync.
            return;
        }

        // Grab customer name/phone from the specific imported docs for the history record.
        const _firstDoc = docsToComplete.length > 0 ? docsToComplete[0]
                        : activeDocs.length > 0      ? activeDocs[0]
                        : null;
        let customerName  = '';
        let customerPhone = '';
        if (_firstDoc) {
            const cust    = _firstDoc.data().customer || {};
            customerName  = cust.name  || '';
            customerPhone = cust.phone || '';
        }

        // Mark ONLY the imported orders as 'completed'.
        // Other pending cards for the same table are left untouched.
        // The customer panel listens to this collection filtered by UID + status,
        // so these updates remove them from the Active Orders view in real time.
        await Promise.all(
            docsToComplete.map(d =>
                updateDoc(d.ref, {
                    status:      'completed',
                    completedAt: serverTimestamp(),
                }).catch(e => console.warn('[OrderSync] status update failed:', e))
            )
        );

        console.log(
            `[OrderSync] Marked ${docsToComplete.length} order(s) completed for table "${tableName}"`,
            `(tracked: ${_acceptedIds.length}, active total: ${activeDocs.length})`
        );

        // ── Step 2: Write a permanent record to the customer's order history ───
        if (cartSnapshot.length > 0) {
            const historyId = `ORDER_${Date.now()}`;
            await setDoc(
                doc(db, 'customer_order_history', customerUid, 'orders', historyId),
                {
                    orderId:          historyId,
                    // AI UPDATE [2026-07-29] session 18: added billNumber + orderStatus
                    billNumber:       billNumber || null,     // short ID printed on bill (Bill & Settle only)
                    orderStatus:      'completed',
                    tableId:          tableName,
                    customerName,
                    customerPhone,
                    items: cartSnapshot.map(i => ({
                        name:     i.name,
                        price:    i.price,
                        quantity: i.qty,
                        subtotal: +(i.price * i.qty).toFixed(2),
                    })),
                    total:            +total.toFixed(2),
                    completedAt:      serverTimestamp(),
                    completionReason,          // 'bill_settle' | 'save_exit'
                    orderedAt:        new Date().toISOString(),
                }
            );

            // ── Step 2b: Update pre-computed stats on the customer profile ───────
            // Uses increment() for atomic, race-condition-free updates.
            // The customers/{phone} profile is guaranteed to exist at this point
            // because the customer must have registered before placing an order.
            // Non-blocking — billing is already complete by this step.
            if (customerPhone) {
                updateDoc(doc(db, 'customers', customerPhone), {
                    totalOrders:   increment(1),
                    lifetimeSpend: increment(+total.toFixed(2)),
                    lastOrderAt:   serverTimestamp(),
                }).catch(e => console.warn('[OrderSync] Profile stats update failed (non-fatal):', e.message));
            }
        }

        // ── Step 3: Clear localStorage convenience cache for this table ────────
        // acceptedOrderIds added to the clear list (v2 / Issue 2 fix).
        ['activeOrderDocId', 'activeCustomerUid', 'activeSessionId', 'activeLockId', 'acceptedOrderIds']
            .forEach(key => localStorage.removeItem(`${key}_${tableName}`));

        console.log(`[OrderSync] Order completion synced for table "${tableName}" (${completionReason})`);
    } catch (err) {
        // Non-fatal — billing is already done, this is just customer-panel sync.
        console.warn('[OrderSync] Customer order history sync failed (non-fatal):', err.message || err);
    }
}

// ── Customer table-lock release (best-effort, non-blocking) ──────────────────
//
// Calls the releaseTableLock Cloud Function to clean up any active customer
// session for this table (used by the Customer Order Panel integration).
//
// This is fire-and-forget: billing operations (save to Firestore, clear cart,
// navigate back) always proceed regardless of whether the Cloud Function
// succeeds.  The function only exists to serve the customer-facing panel; the
// billing panel's core flow must never be blocked by it.
//
// If the operator is not signed in via Firebase Auth, or the function is not
// yet deployed, the call silently fails and we continue normally.
// ─────────────────────────────────────────────────────────────────────────────
function releaseTableLockInBackground(tableName, releaseReason) {
    try {
        const fn = httpsCallable(functions, 'releaseTableLock');
        fn({ tableId: tableName, releaseReason })
            .then(result => {
                console.log(`[LockRelease] OK for "${tableName}", reason: ${releaseReason}`, result.data);
            })
            .catch(err => {
                // Non-fatal — customer panel lock cleanup failed, but billing is done.
                console.warn(`[LockRelease] Cloud Function failed (non-fatal) for "${tableName}":`, err.code, err.message);
            });
    } catch (err) {
        console.warn('[LockRelease] Could not invoke Cloud Function (non-fatal):', err.message);
    }
}

// ── Auto-cancel imported order when cart is emptied before saving ─────────────
//
// Called by Hold and Save & Exit when the cart is empty at exit time.
// If the operator imported a customer order ("Open in POS") but removed every
// item before billing, the order would be stuck as "accepted" in Firestore
// forever — the customer would see "Order Confirmed" with no way to clear it.
//
// Reuses the existing "dismissed" status (same as the Dismiss button in
// incoming-orders.js) so the customer panel immediately removes the order from
// Active Orders, matching the behaviour of operator-dismissed orders.
//
// Guards:
//   1. acceptedOrderIds_<table> must be non-empty (an order was imported).
//   2. Firestore status must still be "pending" or "accepted" — if the order
//      has already reached "kot", the kitchen has it; do not silently cancel.
//
// Fire-and-forget: navigation back to the table grid always proceeds
// regardless of whether the Firestore writes succeed.
// ─────────────────────────────────────────────────────────────────────────────
// AI UPDATE [2026-07-29] session 23:
//   Added — handles the missing edge case where all imported items are removed
//   from the POS cart before Save/Bill.  Without this, status stayed "accepted"
//   and the customer saw "Order Confirmed" forever.
async function cancelImportedOrdersOnEmptyCart(tableName) {
    const acceptedIds = JSON.parse(
        localStorage.getItem(`acceptedOrderIds_${tableName}`) || '[]'
    );
    if (acceptedIds.length === 0) return; // No imported order — nothing to cancel

    try {
        await Promise.all(
            acceptedIds.map(async id => {
                const ref      = doc(db, 'pending_table_orders', id);
                const snapshot = await getDoc(ref);
                if (!snapshot.exists()) return;
                const status = (snapshot.data().status || '').toLowerCase();
                // Only cancel pre-KOT orders.  "kot" or "completed" means the
                // kitchen / billing already owns the order — never touch those.
                if (!['pending', 'accepted'].includes(status)) return;
                return updateDoc(ref, { status: 'dismissed' })
                    .catch(e => console.warn('[OrderCancel] Failed to dismiss order:', id, e));
            })
        );

        // Clear the same localStorage convenience-cache keys that
        // syncCustomerOrderCompletion clears on normal completion.
        ['activeOrderDocId', 'activeCustomerUid', 'activeSessionId', 'activeLockId', 'acceptedOrderIds']
            .forEach(key => localStorage.removeItem(`${key}_${tableName}`));

        console.log(`[OrderCancel] Auto-cancelled empty imported order(s) for table "${tableName}"`);
    } catch (err) {
        // Non-fatal — the operator has already navigated back to the table grid.
        console.warn('[OrderCancel] Auto-cancel failed (non-fatal):', err.message || err);
    }
}

// ── Cancel Order — operator explicitly cancels while in POS ──────────────────
//
// AI UPDATE [2026-07-30]:
// Added to handle the case where the operator opens an order in POS but decides
// not to process it.  Without this, the customer's Active Orders card would be
// stuck forever showing "Order Confirmed" or "Preparing 🍕".
//
// Differences from cancelImportedOrdersOnEmptyCart():
//   - Also cancels 'kot'-status orders (operator decides to abort even after
//     KOT was printed and kitchen was notified).
//   - Only skips 'completed' orders (already billed — must never be un-billed).
//   - Triggered by an explicit CANCEL ORDER button press, not by an empty-cart
//     edge-case on Save & Exit.
//
// Firestore documents updated:
//   - pending_table_orders/{id}  →  { status: 'dismissed' }
//     for every doc in acceptedOrderIds_<tableName> whose status is not 'completed'.
//     'dismissed' is the existing shared contract: the Customer Panel's onSnapshot
//     listener removes any Active Order card when it sees this status.
//
// Does NOT write to:
//   - sales_history          (not a completed sale)
//   - customer_order_history (customer sees no record)
//   - ghost history / saveToGhostHistory
//
// Fire-and-forget: navigation back to the table grid has already happened before
// this function runs.  A Firestore failure is logged but never blocks the UI.
// ─────────────────────────────────────────────────────────────────────────────
async function cancelOrderInPOS(tableName) {
    const acceptedIds = JSON.parse(
        localStorage.getItem(`acceptedOrderIds_${tableName}`) || '[]'
    );

    try {
        if (acceptedIds.length > 0) {
            await Promise.all(
                acceptedIds.map(async id => {
                    const ref      = doc(db, 'pending_table_orders', id);
                    const snapshot = await getDoc(ref);
                    if (!snapshot.exists()) return;
                    const status = (snapshot.data().status || '').toLowerCase();
                    // Skip only 'completed' — pending, accepted, and kot are all
                    // valid targets for an explicit operator cancel.
                    if (status === 'completed') return;
                    return updateDoc(ref, { status: 'dismissed' })
                        .catch(e => console.warn('[CancelOrder] dismiss failed for', id, e));
                })
            );
        }

        // Clear all localStorage convenience-cache keys — same set as
        // syncCustomerOrderCompletion and cancelImportedOrdersOnEmptyCart.
        ['activeOrderDocId', 'activeCustomerUid', 'activeSessionId', 'activeLockId', 'acceptedOrderIds']
            .forEach(key => localStorage.removeItem(`${key}_${tableName}`));

        console.log(`[CancelOrder] Order explicitly cancelled for table "${tableName}".`);
    } catch (err) {
        // Non-fatal — UI has already returned to the table grid.
        console.warn('[CancelOrder] Firestore cancel failed (non-fatal):', err.message || err);
    }
}

// ── Error banner helper ───────────────────────────────────────────────────────
// Shows a temporary error message near the action buttons.
// Auto-removes after 6 seconds.  Uses the dark POS colour palette.
function _showReleaseError(message) {
    const existing = document.getElementById('lock-release-error');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'lock-release-error';
    banner.style.cssText = [
        'position:fixed',
        'bottom:80px',
        'left:50%',
        'transform:translateX(-50%)',
        'background:#7f1d1d',
        'color:#fecaca',
        'border:1px solid #ef4444',
        'border-radius:10px',
        'padding:12px 20px',
        'font-size:0.9rem',
        'font-weight:600',
        'text-align:center',
        'z-index:9999',
        'max-width:90vw',
        'box-shadow:0 4px 20px rgba(0,0,0,0.5)',
    ].join(';');
    banner.textContent = '⚠️ ' + message;
    document.body.appendChild(banner);

    setTimeout(() => banner.remove(), 6000);
}

// AI UPDATE [2026-07-30]: Pre-load the shop logo for thermal receipt printing.
// Fire-and-forget — printing falls back gracefully if logo isn't ready yet.
initReceiptPrinter();

document.addEventListener('DOMContentLoaded', () => {
    const cartItemsContainer = document.getElementById('cartItems');
    const cartTotalElement = document.getElementById('cartTotal');
    const activeTableNameEl = document.getElementById('activeTableName');

    let currentCart = [];

    const getCurrentTable = () => activeTableNameEl.innerText;
    const getCurrentCustomer = () => activeTableNameEl.dataset.customer || 'C1';
    
    const getCartKey = () => `cart_${getCurrentTable()}_${getCurrentCustomer()}`;
    const getKotTimeKey = () => `kotTime_${getCurrentTable()}_${getCurrentCustomer()}`;

    const getLocalCart = () => {
        const data = localStorage.getItem(getCartKey());
        return data ? JSON.parse(data) : [];
    };

    const saveLocalCart = (cartData) => {
        const key = getCartKey();
        if (cartData.length === 0) {
            localStorage.removeItem(key);
            localStorage.removeItem(getKotTimeKey()); 
        } else {
            localStorage.setItem(key, JSON.stringify(cartData));
        }
        window.dispatchEvent(new Event('cart-updated'));
    };

    window.addEventListener('pos-opened', (e) => {
        const name = e.detail.name;
        const holdBtn = document.getElementById('holdBtn');
        const kotBtn = document.getElementById('kotBtn');
        const saveExitBtn = document.getElementById('saveExitBtn');

        if (name === 'Direct Entry') {
            if(holdBtn) holdBtn.style.display = 'none';
            if(kotBtn) kotBtn.style.display = 'none';
            if(saveExitBtn) {
                saveExitBtn.innerText = "SAVE ENTRY"; 
            }
        } else {
            if(holdBtn) holdBtn.style.display = 'block';
            if(kotBtn) kotBtn.style.display = 'block';
            if(saveExitBtn) {
                saveExitBtn.innerText = "SAVE & EXIT";
            }
        }
    });

    window.addEventListener('add-to-cart', (e) => {
        const item = e.detail;
        currentCart = getLocalCart();
        const existingItem = currentCart.find(i => i.id === item.id);
        if (existingItem) {
            existingItem.qty += 1;
        } else {
            currentCart.push({ id: item.id, name: item.name, price: item.price, qty: 1, printedQty: 0 });
        }
        saveLocalCart(currentCart);
        renderCart();
    });

    window.addEventListener('add-custom-item-to-bill', (e) => {
        const item = e.detail;
        currentCart = getLocalCart();
        currentCart.push({ id: item.id, name: item.name, price: item.price, qty: 1, printedQty: 0 });
        saveLocalCart(currentCart);
        renderCart();
    });

    window.addEventListener('set-cart-quantity', (e) => {
        const item = e.detail;
        currentCart = getLocalCart();
        const existingIndex = currentCart.findIndex(i => i.id === item.id);

        if (item.qty <= 0) {
            if (existingIndex > -1) currentCart.splice(existingIndex, 1);
        } else if (existingIndex > -1) {
            currentCart[existingIndex].qty = item.qty;
            if ((currentCart[existingIndex].printedQty || 0) > item.qty) {
                currentCart[existingIndex].printedQty = item.qty;
            }
        } else {
            currentCart.push({ id: item.id, name: item.name, price: item.price, qty: item.qty, printedQty: 0 });
        }

        saveLocalCart(currentCart);
        renderCart();
    });

    function updateQuantity(id, delta) {
        currentCart = getLocalCart();
        const itemIndex = currentCart.findIndex(item => item.id === id);
        if (itemIndex > -1) {
            currentCart[itemIndex].qty += delta;
            
            if ((currentCart[itemIndex].printedQty || 0) > currentCart[itemIndex].qty) {
                currentCart[itemIndex].printedQty = currentCart[itemIndex].qty;
            }

            if (currentCart[itemIndex].qty <= 0) currentCart.splice(itemIndex, 1);
            saveLocalCart(currentCart);
            renderCart();
        }
    }

    window.addEventListener('load-table-cart', () => {
        currentCart = getLocalCart();
        renderCart();
    });

    // =====================================
    // RENDER CART (COMPLETE FUNCTION)
    // =====================================
    function renderCart() {
        cartItemsContainer.innerHTML = '';
        let totalAmount = 0;

        let fullKotBtn = document.getElementById('fullKotBtn');
        const kotBtn = document.getElementById('kotBtn');
        
        if(!fullKotBtn && kotBtn) {
            fullKotBtn = document.createElement('button');
            fullKotBtn.id = 'fullKotBtn';
            fullKotBtn.className = 'btn';
            fullKotBtn.style.background = '#8b5cf6'; 
            fullKotBtn.innerText = 'PRINT FULL K.O.T';
            fullKotBtn.style.display = 'none';
            
            // Insert right after KOT: View Details | KOT | PRINT FULL K.O.T | SAVE & EXIT
            kotBtn.insertAdjacentElement('afterend', fullKotBtn);
            
            fullKotBtn.addEventListener('click', () => printKOT(true)); 
        }

        let hasPrintedItems = currentCart.some(item => (item.printedQty || 0) > 0);
        
        if (fullKotBtn) {
            if (hasPrintedItems && activeTableNameEl.innerText !== 'Direct Entry') {
                fullKotBtn.style.display = 'block';
            } else {
                fullKotBtn.style.display = 'none';
            }
        }

        if (currentCart.length === 0) {
            cartItemsContainer.innerHTML = `
                <div style="text-align: center; color: #9ca3af; margin-top: 50px; font-weight: bold;">
                    Cart is empty <br> <span style="font-size: 0.8rem; font-weight: normal;">Click items to add</span>
                </div>  
            `;
            cartTotalElement.innerText = '₹0.00';
            return;
        }

        currentCart.forEach(item => {
            const itemTotal = item.price * item.qty;
            totalAmount += itemTotal;

            let unprintedQty = item.qty - (item.printedQty || 0);
            let unprintedTag = unprintedQty > 0 ? `<span style="background: #ef4444; color: white; font-size: 0.7rem; padding: 2px 5px; border-radius: 4px; margin-left: 5px;">+${unprintedQty} New</span>` : '';

            const cartItemDiv = document.createElement('div');
            cartItemDiv.className = 'cart-item';
            cartItemDiv.innerHTML = `
                <button class="cart-item-remove" data-id="${item.id}" title="Remove item">✕</button>
                <div class="cart-item-header">
                    <span>${item.name} ${unprintedTag}</span>
                    <span class="editable-price" data-id="${item.id}" style="cursor:pointer; color:#10b981; font-weight:bold; border-bottom:1px dashed #10b981;">
                        ₹${itemTotal}
                    </span>
                </div>
                <div class="cart-item-controls">
                    <span style="color: #4b5563; font-size: 1.1rem; font-weight: bold;">₹${item.price} × ${item.qty}</span>
                    <div class="quantity-control">
                        <button class="qty-btn qty-minus" data-id="${item.id}">−</button>
                        <input type="number" class="qty-input" data-id="${item.id}" value="${item.qty}" min="1">
                        <button class="qty-btn qty-plus" data-id="${item.id}">+</button>
                    </div>
                </div>
            `;

            cartItemsContainer.appendChild(cartItemDiv);
        });

        cartTotalElement.innerText = `₹${totalAmount.toFixed(2)}`;

        document.querySelectorAll('.qty-minus').forEach(btn => {
            btn.addEventListener('click', (e) => updateQuantity(e.target.dataset.id, -1));
        });
        document.querySelectorAll('.qty-plus').forEach(btn => {
            btn.addEventListener('click', (e) => updateQuantity(e.target.dataset.id, 1));
        });

        // Qty input: direct typing → update on change/blur
        document.querySelectorAll('.qty-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const id = e.target.dataset.id;
                const newQty = parseInt(e.target.value, 10);
                const idx = currentCart.findIndex(i => i.id === id);
                if (idx === -1) return;
                if (!isNaN(newQty) && newQty > 0) {
                    if ((currentCart[idx].printedQty || 0) > newQty) {
                        currentCart[idx].printedQty = newQty;
                    }
                    currentCart[idx].qty = newQty;
                } else {
                    currentCart.splice(idx, 1);
                }
                saveLocalCart(currentCart);
                renderCart();
            });
            // Prevent wheel from accidentally changing qty
            input.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
        });

        // Remove button: instant full removal
        document.querySelectorAll('.cart-item-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const idx = currentCart.findIndex(i => i.id === id);
                if (idx !== -1) {
                    currentCart.splice(idx, 1);
                    saveLocalCart(currentCart);
                    renderCart();
                }
            });
        });

        // ✅ CUSTOM MODAL WALA PRICE EDIT — RENDER CART KE ANDAR
        document.querySelectorAll('.editable-price').forEach(span => {
            span.addEventListener('click', (e) => {
                const itemId = e.target.dataset.id;
                let item = currentCart.find(i => i.id === itemId);
                
                const modal = document.getElementById('priceEditModal');
                const itemNameEl = document.getElementById('priceEditItemName');
                const inputEl = document.getElementById('newPriceInput');
                const saveBtn = document.getElementById('savePriceBtn');
                const cancelBtn = document.getElementById('cancelPriceEditBtn');
                
                itemNameEl.textContent = item.name;
                inputEl.value = item.price;
                modal.classList.remove('hidden');
                
                setTimeout(() => inputEl.focus(), 100);
                
                const handleSave = () => {
                    const newPrice = inputEl.value;
                    if (newPrice !== "" && !isNaN(newPrice) && Number(newPrice) > 0) {
                        item.price = Number(newPrice);
                        saveLocalCart(currentCart);
                        renderCart();
                    }
                    modal.classList.add('hidden');
                    cleanup();
                };
                
                const handleCancel = () => {
                    modal.classList.add('hidden');
                    cleanup();
                };
                
                const handleKey = (ev) => {
                    if (ev.key === 'Enter') handleSave();
                    if (ev.key === 'Escape') handleCancel();
                };
                
                const cleanup = () => {
                    saveBtn.removeEventListener('click', handleSave);
                    cancelBtn.removeEventListener('click', handleCancel);
                    inputEl.removeEventListener('keydown', handleKey);
                };
                
                saveBtn.addEventListener('click', handleSave);
                cancelBtn.addEventListener('click', handleCancel);
                inputEl.addEventListener('keydown', handleKey);
            });
        });
    } // renderCart() END

    const holdBtn = document.getElementById('holdBtn');
    const kotBtn = document.getElementById('kotBtn');
    const checkoutBtn = document.getElementById('checkoutBtn');
    const saveExitBtn = document.getElementById('saveExitBtn'); 
    const backToTablesBtn = document.getElementById('backToTablesBtn');

    const getDisplayTitle = () => {
        const tName = getCurrentTable();
        if(tName === 'Direct Entry') return 'Cash Sale';
        return tName; 
    };

    if (holdBtn) holdBtn.addEventListener('click', () => {
        // If the cart is empty and an order was imported via "Open in POS",
        // auto-cancel it so the customer panel clears "Order Confirmed".
        // Fire-and-forget — navigation proceeds immediately regardless.
        if (currentCart.length === 0) {
            cancelImportedOrdersOnEmptyCart(getCurrentTable());
        }
        backToTablesBtn.click();
    });

    // ── triggerRawBTPrint — original text-based rawbt: transport (KOT + fallback) ──
    // Kept unchanged. Used by KOT printing and as fallback when the ESC/POS
    // encoder is unavailable.
    const triggerRawBTPrint = (text) => {
        const uri = "rawbt:" + encodeURIComponent(text);
        const a = document.createElement('a');
        a.href = uri;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    // ── triggerESCPOSPrint — binary ESC/POS rawbt: transport (bill receipts) ────
    // AI UPDATE [2026-07-30]: New function for sending a Uint8Array ESC/POS buffer
    // through the same rawbt: URI scheme.  The Uint8Array is converted to a binary
    // string before URL-encoding so RawBT receives the exact bytes the encoder
    // produced (including all ESC/POS control sequences for alignment, bold,
    // image raster data, paper cut, etc.).
    // The Bluetooth pairing, connection, and RawBT dispatch are unchanged.
    const triggerESCPOSPrint = (uint8Array) => {
        let binaryStr = '';
        for (let i = 0; i < uint8Array.length; i++) {
            binaryStr += String.fromCharCode(uint8Array[i]);
        }
        const uri = 'rawbt:' + encodeURIComponent(binaryStr);
        const a = document.createElement('a');
        a.href = uri;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    const centerText = (text) => {
        if (text.length >= 32) return text.substring(0, 32);
        const spaces = Math.floor((32 - text.length) / 2);
        return " ".repeat(spaces) + text;
    };

    const getFormattedDate = () => {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yy = String(now.getFullYear()).slice(-2);
        let hours = now.getHours();
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        return `${dd}/${mm}/${yy} ${hours}:${minutes} ${ampm}`;
    };

    const formatBillRow = (name, qty, rate, total) => {
        let nameLines = [];
        let currentLine = "";
        let words = name.split(" ");
        
        for(let w of words) {
            if((currentLine + w).length > 14) {
                if(currentLine) nameLines.push(currentLine.trim());
                currentLine = w + " ";
            } else {
                currentLine += w + " ";
            }
        }
        if(currentLine) nameLines.push(currentLine.trim());

        let res = "";
        for(let i=0; i<nameLines.length; i++) {
            let line = nameLines[i].padEnd(14, " ");
            if(i === 0) {
                let q = String(qty).padStart(3, " ");
                let r = String(rate).padStart(4, " ");
                let t = String(total).padStart(6, " ");
                res += `${line} ${q} ${r}  ${t}\n`;
            } else {
                res += `${line}\n`;
            }
        }
        return res;
    };

    const printKOT = (isFullKot = false) => {
        if (!currentCart || currentCart.length === 0) return;
        
        const itemsToPrint = isFullKot 
            ? currentCart.map(item => ({name: item.name, printQty: item.qty}))
            : currentCart
                .filter(item => item.qty > (item.printedQty || 0))
                .map(item => ({name: item.name, printQty: item.qty - (item.printedQty || 0)}));

        if (itemsToPrint.length === 0) {
            // AI UPDATE [2026-07-30]: Replaced alert() with custom dialog.
            await showAlert(
                "Koi naya item nahi hai! Puraana order print karne ke liye 'PRINT FULL K.O.T' dabayein.",
                'warning',
                'No New Items'
            );
            return;
        }

        const kotTimeKey = getKotTimeKey();
        if (!localStorage.getItem(kotTimeKey)) {
            localStorage.setItem(kotTimeKey, Date.now().toString());
        }

        // ── Sync KOT status to customer panel in real-time ─────────────────────
        (async () => {
            try {
                const _snap = await getDocs(query(
                    collection(db, 'pending_table_orders'),
                    where('tableId', '==', getCurrentTable())
                ));
                _snap.docs.forEach(_d => {
                    const _st = (_d.data().status || 'pending').toLowerCase();
                    if (['pending', 'accepted', 'kot'].includes(_st)) {
                        updateDoc(_d.ref, { status: 'kot', kotAt: serverTimestamp() })
                            .catch(e => console.warn('[KOT] sync failed:', e));
                    }
                });
            } catch(e) { console.warn('[KOT] query failed:', e); }
        })();

        const BOLD_ON = '\x1B\x45\x01';
        const BOLD_OFF = '\x1B\x45\x00';
        const now = new Date();
        const timeStr = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getFullYear()).slice(-2)} ${now.getHours()%12||12}:${String(now.getMinutes()).padStart(2,'0')} ${now.getHours()>=12?'PM':'AM'}`;
        
        let kotText = BOLD_ON;
        if (isFullKot) kotText += "FULL K.O.T\n";
        kotText += `KOT No: ${Math.floor(Math.random()*900)+100}\n`;
        kotText += `Time: ${timeStr}\n`;
        kotText += `Table: ${getDisplayTitle()}\n\n`;
        
        for (const item of itemsToPrint) {
            kotText += `${item.name} (${item.printQty})\n`;
        }
        
        kotText += "\n\n\n" + BOLD_OFF;

        triggerRawBTPrint(kotText);

        setTimeout(() => {
            for (const item of currentCart) {
                item.printedQty = item.qty;
            }
            saveLocalCart(currentCart);
            renderCart();
        }, 0);
    };

    if (kotBtn) {
        kotBtn.addEventListener('click', () => printKOT(false));
    }

    // ── Bill & Settle ──────────────────────────────────────────────────────────
    if (checkoutBtn) {
        checkoutBtn.addEventListener('click', () => {
            if (currentCart.length === 0) return;

            const tableName    = getCurrentTable();
            const customerName = getCurrentCustomer();
            const total        = currentCart.reduce((sum, item) => sum + (item.price * item.qty), 0);

            // ── Snapshot cart before clearing ─────────────────────────────────
            const cartSnapshot = currentCart.slice();

            // ── Build and print bill immediately (no network wait) ────────────
            // AI UPDATE [2026-07-30]: Replace manual string-based bill generation
            // with ESC/POS encoder (esc-pos-encoder library via CDN in index.html).
            // buildBillReceipt() returns a Uint8Array; sent via triggerESCPOSPrint().
            // Falls back to the legacy text receipt if the library is unavailable.
            let shortOrderId = String(Date.now()).slice(-5);
            const escposBuffer = buildBillReceipt(
                currentCart,
                getDisplayTitle(),
                shortOrderId,
                getFormattedDate()
            );

            if (escposBuffer) {
                // ── ESC/POS path: proper column alignment, logo, bold totals ──
                triggerESCPOSPrint(escposBuffer);
            } else {
                // ── Legacy fallback: plain text (library unavailable) ─────────
                const BOLD_ON  = '\x1B\x45\x01';
                const BOLD_OFF = '\x1B\x45\x00';
                let billText = BOLD_ON;
                billText += centerText("NEW PIZZA HUT AND LIVE CAKE") + "\n";
                billText += centerText("in front of SBI bank ke tik") + "\n";
                billText += centerText("samne salempur Deoria, UP") + "\n";
                billText += centerText("FSSAI: 30230324113093042") + "\n";
                billText += centerText("Phone: 9628548655") + "\n\n";
                billText += `Bill No: ${shortOrderId}\n`;
                billText += `Created On: ${getFormattedDate()}\n`;
                billText += `Bill To: ${getDisplayTitle()}\n\n`;
                billText += "Item Name      Qty Rate  Total\n\n";
                let legacyTotalQty = 0;
                currentCart.forEach(item => {
                    legacyTotalQty += item.qty;
                    billText += formatBillRow(item.name, item.qty, item.price, item.price * item.qty);
                });
                billText += "\n";
                billText += `Total Items: ${currentCart.length}\n`;
                billText += `Total Quantity: ${legacyTotalQty}\n`;
                billText += `Sub Total`.padEnd(25, ' ') + String(total).padStart(7, ' ') + "\n\n";
                billText += centerText(`TOTAL: Rs ${total}`) + "\n\n";
                billText += centerText("Thank You! Visit Again!") + "\n\n\n\n" + BOLD_OFF;
                triggerRawBTPrint(billText);
            }

            // ── Clear cart and navigate back immediately ───────────────────────
            saveLocalCart([]);
            currentCart = [];
            renderCart();
            setTimeout(() => { if (backToTablesBtn) backToTablesBtn.click(); }, 300);

            // ── Save sale to Firestore (fire & forget) ────────────────────────
            const billId = `SALE_${Date.now()}`;
            setDoc(doc(db, "sales_history", billId), {
                table: tableName,
                customer: customerName,
                items: cartSnapshot,
                total: total,
                timestamp: new Date().toISOString()
            }).catch(err => console.error("Bill save failed:", err));

            if (window.saveToGhostHistory) {
                let orderId = tableName.includes('Parcel') ? tableName : `${tableName} [${customerName}]`;
                window.saveToGhostHistory(orderId, total, cartSnapshot);
            }

            // ── Sync completed order to Customer Panel (non-blocking) ────────
            // Marks pending_table_orders as 'completed' and writes a record to
            // customer_order_history so the customer's history tab updates.
            // Only runs if this table had a Customer Panel order (no-op for
            // manual/walk-in bills — see syncCustomerOrderCompletion above).
            // AI UPDATE [2026-07-29] session 18: pass shortOrderId as billNumber
            syncCustomerOrderCompletion(tableName, cartSnapshot, total, 'bill_settle', shortOrderId);

            // ── Release customer table lock in background (non-blocking) ──────
            releaseTableLockInBackground(tableName, 'bill_settle');
        });
    }

    // ── Save & Exit ────────────────────────────────────────────────────────────
    if (saveExitBtn) {
        saveExitBtn.addEventListener('click', () => {
            const tableName    = getCurrentTable();
            const customerName = getCurrentCustomer();
            const cartSnapshot = currentCart.slice();
            const total        = cartSnapshot.reduce((sum, item) => sum + (item.price * item.qty), 0);

            // ── Clear cart and navigate back immediately ───────────────────────
            saveLocalCart([]);
            currentCart = [];
            renderCart();
            if (backToTablesBtn) backToTablesBtn.click();

            // ── Save to Firestore in background only if there were items ──────
            if (cartSnapshot.length > 0) {
                setDoc(doc(db, "sales_history", `SALE_${Date.now()}`), {
                    table: tableName,
                    customer: customerName,
                    items: cartSnapshot,
                    total: total,
                    timestamp: new Date().toISOString()
                }).catch(err => console.error("Save & Exit Firestore failed:", err));

                if (window.saveToGhostHistory) {
                    let orderId = tableName.includes('Parcel') ? tableName : `${tableName} [${customerName}]`;
                    window.saveToGhostHistory(orderId + " (HOLD)", total, cartSnapshot);
                }
            }

            // ── Sync completed order to Customer Panel (non-blocking) ────────
            // Same as Bill & Settle path above — marks pending_table_orders as
            // 'completed' and writes customer_order_history entry.
            // No-op for manual/walk-in orders (no activeCustomerUid in localStorage).
            if (cartSnapshot.length > 0) {
                syncCustomerOrderCompletion(tableName, cartSnapshot, total, 'save_exit');
            } else {
                // Cart is empty — if an order was imported via "Open in POS" but
                // the operator removed every item before saving, auto-cancel it.
                // Reuses "dismissed" status so the customer panel clears
                // "Order Confirmed" immediately (same as operator pressing Dismiss).
                // AI UPDATE [2026-07-29] session 23: missing edge-case fix.
                cancelImportedOrdersOnEmptyCart(tableName);
            }

            // ── Release customer table lock in background (non-blocking) ──────
            releaseTableLockInBackground(tableName, 'save_exit');
        });
    }

    // ── Cancel Order ───────────────────────────────────────────────────────────
    // AI UPDATE [2026-07-30]: New handler for the CANCEL ORDER button.
    //
    // Flow:
    //   1. confirm() guard — prevents accidental cancellation.
    //   2. Cart wiped instantly (UI + localStorage) — operator sees empty POS.
    //   3. Navigate back to the table grid immediately — UI is unblocked.
    //   4. Firestore: cancelOrderInPOS() sets status='dismissed' on all accepted
    //      order docs (fire-and-forget — navigation already happened).
    //   5. releaseTableLockInBackground() cleans up the customer table lock.
    //
    // Does NOT write to sales_history, customer_order_history, or ghost history.
    // Does NOT affect revenue, statistics, or order counts.
    const cancelOrderBtn = document.getElementById('cancelOrderBtn');
    if (cancelOrderBtn) {
        // AI UPDATE [2026-07-30]: Replaced confirm() with custom dialog.
        cancelOrderBtn.addEventListener('click', async () => {
            const _cancelConfirmed = await showConfirm(
                'All items will be cleared and the customer will immediately lose the active order on their screen.\n\nThis cannot be undone.',
                {
                    title:       'Cancel this entire order?',
                    confirmText: 'Yes, Cancel Order',
                    cancelText:  'Keep Order',
                    type:        'error',
                }
            );
            if (!_cancelConfirmed) return;

            const tableName = getCurrentTable();

            // Step 1: Wipe cart immediately (UI + localStorage)
            saveLocalCart([]);
            currentCart = [];
            renderCart();

            // Step 2: Navigate back to the table grid immediately
            if (backToTablesBtn) backToTablesBtn.click();

            // Step 3: Update Firestore + release lock (fire-and-forget)
            // These run after navigation so the UI is never blocked.
            cancelOrderInPOS(tableName);
            releaseTableLockInBackground(tableName, 'cancel_order');
        });
    }
});
