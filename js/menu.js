import { db } from './firebase-config.js';
import { collection, getDocs, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', () => {

    const categoryList = document.getElementById('categoryList');
    const itemsGrid = document.getElementById('itemsGrid');
    const searchInput = document.getElementById('searchInput');

    const quickAddBtn = document.getElementById('quickAddBtn');
    const quickAddChoiceModal = document.getElementById('quickAddChoiceModal');
    const billOnlyModal = document.getElementById('billOnlyModal');
    const globalMenuModal = document.getElementById('globalMenuModal');
    const categoryOptionsList = document.getElementById('categoryOptions');

    // Ab data Firebase se aayega, hardcode nahi
    let allMenuItems = [];
    let activeCategories = [];
    let activeCategory = 'Pizza'; // Default

    // ==========================================
    // 1. FETCH MENU FROM FIREBASE (CLOUD)
    // ==========================================
    async function loadMenuFromCloud() {
        itemsGrid.innerHTML = '<p style="grid-column: 1 / -1; text-align:center; padding: 20px; color:#6b7280;">Loading Menu from Cloud... ☁️</p>';
        
        try {
            const querySnapshot = await getDocs(collection(db, "menu_items"));
            const items = [];
            const categoriesSet = new Set();

            querySnapshot.forEach((doc) => {
                const data = doc.data();
                items.push(data);
                if (data.category) {
                    categoriesSet.add(data.category);
                }
            });

            allMenuItems = items;
            activeCategories = Array.from(categoriesSet);
            
            // Agar Pizza category mili toh usko default rakho, warna jo pehli ho
            if (activeCategories.includes('Pizza')) {
                activeCategory = 'Pizza';
            } else if (activeCategories.length > 0) {
                activeCategory = activeCategories[0];
            }

            renderCategories();
            renderItems(activeCategory);

        } catch (error) {
            console.error("Error fetching menu:", error);
            itemsGrid.innerHTML = '<p style="grid-column: 1 / -1; text-align:center; padding: 20px; color:#ef4444;">Error fetching menu. Check Internet!</p>';
        }
    }

    // Call the function when page loads
    loadMenuFromCloud();


    // ==========================================
    // 2. RENDER CATEGORIES & ITEMS
    // ==========================================
    function renderCategories() {
        categoryList.innerHTML = '';
        categoryOptionsList.innerHTML = ''; 

        // Categories ko alphabetically sort kar dete hain
        activeCategories.sort().forEach(cat => {
            const div = document.createElement('div');
            div.style.padding = '15px';
            div.style.borderBottom = '1px solid #e5e7eb';
            div.style.cursor = 'pointer';
            div.style.fontWeight = 'bold';
            div.style.fontSize = '0.95rem';
            div.style.backgroundColor = cat === activeCategory ? '#eef2ff' : 'transparent';
            div.style.color = cat === activeCategory ? '#4f46e5' : '#4b5563';
            div.innerText = cat;
            
            div.addEventListener('click', () => {
                activeCategory = cat;
                renderCategories();
                renderItems(cat);
            });
            categoryList.appendChild(div);

            const option = document.createElement('option');
            option.value = cat;
            categoryOptionsList.appendChild(option);
        });
    }

    function renderItems(filterCategory = '', searchQuery = '') {
        itemsGrid.innerHTML = '';
        let filteredItems = allMenuItems;

        if (searchQuery !== '') {
            filteredItems = allMenuItems.filter(item => 
                item.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                (item.id && item.id.toLowerCase().includes(searchQuery.toLowerCase()))
            );
        } else if (filterCategory) {
            filteredItems = allMenuItems.filter(item => item.category === filterCategory);
        }

        if(filteredItems.length === 0) {
            itemsGrid.innerHTML = '<p style="grid-column: 1 / -1; text-align:center; padding: 20px; color:#6b7280;">No items found.</p>';
            return;
        }

        filteredItems.forEach(item => {
            const card = document.createElement('div');
            card.className = 'item-card';
            
            // Custom item identifier UI
            const isCustom = item.id.startsWith('CUST_');
            
            card.innerHTML = `
                <div class="item-image" style="display:flex; justify-content:center; align-items:center; color:#9ca3af; font-size:2rem;">
                    ${isCustom ? '✨' : ''}
                </div>
                <div class="item-title">${isCustom ? '' : item.id + ' | '} ${item.name}</div>
                <div class="item-price">₹${item.price}</div>
            `;
            
            card.addEventListener('click', () => {
                window.dispatchEvent(new CustomEvent('add-to-cart', { detail: item }));
            });
            itemsGrid.appendChild(card);
        });
    }

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value;
        if(query.trim() !== '') {
            renderItems('', query);
        } else {
            renderItems(activeCategory);
        }
    });


    // ==========================================
    // 3. QUICK ADD MODALS (WITH CLOUD SAVE)
    // ==========================================
    quickAddBtn.addEventListener('click', () => quickAddChoiceModal.classList.remove('hidden'));
    document.getElementById('closeChoiceModalBtn').addEventListener('click', () => quickAddChoiceModal.classList.add('hidden'));

    document.getElementById('btnAddToBillOnly').addEventListener('click', () => {
        quickAddChoiceModal.classList.add('hidden');
        billOnlyModal.classList.remove('hidden');
    });

    document.getElementById('btnAddToMenu').addEventListener('click', () => {
        quickAddChoiceModal.classList.add('hidden');
        globalMenuModal.classList.remove('hidden');
    });

    // --- BILL ONLY FORM LOGIC ---
    document.getElementById('cancelBillOnlyBtn').addEventListener('click', () => {
        billOnlyModal.classList.add('hidden');
        document.getElementById('tempItemName').value = '';
        document.getElementById('tempItemPrice').value = '';
    });

    document.getElementById('saveToBillBtn').addEventListener('click', () => {
        const name = document.getElementById('tempItemName').value.trim();
        const price = parseFloat(document.getElementById('tempItemPrice').value);

        if (!name || isNaN(price)) {
            alert("Please enter valid name and price!");
            return;
        }

        const tempItem = {
            id: `TEMP_${Date.now()}`,
            name: name,
            price: price
        };

        window.dispatchEvent(new CustomEvent('add-custom-item-to-bill', { detail: tempItem }));
        
        document.getElementById('tempItemName').value = '';
        document.getElementById('tempItemPrice').value = '';
        billOnlyModal.classList.add('hidden');
    });

    // --- GLOBAL MENU FORM LOGIC (SAVES TO FIREBASE) ---
    document.getElementById('cancelGlobalBtn').addEventListener('click', () => {
        globalMenuModal.classList.add('hidden');
        clearGlobalForm();
    });

    document.getElementById('saveGlobalBtn').addEventListener('click', async () => {
        const name = document.getElementById('globalItemName').value.trim();
        const price = parseFloat(document.getElementById('globalItemPrice').value);
        let category = document.getElementById('globalItemCategory').value.trim();
        const saveBtn = document.getElementById('saveGlobalBtn');

        if (!name || isNaN(price) || !category) {
            alert("Please fill all details (Name, Price, Category)!");
            return;
        }

        category = category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();

        const newItem = {
            id: `CUST_${Date.now()}`,
            name: name,
            price: price,
            category: category
        };

        // Firebase me upload karna shuru
        try {
            saveBtn.innerText = "Saving to Cloud... ☁️";
            saveBtn.disabled = true;

            await setDoc(doc(db, "menu_items", newItem.id), newItem);

            // Successfully cloud me save ho gaya, ab UI update karo
            allMenuItems.push(newItem);
            if (!activeCategories.includes(category)) {
                activeCategories.push(category);
            }
            activeCategory = category;
            
            renderCategories();
            renderItems(activeCategory);

            clearGlobalForm();
            globalMenuModal.classList.add('hidden');
            
        } catch (error) {
            console.error("Error saving global item:", error);
            alert("Firebase me save nahi ho paya. Internet connection check karo.");
        } finally {
            saveBtn.innerText = "Save to Menu";
            saveBtn.disabled = false;
        }
    });

    function clearGlobalForm() {
        document.getElementById('globalItemName').value = '';
        document.getElementById('globalItemPrice').value = '';
        document.getElementById('globalItemCategory').value = '';
    }
});
