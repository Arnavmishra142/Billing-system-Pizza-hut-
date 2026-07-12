import { db, storage } from './firebase-config.js';
import {
    collection, getDocs, doc, deleteDoc, addDoc, updateDoc,
    getDocsFromCache, getDocsFromServer
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// ==========================================
// LOGIN & SESSION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('adminLoggedIn') === 'true') {
        showDashboard();
    }

    // Enter key on PIN
    document.getElementById('pinInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('loginBtn').click();
    });
});

document.getElementById('loginBtn').addEventListener('click', () => {
    const pin = document.getElementById('pinInput').value;
    if (pin === "1414") {
        localStorage.setItem('adminLoggedIn', 'true');
        showDashboard();
    } else {
        document.getElementById('pinInput').value = '';
        document.getElementById('pinInput').placeholder = 'Wrong PIN!';
        setTimeout(() => { document.getElementById('pinInput').placeholder = '••••'; }, 1500);
    }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('adminLoggedIn');
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
let allSales = [];

async function fetchAllSales() {
    // Cache-first for speed
    try {
        const snap = await getDocsFromCache(collection(db, "sales_history"));
        if (!snap.empty) {
            allSales = [];
            snap.forEach(d => { allSales.push({ ...d.data(), id: d.id }); });
        }
    } catch (e) {}

    // Then update from server
    try {
        const snap = await getDocsFromServer(collection(db, "sales_history"));
        allSales = [];
        snap.forEach(d => { allSales.push({ ...d.data(), id: d.id }); });
    } catch (e) { console.error("Sales fetch error:", e); }
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
    if (!confirm("Delete this bill?")) return;
    try {
        await deleteDoc(doc(db, "sales_history", saleId));
        const activeFilter = document.querySelector('#salesSection .filter-pill.active');
        const customDate   = document.getElementById('customDateSearch').value;
        if (customDate) loadSalesData('date', customDate);
        else loadSalesData('days', parseInt(activeFilter?.dataset.val || '1'));
    } catch (e) { alert("Delete failed. Check internet."); }
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
    const active     = document.querySelector('#salesSection .filter-pill.active');
    const customDate = document.getElementById('customDateSearch').value;
    if (customDate) await loadSalesData('date', customDate);
    else await loadSalesData('days', parseInt(active?.dataset.val || '1'));
    e.target.textContent = '↻'; e.target.disabled = false;
});

// ==========================================
// MENU MANAGEMENT
// ==========================================
const itemModal        = document.getElementById('itemModal');
const imagePreview     = document.getElementById('imagePreview');
const itemImageInput   = document.getElementById('itemImageInput');
const imagePreviewText = document.getElementById('imagePreviewText');

let selectedImageFile = null;
let currentEditId     = null;
let allMenuItems      = [];

window.loadMenuData = async function() {
    const grid = document.getElementById('menuCardGrid');
    grid.innerHTML = '<div class="loading-state">Loading menu... ☁️</div>';

    try {
        // Cache-first
        let snap;
        try { snap = await getDocsFromCache(collection(db, "menu_items")); } catch(e) {}
        if (!snap || snap.empty) snap = await getDocsFromServer(collection(db, "menu_items"));

        allMenuItems = [];
        snap.forEach(d => allMenuItems.push({ ...d.data(), id: d.id }));

        allMenuItems.sort((a, b) => {
            const ca = (a.category || '').toUpperCase(), cb = (b.category || '').toUpperCase();
            if (ca < cb) return -1; if (ca > cb) return 1;
            const na = (a.name || '').toUpperCase(), nb = (b.name || '').toUpperCase();
            return na < nb ? -1 : na > nb ? 1 : 0;
        });

        renderMenuCards();
    } catch (e) {
        console.error(e);
        grid.innerHTML = '<div class="empty-state" style="color:#f85149;">Failed to load menu. Check internet.</div>';
    }
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
        const imgTag   = item.image
            ? `<div class="menu-thumb"><img src="${item.image}" alt="${item.name}"></div>`
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
    catch(e) { alert("Stock update failed!"); }
};

window.deleteMenuItem = async function(id) {
    if (!confirm("Delete this item permanently?")) return;
    await deleteDoc(doc(db, "menu_items", id));
    loadMenuData();
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
    currentEditId = null;
    selectedImageFile = null;
    document.getElementById('modalTitle').textContent     = 'Add New Item';
    document.getElementById('saveItemBtn').textContent    = 'Save Item';
    document.getElementById('itemNameInput').value        = '';
    document.getElementById('itemPriceInput').value       = '';
    imagePreview.style.backgroundImage = 'none';
    imagePreviewText.style.display = 'flex';
    itemImageInput.value = '';
    populateCategoryDropdown();
    itemModal.classList.remove('hidden');
});

window.editMenuItem = function(id) {
    const item = allMenuItems.find(i => i.id === id);
    if (!item) return;
    currentEditId     = id;
    selectedImageFile = null;
    document.getElementById('modalTitle').textContent     = 'Edit Item';
    document.getElementById('saveItemBtn').textContent    = 'Update Item';
    document.getElementById('itemNameInput').value        = item.name;
    document.getElementById('itemPriceInput').value       = item.price;
    populateCategoryDropdown(item.category);
    if (item.image) {
        imagePreview.style.backgroundImage = `url(${item.image})`;
        imagePreviewText.style.display = 'none';
    } else {
        imagePreview.style.backgroundImage = 'none';
        imagePreviewText.style.display = 'flex';
    }
    itemImageInput.value = '';
    itemModal.classList.remove('hidden');
};

