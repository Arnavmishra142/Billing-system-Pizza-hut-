

import { db, storage } from './firebase-config.js';
import { collection, getDocs, doc, deleteDoc, addDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// ==========================================
// LOGIN & SESSION LOGIC
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('adminLoggedIn') === 'true') {
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('adminContent').style.display = 'flex';
        loadSalesData('days', 1);
    }
});

document.getElementById('loginBtn').addEventListener('click', () => {
    const pin = document.getElementById('pinInput').value;
    if(pin === "1414") { 
        localStorage.setItem('adminLoggedIn', 'true');
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('adminContent').style.display = 'flex';
        loadSalesData('days', 1); 
    } else {
        alert("Incorrect PIN!");
        document.getElementById('pinInput').value = '';
    }
});

window.switchTab = function(tabName) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    
    document.getElementById(tabName + 'Section').classList.add('active');
    event.target.classList.add('active');

    if(tabName === 'menu') {
        loadMenuData();
    }
}

// ==========================================
// SALES LOGIC
// ==========================================
let allSales = []; 
async function fetchAllSalesFromDB() {
    try {
        const querySnapshot = await getDocs(collection(db, "sales_history"));
        allSales = [];
        querySnapshot.forEach((docSnap) => {
            let data = docSnap.data(); data.id = docSnap.id; allSales.push(data);
        });
    } catch (error) { console.error(error); }
}

