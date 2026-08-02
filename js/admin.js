// AI UPDATE [2026-07-29] session 15:
// Added Customers tab support to switchTab(). Imports initCustomerManagement
// and refreshCustomerManagement from js/customers.js.
// AI UPDATE [2026-07-30]: Import custom dialog system — replaces alert()/confirm().
import { db, auth, functions } from './firebase-config.js';
import { initCustomerManagement, refreshCustomerManagement } from './customers.js';
import { showAlert, showConfirm } from './dialog.js';
// AI UPDATE [2026-08-02]: Switched menu image storage from Firebase Storage to Cloudinary.
// Credentials are server-side only; this module calls the Express proxy endpoints.
import { uploadMenuImage, deleteMenuImage, extractCloudinaryPublicId } from './cloudinary-upload.js';
import {
    collection, getDocs, doc, deleteDoc, addDoc, updateDoc,
    getDocsFromCache, getDocsFromServer, enableNetwork, onSnapshot,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
// AI UPDATE [2026-08-02]: Firebase Storage imports removed — image uploads now go
// through Cloudinary via the server-side proxy (js/cloudinary-upload.js).
import { onAuthStateChanged, signInAnonymously, signOut }
    from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// ===== AI UPDATE =====
// Date: 2026-07-28 (session 3)
// Bug: Login session was lost on every browser/tab close.
// Root cause: operatorLoggedIn was stored in sessionStorage, which is
//   scoped to a single tab and cleared when the tab or browser is closed.
//   Every reopening of the Admin panel required re-entering the PIN.
// Fix: Changed all three sessionStorage references to localStorage so the
//   session persists until the admin explicitly taps "Logout" or clears
//   browser data. Security is unchanged — the PIN is still required on
//   first login; only the persistence boundary is widened.
// =====================

// ==========================================
// LOGIN & SESSION
// ==========================================
// PIN is checked locally (instant, no network).
// On success, Firebase Auth anonymous sign-in is used so Firestore rules
// that require request.auth != null continue to work.
// Session persists in localStorage until explicit logout or data clear.

const ADMIN_PIN = '1414';

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('pinInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('loginBtn').click();
    });

    // Restore session across browser restarts — localStorage persists until
    // the admin explicitly logs out or the user clears browser data.
    if (localStorage.getItem('operatorLoggedIn') === 'true') {
        // Show dashboard immediately — PIN was already verified previously.
        // Re-establish Firebase Auth in the background for Firestore rules.
        showDashboard();
        onAuthStateChanged(auth, (user) => {
            if (!user) {
                signInAnonymously(auth).catch(err => {
                    console.warn('[Session restore] Firebase anonymous sign-in failed:', err.code);
                });
            }
        });
    }
});

document.getElementById('loginBtn').addEventListener('click', async () => {
    const pinInput = document.getElementById('pinInput');
    const pin = pinInput.value.trim();
    if (!pin) return;

    const loginBtn = document.getElementById('loginBtn');
    loginBtn.disabled = true;
    loginBtn.textContent = '…';

    if (pin !== ADMIN_PIN) {
        pinInput.value = '';
        pinInput.placeholder = 'Wrong PIN!';
        setTimeout(() => { pinInput.placeholder = '••••'; }, 1500);
        loginBtn.disabled = false;
        loginBtn.textContent = 'Unlock Dashboard';
        return;
    }

    // PIN is correct — unlock the dashboard immediately.
    // Firebase anonymous sign-in runs in the background so Firestore security
    // rules (which require request.auth != null) can be satisfied.
    // A Firebase Auth failure must NOT block the login — the PIN already
    // proved identity; auth/operation-not-allowed just means Anonymous Auth
    // isn't enabled in the Firebase console, which is a Firebase config issue,
    // not a wrong-password issue.
    localStorage.setItem('operatorLoggedIn', 'true');
    showDashboard();
    loginBtn.disabled = false;
    loginBtn.textContent = 'Unlock Dashboard';

    signInAnonymously(auth).catch(err => {
        console.warn('[Login] Firebase anonymous sign-in failed — Firestore writes may be blocked if security rules require auth. Error:', err.code, err.message);
    });
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
    localStorage.removeItem('operatorLoggedIn');
    await signOut(auth).catch(() => {});
    location.reload();
});

function showDashboard() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('adminContent').style.display = 'flex';
    loadSalesData('days', 1);
}

// ==========================================
// TAB SWITCHER (bottom nav)
// ==========================================
let currentTab = 'sales';

window.switchTab = function(tabName, navBtn) {
    currentTab = tabName;

    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('active'));

    document.getElementById(tabName + 'Section').classList.add('active');
    if (navBtn) navBtn.classList.add('active');

    if (tabName === 'menu') loadMenuData();
    if (tabName === 'expense') {
        const todayBtn = document.querySelector('#expenseSection .filter-pill[data-val="1"]');
        loadAdminExpenses('days', 1, todayBtn);
    }
    if (tabName === 'sales') loadSalesData('days', 1);
    // AI UPDATE [2026-07-29] session 19:
    // Changed initCustomerManagement() → refreshCustomerManagement() here.
    // Root cause: initCustomerManagement() returned the in-memory _customers
    // array immediately when _loaded = true (set on first tab open).  If an
    // order was completed AFTER the Customers tab was first opened, the stale
    // cache showed 0 orders / ₹0 forever until the page was reloaded or the
    // refresh button was manually tapped.
    // refreshCustomerManagement() always resets _loaded=false and re-reads from
    // the Firestore IndexedDB cache (which already reflects the increment() write
    // from syncCustomerOrderCompletion via persistentMultipleTabManager).
    if (tabName === 'customers') refreshCustomerManagement();
};

