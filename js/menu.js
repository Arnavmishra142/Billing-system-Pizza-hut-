import { db } from './firebase-config.js';
import { collection, getDocs, addDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// Tu cart.js me item bhejne ke liye global window function use kar raha hoga (Assuming addToCart is in cart.js)
// Agar nahi, toh error aayega, par abhi menu load pe focus karte hain.

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

        categories = Array.from(catSet);
        
        loadCategories();
        loadItems('All');
        updateDatalist(); // Quick Add me categories dikhane ke liye
        
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
        
        // CSS matching for active state
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


// 4. QUICK ADD LOGIC (Tere HTML Popups ke sath)
function setupQuickAddPopups() {
    const mainBtn = document.getElementById('qckAddBtn');
    const choiceModal = document.getElementById('quickAddChoiceModal');
    const globalModal = document.getElementById('globalMenuModal');
    
    if(!mainBtn || !choiceModal || !globalModal) return;

    // Open Choice Modal
    mainBtn.onclick = () => choiceModal.classList.remove('hidden');
    document.getElementById('closeChoiceModalBtn').onclick = () => choiceModal.classList.add('hidden');

    // Choice -> Global Menu Modal
    document.getElementById('btnAddToMenu').onclick = () => {
        choiceModal.classList.add('hidden');
        globalModal.classList.remove('hidden');
    };
    
    document.getElementById('cancelGlobalBtn').onclick = () => globalModal.classList.add('hidden');

    // Choice -> Bill Only Modal (Optional for now)
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
            
            // Grid refresh karo
            await fetchMenuFromCloud();

        } catch(e) {
            console.error("Save error:", e);
            alert("Save nahi hua!");
        } finally {
            btn.innerText = "Save to Menu";
            btn.disabled = false;
        }
    };
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

        // Agar search box khali hai, toh current category ke items wapas load kar do
        if (searchTerm === '') {
            loadItems(currentCategory);
            return;
        }

        // Search term ke hisaab se allItems ko filter karo
        let searchedItems = allItems.filter(item => 
            item.name.toLowerCase().includes(searchTerm)
        );

        if (searchedItems.length === 0) {
            grid.innerHTML = '<div style="padding:20px; color:gray; width:100%; text-align:center;">Koi item nahi mila bhai.</div>';
            return;
        }

        // Filtered items ko grid mein dikhao
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