window.loadSalesData = async function(filterType, filterValue) {
    document.getElementById('tableSalesTableBody').innerHTML = '<tr><td colspan="3" class="loading">Loading...</td></tr>';
    document.getElementById('qsSalesTableBody').innerHTML = '<tr><td colspan="3" class="loading">Loading...</td></tr>';
    await fetchAllSalesFromDB();
    const now = new Date();
    let filteredSales = [];

    allSales.forEach(sale => {
        if(!sale.timestamp) return; 
        const saleDate = new Date(sale.timestamp);
        if (filterType === 'date') {
            if (saleDate.toDateString() === new Date(filterValue).toDateString()) filteredSales.push(sale);
        } else if (filterType === 'days') {
            const diffDays = Math.ceil(Math.abs(now - saleDate) / (1000 * 60 * 60 * 24)); 
            if (filterValue === 1 && saleDate.toDateString() === now.toDateString()) filteredSales.push(sale);
            else if (filterValue !== 1 && diffDays <= filterValue) filteredSales.push(sale);
        }
    });

    filteredSales.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    let totalRevenue = 0;
    let tableRevenue = 0, tableOrders = 0, tableItemStats = {};
    let qsRevenue = 0, qsOrders = 0, qsItemStats = {};

    const tableBillsTbody = document.getElementById('tableBillsTableBody'); tableBillsTbody.innerHTML = '';
    const qsBillsTbody = document.getElementById('qsBillsTableBody'); qsBillsTbody.innerHTML = '';

    filteredSales.forEach(sale => {
        const saleTotal = Number(sale.total) || 0;
        totalRevenue += saleTotal;

        const isQuickSale = sale.table === 'Direct Entry';
        let timeString = sale.timestamp ? new Date(sale.timestamp).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : 'N/A';

        let displayName = sale.table || 'Unknown';
        if (isQuickSale) {
            displayName = 'Cash Sale';
        } else if (!displayName.includes('Parcel')) {
            displayName = `${displayName} [${sale.customer || 'C1'}]`;
        }

        const rowHTML = `
            <tr>
                <td style="color:#94a3b8; white-space:nowrap;">${timeString}</td>
                <td style="font-weight:bold; color:white; white-space:nowrap;">${displayName}</td>
                <td class="text-right" style="color:#10b981; font-weight:bold;">₹${saleTotal.toFixed(2)}</td>
                <td class="text-center"><button class="btn btn-danger" style="padding: 6px 12px; font-size: 0.9rem;" onclick="deleteSale('${sale.id}')">🗑️</button></td>
            </tr>
        `;

        const targetStats = isQuickSale ? qsItemStats : tableItemStats;
        (sale.items || []).forEach(item => {
            const itemName = item.name || 'Unknown Item';
            if (!targetStats[itemName]) targetStats[itemName] = { qty: 0, rev: 0 };
            targetStats[itemName].qty += Number(item.qty) || 0;
            targetStats[itemName].rev += (Number(item.qty) || 0) * (Number(item.price) || 0);
        });

        if (isQuickSale) {
            qsRevenue += saleTotal;
            qsOrders++;
            qsBillsTbody.innerHTML += rowHTML;
        } else {
            tableRevenue += saleTotal;
            tableOrders++;
            tableBillsTbody.innerHTML += rowHTML;
        }
    });

    if (tableOrders === 0) tableBillsTbody.innerHTML = '<tr><td colspan="4" class="text-center" style="padding:20px; color:#64748b;">No bills found.</td></tr>';
    if (qsOrders === 0) qsBillsTbody.innerHTML = '<tr><td colspan="4" class="text-center" style="padding:20px; color:#64748b;">No bills found.</td></tr>';

    document.getElementById('totalRevenueBox').innerText = `₹${totalRevenue.toFixed(2)}`;
    document.getElementById('totalOrdersBox').innerText = filteredSales.length;
    document.getElementById('tableRevenueBox').innerText = `₹${tableRevenue.toFixed(2)}`;
    document.getElementById('tableOrdersBox').innerText = tableOrders;
    document.getElementById('qsRevenueBox').innerText = `₹${qsRevenue.toFixed(2)}`;
    document.getElementById('qsOrdersBox').innerText = qsOrders;

    const renderItemStats = (tbodyId, statsObj) => {
        const tbody = document.getElementById(tbodyId);
        tbody.innerHTML = '';
        let sortedItems = Object.keys(statsObj).map(key => ({ name: key, qty: statsObj[key].qty, rev: statsObj[key].rev })).sort((a, b) => b.qty - a.qty);

        if (sortedItems.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center" style="padding:30px; color:#64748b;">No items sold.</td></tr>';
        } else {
            sortedItems.forEach(stat => {
                tbody.innerHTML += `<tr><td style="font-weight:bold; color:white;">${stat.name}</td><td class="text-right" style="color:#38bdf8; font-weight:bold;">${stat.qty}</td><td class="text-right" style="color:#10b981; font-weight:bold;">₹${stat.rev.toFixed(2)}</td></tr>`;
            });
        }
    };

    renderItemStats('tableSalesTableBody', tableItemStats);
    renderItemStats('qsSalesTableBody', qsItemStats);
}
window.deleteSale = async function(saleId) {
    if (confirm("Delete this bill?")) {
        await deleteDoc(doc(db, "sales_history", saleId));
        const activeBtn = document.querySelector('.filter-btn.active');
        if(activeBtn) loadSalesData('days', parseInt(activeBtn.dataset.val)); 
        else loadSalesData('date', document.getElementById('customDateSearch').value);
    }
}

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        document.getElementById('customDateSearch').value = ''; 
        loadSalesData('days', parseInt(e.target.dataset.val));
    });
});
document.getElementById('refreshBtn').addEventListener('click', async (e) => {
    const btn = e.target; btn.innerText = "🔄..."; btn.disabled = true;
    const activeBtn = document.querySelector('.filter-btn.active');
    if(activeBtn) await loadSalesData('days', parseInt(activeBtn.dataset.val));
    else await loadSalesData('date', document.getElementById('customDateSearch').value || new Date());
    btn.innerText = "🔄 Refresh Data"; btn.disabled = false;
});
document.getElementById('customDateSearch').addEventListener('change', (e) => {
    if (e.target.value) { document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active')); loadSalesData('date', e.target.value); }
});

// ==========================================
// MENU MANAGEMENT & UI UPDATES
// ==========================================
const itemModal = document.getElementById('itemModal');
const imagePreview = document.getElementById('imagePreview');
const itemImageInput = document.getElementById('itemImageInput');
const imagePreviewText = document.getElementById('imagePreviewText');

let selectedImageFile = null; 
let currentEditId = null; 
let allMenuItems = []; 

window.loadMenuData = async function() {
    const tbody = document.getElementById('menuTableBody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading">Loading Menu from Cloud... ☁️</td></tr>';
    
    try {
        const querySnapshot = await getDocs(collection(db, "menu_items"));
        tbody.innerHTML = '';
        allMenuItems = []; 
        
        if (querySnapshot.empty) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:30px; color:#64748b;">Your menu is empty. Click "+ Add New Item".</td></tr>';
            return;
        }

        querySnapshot.forEach((docSnap) => {
            let item = docSnap.data();
            item.id = docSnap.id;
            allMenuItems.push(item); 
        });

        // NAYA LOGIC: Sorting by Category then by Name
        allMenuItems.sort((a, b) => {
            let catA = (a.category || "").toUpperCase();
            let catB = (b.category || "").toUpperCase();
            if (catA < catB) return -1;
            if (catA > catB) return 1;
            
            let nameA = (a.name || "").toUpperCase();
            let nameB = (b.name || "").toUpperCase();
            if (nameA < nameB) return -1;
            if (nameA > nameB) return 1;
            return 0;
        });

        // Table mein print karna (Category wise format)
        let currentCategoryTrack = "";

        allMenuItems.forEach((item) => {
            if(item.category !== currentCategoryTrack) {
                currentCategoryTrack = item.category;
                tbody.innerHTML += `
                    <tr style="background: #334155;">
                        <td colspan="6" style="color: #f8fafc; font-weight: 800; font-size: 1.1rem; padding: 10px 15px; letter-spacing: 1px; text-transform: uppercase;">
                            📌 ${item.category}
                        </td>
                    </tr>
                `;
            }

            let checked = item.inStock !== false ? 'checked' : '';
            let imageTag = item.image ? `<img src="${item.image}" class="menu-thumb">` : `<div class="menu-thumb" style="display:flex;align-items:center;justify-content:center;font-size:10px;color:gray;">No Img</div>`;

            tbody.innerHTML += `
                <tr>
                    <td>${imageTag}</td>
                    <td style="font-weight: bold; color: white;">${item.name}</td>
                    <td style="color: #38bdf8;">${item.category}</td>
                    <td style="color: #10b981; font-weight: bold;">₹${item.price}</td>
                    <td class="text-center">
                        <label class="switch">
                            <input type="checkbox" ${checked} onchange="toggleStock('${item.id}', this.checked)">
                            <span class="slider"></span>
                        </label>
                    </td>
                    <td class="text-center" style="white-space: nowrap;">
                        <button class="action-btn btn-edit" onclick="editMenuItem('${item.id}')">✏️</button>
                        <button class="action-btn btn-delete" onclick="deleteMenuItem('${item.id}')">🗑️</button>
                    </td>
                </tr>
            `;
        });
    } catch (e) {
        console.error("Error loading menu:", e);
        tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="color:red;">Error loading menu. Internet check karo.</td></tr>';
    }
}

// MISSING FUNCTIONS RESTORED
window.toggleStock = async function(id, isStockStatus) {
    try { await updateDoc(doc(db, "menu_items", id), { inStock: isStockStatus }); } 
    catch(e) { alert("Stock update fail hua!"); }
}

window.deleteMenuItem = async function(id) {
    if(confirm("Are you sure you want to delete this item permanently?")) {
        await deleteDoc(doc(db, "menu_items", id));
        loadMenuData(); 
    }
}

function populateCategoryDropdown(selectedCategory = null) {
    const select = document.getElementById('itemCategoryInput');
    const newCatInput = document.getElementById('newCategoryInput');
    select.innerHTML = '';
    
    const uniqueCategories = [...new Set(allMenuItems.map(item => item.category))].filter(Boolean);
    
    uniqueCategories.forEach(cat => {
        select.innerHTML += `<option value="${cat}">${cat}</option>`;
    });
    
    select.innerHTML += `<option value="NEW_CATEGORY" style="font-weight:bold; color:#10b981;">+ Add Custom Category</option>`;
    
    if(selectedCategory) {
        select.value = selectedCategory;
    }
    
    newCatInput.classList.add('hidden');
    newCatInput.value = '';
}

document.getElementById('itemCategoryInput').addEventListener('change', (e) => {
    if(e.target.value === 'NEW_CATEGORY') {
        document.getElementById('newCategoryInput').classList.remove('hidden');
        document.getElementById('newCategoryInput').focus();
    } else {
        document.getElementById('newCategoryInput').classList.add('hidden');
    }
});

document.getElementById('addNewItemBtn').addEventListener('click', () => {
    currentEditId = null; 
    document.getElementById('modalTitle').innerText = 'Add New Item';
    document.getElementById('saveItemBtn').innerText = 'Save Item';
    
    document.getElementById('itemNameInput').value = '';
    document.getElementById('itemPriceInput').value = '';
    
    populateCategoryDropdown(); 
    
    imagePreview.style.backgroundImage = 'none';
    imagePreviewText.style.display = 'block';
    itemImageInput.value = '';
    selectedImageFile = null;
    
    itemModal.classList.remove('hidden');
});

window.editMenuItem = function(id) {
    const item = allMenuItems.find(i => i.id === id); 
    if(!item) return;

    currentEditId = id; 
    selectedImageFile = null; 

    document.getElementById('modalTitle').innerText = 'Edit Item';
    document.getElementById('saveItemBtn').innerText = 'Update Item';
    document.getElementById('itemNameInput').value = item.name;
    document.getElementById('itemPriceInput').value = item.price;
    
    populateCategoryDropdown(item.category); 

    if(item.image) {
        imagePreview.style.backgroundImage = `url(${item.image})`;
        imagePreviewText.style.display = 'none';
    } else {
        imagePreview.style.backgroundImage = 'none';
        imagePreviewText.style.display = 'block';
    }

    itemImageInput.value = ''; 
    itemModal.classList.remove('hidden');
}

document.getElementById('closeModalBtn').addEventListener('click', () => {
    itemModal.classList.add('hidden');
});

imagePreview.addEventListener('click', () => itemImageInput.click());
itemImageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        selectedImageFile = file;
        const reader = new FileReader();
        reader.onload = function(e) {
            imagePreview.style.backgroundImage = `url(${e.target.result})`;
            imagePreviewText.style.display = 'none'; 
        }
        reader.readAsDataURL(file);
    }
});