// ==========================================
// SALES SUB-TAB (Table vs Quick Sale)
// ==========================================
window.switchSalesSubtab = function(which) {
    document.getElementById('subtab-table').classList.toggle('active', which === 'table');
    document.getElementById('subtab-qs').classList.toggle('active', which === 'qs');
    document.getElementById('salesPanel-table').classList.toggle('hidden', which !== 'table');
    document.getElementById('salesPanel-qs').classList.toggle('hidden', which !== 'qs');
};

// ==========================================
// SALES DATA
// ==========================================

// ===== AI UPDATE =====
// Date: 2026-07-28 (session 3)
// Bug: Sales data triggered a full Firestore server round-trip on every tab
//   switch to the Sales section (switchTab calls loadSalesData unconditionally).
// Root cause: fetchAllSales always called both getDocsFromCache AND
//   getDocsFromServer regardless of how recently the server was last queried.
//   With rapid tab switching, this meant multiple overlapping server fetches
//   with no benefit.
// Fix: Added a 30-second throttle on the server fetch via _salesServerFetchedAt.
//   The IndexedDB cache read still happens every call for instant local data;
//   the server fetch is skipped if it ran within the last 30 seconds.
//   The Refresh button always forces a fresh server fetch (resets the timestamp).
// =====================

let allSales = [];
let _salesServerFetchedAt = 0; // timestamp of last successful server fetch

async function fetchAllSales(forceServer = false) {
    // Cache-first: read from IndexedDB immediately for instant display
    try {
        const snap = await getDocsFromCache(collection(db, "sales_history"));
        if (!snap.empty) {
            allSales = [];
            snap.forEach(d => { allSales.push({ ...d.data(), id: d.id }); });
        }
    } catch (e) {}

    // Server fetch — throttled to 30 s to avoid hammering Firestore on every
    // tab switch. The Refresh button passes forceServer=true to bypass this.
    const now = Date.now();
    if (forceServer || now - _salesServerFetchedAt > 30000) {
        try {
            const snap = await getDocsFromServer(collection(db, "sales_history"));
            allSales = [];
            snap.forEach(d => { allSales.push({ ...d.data(), id: d.id }); });
            _salesServerFetchedAt = now;
        } catch (e) { console.error("Sales fetch error:", e); }
    }
}

window.loadSalesData = async function(filterType, filterValue) {
    // Show skeletons
    document.getElementById('tableSalesTableBody').innerHTML = '<tr><td colspan="3" class="loading">Loading...</td></tr>';
    document.getElementById('qsSalesTableBody').innerHTML    = '<tr><td colspan="3" class="loading">Loading...</td></tr>';
    document.getElementById('tableBillsList').innerHTML = '<div class="loading-state">Loading...</div>';
    document.getElementById('qsBillsList').innerHTML    = '<div class="loading-state">Loading...</div>';

    await fetchAllSales();
    const now = new Date();

    let filteredSales = allSales.filter(sale => {
        if (!sale.timestamp) return false;
        const d = new Date(sale.timestamp);
        if (filterType === 'date') return d.toDateString() === new Date(filterValue).toDateString();
        if (filterValue === 1)     return d.toDateString() === now.toDateString();
        const diff = Math.ceil(Math.abs(now - d) / 864e5);
        return diff <= filterValue;
    });

    filteredSales.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    let totalRevenue = 0;
    let tableRevenue = 0, tableOrders = 0, tableItemStats = {};
    let qsRevenue = 0,    qsOrders = 0,    qsItemStats = {};
    const tableBills = [], qsBills = [];

    filteredSales.forEach(sale => {
        const total     = Number(sale.total) || 0;
        totalRevenue   += total;
        const isQS      = sale.table === 'Direct Entry';
        const timeStr   = sale.timestamp
            ? new Date(sale.timestamp).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })
            : '—';
        let label = sale.table || 'Unknown';
        if (isQS)                           label = 'Cash Sale';
        else if (!label.includes('Parcel')) label = `${label} [${sale.customer || 'C1'}]`;

        const targetStats = isQS ? qsItemStats : tableItemStats;
        (sale.items || []).forEach(item => {
            const n = item.name || 'Unknown';
            if (!targetStats[n]) targetStats[n] = { qty: 0, rev: 0 };
            targetStats[n].qty += Number(item.qty) || 0;
            targetStats[n].rev += (Number(item.qty) || 0) * (Number(item.price) || 0);
        });

        const card = { id: sale.id, label, timeStr, total };
        if (isQS) { qsRevenue += total; qsOrders++; qsBills.push(card); }
        else       { tableRevenue += total; tableOrders++; tableBills.push(card); }
    });

    // ── Stats ──
    document.getElementById('totalRevenueBox').textContent = `₹${totalRevenue.toFixed(0)}`;
    document.getElementById('totalOrdersBox').textContent  = filteredSales.length;
    document.getElementById('tableRevenueBox').textContent = `₹${tableRevenue.toFixed(0)}`;
    document.getElementById('tableOrdersBox').textContent  = tableOrders;
    document.getElementById('qsRevenueBox').textContent    = `₹${qsRevenue.toFixed(0)}`;
    document.getElementById('qsOrdersBox').textContent     = qsOrders;

    // ── Item breakdown tables ──
    const renderItemTable = (tbodyId, statsObj) => {
        const tbody = document.getElementById(tbodyId);
        const rows = Object.entries(statsObj)
            .map(([name, s]) => ({ name, ...s }))
            .sort((a, b) => b.qty - a.qty);
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="3" class="empty-row"><td>No items sold.</td></td></tr>';
            return;
        }
        tbody.innerHTML = rows.map(r => `
            <tr>
                <td style="color:#e6edf3;font-weight:700;">${r.name}</td>
                <td style="color:#58a6ff;font-weight:800;text-align:right;">${r.qty}</td>
                <td style="color:#3fb950;font-weight:800;text-align:right;">₹${r.rev.toFixed(0)}</td>
            </tr>
        `).join('');
    };
    renderItemTable('tableSalesTableBody', tableItemStats);
    renderItemTable('qsSalesTableBody', qsItemStats);

    // ── Bill cards ──
    const renderBillCards = (containerId, bills) => {
        const el = document.getElementById(containerId);
        if (!bills.length) {
            el.innerHTML = '<div class="empty-state">No bills found.</div>';
            return;
        }
        el.innerHTML = bills.map(b => `
            <div class="bill-card">
                <div class="bill-card-left">
                    <div class="bill-card-name">${b.label}</div>
                    <div class="bill-card-time">${b.timeStr}</div>
                </div>
                <div class="bill-card-right">
                    <div class="bill-card-amt">₹${Number(b.total).toFixed(0)}</div>
                    <button class="bill-del-btn" onclick="deleteSale('${b.id}')">🗑</button>
                </div>
            </div>
        `).join('');
    };
    renderBillCards('tableBillsList', tableBills);
    renderBillCards('qsBillsList', qsBills);
};