function closeModal() { itemModal.classList.add('hidden'); }
document.getElementById('closeModalBtn').addEventListener('click', closeModal);
document.getElementById('closeModalBtnBottom').addEventListener('click', closeModal);
// Tap outside modal box to close
itemModal.addEventListener('click', (e) => { if (e.target === itemModal) closeModal(); });

imagePreview.addEventListener('click', () => itemImageInput.click());
itemImageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    selectedImageFile = file;
    const reader = new FileReader();
    reader.onload = (ev) => {
        imagePreview.style.backgroundImage = `url(${ev.target.result})`;
        imagePreviewText.style.display = 'none';
    };
    reader.readAsDataURL(file);
});

document.getElementById('saveItemBtn').addEventListener('click', async () => {
    const btn      = document.getElementById('saveItemBtn');
    const name     = document.getElementById('itemNameInput').value.trim();
    const price    = document.getElementById('itemPriceInput').value.trim();
    let category   = document.getElementById('itemCategoryInput').value;

    if (category === 'NEW_CATEGORY') {
        category = document.getElementById('newCategoryInput').value.trim();
        if (!category) { alert("Enter category name!"); return; }
    }
    if (!name || !price) { alert("Name and Price are required!"); return; }

    btn.textContent = "Saving... ⏳";
    btn.disabled    = true;

    try {
        let imageUrl = null;
        if (selectedImageFile) {
            const imgRef = ref(storage, `menu_images/${Date.now()}_${selectedImageFile.name}`);
            await uploadBytes(imgRef, selectedImageFile);
            imageUrl = await getDownloadURL(imgRef);
        }

        if (currentEditId) {
            const update = { name, price: Number(price), category };
            if (imageUrl) update.image = imageUrl;
            await updateDoc(doc(db, "menu_items", currentEditId), update);
        } else {
            await addDoc(collection(db, "menu_items"), {
                name, price: Number(price), category, image: imageUrl, inStock: true
            });
        }
        closeModal();
        loadMenuData();
    } catch (e) {
        console.error(e);
        alert("Save failed! Check internet.");
    } finally {
        btn.textContent = currentEditId ? "Update Item" : "Save Item";
        btn.disabled    = false;
    }
});

// ==========================================
// EXPENSES
// ==========================================
window.loadAdminExpenses = async function(filterType, filterValue, btnContext) {
    if (btnContext) {
        document.querySelectorAll('#expenseSection .filter-pill').forEach(b => b.classList.remove('active'));
        btnContext.classList.add('active');
    }

    const listEl = document.getElementById('expenseCardList');
    listEl.innerHTML = '<div class="loading-state">Loading... ☁️</div>';

    const applySnap = (snap) => {
        const now = new Date();
        let filtered = [];
        snap.forEach(d => {
            const exp     = { ...d.data(), id: d.id };
            const expDate = new Date(exp.timestamp);
            const diff    = Math.ceil(Math.abs(now - expDate) / 864e5);
            if (filterType === 'days') {
                if (filterValue === 1 && expDate.toDateString() === now.toDateString()) filtered.push(exp);
                else if (filterValue !== 1 && diff <= filterValue) filtered.push(exp);
            } else if (filterType === 'date') {
                if (expDate.toDateString() === new Date(filterValue).toDateString()) filtered.push(exp);
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
    };

    // Phase 1: show cached data instantly
    try {
        const cacheSnap = await getDocsFromCache(collection(db, "daily_expenses"));
        if (!cacheSnap.empty) applySnap(cacheSnap);
    } catch(e) {}

    // Phase 2: always fetch from server so new expenses are never missed
    try {
        const serverSnap = await getDocsFromServer(collection(db, "daily_expenses"));
        applySnap(serverSnap);
    } catch (e) {
        console.error(e);
        if (listEl.innerHTML.includes('Loading')) {
            listEl.innerHTML = '<div class="empty-state" style="color:#f85149;">Failed to load. Check internet.</div>';
        }
    }
};

document.getElementById('expenseDateSearch').addEventListener('change', (e) => {
    if (e.target.value) {
        document.querySelectorAll('#expenseSection .filter-pill').forEach(b => b.classList.remove('active'));
        loadAdminExpenses('date', e.target.value, null);
    }
});

document.getElementById('refreshExpenseBtn').addEventListener('click', async (e) => {
    e.target.textContent = '⏳'; e.target.disabled = true;
    const active    = document.querySelector('#expenseSection .filter-pill.active');
    const dateVal   = document.getElementById('expenseDateSearch').value;
    if (dateVal) await loadAdminExpenses('date', dateVal, null);
    else await loadAdminExpenses('days', parseInt(active?.dataset.val || '1'), active);
    e.target.textContent = '↻'; e.target.disabled = false;
});

window.deleteExpense = async function(id) {
    if (!confirm("Delete this expense?")) return;
    try {
        await deleteDoc(doc(db, "daily_expenses", id));
        const active  = document.querySelector('#expenseSection .filter-pill.active');
        const dateVal = document.getElementById('expenseDateSearch').value;
        if (dateVal) loadAdminExpenses('date', dateVal, null);
        else loadAdminExpenses('days', parseInt(active?.dataset.val || '1'), active);
    } catch (e) { alert("Delete failed. Check internet."); }
};
