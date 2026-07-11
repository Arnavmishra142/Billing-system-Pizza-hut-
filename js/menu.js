import { db } from './firebase-config.js';
import { collection, getDocs, addDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

let allItems = [];
let categories = ['All'];
let currentCategory = 'All';

document.addEventListener('DOMContentLoaded', () => {
    fetchMenuFromCloud();
    setupQuickAddPopups();
    setupSearch();
});

// 1. FIREBASE SE MENU LAO
export async function fetchMenuFromCloud() {
    const grid = document.getElementById('itemsGrid');
    if(!grid) return;
    
    grid.innerHTML = '<div style="padding:20px; color:gray; width:100%; text-align:center;">Cloud se Menu aa raha hai... ☁️⏳</div>';
    
    try {
        const querySnapshot = await getDocs(collection(db, "menu_items"));
        allItems = [];
        let catSet = new Set(['All']);

        querySnapshot.forEach((docSnap) => {
            let item = docSnap.data();
            item.id = docSnap.id;
            if(item.inStock !== false) {
                allItems.push(item);
                if(item.category) catSet.add(item.category);
            }
        });

        const getBaseName = (name) => name.includes('(') ? name.split('(')[0].trim().toLowerCase() : name.trim().toLowerCase();

        allItems.sort((a, b) => {
            const baseA = getBaseName(a.name);
            const baseB = getBaseName(b.name);

            if (baseA < baseB) return -1;
            if (baseA > baseB) return 1;

            return (Number(a.price) || 0) - (Number(b.price) || 0);
        });

        categories = Array.from(catSet);

        categories.sort((a, b) => {
            if (a === 'All') return -1;
            if (b === 'All') return 1;
            return a.localeCompare(b);
        });
        
        loadCategories();
        loadItems('All');
        updateDatalist(); 
        
    } catch (e) {
        console.error("Menu fetch error:", e);
        grid.innerHTML = '<div style="color:red; padding:20px;">Menu load fail hua. Internet check karo!</div>';
    }
}

// 2. RENDER CATEGORIES
function loadCategories() {
    const list = document.getElementById('categoryList');
    if(!list) return;
    list.innerHTML = ''; 

    categories.forEach(cat => {
        let btn = document.createElement('button');
        btn.className = 'category-btn';
        btn.innerText = cat;
        
        btn.style.width = "100%";
        btn.style.padding = "15px";
        btn.style.marginBottom = "5px";
        btn.style.border = "none";
        btn.style.textAlign = "left";
        btn.style.background = cat === currentCategory ? "#3b82f6" : "transparent";
        btn.style.color = cat === currentCategory ? "white" : "#4b5563";
        btn.style.cursor = "pointer";
        btn.style.borderRadius = "8px";
        
        btn.onclick = () => {
            currentCategory = cat;
            loadCategories(); 
            loadItems(cat);
        };
        list.appendChild(btn);
    });
}

// ==========================================
// ITEM CARD BANANA (NO IMAGE - COMPACT)
// ==========================================
function createItemCard(item) {
    let card = document.createElement('div');
    card.className = 'item-card';
    card.dataset.id = item.id;

    // ✅ IMAGE HATA DIYA - SIRF NAME + PRICE
    card.innerHTML = `
        <div class="item-remove-badge" title="Remove from cart">✕</div>
        <div class="item-qty-badge">0</div>
        <div class="item-title" style="padding:15px 10px 5px; font-weight:900; font-size:1.1rem; color:#f1f5f9;">${item.name}</div>
        <div class="item-price" style="padding:5px 10px 15px; color:#34d399; font-weight:800; font-size:1.3rem;">₹${item.price}</div>
    `;

    card.onclick = () => {
        window.dispatchEvent(new CustomEvent('add-to-cart', { detail: item }));
    };

    // ✕ remove badge — top-left, instantly removes item from cart
    const removeBadge = card.querySelector('.item-remove-badge');
    removeBadge.onclick = (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('set-cart-quantity', { detail: { id: item.id, name: item.name, price: item.price, qty: 0 } }));
    };

    // Qty badge — top-right, opens custom modal (no browser prompt)
    const badge = card.querySelector('.item-qty-badge');
    badge.onclick = (e) => {
        e.stopPropagation();
        const currentQty = getCurrentCartItems().find(i => i.id === item.id)?.qty || 0;
        openQtyEditModal(item, currentQty);
    };

    return card;
}

// ==========================================
// CART SE SYNC
// ==========================================
function getCurrentCartItems() {
    const activeTableNameEl = document.getElementById('activeTableName');
    if (!activeTableNameEl) return [];
    const tableName = activeTableNameEl.innerText;
    const customer = activeTableNameEl.dataset.customer || 'C1';
    try {
        const data = localStorage.getItem(`cart_${tableName}_${customer}`);
        return data ? JSON.parse(data) : [];
    } catch (e) {
        return [];
    }
}

// Custom qty-edit modal — same UX as price-edit modal
function openQtyEditModal(item, currentQty) {
    const modal    = document.getElementById('qtyEditModal');
    const nameEl   = document.getElementById('qtyEditItemName');
    const inputEl  = document.getElementById('newQtyInput');
    const saveBtn  = document.getElementById('saveQtyBtn');
    const cancelBtn = document.getElementById('cancelQtyEditBtn');

    nameEl.textContent = item.name;
    inputEl.value = currentQty > 0 ? currentQty : 1;
    modal.classList.remove('hidden');
    setTimeout(() => { inputEl.focus(); inputEl.select(); }, 80);

    const handleSave = () => {
        const newQty = parseInt(inputEl.value, 10);
        if (!isNaN(newQty) && newQty >= 0) {
            window.dispatchEvent(new CustomEvent('set-cart-quantity', {
                detail: { id: item.id, name: item.name, price: item.price, qty: newQty }
            }));
        }
        modal.classList.add('hidden');
        cleanup();
    };
    const handleCancel = () => { modal.classList.add('hidden'); cleanup(); };
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
}