window.deleteSale = async function(saleId) {
    // AI UPDATE [2026-07-30]: Replaced confirm()/alert() with custom dialogs.
    if (!await showConfirm("This bill will be permanently removed from sales history.", {
        title: 'Delete this bill?', confirmText: 'Delete', type: 'error'
    })) return;
    try {
        await deleteDoc(doc(db, "sales_history", saleId));
        const activeFilter = document.querySelector('#salesSection .filter-pill.active');
        const customDate   = document.getElementById('customDateSearch').value;
        if (customDate) loadSalesData('date', customDate);
        else loadSalesData('days', parseInt(activeFilter?.dataset.val || '1'));
    } catch (e) {
        await showAlert("Delete failed. Check internet.", 'error', 'Delete Failed');
    }
};

// Filter pills in sales section
document.querySelectorAll('#salesSection .filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#salesSection .filter-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('customDateSearch').value = '';
        loadSalesData('days', parseInt(btn.dataset.val));
    });
});
document.getElementById('customDateSearch').addEventListener('change', (e) => {
    if (e.target.value) {
        document.querySelectorAll('#salesSection .filter-pill').forEach(b => b.classList.remove('active'));
        loadSalesData('date', e.target.value);
    }
});
document.getElementById('refreshBtn').addEventListener('click', async (e) => {
    e.target.textContent = '⏳'; e.target.disabled = true;
    // Force a fresh server fetch by resetting the throttle timestamp
    _salesServerFetchedAt = 0;
    const active     = document.querySelector('#salesSection .filter-pill.active');
    const customDate = document.getElementById('customDateSearch').value;
    if (customDate) await loadSalesData('date', customDate);
    else await loadSalesData('days', parseInt(active?.dataset.val || '1'));
    e.target.textContent = '↻'; e.target.disabled = false;
});

// ==========================================
// MENU MANAGEMENT
// ==========================================

// ===== AI UPDATE =====
// Date: 2026-07-28 (session 3)
// Bugs fixed in this section:
//
// Bug A — Menu listener torn down on every tab switch:
//   loadMenuData() previously always called _menuUnsub() then created a new
//   onSnapshot. Switching to the Menu tab always caused "Loading menu…" flash,
//   then IndexedDB stale-cache snapshot, then server snapshot — a noticeable
//   two-step update visible to the user.
//   Fix: loadMenuData() now checks if _menuUnsub is already alive. If it is,
//   just re-render from the in-memory allMenuItems array (instant, no network).
//   The listener is only created on the first call or after it drops.
//
// Bug B — deleteMenuItem() unnecessarily recreated the listener:
//   After deleteDoc(), the live onSnapshot fires automatically with the updated
//   collection. Calling loadMenuData() on top of that tore down the listener
//   and recreated it — causing a double-update flash.
//   Fix: deleteMenuItem() no longer calls loadMenuData(). The listener handles it.
//
// Bug C — saveItemBtn handler unnecessarily recreated the listener:
//   Same issue as Bug B — adding or editing an item triggers the live listener
//   automatically. The explicit loadMenuData() call was redundant.
//   Fix: saveItemBtn handler no longer calls loadMenuData().
// =====================