document.getElementById('saveItemBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveItemBtn');
    const name = document.getElementById('itemNameInput').value.trim();
    const price = document.getElementById('itemPriceInput').value.trim();
    
    let category = document.getElementById('itemCategoryInput').value;
    if(category === 'NEW_CATEGORY') {
        category = document.getElementById('newCategoryInput').value.trim();
        if(!category) {
            alert("Bhai nayi category ka naam toh daal!");
            return;
        }
    }

    if(!name || !price) {
        alert("Bhai Name aur Price zaroori hain!");
        return;
    }

    btn.innerText = "Saving... ⏳";
    btn.disabled = true;

    try {
        let imageUrl = null;

        if(selectedImageFile) {
            const imageRef = ref(storage, `menu_images/${Date.now()}_${selectedImageFile.name}`);
            await uploadBytes(imageRef, selectedImageFile);
            imageUrl = await getDownloadURL(imageRef);
        }

        if(currentEditId) {
            let updateData = {
                name: name,
                price: Number(price),
                category: category
            };
            if(imageUrl) updateData.image = imageUrl;
            
            await updateDoc(doc(db, "menu_items", currentEditId), updateData);
            
        } else {
            await addDoc(collection(db, "menu_items"), {
                name: name,
                price: Number(price),
                category: category,
                image: imageUrl,
                inStock: true
            });
        }
        itemModal.classList.add('hidden');
        loadMenuData(); 

    } catch (e) {
        console.error("Save error: ", e);
        alert("Error saving item! Internet check karo.");
    } finally {
        btn.innerText = currentEditId ? "Update Item" : "Save Item";
        btn.disabled = false;
    }
});
// Tab switcher update taaki expense load ho
window.switchTab = function(tabName) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    
    document.getElementById(tabName + 'Section').classList.add('active');
    event.target.classList.add('active');

    if(tabName === 'menu') loadMenuData();
    if(tabName === 'expense') loadAdminExpenses('days', 1);
}

