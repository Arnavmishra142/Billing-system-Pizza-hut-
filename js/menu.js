import { db } from './firebase-config.js';
import { collection, getDocs, addDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

let allItems = [];
let categories = []; // "All" hata diya
let currentCategory = ''; // Blank rakha hai, baad me auto-set hoga

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
        let catSet = new Set();

        querySnapshot.forEach((docSnap) => {
            let item = docSnap.data();
            item.id = docSnap.id;
            if(item.inStock !== false) {
                allItems.push(item);
                if(item.category) catSet.add(item.category);
            }
        });

        // SORT 1: Categories A-Z
        let sortedCats = Array.from(catSet).sort();
        categories = [...sortedCats]; // Sirf real categories rahengi

        // NAYA: Pehli category ko default set karo (e.g. Burger)
        if(categories.length > 0) {
            currentCategory = categories[0];
        }

        // SORT 2: Items Sorting (Category -> Parivar -> Size)
        allItems.sort((a, b) => {
            const getBase = (name) => name.includes('(') ? name.split('(')[0].trim().toLowerCase() : name.trim().toLowerCase();
            const getRank = (name) => {
                let n = name.toLowerCase();
                if (n.includes('(half)') || n.includes('(regular)')) return 1;
                if (n.includes('(full)') || n.includes('(medium)')) return 2;
                if (n.includes('(large)')) return 3;
                return 0; 
            };

            let catA = (a.category || "").toLowerCase();
            let catB = (b.category || "").toLowerCase();
            if (catA < catB) return -1;
            if (catA > catB) return 1;

            let baseA = getBase(a.name);
            let baseB = getBase(b.name);
            if (baseA < baseB) return -1;
            if (baseA > baseB) return 1;

            return getRank(a.name) - getRank(b.name);
        });
        
        loadCategories();
        if(currentCategory) {
            loadItems(currentCategory); // Pehli category show karo
        }
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
        btn.style.fontWeight = "bold"; 
        
        btn.onclick = () => {
            currentCategory = cat;
            loadCategories(); 
            loadItems(cat);
        };
        list.appendChild(btn);
    });
}

// 3. RENDER ITEMS IN GRID
function loadItems(categoryFilter) {
    const grid = document.getElementById('itemsGrid');
    if(!grid) return;
    grid.innerHTML = '';

    // "All" ki logic hata di, ab hamesha specific category hi show hogi
    let itemsToShow = allItems.filter(item => item.category === categoryFilter);

    if(itemsToShow.length === 0) {
        grid.innerHTML = '<div style="padding:20px; color:gray;">Is category me item nahi hai.</div>';
        return;
    }

    itemsToShow.forEach(item => {
        let card = document.createElement('div');
        card.className = 'item-card';
        
        let bgImage = item.image ? `url('${item.image}')` : 'none';
        let bgText = item.image ? '' : '<span style="color:#aaa; font-size:10px;">No Image</span>';

        card.innerHTML = `
            <div class="item-image" style="background-image: ${bgImage}; background-size:cover; background-position:center; height:100px; display:flex; align-items:center; justify-content:center; background-color:#f3f4f6; border-radius:8px 8px 0 0;">
                ${bgText}
            </div>
            <div class="item-title" style="padding:10px 10px 0; font-weight:bold; font-size:0.9rem;">${item.name}</div>
            <div class="item-price" style="padding:5px 10px 10px; color:#10b981; font-weight:bold;">₹${item.price}</div>
        `;
        
        card.onclick = () => {
            window.dispatchEvent(new CustomEvent('add-to-cart', { detail: item }));
        };

        grid.appendChild(card);
    });
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

    // SAVE TO GLOBAL FIREBASE
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

    // SAVE TO BILL ONLY LOGIC
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
        datalist.innerHTML += `<option value="${cat}">`;
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

        // Search hamesha saare (allItems) par kaam karega
        let searchedItems = allItems.filter(item => 
            item.name.toLowerCase().includes(searchTerm)
        );

        if (searchedItems.length === 0) {
            grid.innerHTML = '<div style="padding:20px; color:gray; width:100%; text-align:center;">Koi item nahi mila bhai.</div>';
            return;
        }

        searchedItems.forEach(item => {
            let card = document.createElement('div');
            card.className = 'item-card';
            
            let bgImage = item.image ? `url('${item.image}')` : 'none';
            let bgText = item.image ? '' : '<span style="color:#aaa; font-size:10px;">No Image</span>';

            card.innerHTML = `
                <div class="item-image" style="background-image: ${bgImage}; background-size:cover; background-position:center; height:100px; display:flex; align-items:center; justify-content:center; background-color:#f3f4f6; border-radius:8px 8px 0 0;">
                    ${bgText}
                </div>
                <div class="item-title" style="padding:10px 10px 0; font-weight:bold; font-size:0.9rem;">${item.name}</div>
                <div class="item-price" style="padding:5px 10px 10px; color:#10b981; font-weight:bold;">₹${item.price}</div>
            `;
            
            card.onclick = () => {
                window.dispatchEvent(new CustomEvent('add-to-cart', { detail: item }));
            };
            
            grid.appendChild(card);
        });
    });
}