const itemModal          = document.getElementById('itemModal');
const imagePreview       = document.getElementById('imagePreview');
const itemImageInput     = document.getElementById('itemImageInput');
const imagePreviewText   = document.getElementById('imagePreviewText');
const imageUploadSpinner = document.getElementById('imageUploadSpinner');
const imgUploadBtn       = document.getElementById('imgUploadBtn');
const imgRemoveBtn       = document.getElementById('imgRemoveBtn');

// AI UPDATE [2026-08-02]: Replaced selectedImageFile (lazy upload on Save) with
// eager upload model. _currentImageUrl is the effective URL that will be written
// to Firestore; it is set as soon as the upload completes, not on Save.
// _uploadedThisSession tracks a URL uploaded in the current modal session so it
// can be cleaned up from Storage if the user removes it before saving.
let _currentImageUrl     = null;
// AI UPDATE [2026-08-02]: Cloudinary public_id of the current image (for delete).
// null when no image or when the URL is a legacy Firebase Storage URL.
let _currentPublicId     = null;
let _uploadedThisSession = null; // publicId of image uploaded this modal session (for cleanup)
let _uploadInProgress    = false;
let currentEditId        = null;
let allMenuItems         = [];

let _menuUnsub = null;

window.loadMenuData = function() {
    const grid = document.getElementById('menuCardGrid');

    // If the listener is already alive, just re-render from the in-memory
    // cache — instant, no network round-trip, no loading flash.
    if (_menuUnsub) {
        renderMenuCards();
        return;
    }

    // First call (or listener dropped after an error): show loading and
    // create a fresh listener. Wake the Firestore network channel first in
    // case the PWA suspended it while the tab was in the background.
    grid.innerHTML = '<div class="loading-state">Loading menu... ☁️</div>';

    enableNetwork(db).catch(() => {}).finally(() => {
        _menuUnsub = onSnapshot(
            collection(db, "menu_items"),
            (snap) => {
                allMenuItems = [];
                snap.forEach(d => allMenuItems.push({ ...d.data(), id: d.id }));
                allMenuItems.sort((a, b) => {
                    const ca = (a.category || '').toUpperCase(), cb = (b.category || '').toUpperCase();
                    if (ca < cb) return -1; if (ca > cb) return 1;
                    const na = (a.name || '').toUpperCase(), nb = (b.name || '').toUpperCase();
                    return na < nb ? -1 : na > nb ? 1 : 0;
                });
                renderMenuCards();
            },
            (err) => {
                console.error("Menu listener error:", err);
                // Mark listener as dropped so next call to loadMenuData() restarts it
                _menuUnsub = null;
                if (grid.innerHTML.includes('Loading')) {
                    grid.innerHTML = '<div class="empty-state" style="color:#f85149;">Failed to load menu. Check internet.</div>';
                }
            }
        );
    });
};

function renderMenuCards() {
    const grid = document.getElementById('menuCardGrid');
    if (!allMenuItems.length) {
        grid.innerHTML = '<div class="empty-state">Menu is empty. Add your first item!</div>';
        return;
    }
    let html = '';
    let lastCat = '';
    allMenuItems.forEach(item => {
        if (item.category !== lastCat) {
            lastCat = item.category;
            html += `<div class="menu-category-header">📌 ${item.category || 'Uncategorised'}</div>`;
        }
        const checked  = item.inStock !== false ? 'checked' : '';
        // AI UPDATE [2026-08-02]: Use imageUrl (new field); fall back to image (old field) for
        // items that existed before the schema upgrade. Customer Panel does the same.
        const _imgSrc  = item.imageUrl || item.image || null;
        const imgTag   = _imgSrc
            ? `<div class="menu-thumb"><img src="${_imgSrc}" alt="${item.name}"></div>`
            : `<div class="menu-thumb" style="font-size:1.4rem;">🍽️</div>`;

        html += `
        <div class="menu-item-card">
            ${imgTag}
            <div class="menu-item-info">
                <div class="menu-item-name">${item.name}</div>
                <div class="menu-item-price">₹${item.price}</div>
            </div>
            <div class="menu-item-actions">
                <label class="switch" title="In Stock">
                    <input type="checkbox" ${checked} onchange="toggleStock('${item.id}', this.checked)">
                    <span class="slider"></span>
                </label>
                <button class="btn-edit-sm" onclick="editMenuItem('${item.id}')">✏️</button>
                <button class="btn-del-sm"  onclick="deleteMenuItem('${item.id}')">🗑️</button>
            </div>
        </div>`;
    });
    grid.innerHTML = html;
}

window.toggleStock = async function(id, status) {
    try { await updateDoc(doc(db, "menu_items", id), { inStock: status }); }
    // AI UPDATE [2026-07-30]: Replaced alert() with custom dialog.
    catch(e) { await showAlert("Stock update failed!", 'error', 'Update Failed'); }
};

