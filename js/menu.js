import { db } from './firebase-config.js';
import {
    collection, getDocs, addDoc,
    getDocsFromCache, getDocsFromServer
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

let allItems = [];
let categories = ['All'];
let currentCategory = 'All';

document.addEventListener('DOMContentLoaded', () => {
    fetchMenuFromCloud();
    setupQuickAddPopups();
    setupSearch();
});

// ── Helper: parse a Firestore snapshot into allItems + categories ──
const MENU_SORT_BASE = (name) =>
    name.includes('(') ? name.split('(')[0].trim().toLowerCase() : name.trim().toLowerCase();

function processSnapshot(querySnapshot) {
    const items = [];
    const catSet = new Set(['All']);

    querySnapshot.forEach((docSnap) => {
        const item = { ...docSnap.data(), id: docSnap.id };
        if (item.inStock !== false) {
            items.push(item);
            if (item.category) catSet.add(item.category);
        }
    });

    // Pre-compute minimum price per pizza group (= Regular price)
    // so we can sort pizza items by Regular price, not alphabetically.
    const pizzaGroupMin = {};
    items.forEach(item => {
        if ((item.category || '').toLowerCase() === 'pizza') {
            const base = MENU_SORT_BASE(item.name);
            const price = Number(item.price) || 0;
            if (!(base in pizzaGroupMin) || price < pizzaGroupMin[base]) {
                pizzaGroupMin[base] = price;
            }
        }
    });

    items.sort((a, b) => {
        const isPizzaA = (a.category || '').toLowerCase() === 'pizza';
        const isPizzaB = (b.category || '').toLowerCase() === 'pizza';
        const baseA = MENU_SORT_BASE(a.name);
        const baseB = MENU_SORT_BASE(b.name);

        // Both pizza → sort by group Regular price, then within group by price
        if (isPizzaA && isPizzaB) {
            const minA = pizzaGroupMin[baseA] || 0;
            const minB = pizzaGroupMin[baseB] || 0;
            if (minA !== minB) return minA - minB;
            if (baseA !== baseB) return baseA.localeCompare(baseB);
            return (Number(a.price) || 0) - (Number(b.price) || 0);
        }

        // Both non-pizza → alphabetical
        if (!isPizzaA && !isPizzaB) {
            if (baseA < baseB) return -1;
            if (baseA > baseB) return 1;
            return (Number(a.price) || 0) - (Number(b.price) || 0);
        }

        // Mixed → keep category alphabetical order
        return (a.category || '').toLowerCase().localeCompare((b.category || '').toLowerCase());
    });

    const cats = Array.from(catSet).sort((a, b) => {
        if (a === 'All') return -1;
        if (b === 'All') return 1;
        return a.localeCompare(b);
    });

    return { items, cats };
}

// ── Save / load menu from localStorage (instant fallback) ──
const MENU_LS_KEY = 'pos_menu_cache_v1';

function saveMenuToLS(items, cats) {
    try {
        localStorage.setItem(MENU_LS_KEY, JSON.stringify({ items, cats, ts: Date.now() }));
    } catch (e) { /* storage full? ignore */ }
}

function loadMenuFromLS() {
    try {
        const raw = localStorage.getItem(MENU_LS_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) { return null; }
}

// ── Apply data to UI ──
function applyMenuData(items, cats) {
    allItems = items;
    categories = cats;
    loadCategories();
    loadItems(currentCategory);
    updateDatalist();
    syncItemBadges();
}

// 1. FIREBASE SE MENU LAO  (two-phase: cache → network)
export async function fetchMenuFromCloud() {
    const grid = document.getElementById('itemsGrid');
    if (!grid) return;

    // ── Phase 0: localStorage instant render ──
    const cached = loadMenuFromLS();
    if (cached && cached.items && cached.items.length > 0) {
        applyMenuData(cached.items, cached.cats);
        // Show a subtle "refreshing" note instead of full spinner
        const note = document.createElement('div');
        note.id = 'menuRefreshNote';
        note.style.cssText = 'position:fixed;bottom:160px;left:50%;transform:translateX(-50%);background:#1f2937;color:#9ca3af;padding:6px 16px;border-radius:20px;font-size:0.82rem;z-index:9995;pointer-events:none;';
        note.textContent = '🔄 Syncing menu...';
        document.body.appendChild(note);
    } else {
        grid.innerHTML = '<div style="padding:20px;color:gray;width:100%;text-align:center;">Menu load ho raha hai... ☁️⏳</div>';
    }

    // ── Phase 1: Firestore IndexedDB cache (near-instant, no network) ──
    try {
        const cacheSnap = await getDocsFromCache(collection(db, "menu_items"));
        if (!cacheSnap.empty) {
            const { items, cats } = processSnapshot(cacheSnap);
            applyMenuData(items, cats);
            saveMenuToLS(items, cats);
        }
    } catch (e) {
        // No Firestore cache yet — that's fine, continue to server fetch
    }

    // ── Phase 2: Live server fetch (always runs to get fresh data) ──
    try {
        const serverSnap = await getDocsFromServer(collection(db, "menu_items"));
        const { items, cats } = processSnapshot(serverSnap);
        applyMenuData(items, cats);
        saveMenuToLS(items, cats);
    } catch (e) {
        console.error("Server fetch error:", e);
        // If we already rendered from cache, this is silent — user sees menu fine
        if (!cached || !cached.items || cached.items.length === 0) {
            grid.innerHTML = '<div style="color:#f87171;padding:20px;text-align:center;">Menu load nahi hua.<br>Internet check karo ya refresh karo.</div>';
        }
    }

    // Remove sync note
    const note = document.getElementById('menuRefreshNote');
    if (note) note.remove();
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

    // Regular item cards
    document.querySelectorAll('.item-card').forEach(card => {
        const qty = qtyMap[card.dataset.id] || 0;
        const badge = card.querySelector('.item-qty-badge');
        if (badge) badge.innerText = qty;
        card.classList.toggle('in-cart', qty > 0);
    });

    // Half-full card sides
    document.querySelectorAll('.half-full-side').forEach(side => {
        const qty = qtyMap[side.dataset.id] || 0;
        const qtyBadge    = side.querySelector('.hf-qty');
        const removeBadge = side.querySelector('.hf-remove');
        if (qtyBadge) qtyBadge.innerText = qty;
        const inCart = qty > 0;
        side.classList.toggle('in-cart', inCart);
        if (removeBadge) removeBadge.style.display = inCart ? 'flex' : 'none';
        if (qtyBadge)    qtyBadge.style.display    = inCart ? 'flex' : 'none';
    });

    // Triple card sides (Regular / Medium / Large)
    document.querySelectorAll('.triple-side').forEach(side => {
        const qty = qtyMap[side.dataset.id] || 0;
        const qtyBadge    = side.querySelector('.triple-qty');
        const removeBadge = side.querySelector('.triple-remove');
        if (qtyBadge) qtyBadge.innerText = qty;
        const inCart = qty > 0;
        side.classList.toggle('in-cart', inCart);
        if (removeBadge) removeBadge.style.display = inCart ? 'flex' : 'none';
        if (qtyBadge)    qtyBadge.style.display    = inCart ? 'flex' : 'none';
    });
}

window.addEventListener('cart-updated', syncItemBadges);
window.addEventListener('load-table-cart', syncItemBadges);

// ==========================================
// HALF / FULL VARIANT HELPERS
// ==========================================
function isHalfVariant(name) { return /\(\s*half\s*\)/i.test(name); }
function isFullVariant(name)  { return /\(\s*full\s*\)/i.test(name);  }
function getHalfFullBase(name) {
    return name.replace(/\s*\(\s*(half|full)\s*\)\s*/gi, '').trim().toLowerCase();
}
function displayBaseName(name) {
    return name.replace(/\s*\(\s*(half|full)\s*\)\s*/gi, '').trim();
}

// ==========================================
// TRIPLE (Regular / Medium / Large) HELPERS
// ==========================================
function isRegularVariant(name) { return /\(\s*regular\s*\)/i.test(name); }
function isMediumVariant(name)  { return /\(\s*medium\s*\)/i.test(name);  }
function isLargeVariant(name)   { return /\(\s*large\s*\)/i.test(name);   }
function isTripleVariant(name)  { return isRegularVariant(name) || isMediumVariant(name) || isLargeVariant(name); }
function getTripleBase(name) {
    return name.replace(/\s*\(\s*(regular|medium|large)\s*\)\s*/gi, '').trim().toLowerCase();
}
function displayTripleBaseName(name) {
    return name.replace(/\s*\(\s*(regular|medium|large)\s*\)\s*/gi, '').trim();
}

// Shared renderer — used by loadItems AND search
function renderItemsToGrid(itemsToShow, grid) {
    const processed = new Set();

    itemsToShow.forEach(item => {
        if (processed.has(item.id)) return;

        // ── Triple card: Regular / Medium / Large ──
        if (isTripleVariant(item.name)) {
            const base = getTripleBase(item.name);
            const regularItem = itemsToShow.find(i => !processed.has(i.id) && isRegularVariant(i.name) && getTripleBase(i.name) === base);
            const mediumItem  = itemsToShow.find(i => !processed.has(i.id) && isMediumVariant(i.name)  && getTripleBase(i.name) === base);
            const largeItem   = itemsToShow.find(i => !processed.has(i.id) && isLargeVariant(i.name)   && getTripleBase(i.name) === base);
            if (regularItem && mediumItem && largeItem) {
                grid.appendChild(createTripleCard(regularItem, mediumItem, largeItem));
                processed.add(regularItem.id);
                processed.add(mediumItem.id);
                processed.add(largeItem.id);
                return;
            }
        }

        // ── Half / Full card ──
        if (isHalfVariant(item.name)) {
            const base = getHalfFullBase(item.name);
            const fullItem = itemsToShow.find(i =>
                !processed.has(i.id) && isFullVariant(i.name) && getHalfFullBase(i.name) === base
            );
            if (fullItem) {
                grid.appendChild(createHalfFullCard(item, fullItem));
                processed.add(item.id);
                processed.add(fullItem.id);
                return;
            }
        } else if (isFullVariant(item.name)) {
            const base = getHalfFullBase(item.name);
            const halfItem = itemsToShow.find(i =>
                !processed.has(i.id) && isHalfVariant(i.name) && getHalfFullBase(i.name) === base
            );
            if (halfItem) {
                grid.appendChild(createHalfFullCard(halfItem, item));
                processed.add(halfItem.id);
                processed.add(item.id);
                return;
            }
        }

        grid.appendChild(createItemCard(item));
        processed.add(item.id);
    });
}

// Combined Regular + Medium + Large card (Pizza variants)
function createTripleCard(regularItem, mediumItem, largeItem) {
    const baseName = displayTripleBaseName(regularItem.name);
    const card = document.createElement('div');
    card.className = 'triple-card';

    const makeSide = (item, label) => `
        <div class="triple-side" data-id="${item.id}">
            <div class="item-remove-badge triple-remove" data-id="${item.id}" title="Remove">✕</div>
            <div class="triple-label">${label}</div>
            <div class="triple-price">₹${item.price}</div>
            <div class="item-qty-badge triple-qty" data-id="${item.id}">0</div>
        </div>
    `;

    card.innerHTML = `
        <div class="triple-heading">${baseName}</div>
        <div class="triple-body">
            ${makeSide(regularItem, 'Regular')}
            <div class="triple-divider"></div>
            ${makeSide(mediumItem, 'Medium')}
            <div class="triple-divider"></div>
            ${makeSide(largeItem, 'Large')}
        </div>
    `;

    const items = { [regularItem.id]: regularItem, [mediumItem.id]: mediumItem, [largeItem.id]: largeItem };

    // Side click → add to cart
    card.querySelectorAll('.triple-side').forEach(side => {
        side.addEventListener('click', (e) => {
            if (e.target.closest('.triple-remove') || e.target.closest('.triple-qty')) return;
            window.dispatchEvent(new CustomEvent('add-to-cart', { detail: items[side.dataset.id] }));
        });
    });

    // Remove badges
    card.querySelectorAll('.triple-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const it = items[btn.dataset.id];
            window.dispatchEvent(new CustomEvent('set-cart-quantity', {
                detail: { id: it.id, name: it.name, price: it.price, qty: 0 }
            }));
        });
    });

    // Qty badges → custom modal
    card.querySelectorAll('.triple-qty').forEach(badge => {
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            const it = items[badge.dataset.id];
            const currentQty = getCurrentCartItems().find(i => i.id === it.id)?.qty || 0;
            openQtyEditModal(it, currentQty);
        });
    });

    return card;
}

