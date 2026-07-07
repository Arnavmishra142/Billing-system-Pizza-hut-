import { db, storage } from './firebase-config.js';
import { collection, getDocs, doc, deleteDoc, addDoc, updateDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
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

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('adminLoggedIn');
    document.getElementById('adminContent').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('pinInput').value = ''; 
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
// SALES LOGIC (UNTOUCHED)
// ==========================================
let allSales = []; 
async function fetchAllSalesFromDB() {
    try {
        const querySnapshot = await getDocs(collection(db, "sales_history"));
        allSales = [];
        querySnapshot.forEach((doc) => {
            let data = doc.data(); data.id = doc.id; allSales.push(data);
        });
    } catch (error) { console.error(error); }
}

window.loadSalesData = async function(filterType, filterValue) {
    document.getElementById('salesTableBody').innerHTML = '<tr><td colspan="3" class="loading">Loading...</td></tr>';
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
    let totalRevenue = 0; let itemStats = {}; 
    const billsTbody = document.getElementById('billsTableBody'); billsTbody.innerHTML = '';

    if (filteredSales.length === 0) {
        billsTbody.innerHTML = '<tr><td colspan="4" class="text-center" style="padding:20px; color:#64748b;">No bills found.</td></tr>';
    } else {
        filteredSales.forEach(sale => {
            const saleTotal = Number(sale.total) || 0; totalRevenue += saleTotal;
            (sale.items || []).forEach(item => {
                const itemName = item.name || 'Unknown Item';
                if (!itemStats[itemName]) itemStats[itemName] = { qty: 0, rev: 0 };
                itemStats[itemName].qty += Number(item.qty) || 0;
                itemStats[itemName].rev += (Number(item.qty) || 0) * (Number(item.price) || 0);
            });

            let timeString = sale.timestamp ? new Date(sale.timestamp).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : 'N/A';
            let tableName = sale.table || 'Unknown';
            if(!tableName.includes('Parcel')) tableName = `${tableName} [${sale.customer || 'C1'}]`;
            
            billsTbody.innerHTML += `
                <tr>
                    <td style="color:#94a3b8; white-space:nowrap;">${timeString}</td>
                    <td style="font-weight:bold; color:white; white-space:nowrap;">${tableName}</td>
                    <td class="text-right" style="color:#10b981; font-weight:bold;">₹${saleTotal.toFixed(2)}</td>
                    <td class="text-center"><button class="btn btn-danger" style="padding: 6px 12px; font-size: 0.9rem;" onclick="deleteSale('${sale.id}')">🗑️</button></td>
                </tr>
            `;
        });
    }

    document.getElementById('totalRevenueBox').innerText = `₹${totalRevenue.toFixed(2)}`;
    document.getElementById('totalOrdersBox').innerText = filteredSales.length;

    const salesTbody = document.getElementById('salesTableBody'); salesTbody.innerHTML = '';
    let sortedItems = Object.keys(itemStats).map(key => ({ name: key, qty: itemStats[key].qty, rev: itemStats[key].rev })).sort((a, b) => b.qty - a.qty);

    if (sortedItems.length === 0) salesTbody.innerHTML = '<tr><td colspan="3" class="text-center" style="padding:30px; color:#64748b;">No items sold.</td></tr>';
    else sortedItems.forEach(stat => {
        salesTbody.innerHTML += `<tr><td style="font-weight:bold; color:white;">${stat.name}</td><td class="text-right" style="color:#38bdf8; font-weight:bold;">${stat.qty}</td><td class="text-right" style="color:#10b981; font-weight:bold;">₹${stat.rev.toFixed(2)}</td></tr>`;
    });
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
// ASLI MENU MANAGEMENT (WITH EDIT FEATURE)
// ==========================================
const itemModal = document.getElementById('itemModal');
const imagePreview = document.getElementById('imagePreview');
const itemImageInput = document.getElementById('itemImageInput');
const imagePreviewText = document.getElementById('imagePreviewText');

let selectedImageFile = null; 
let currentEditId = null; 
let allMenuItems = []; 

// 1. FETCH MENU FROM FIREBASE
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

// ==========================================
// DYNAMIC CATEGORY LOGIC
// ==========================================
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

// ==========================================
// MODAL OPENERS (ADD & EDIT) - THE MISSING PIECE!
// ==========================================
document.getElementById('addNewItemBtn').addEventListener('click', () => {
    currentEditId = null; 
    document.getElementById('modalTitle').innerText = 'Add New Item';
    document.getElementById('saveItemBtn').innerText = 'Save Item';
    
    document.getElementById('itemNameInput').value = '';
    document.getElementById('itemPriceInput').value = '';
    
    populateCategoryDropdown(); // Dropdown load karo
    
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
    
    populateCategoryDropdown(item.category); // Purani category select karo

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

// 6. CLOSE MODAL
document.getElementById('closeModalBtn').addEventListener('click', () => {
    itemModal.classList.add('hidden');
});

// 7. IMAGE PREVIEW LOGIC
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

// 8. SAVE & UPDATE LOGIC
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
// ==========================================
// 🔴 TEMPORARY MAGIC BULK UPLOAD SCRIPT 🔴
// ==========================================
const bulkMenuItems = [
    // PIZZA
    { name: "Margherita Pizza (Regular)", price: 75, category: "Pizza" },
    { name: "Margherita Pizza (Medium)", price: 160, category: "Pizza" },
    { name: "Margherita Pizza (Large)", price: 240, category: "Pizza" },
    { name: "O.C.T Pizza (Regular)", price: 100, category: "Pizza" },
    { name: "O.C.T Pizza (Medium)", price: 200, category: "Pizza" },
    { name: "O.C.T Pizza (Large)", price: 300, category: "Pizza" },
    { name: "Cheese & Paneer Pizza (Regular)", price: 110, category: "Pizza" },
    { name: "Cheese & Paneer Pizza (Medium)", price: 210, category: "Pizza" },
    { name: "Cheese & Paneer Pizza (Large)", price: 300, category: "Pizza" },
    { name: "Italiano Pizza (Regular)", price: 120, category: "Pizza" },
    { name: "Italiano Pizza (Medium)", price: 210, category: "Pizza" },
    { name: "Italiano Pizza (Large)", price: 320, category: "Pizza" },
    { name: "Farmhouse Pizza (Regular)", price: 120, category: "Pizza" },
    { name: "Farmhouse Pizza (Medium)", price: 250, category: "Pizza" },
    { name: "Farmhouse Pizza (Large)", price: 350, category: "Pizza" },
    { name: "Peri Peri Pizza (Regular)", price: 130, category: "Pizza" },
    { name: "Peri Peri Pizza (Medium)", price: 240, category: "Pizza" },
    { name: "Peri Peri Pizza (Large)", price: 340, category: "Pizza" },
    { name: "Cheese & Mushroom Pizza (Regular)", price: 140, category: "Pizza" },
    { name: "Cheese & Mushroom Pizza (Medium)", price: 220, category: "Pizza" },
    { name: "Cheese & Mushroom Pizza (Large)", price: 320, category: "Pizza" },
    { name: "Cheese Overload Pizza (Regular)", price: 140, category: "Pizza" },
    { name: "Cheese Overload Pizza (Medium)", price: 260, category: "Pizza" },
    { name: "Cheese Overload Pizza (Large)", price: 360, category: "Pizza" },
    { name: "Paneer Schezwan Pizza (Regular)", price: 150, category: "Pizza" },
    { name: "Paneer Schezwan Pizza (Medium)", price: 260, category: "Pizza" },
    { name: "Paneer Schezwan Pizza (Large)", price: 360, category: "Pizza" },
    { name: "Country Pizza (Regular)", price: 150, category: "Pizza" },
    { name: "Country Pizza (Medium)", price: 260, category: "Pizza" },
    { name: "Country Pizza (Large)", price: 360, category: "Pizza" },
    { name: "Paneer Makhani Pizza (Regular)", price: 150, category: "Pizza" },
    { name: "Paneer Makhani Pizza (Medium)", price: 260, category: "Pizza" },
    { name: "Paneer Makhani Pizza (Large)", price: 360, category: "Pizza" },
    { name: "Tandoori Pizza (Regular)", price: 150, category: "Pizza" },
    { name: "Tandoori Pizza (Medium)", price: 270, category: "Pizza" },
    { name: "Tandoori Pizza (Large)", price: 380, category: "Pizza" },
    { name: "Paneer Tikka Pizza (Regular)", price: 160, category: "Pizza" },
    { name: "Paneer Tikka Pizza (Medium)", price: 280, category: "Pizza" },
    { name: "Paneer Tikka Pizza (Large)", price: 390, category: "Pizza" },

    // EXTRA TOPPING
    { name: "Extra Cheese", price: 50, category: "Extra Topping" },
    { name: "Extra Veggies", price: 50, category: "Extra Topping" },

    // SANDWICH
    { name: "Classic Sandwich", price: 60, category: "Sandwich" },
    { name: "Maxican Sandwich", price: 70, category: "Sandwich" },
    { name: "Cheese Overload Sandwich", price: 90, category: "Sandwich" },
    { name: "Paneer Sandwich", price: 110, category: "Sandwich" },

    // FRENCH FRIES
    { name: "French Fry", price: 50, category: "French Fries" },
    { name: "Masala Fresh Fry", price: 60, category: "French Fries" },
    { name: "Peri Peri Fry", price: 70, category: "French Fries" },

    // BURGER
    { name: "Veg Burger", price: 50, category: "Burger" },
    { name: "Maxican Burger", price: 60, category: "Burger" },
    { name: "Cheese Burger", price: 70, category: "Burger" },
    { name: "Double Decker Burger", price: 100, category: "Burger" },

    // CHINESE STARTER
    { name: "Soya Chilli (Half)", price: 70, category: "Chinese Starter" },
    { name: "Soya Chilli (Full)", price: 150, category: "Chinese Starter" },
    { name: "Veg Manchurian (Half)", price: 80, category: "Chinese Starter" },
    { name: "Veg Manchurian (Full)", price: 150, category: "Chinese Starter" },
    { name: "Honey Chilli Patato (Half)", price: 90, category: "Chinese Starter" },
    { name: "Honey Chilli Patato (Full)", price: 160, category: "Chinese Starter" },
    { name: "Chilli Patato (Half)", price: 90, category: "Chinese Starter" },
    { name: "Chilli Patato (Full)", price: 160, category: "Chinese Starter" },
    { name: "Crispy Corn (Half)", price: 90, category: "Chinese Starter" },
    { name: "Crispy Corn (Full)", price: 170, category: "Chinese Starter" },
    { name: "Paneer Garlic (Half)", price: 90, category: "Chinese Starter" },
    { name: "Paneer Garlic (Full)", price: 180, category: "Chinese Starter" },
    { name: "Panner Chilli (Half)", price: 100, category: "Chinese Starter" },
    { name: "Panner Chilli (Full)", price: 180, category: "Chinese Starter" },
    { name: "Baby Corn Chilli (Half)", price: 100, category: "Chinese Starter" },
    { name: "Baby Corn Chilli (Full)", price: 180, category: "Chinese Starter" },
    { name: "Mashroom Salt And Chilli (Half)", price: 100, category: "Chinese Starter" },
    { name: "Mashroom Salt And Chilli (Full)", price: 180, category: "Chinese Starter" },
    { name: "Mashroom Chilli (Half)", price: 100, category: "Chinese Starter" },
    { name: "Mashroom Chilli (Full)", price: 180, category: "Chinese Starter" },

    // NOODLES
    { name: "Hakka Noodles (Half)", price: 60, category: "Noodles" },
    { name: "Hakka Noodles (Full)", price: 110, category: "Noodles" },
    { name: "Singapuri Noodles (Half)", price: 70, category: "Noodles" },
    { name: "Singapuri Noodles (Full)", price: 110, category: "Noodles" },
    { name: "Schezwan Noodles (Half)", price: 80, category: "Noodles" },
    { name: "Schezwan Noodles (Full)", price: 120, category: "Noodles" },
    { name: "Hong Kong Noodles (Half)", price: 90, category: "Noodles" },
    { name: "Hong Kong Noodles (Full)", price: 130, category: "Noodles" },
    { name: "Paneer Noodles (Half)", price: 100, category: "Noodles" },
    { name: "Paneer Noodles (Full)", price: 150, category: "Noodles" },

    // FRIED RICE
    { name: "Veg Fried Rice (Half)", price: 50, category: "Fried Rice" },
    { name: "Veg Fried Rice (Full)", price: 90, category: "Fried Rice" },
    { name: "Schezwan Fried Rice (Half)", price: 70, category: "Fried Rice" },
    { name: "Schezwan Fried Rice (Full)", price: 110, category: "Fried Rice" },
    { name: "Paneer Fried Rice (Half)", price: 80, category: "Fried Rice" },
    { name: "Paneer Fried Rice (Full)", price: 140, category: "Fried Rice" },

    // SOUP
    { name: "Veg Manchow Soup", price: 60, category: "Soup" },
    { name: "Golden Garlic Soup", price: 50, category: "Soup" },
    { name: "Hot & Sour Soup", price: 55, category: "Soup" },
    { name: "Lemon Coriander Soup", price: 40, category: "Soup" },
    { name: "Sweet Corn Soup", price: 45, category: "Soup" },

    // ROLL
    { name: "Spring Roll", price: 60, category: "Roll" },
    { name: "Kathi Roll", price: 50, category: "Roll" },
    { name: "Cheese Corn Roll", price: 90, category: "Roll" },
    { name: "Paneer Roll", price: 100, category: "Roll" },

    // PAV BHAJI
    { name: "Pav Bhaji", price: 60, category: "Pav Bhaji" },
    { name: "Extra Pav (1 Pcs)", price: 20, category: "Pav Bhaji" },
    { name: "Extra Bhaji", price: 20, category: "Pav Bhaji" },

    // MAGGIE
    { name: "Masala Maggie", price: 50, category: "Maggie" },
    { name: "Paneer Maggie", price: 70, category: "Maggie" },
    { name: "Sweetcorn Maggie", price: 70, category: "Maggie" },
    { name: "Cheese Maggie", price: 70, category: "Maggie" },

    // COFFEE
    { name: "Espresso (Cold Coffee)", price: 70, category: "Coffee" },
    { name: "Americano (Cold Coffee)", price: 80, category: "Coffee" },
    { name: "Coffee", price: 40, category: "Coffee" },

    // SHAKE
    { name: "Chocolate Shake", price: 80, category: "Shake" },
    { name: "Oreo Shake", price: 90, category: "Shake" },
    { name: "Kit-Kat Shake", price: 90, category: "Shake" },
    { name: "Vanilla Shake", price: 90, category: "Shake" },
    { name: "Strawberry Shake", price: 90, category: "Shake" },
    { name: "Pineapple Shake", price: 90, category: "Shake" },
    { name: "Butterscotch Shake", price: 90, category: "Shake" },

    // MOMO'S
    { name: "Veg Steamed Momo (Half)", price: 50, category: "Momo's" },
    { name: "Veg Steamed Momo (Full)", price: 90, category: "Momo's" },
    { name: "Paneer Steamed Momo (Half)", price: 70, category: "Momo's" },
    { name: "Paneer Steamed Momo (Full)", price: 130, category: "Momo's" },
    { name: "Fried Veg Momo (Half)", price: 60, category: "Momo's" },
    { name: "Fried Veg Momo (Full)", price: 110, category: "Momo's" },
    { name: "Fried Panner Momo (Half)", price: 80, category: "Momo's" },
    { name: "Fried Panner Momo (Full)", price: 140, category: "Momo's" },
    { name: "Veg Kurkure Momo (Half)", price: 70, category: "Momo's" },
    { name: "Veg Kurkure Momo (Full)", price: 120, category: "Momo's" },
    { name: "Panner Kurkure Momo (Half)", price: 90, category: "Momo's" },
    { name: "Panner Kurkure Momo (Full)", price: 140, category: "Momo's" },

    // PASTRY
    { name: "Pineapple Pastry", price: 50, category: "Pastry" },
    { name: "Strawberry Pastry", price: 50, category: "Pastry" },
    { name: "Butterscotch Pastry", price: 50, category: "Pastry" },
    { name: "White Forest Pastry", price: 50, category: "Pastry" },
    { name: "Choco Chips Pastry", price: 60, category: "Pastry" },
    { name: "Chocolate Flax Pastry", price: 60, category: "Pastry" },

    // GARLIC BREAD
    { name: "Plain Garlic Bread", price: 50, category: "Garlic Bread" },
    { name: "Stuffed Garlic Bread", price: 60, category: "Garlic Bread" },
    { name: "Cheese Garlic Bread", price: 70, category: "Garlic Bread" },

    // COMBO
    { name: "Combo: Margherita + Fries + Veg Burger + Coldrink", price: 200, category: "Combo" },
    { name: "Combo: Hakka Noodle + Veg Manchurian + Pastry + Coldrink", price: 200, category: "Combo" },

    // CAKE
    { name: "Black Forest Cake", price: 300, category: "Cake" },
    { name: "White Forest Cake", price: 350, category: "Cake" },
    { name: "Chocolate Chips Cake", price: 350, category: "Cake" },
    { name: "Chocolate Flex Cake", price: 350, category: "Cake" },
    { name: "Chocolate Munch Cake", price: 380, category: "Cake" },
    { name: "Kit-Kat Cake", price: 400, category: "Cake" },
    { name: "Chocolate Vanilla Cake", price: 300, category: "Cake" },
    { name: "Chocolate Oreo Cake", price: 300, category: "Cake" },
    { name: "Red Velvet Cake", price: 450, category: "Cake" },
    { name: "Chocolate Truffles Cake", price: 500, category: "Cake" },
    { name: "Pineapple Cake", price: 300, category: "Cake" },
    { name: "Strawberry Cake", price: 300, category: "Cake" },
    { name: "Butter Scotch Cake", price: 300, category: "Cake" },
    { name: "Mixed Fruit Cake", price: 350, category: "Cake" },
    { name: "Real Fruit Cake", price: 450, category: "Cake" },
    { name: "3D Cake", price: 750, category: "Cake" }
];

    const magicBtn = document.getElementById('magicUploadBtn');
if(magicBtn) {
    magicBtn.addEventListener('click', async () => {
        const totalItems = bulkMenuItems.length;
        const confirmUpload = confirm(`Kya tum sach mein in ${totalItems} items ko ek saath upload karna chahte ho?`);
        
        if (confirmUpload) {
            magicBtn.innerText = `PACKING ${totalItems} ITEMS... ⏳`;
            magicBtn.disabled = true;
            magicBtn.style.background = "#eab308"; // Yellow
            
            try {
                // Ek naya dibba (Batch) banao
                const batch = writeBatch(db);
                
                // Saare items dibbe mein daalo (Bina internet use kiye)
                for (let i = 0; i < totalItems; i++) {
                    const item = bulkMenuItems[i];
                    // Har item ke liye ek khali document ID banao
                    const docRef = doc(collection(db, "menu_items"));
                    
                    batch.set(docRef, {
                        name: item.name,
                        price: Number(item.price),
                        category: item.category,
                        image: null, 
                        inStock: true
                    });
                }
                
                magicBtn.innerText = "SENDING TO CLOUD... 🚀";
                
                // Pura dibba ek hi baar me Firebase bhej do!
                await batch.commit();
                
                magicBtn.style.background = "#10b981"; // Green
                magicBtn.innerText = "✅ DONE! (Now Delete Me)";
                alert(`🎉 BOOM! Ek hi shot mein saare ${totalItems} items upload ho gaye!`);
                
                loadMenuData(); 
                
            } catch (error) {
                console.error("Batch Upload Error:", error);
                magicBtn.style.background = "#ef4444"; // Red
                magicBtn.innerText = "❌ FAILED!";
                alert(`⚠️ ERROR AAYI:\n${error.message}`);
            }
        }
    });
}