window.deleteMenuItem = async function(id) {
    // AI UPDATE [2026-07-30]: Replaced confirm() with custom dialog.
    if (!await showConfirm("This menu item will be permanently removed from the database.", {
        title: 'Delete item permanently?', confirmText: 'Delete', type: 'error'
    })) return;
    await deleteDoc(doc(db, "menu_items", id));
    // The live onSnapshot listener fires automatically after the delete —
    // no need to call loadMenuData() here; doing so would unnecessarily
    // tear down the listener and recreate it.
};

function populateCategoryDropdown(selectedCat = null) {
    const sel = document.getElementById('itemCategoryInput');
    const cats = [...new Set(allMenuItems.map(i => i.category))].filter(Boolean).sort();
    sel.innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join('');
    sel.innerHTML += `<option value="NEW_CATEGORY" style="font-weight:bold;color:#3fb950;">+ New Category</option>`;
    if (selectedCat) sel.value = selectedCat;
    document.getElementById('newCategoryInput').classList.add('hidden');
    document.getElementById('newCategoryInput').value = '';
}

document.getElementById('itemCategoryInput').addEventListener('change', (e) => {
    const show = e.target.value === 'NEW_CATEGORY';
    document.getElementById('newCategoryInput').classList.toggle('hidden', !show);
    if (show) document.getElementById('newCategoryInput').focus();
});

document.getElementById('addNewItemBtn').addEventListener('click', () => {
    currentEditId            = null;
    _currentImageUrl         = null;
    _currentPublicId         = null;
    _uploadedThisSession     = null;
    _uploadInProgress        = false;
    document.getElementById('modalTitle').textContent     = 'Add New Item';
    document.getElementById('saveItemBtn').textContent    = 'Save Item';
    document.getElementById('saveItemBtn').disabled       = false;
    document.getElementById('itemNameInput').value        = '';
    document.getElementById('itemDescInput').value        = '';
    document.getElementById('itemPriceInput').value       = '';
    imagePreview.style.backgroundImage = '';
    imagePreviewText.style.display     = 'flex';
    imageUploadSpinner.classList.add('hidden');
    imgRemoveBtn.classList.add('hidden');
    imgUploadBtn.textContent           = '📤 Upload Image';
    imgUploadBtn.disabled              = false;
    itemImageInput.value               = '';
    populateCategoryDropdown();
    itemModal.classList.remove('hidden');
});

window.editMenuItem = function(id) {
    const item = allMenuItems.find(i => i.id === id);
    if (!item) return;
    currentEditId            = id;
    _currentImageUrl         = item.imageUrl || item.image || null; // backward-compat: old field was `image`
    _currentPublicId         = extractCloudinaryPublicId(_currentImageUrl); // null for legacy Firebase Storage URLs
    _uploadedThisSession     = null;
    _uploadInProgress        = false;
    document.getElementById('modalTitle').textContent     = 'Edit Item';
    document.getElementById('saveItemBtn').textContent    = 'Update Item';
    document.getElementById('saveItemBtn').disabled       = false;
    document.getElementById('itemNameInput').value        = item.name        || '';
    document.getElementById('itemDescInput').value        = item.description || '';
    document.getElementById('itemPriceInput').value       = item.price       || '';
    populateCategoryDropdown(item.category);
    if (_currentImageUrl) {
        imagePreview.style.backgroundImage = `url(${_currentImageUrl})`;
        imagePreviewText.style.display     = 'none';
        imgRemoveBtn.classList.remove('hidden');
        imgUploadBtn.textContent           = '🔄 Replace Image';
    } else {
        imagePreview.style.backgroundImage = '';
        imagePreviewText.style.display     = 'flex';
        imgRemoveBtn.classList.add('hidden');
        imgUploadBtn.textContent           = '📤 Upload Image';
    }
    imageUploadSpinner.classList.add('hidden');
    imgUploadBtn.disabled = false;
    itemImageInput.value  = '';
    itemModal.classList.remove('hidden');
};

function closeModal() {
    itemModal.classList.add('hidden');
    // Reset upload state so stale state never leaks into the next modal open
    _uploadInProgress = false;
    imageUploadSpinner.classList.add('hidden');
    imgUploadBtn.disabled = false;
    document.getElementById('saveItemBtn').disabled = false;
}
document.getElementById('closeModalBtn').addEventListener('click', closeModal);
document.getElementById('closeModalBtnBottom').addEventListener('click', closeModal);
// Tap outside modal box to close
itemModal.addEventListener('click', (e) => { if (e.target === itemModal) closeModal(); });

// ── Image upload UX ───────────────────────────────────────────────────────────
// AI UPDATE [2026-08-02]: Eager upload — image uploads on file select, not on
// Save. Save is disabled while upload is in progress. Image is converted to WebP
// for optimised storage. Old image is deleted from Storage (best-effort) when
// replaced or removed.

// Upload button and clicking the preview both open the file picker
imgUploadBtn.addEventListener('click', () => { if (!_uploadInProgress) itemImageInput.click(); });
imagePreview.addEventListener('click', () => { if (!_uploadInProgress) itemImageInput.click(); });