// Combined Half + Full card
function createHalfFullCard(halfItem, fullItem) {
    const baseName = displayBaseName(halfItem.name);
    const card = document.createElement('div');
    card.className = 'half-full-card';

    card.innerHTML = `
        <div class="half-full-heading">${baseName}</div>
        <div class="half-full-body">
            <div class="half-full-side" data-id="${halfItem.id}">
                <div class="item-remove-badge hf-remove" data-id="${halfItem.id}" title="Remove">✕</div>
                <div class="half-full-label">Half</div>
                <div class="half-full-price">₹${halfItem.price}</div>
                <div class="item-qty-badge hf-qty" data-id="${halfItem.id}">0</div>
            </div>
            <div class="half-full-divider"></div>
            <div class="half-full-side" data-id="${fullItem.id}">
                <div class="item-remove-badge hf-remove" data-id="${fullItem.id}" title="Remove">✕</div>
                <div class="half-full-label">Full</div>
                <div class="half-full-price">₹${fullItem.price}</div>
                <div class="item-qty-badge hf-qty" data-id="${fullItem.id}">0</div>
            </div>
        </div>
    `;

    // Side clicks → add to cart
    card.querySelectorAll('.half-full-side').forEach(side => {
        side.addEventListener('click', (e) => {
            if (e.target.closest('.hf-remove') || e.target.closest('.hf-qty')) return;
            const id = side.dataset.id;
            const it = id === halfItem.id ? halfItem : fullItem;
            window.dispatchEvent(new CustomEvent('add-to-cart', { detail: it }));
        });
    });

    // Remove badges
    card.querySelectorAll('.hf-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const it = id === halfItem.id ? halfItem : fullItem;
            window.dispatchEvent(new CustomEvent('set-cart-quantity', {
                detail: { id: it.id, name: it.name, price: it.price, qty: 0 }
            }));
        });
    });

    // Qty badges → custom modal
    card.querySelectorAll('.hf-qty').forEach(badge => {
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = badge.dataset.id;
            const it = id === halfItem.id ? halfItem : fullItem;
            const currentQty = getCurrentCartItems().find(i => i.id === it.id)?.qty || 0;
            openQtyEditModal(it, currentQty);
        });
    });

    return card;
}

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

    renderItemsToGrid(itemsToShow, grid);
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

        renderItemsToGrid(searchedItems, grid);
        syncItemBadges();
    });
}