// Expense fetcher
window.loadAdminExpenses = async function(filterType, filterValue, btnContext) {
    if(btnContext) {
        document.querySelectorAll('#expenseSection .filter-btn').forEach(b => b.classList.remove('active'));
        btnContext.classList.add('active');
    }

    const tbody = document.getElementById('expenseTableBody');
    tbody.innerHTML = '<tr><td colspan="3" class="loading">Loading...</td></tr>';
    
    try {
        const querySnapshot = await getDocs(collection(db, "daily_expenses"));
        let filteredExpenses = [];
        const now = new Date();

        querySnapshot.forEach((docSnap) => {
            let exp = docSnap.data();
            const expDate = new Date(exp.timestamp);
            const diffDays = Math.ceil(Math.abs(now - expDate) / (1000 * 60 * 60 * 24)); 
            
            if (filterType === 'days') {
                if (filterValue === 1 && expDate.toDateString() === now.toDateString()) filteredExpenses.push(exp);
                else if (filterValue !== 1 && diffDays <= filterValue) filteredExpenses.push(exp);
            }
        });

        filteredExpenses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        tbody.innerHTML = '';
        let totalExp = 0;

        if(filteredExpenses.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center" style="padding:20px; color:gray;">No expenses found.</td></tr>';
        } else {
            filteredExpenses.forEach(exp => {
                totalExp += Number(exp.amount);
                let timeString = new Date(exp.timestamp).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
                tbody.innerHTML += `
                    <tr>
                        <td style="color:#94a3b8;">${timeString}</td>
                        <td style="font-weight:bold; color:white; text-transform: capitalize;">${exp.note}</td>
                        <td class="text-right" style="color:#ef4444; font-weight:bold;">₹${exp.amount}</td>
                    </tr>
                `;
            });
        }
        document.getElementById('totalExpenseBox').innerText = `₹${totalExp}`;
    } catch (error) {
        console.error(error);
        tbody.innerHTML = '<tr><td colspan="3" style="color:red; text-align:center;">Error loading expenses.</td></tr>';
    }
}
// ==========================================
// EXPENSE LOGIC & REFRESH BUTTON
// ==========================================