// Remove button — clears the image URL and best-effort deletes a session-uploaded image.
// AI UPDATE [2026-08-02]: deleteObject (Firebase Storage) replaced with deleteMenuImage
// (Cloudinary server-side proxy). _uploadedThisSession now stores a publicId, not a URL.
imgRemoveBtn.addEventListener('click', () => {
    if (_uploadInProgress) return;
    if (_uploadedThisSession) {
        deleteMenuImage(_uploadedThisSession); // fire-and-forget, non-fatal
        _uploadedThisSession = null;
    }
    _currentImageUrl               = null;
    _currentPublicId               = null;
    imagePreview.style.backgroundImage = '';
    imagePreviewText.style.display     = 'flex';
    imgRemoveBtn.classList.add('hidden');
    imgUploadBtn.textContent           = '📤 Upload Image';
    itemImageInput.value               = '';
});

// File selected → immediately upload to Cloudinary via server proxy (eager).
// AI UPDATE [2026-08-02]: Switched from Firebase Storage to Cloudinary.
// Credentials are kept server-side; the browser only calls /api/upload-menu-image.
// The 30-second timeout is enforced inside uploadMenuImage() via AbortController.
itemImageInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    itemImageInput.value = ''; // reset so the same file can be re-selected later
    if (!file) return;

    _uploadInProgress = true;
    document.getElementById('saveItemBtn').disabled = true;
    imgUploadBtn.disabled                           = true;

    try {
        // Show spinner — inside try so any null-ref TypeError is caught, not silently swallowed
        imgRemoveBtn.classList.add('hidden');
        imagePreview.style.backgroundImage = '';
        imagePreviewText.style.display     = 'none';
        if (imageUploadSpinner) imageUploadSpinner.classList.remove('hidden');

        // Convert to WebP client-side to reduce upload payload size.
        // Cloudinary also applies auto quality and format optimization server-side.
        const blob = await _toWebP(file);

        // Pass the old publicId so the server deletes it as part of this upload:
        //   - _uploadedThisSession: a previous upload within the same modal session
        //   - _currentPublicId:     the original item image (null for legacy Firebase URLs)
        const oldToDelete = _uploadedThisSession || _currentPublicId || null;
        const result = await uploadMenuImage(blob, oldToDelete);

        _uploadedThisSession               = result.publicId;
        _currentPublicId                   = result.publicId;
        _currentImageUrl                   = result.url;
        imagePreview.style.backgroundImage = `url(${result.url})`;
        imagePreviewText.style.display     = 'none';
        imgRemoveBtn.classList.remove('hidden');
        imgUploadBtn.textContent           = '🔄 Replace Image';
        console.log('[menu-img] Uploaded to Cloudinary:', result.publicId);
    } catch (err) {
        console.error('[menu-img] Upload failed:', err);
        // Restore whatever was showing before the upload attempt
        if (_currentImageUrl) {
            imagePreview.style.backgroundImage = `url(${_currentImageUrl})`;
            imagePreviewText.style.display     = 'none';
            imgRemoveBtn.classList.remove('hidden');
        } else {
            imagePreview.style.backgroundImage = '';
            imagePreviewText.style.display     = 'flex';
        }
        _imgToast('Upload failed. Please try again.');
    } finally {
        _uploadInProgress = false;
        imageUploadSpinner.classList.add('hidden');
        document.getElementById('saveItemBtn').disabled = false;
        imgUploadBtn.disabled = false;
    }
});

// Convert any image file to a WebP Blob using the Canvas API.
// Falls back to the original File on any error or if conversion takes > 10 s.
function _toWebP(file) {
    return new Promise((resolve) => {
        // Safety timeout: if the canvas never calls back, fall back to original
        const timer = setTimeout(() => {
            console.warn('[menu-img] _toWebP timed out — using original file');
            resolve(file);
        }, 10000);

        const cleanup = (result) => { clearTimeout(timer); resolve(result); };

        try {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(url);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width  = img.naturalWidth  || 1;
                    canvas.height = img.naturalHeight || 1;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) { cleanup(file); return; }
                    ctx.drawImage(img, 0, 0);
                    canvas.toBlob(
                        (blob) => cleanup(blob && blob.size > 0 ? blob : file),
                        'image/webp',
                        0.85
                    );
                } catch (_) { cleanup(file); }
            };
            img.onerror = () => { URL.revokeObjectURL(url); cleanup(file); };
            img.src = url;
        } catch (_) { cleanup(file); }
    });
}

// AI UPDATE [2026-08-02]: _storageRefFromUrl removed — Firebase Storage is no longer
// used for menu images. Cloudinary public_id extraction is in js/cloudinary-upload.js.

// Non-blocking toast for image-related errors (non-modal so it doesn't interrupt flow)
function _imgToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = [
        'position:fixed', 'bottom:160px', 'left:50%', 'transform:translateX(-50%)',
        'background:#ef4444', 'color:#fff', 'border-radius:10px',
        'padding:10px 20px', 'font-size:0.88rem', 'font-weight:600',
        'z-index:99999', 'white-space:nowrap', 'box-shadow:0 4px 20px rgba(0,0,0,0.3)'
    ].join(';');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
}