function syncItemBadges() {
    const qtyMap = {};
    getCurrentCartItems().forEach(i => { qtyMap[i.id] = i.qty; });

    document.querySelectorAll('.item-card').forEach(card => {
        const qty = qtyMap[card.dataset.id] || 0;
        const badge = card.querySelector('.item-qty-badge');
        if (badge) badge.innerText = qty;
        card.classList.toggle('in-cart', qty > 0);
    });
}

window.addEventListener('cart-updated', syncItemBadges);
window.addEventListener('load-table-cart', syncItemBadges);

// 3. RENDER ITEMS IN GRID
function loadItems(categoryFilter) {
    const grid = document.getElementById('itemsGrid');
    if(!grid) return;
    grid.innerHTML = '';

    let itemsToShow = categoryFilter === 'All' ? allItems : allItems.filter(item => item.category === categoryFilter);

    if(itemsToShow.length === 0) {
        grid.innerHTML = '<div style="padding:20px; color:gray;">Is category me item nahi hai.</div>';
        return;
    }

    itemsToShow.forEach(item => {
        grid.appendChild(createItemCard(item));
    });

    syncItemBadges();
}

// 4. QUICK ADD LOGIC
function setupQuickAddPopups() {
    const mainBtn = document.getElementById('qckAddBtn');
    const choiceModal = document.getElementById('quickAddChoiceModal');
    const globalModal = document.getElementById('globalMenuModal');
    
    if(!mainBtn || !choiceModal || !globalModal) return;

    mainBtn.onclick = () => choiceModal.classList.remove('hidden');
    document.getElementById('closeChoiceModalBtn').onclick = () => choiceModal.classList.add('hidden');

    document.getElementById('btnAddToMenu').onclick = () => {
        choiceModal.classList.add('hidden');
        globalModal.classList.remove('hidden');
    };
    
    document.getElementById('cancelGlobalBtn').onclick = () => globalModal.classList.add('hidden');

    document.getElementById('btnAddToBillOnly').onclick = () => {
        choiceModal.classList.add('hidden');
        document.getElementById('billOnlyModal').classList.remove('hidden');
    };
    document.getElementById('cancelBillOnlyBtn').onclick = () => document.getElementById('billOnlyModal').classList.add('hidden');

    document.getElementById('saveGlobalBtn').onclick = async () => {
        const name = document.getElementById('globalItemName').value.trim();
        const price = document.getElementById('globalItemPrice').value.trim();
        const cat = document.getElementById('globalItemCategory').value.trim() || 'Custom Item';

        if(!name || !price) {
            alert("Name aur Price zaroori hai!");
            return;
        }

        const btn = document.getElementById('saveGlobalBtn');
        btn.innerText = "Saving...⏳";
        btn.disabled = true;

        try {
            await addDoc(collection(db, "menu_items"), {
                name: name,
                price: Number(price),
                category: cat,
                image: null,
                inStock: true
            });

            document.getElementById('globalItemName').value = '';
            document.getElementById('globalItemPrice').value = '';
            document.getElementById('globalItemCategory').value = '';
            
            globalModal.classList.add('hidden');
            
            await fetchMenuFromCloud();

        } catch(e) {
            console.error("Save error:", e);
            alert("Save nahi hua!");
        } finally {
            btn.innerText = "Save to Menu";
            btn.disabled = false;
        }
    };

    const saveToBillBtn = document.getElementById('saveToBillBtn'); 
    
    if (saveToBillBtn) {
        saveToBillBtn.onclick = () => {
            const name = document.getElementById('tempItemName').value.trim(); 
            const price = document.getElementById('tempItemPrice').value.trim(); 

            if (!name || !price) {
                alert("Bhai naam aur price dono daalna zaroori hai!");
                return;
            }

            const customItem = {
                id: 'CUSTOM_' + Date.now(), 
                name: name,
                price: Number(price)
            };

            window.dispatchEvent(new CustomEvent('add-custom-item-to-bill', { detail: customItem }));

            document.getElementById('tempItemName').value = '';
            document.getElementById('tempItemPrice').value = '';
            document.getElementById('billOnlyModal').classList.add('hidden');
        };
    }
}

function updateDatalist() {
    const datalist = document.getElementById('categoryOptions');
    if(!datalist) return;
    datalist.innerHTML = '';
    categories.forEach(cat => {
        if(cat !== 'All') datalist.innerHTML += `<option value="${cat}">`;
    });
}

// ==========================================
// SEARCH LOGIC
// ==========================================
function setupSearch() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase().trim();
        const grid = document.getElementById('itemsGrid');
        grid.innerHTML = '';

        if (searchTerm === '') {
            loadItems(currentCategory);
            return;
        }

        let searchedItems = allItems.filter(item => 
            item.name.toLowerCase().includes(searchTerm)
        );

        if (searchedItems.length === 0) {
            grid.innerHTML = '<div style="padding:20px; color:gray; width:100%; text-align:center;">Koi item nahi mila bhai.</div>';
            return;
        }

        searchedItems.forEach(item => {
            grid.appendChild(createItemCard(item));
        });

        syncItemBadges();
    });
}