// Tab switcher logic (Ensure expense is handled)
window.switchTab = function(tabName) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    
    document.getElementById(tabName + 'Section').classList.add('active');
    event.target.classList.add('active');

    if(tabName === 'menu') loadMenuData();
    if(tabName === 'expense') {
        if(document.getElementById('expenseDateSearch')) document.getElementById('expenseDateSearch').value = '';
        loadAdminExpenses('days', 1, document.querySelector('#expenseSection .filter-btn[data-val="1"]'));
    }
}

window.loadAdminExpenses = async function(filterType, filterValue, btnContext) {
    if(btnContext) {
        document.querySelectorAll('#expenseSection .filter-btn').forEach(b => b.classList.remove('active'));
        btnContext.classList.add('active');
        if(document.getElementById('expenseDateSearch')) document.getElementById('expenseDateSearch').value = ''; // Reset date if button clicked
    }

    const tbody = document.getElementById('expenseTableBody');
    if(!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="4" class="loading">Loading Expenses... ☁️</td></tr>';
    
    try {
        const querySnapshot = await getDocs(collection(db, "daily_expenses"));
        let filteredExpenses = [];
        const now = new Date();

        querySnapshot.forEach((docSnap) => {
            let exp = docSnap.data();
            exp.id = docSnap.id;
            const expDate = new Date(exp.timestamp);
            const diffDays = Math.ceil(Math.abs(now - expDate) / (1000 * 60 * 60 * 24)); 
            
            if (filterType === 'days') {
                if (filterValue === 1 && expDate.toDateString() === now.toDateString()) {
                    filteredExpenses.push(exp);
                }
                else if (filterValue !== 1 && diffDays <= filterValue) {
                    filteredExpenses.push(exp);
                }
            } else if (filterType === 'date') {
                // NAYA: Particular date ka logic
                if (expDate.toDateString() === new Date(filterValue).toDateString()) {
                    filteredExpenses.push(exp);
                }
            }
        });

        // Naye kharche sabse upar
        filteredExpenses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        tbody.innerHTML = '';
        let totalExp = 0;

        if(filteredExpenses.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center" style="padding:20px; color:gray;">No expenses found for this date.</td></tr>';
        } else {
            filteredExpenses.forEach(exp => {
                totalExp += Number(exp.amount);
                let timeString = new Date(exp.timestamp).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
                tbody.innerHTML += `
                    <tr>
                        <td style="color:#94a3b8;">${timeString}</td>
                        <td style="font-weight:bold; color:white; text-transform: capitalize;">${exp.note}</td>
                        <td class="text-right" style="color:#ef4444; font-weight:bold;">₹${exp.amount}</td>
                        <td class="text-center">
                            <button class="btn btn-danger" onclick="deleteExpense('${exp.id}')" style="padding: 5px 10px; font-size: 0.9rem;">🗑️</button>
                        </td>
                    </tr>
                `;
            });
        }
        document.getElementById('totalExpenseBox').innerText = `₹${totalExp}`;
    } catch (error) {
        console.error(error);
        tbody.innerHTML = '<tr><td colspan="4" style="color:red; text-align:center;">Error loading expenses. Internet check karo.</td></tr>';
    }
}

// NAYA: Date Picker Event Listener
const expenseDateSearch = document.getElementById('expenseDateSearch');
if(expenseDateSearch) {
    expenseDateSearch.addEventListener('change', (e) => {
        if (e.target.value) {
            // Un-highlight normal buttons
            document.querySelectorAll('#expenseSection .filter-btn').forEach(b => b.classList.remove('active'));
            loadAdminExpenses('date', e.target.value, null);
        }
    });
}

// NAYA: Refresh Button Click Listener
const refreshExpBtn = document.getElementById('refreshExpenseBtn');
if(refreshExpBtn) {
    refreshExpBtn.addEventListener('click', async (e) => {
        const btn = e.target;
        btn.innerText = "🔄..."; 
        btn.disabled = true;
        
        const activeBtn = document.querySelector('#expenseSection .filter-btn.active');
        const dateVal = document.getElementById('expenseDateSearch').value;
        
        if(activeBtn) {
            await loadAdminExpenses('days', parseInt(activeBtn.dataset.val));
        } else if(dateVal) {
            await loadAdminExpenses('date', dateVal);
        } else {
            await loadAdminExpenses('days', 1);
        }
        
        btn.innerText = "🔄 Refresh Data";
        btn.disabled = false;
    });
}

// ==========================================
// PWA INSTALL LOGIC (APP DOWNLOAD)
// ==========================================
let deferredPrompt;
const pwaBtn = document.getElementById('pwaDownloadBtn');

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(() => {
        console.log("Service Worker Active!");
    }).catch(err => console.log("SW Error:", err));
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); 
    deferredPrompt = e; 
    if(pwaBtn) pwaBtn.style.display = 'block'; 
});