// AI UPDATE [2026-08-02]: Save handler no longer uploads the image — upload now
// happens eagerly on file-select. Here we just use _currentImageUrl (already set).
// New items get the full extended Firestore schema (description, imageUrl, active,
// createdAt, updatedAt, displayOrder, variants, extraOptions).
// Edits update only the mutable presentation fields; variants/extraOptions/active/
// displayOrder/createdAt are intentionally NOT overwritten so future UI that manages
// those fields won't have its data stomped by the basic edit form.
document.getElementById('saveItemBtn').addEventListener('click', async () => {
    const btn         = document.getElementById('saveItemBtn');
    const name        = document.getElementById('itemNameInput').value.trim();
    const price       = document.getElementById('itemPriceInput').value.trim();
    const description = document.getElementById('itemDescInput').value.trim();
    let   category    = document.getElementById('itemCategoryInput').value;

    if (_uploadInProgress) {
        await showAlert("Please wait for the image to finish uploading.", 'warning', 'Upload In Progress');
        return;
    }
    // AI UPDATE [2026-07-30]: Replaced alert() with custom dialogs.
    if (category === 'NEW_CATEGORY') {
        category = document.getElementById('newCategoryInput').value.trim();
        if (!category) { await showAlert("Enter category name!", 'warning', 'Missing Field'); return; }
    }
    if (!name || !price) { await showAlert("Name and Price are required!", 'warning', 'Missing Fields'); return; }

    btn.textContent = 'Saving… ⏳';
    btn.disabled    = true;

    try {
        if (currentEditId) {
            // Edit: update only the fields the form manages.
            // variants, extraOptions, active, displayOrder, createdAt are NOT touched.
            await updateDoc(doc(db, 'menu_items', currentEditId), {
                name,
                price:       Number(price),
                category,
                description: description || '',
                imageUrl:    _currentImageUrl || null,
                updatedAt:   serverTimestamp(),
            });
        } else {
            // Add: write the complete extended document schema.
            await addDoc(collection(db, 'menu_items'), {
                name,
                price:        Number(price),
                category,
                description:  description || '',
                imageUrl:     _currentImageUrl || null,
                inStock:      true,
                active:       true,       // soft-visible flag (Customer Panel uses this)
                displayOrder: 0,          // sort hint; 0 = no preference
                variants:     [],         // e.g. [{ label:'Regular', price:120 }]
                extraOptions: [],         // e.g. [{ name:'Extra Cheese', price:50 }]
                createdAt:    serverTimestamp(),
                updatedAt:    serverTimestamp(),
            });
        }
        closeModal();
        // The live onSnapshot listener fires automatically after addDoc/updateDoc —
        // no need to call loadMenuData() here; doing so would tear down the
        // listener and recreate it unnecessarily.
    } catch (e) {
        console.error(e);
        // AI UPDATE [2026-07-30]: Replaced alert() with custom dialog.
        await showAlert('Save failed! Check internet.', 'error', 'Save Failed');
    } finally {
        btn.textContent = currentEditId ? 'Update Item' : 'Save Item';
        btn.disabled    = false;
    }
});

// ==========================================
// EXPENSES
// ==========================================

// ===== AI UPDATE =====
// Date: 2026-07-28 (session 3)
// Bugs fixed in this section:
//
// Bug A — Expense listener torn down on every filter change and every tab switch:
//   loadAdminExpenses() always called _expenseUnsub() then created a new
//   onSnapshot, even when switching filter from "Today" → "7 Days" or just
//   switching away and back to the Expense tab.  Each recreation caused a brief
//   loading flash and a Firestore network reconnect.
//   Root cause: filtering was done inside the onSnapshot closure, so the filter
//   was baked in — changing it required a new listener.
//   Fix: filtering is now done in _renderExpensesFromDocs() which reads from the
//   module-level _expenseAllDocs array.  loadAdminExpenses() updates the filter
//   variables and calls _renderExpensesFromDocs() instantly from the cached docs
//   without touching the live listener.  The listener is only created on the
//   first call or when explicitly force-refreshed.
//
// Bug B — deleteExpense() unnecessarily recreated the listener:
//   After deleteDoc(), the live onSnapshot fires automatically with the updated
//   collection.  Calling loadAdminExpenses() on top of that tore down and
//   recreated the listener for no reason.
//   Fix: deleteExpense() no longer calls loadAdminExpenses().
//
// Bug C — Refresh button didn't actually force a fresh network fetch:
//   loadAdminExpenses() (with the old code) did cancel/recreate the listener,
//   but it was indistinguishable from a filter change.  With the new cached-docs
//   approach, the Refresh button now explicitly tears down the listener and
//   recreates it so a forced server sync is guaranteed.
// =====================

// All expense docs from the last Firestore snapshot (unfiltered).
// Filtering is done client-side in _renderExpensesFromDocs() so we can
// switch filters instantly without touching the live listener.
let _expenseUnsub    = null;
let _expenseAllDocs  = [];       // cached raw docs from last onSnapshot
let _expFilterType   = 'days';
let _expFilterValue  = 1;

// Render the expense list from the cached _expenseAllDocs using the current filter.
// Called both from the onSnapshot callback and from loadAdminExpenses() when the
// filter changes with the listener already alive.
function _renderExpensesFromDocs() {
    const listEl = document.getElementById('expenseCardList');
    if (!listEl) return;

    const now = new Date();
    let filtered = [];
    _expenseAllDocs.forEach(exp => {
        const expDate = new Date(exp.timestamp);
        const diff    = Math.ceil(Math.abs(now - expDate) / 864e5);
        if (_expFilterType === 'days') {
            if (_expFilterValue === 1 && expDate.toDateString() === now.toDateString()) filtered.push(exp);
            else if (_expFilterValue !== 1 && diff <= _expFilterValue) filtered.push(exp);
        } else if (_expFilterType === 'date') {
            if (expDate.toDateString() === new Date(_expFilterValue).toDateString()) filtered.push(exp);
        }
    });
    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const total = filtered.reduce((s, e) => s + Number(e.amount), 0);
    document.getElementById('totalExpenseBox').textContent = `₹${total.toFixed(0)}`;

    if (!filtered.length) {
        listEl.innerHTML = '<div class="empty-state">No expenses found. 🎉</div>';
        return;
    }
    listEl.innerHTML = filtered.map(exp => {
        const timeStr = new Date(exp.timestamp).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
        return `
        <div class="expense-card">
            <div class="exp-left">
                <div class="exp-note">${exp.note}</div>
                <div class="exp-time">${timeStr}</div>
            </div>
            <div class="exp-right">
                <div class="exp-amount">₹${exp.amount}</div>
                <button class="exp-del-btn" onclick="deleteExpense('${exp.id}')">🗑</button>
            </div>
        </div>`;
    }).join('');
}

// Start (or restart) the Firestore onSnapshot listener for expenses.
// This is extracted so the Refresh button can force a fresh connection.
function _startExpenseListener() {
    if (_expenseUnsub) { _expenseUnsub(); _expenseUnsub = null; }
    const listEl = document.getElementById('expenseCardList');

    enableNetwork(db).catch(() => {}).finally(() => {
        _expenseUnsub = onSnapshot(
            collection(db, "daily_expenses"),
            (snap) => {
                _expenseAllDocs = [];
                snap.forEach(d => _expenseAllDocs.push({ ...d.data(), id: d.id }));
                _renderExpensesFromDocs();
            },
            (err) => {
                console.error("Expense listener error:", err);
                _expenseUnsub = null; // Mark dropped so next call recreates it
                if (listEl && listEl.innerHTML.includes('Loading')) {
                    listEl.innerHTML = '<div class="empty-state" style="color:#f85149;">Failed to load. Check internet.</div>';
                }
            }
        );
    });
}

window.loadAdminExpenses = function(filterType, filterValue, btnContext, forceRefresh = false) {
    if (btnContext) {
        document.querySelectorAll('#expenseSection .filter-pill').forEach(b => b.classList.remove('active'));
        btnContext.classList.add('active');
    }

    // Update the current filter
    _expFilterType  = filterType;
    _expFilterValue = filterValue;

    if (_expenseUnsub && !forceRefresh) {
        // Listener is alive — re-render instantly from the cached docs using the
        // updated filter.  No network round-trip, no loading flash.
        _renderExpensesFromDocs();
        return;
    }

    // First call, listener dropped, or explicit force-refresh — start fresh.
    const listEl = document.getElementById('expenseCardList');
    listEl.innerHTML = '<div class="loading-state">Loading... ☁️</div>';
    document.getElementById('totalExpenseBox').textContent = '₹0';
    _startExpenseListener();
};

document.getElementById('expenseDateSearch').addEventListener('change', (e) => {
    if (e.target.value) {
        document.querySelectorAll('#expenseSection .filter-pill').forEach(b => b.classList.remove('active'));
        loadAdminExpenses('date', e.target.value, null);
    }
});

document.getElementById('refreshExpenseBtn').addEventListener('click', (e) => {
    e.target.textContent = '⏳'; e.target.disabled = true;
    const active  = document.querySelector('#expenseSection .filter-pill.active');
    const dateVal = document.getElementById('expenseDateSearch').value;
    // forceRefresh=true: tear down the listener and reconnect for a guaranteed
    // server sync (same visible behaviour as before, now explicit).
    if (dateVal) loadAdminExpenses('date', dateVal, null, true);
    else loadAdminExpenses('days', parseInt(active?.dataset.val || '1'), active, true);
    setTimeout(() => { e.target.textContent = '↻'; e.target.disabled = false; }, 1500);
});

window.deleteExpense = async function(id) {
    // AI UPDATE [2026-07-30]: Replaced confirm()/alert() with custom dialogs.
    if (!await showConfirm("This expense will be permanently removed.", {
        title: 'Delete this expense?', confirmText: 'Delete', type: 'error'
    })) return;
    try {
        await deleteDoc(doc(db, "daily_expenses", id));
        // The live onSnapshot fires automatically after the delete — no need to
        // call loadAdminExpenses() here; doing so would tear down and recreate
        // the listener unnecessarily.
    } catch (e) {
        await showAlert("Delete failed. Check internet.", 'error', 'Delete Failed');
    }
};