if(pwaBtn) {
    pwaBtn.addEventListener('click', () => {
        if (deferredPrompt) {
            deferredPrompt.prompt(); 
            deferredPrompt.userChoice.then((choiceResult) => {
                if (choiceResult.outcome === 'accepted') {
                    console.log('App Installed!');
                }
                deferredPrompt = null;
                pwaBtn.style.display = 'none'; 
            });
        }
    });
}

window.addEventListener('appinstalled', () => {
    if(pwaBtn) pwaBtn.style.display = 'none';
});

// ==========================================
// EXPENSE DELETE LOGIC
// ==========================================
window.deleteExpense = async function(expenseId) {
    if(!confirm("Pakka delete karna hai ye kharcha?")) return;
    
    try {
        await deleteDoc(doc(db, "daily_expenses", expenseId));
        
        const activeBtn = document.querySelector('#expenseSection .filter-btn.active');
        const dateVal = document.getElementById('expenseDateSearch').value;
        
        if(activeBtn) {
            await loadAdminExpenses('days', parseInt(activeBtn.dataset.val));
        } else if (dateVal) {
            await loadAdminExpenses('date', dateVal);
        } else {
            await loadAdminExpenses('days', 1);
        }
    } catch (error) {
        console.error("Delete error: ", error);
        alert("Delete nahi hua. Internet check kar!");
    }
}
