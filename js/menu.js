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
    
    // TEMPORARY UPLOAD BUTTON
    const tempUploadBtn = document.getElementById('tempUploadBtn');

    // ==========================================
    // EMERGENCY FULL MENU UPLOAD LOGIC
    // ==========================================
    const fullMenu = [
        // BURGER
        { id: '101', name: 'Veg Burger', price: 50, category: 'Burger' },
        { id: '102', name: 'Mexican Burger', price: 60, category: 'Burger' },
        { id: '103', name: 'Cheese Burger', price: 70, category: 'Burger' },
        { id: '104', name: 'Double Decker Burger', price: 100, category: 'Burger' },

        // SANDWICH
        { id: '111', name: 'Classic Sandwich', price: 60, category: 'Sandwich' },
        { id: '112', name: 'Mexican Sandwich', price: 70, category: 'Sandwich' },
        { id: '113', name: 'Cheese Overload Sandwich', price: 90, category: 'Sandwich' },
        { id: '114', name: 'Paneer Sandwich', price: 110, category: 'Sandwich' },

        // FRENCH FRIES
        { id: '121', name: 'French Fry', price: 50, category: 'French Fries' },
        { id: '122', name: 'Masala Fresh Fry', price: 60, category: 'French Fries' },
        { id: '123', name: 'Peri Peri Fry', price: 70, category: 'French Fries' },

        // GARLIC BREAD
        { id: '131', name: 'Plain Garlic Bread', price: 50, category: 'Garlic Bread' },
        { id: '132', name: 'Stuffed Garlic Bread', price: 60, category: 'Garlic Bread' },
        { id: '133', name: 'Cheese Garlic Bread', price: 70, category: 'Garlic Bread' },

        // PASTRY
        { id: '141', name: 'Pineapple Pastry', price: 50, category: 'Pastry' },
        { id: '142', name: 'Strawberry Pastry', price: 50, category: 'Pastry' },
        { id: '143', name: 'Butterscotch Pastry', price: 50, category: 'Pastry' },
        { id: '144', name: 'White Forest Pastry', price: 50, category: 'Pastry' },
        { id: '145', name: 'Choco Chips Pastry', price: 50, category: 'Pastry' },
        { id: '146', name: 'Chocolate Flax Pastry', price: 60, category: 'Pastry' },

        // COMBO
        { id: '151', name: 'Margherita + Fries + Burger + Drink', price: 200, category: 'Combo' },
        { id: '152', name: 'Hakka Noodle + Manchurian + Pastry + Drink', price: 200, category: 'Combo' },

        // CAKE
        { id: '201', name: 'Black Forest Cake', price: 300, category: 'Cake' },
        { id: '202', name: 'White Forest Cake', price: 350, category: 'Cake' },
        { id: '203', name: 'Chocolate Chips Cake', price: 350, category: 'Cake' },
        { id: '204', name: 'Chocolate Flex Cake', price: 350, category: 'Cake' },
        { id: '205', name: 'Chocolate Munch Cake', price: 380, category: 'Cake' },
        { id: '206', name: 'Kit-Kat Cake', price: 400, category: 'Cake' },
        { id: '207', name: 'Chocolate Vanilla Cake', price: 300, category: 'Cake' },
        { id: '208', name: 'Chocolate Oreo Cake', price: 300, category: 'Cake' },
        { id: '209', name: 'Red Velvet Cake', price: 450, category: 'Cake' },
        { id: '210', name: 'Chocolate Truffles Cake', price: 500, category: 'Cake' },
        { id: '211', name: 'Pineapple Cake', price: 300, category: 'Cake' },
        { id: '212', name: 'Strawberry Cake', price: 300, category: 'Cake' },
        { id: '213', name: 'Butter Scotch Cake', price: 300, category: 'Cake' },
        { id: '214', name: 'Mixed Fruit Cake', price: 350, category: 'Cake' },
        { id: '215', name: 'Real Fruit Cake', price: 450, category: 'Cake' },
        { id: '216', name: '3D Cake', price: 750, category: 'Cake' },

        // CHINESE STARTER
        { id: '301H', name: 'Soya Chilli (Half)', price: 70, category: 'Chinese Starter' },
        { id: '301F', name: 'Soya Chilli (Full)', price: 150, category: 'Chinese Starter' },
        { id: '302H', name: 'Veg Manchurian (Half)', price: 80, category: 'Chinese Starter' },
        { id: '302F', name: 'Veg Manchurian (Full)', price: 150, category: 'Chinese Starter' },
        { id: '303H', name: 'Honey Chilli Potato (Half)', price: 90, category: 'Chinese Starter' },
        { id: '303F', name: 'Honey Chilli Potato (Full)', price: 160, category: 'Chinese Starter' },
        { id: '304H', name: 'Chilli Potato (Half)', price: 90, category: 'Chinese Starter' },
        { id: '304F', name: 'Chilli Potato (Full)', price: 160, category: 'Chinese Starter' },
        { id: '305H', name: 'Crispy Corn (Half)', price: 90, category: 'Chinese Starter' },
        { id: '305F', name: 'Crispy Corn (Full)', price: 170, category: 'Chinese Starter' },
        { id: '306H', name: 'Paneer Garlic (Half)', price: 90, category: 'Chinese Starter' },
        { id: '306F', name: 'Paneer Garlic (Full)', price: 180, category: 'Chinese Starter' },
        { id: '307H', name: 'Paneer Chilli (Half)', price: 100, category: 'Chinese Starter' },
        { id: '307F', name: 'Paneer Chilli (Full)', price: 180, category: 'Chinese Starter' },
        { id: '308H', name: 'Baby Corn Chilli (Half)', price: 100, category: 'Chinese Starter' },
        { id: '308F', name: 'Baby Corn Chilli (Full)', price: 180, category: 'Chinese Starter' },
        { id: '309H', name: 'Mushroom Salt & Chilli (Half)', price: 100, category: 'Chinese Starter' },
        { id: '309F', name: 'Mushroom Salt & Chilli (Full)', price: 180, category: 'Chinese Starter' },
        { id: '310H', name: 'Mushroom Chilli (Half)', price: 100, category: 'Chinese Starter' },
        { id: '310F', name: 'Mushroom Chilli (Full)', price: 180, category: 'Chinese Starter' },

        // NOODLES
        { id: '401H', name: 'Hakka Noodles (Half)', price: 60, category: 'Noodles' },
        { id: '401F', name: 'Hakka Noodles (Full)', price: 110, category: 'Noodles' },
        { id: '402H', name: 'Singapuri Noodles (Half)', price: 70, category: 'Noodles' },
        { id: '402F', name: 'Singapuri Noodles (Full)', price: 110, category: 'Noodles' },
        { id: '403H', name: 'Schezwan Noodles (Half)', price: 80, category: 'Noodles' },
        { id: '403F', name: 'Schezwan Noodles (Full)', price: 120, category: 'Noodles' },
        { id: '404H', name: 'Hong Kong Noodles (Half)', price: 90, category: 'Noodles' },
        { id: '404F', name: 'Hong Kong Noodles (Full)', price: 130, category: 'Noodles' },
        { id: '405H', name: 'Paneer Noodles (Half)', price: 100, category: 'Noodles' },
        { id: '405F', name: 'Paneer Noodles (Full)', price: 150, category: 'Noodles' },

        // FRIED RICE
        { id: '501H', name: 'Veg Fried Rice (Half)', price: 50, category: 'Fried Rice' },
        { id: '501F', name: 'Veg Fried Rice (Full)', price: 90, category: 'Fried Rice' },
        { id: '502H', name: 'Schezwan Fried Rice (Half)', price: 70, category: 'Fried Rice' },
        { id: '502F', name: 'Schezwan Fried Rice (Full)', price: 110, category: 'Fried Rice' },
        { id: '503H', name: 'Paneer Fried Rice (Half)', price: 80, category: 'Fried Rice' },
        { id: '503F', name: 'Paneer Fried Rice (Full)', price: 140, category: 'Fried Rice' },

        // PIZZA
        { id: '601R', name: 'Margherita Pizza (Reg)', price: 75, category: 'Pizza' },
        { id: '601M', name: 'Margherita Pizza (Med)', price: 160, category: 'Pizza' },
        { id: '601L', name: 'Margherita Pizza (Lrg)', price: 240, category: 'Pizza' },
        { id: '602R', name: 'O.C.T Pizza (Reg)', price: 100, category: 'Pizza' },
        { id: '602M', name: 'O.C.T Pizza (Med)', price: 200, category: 'Pizza' },
        { id: '602L', name: 'O.C.T Pizza (Lrg)', price: 300, category: 'Pizza' },
        { id: '603R', name: 'Cheese & Paneer Pizza (Reg)', price: 110, category: 'Pizza' },
        { id: '603M', name: 'Cheese & Paneer Pizza (Med)', price: 210, category: 'Pizza' },
        { id: '603L', name: 'Cheese & Paneer Pizza (Lrg)', price: 300, category: 'Pizza' },
        { id: '604R', name: 'Italiano Pizza (Reg)', price: 120, category: 'Pizza' },
        { id: '604M', name: 'Italiano Pizza (Med)', price: 210, category: 'Pizza' },
        { id: '604L', name: 'Italiano Pizza (Lrg)', price: 320, category: 'Pizza' },
        { id: '605R', name: 'Farmhouse Pizza (Reg)', price: 120, category: 'Pizza' },
        { id: '605M', name: 'Farmhouse Pizza (Med)', price: 250, category: 'Pizza' },
        { id: '605L', name: 'Farmhouse Pizza (Lrg)', price: 350, category: 'Pizza' },
        { id: '606R', name: 'Peri Peri Pizza (Reg)', price: 130, category: 'Pizza' },
        { id: '606M', name: 'Peri Peri Pizza (Med)', price: 240, category: 'Pizza' },
        { id: '606L', name: 'Peri Peri Pizza (Lrg)', price: 340, category: 'Pizza' },
        { id: '607R', name: 'Cheese & Mushroom Pizza (Reg)', price: 140, category: 'Pizza' },
        { id: '607M', name: 'Cheese & Mushroom Pizza (Med)', price: 220, category: 'Pizza' },
        { id: '607L', name: 'Cheese & Mushroom Pizza (Lrg)', price: 320, category: 'Pizza' },
        { id: '608R', name: 'Cheese Overload Pizza (Reg)', price: 140, category: 'Pizza' },
        { id: '608M', name: 'Cheese Overload Pizza (Med)', price: 260, category: 'Pizza' },
        { id: '608L', name: 'Cheese Overload Pizza (Lrg)', price: 360, category: 'Pizza' },
        { id: '609R', name: 'Paneer Schezwan Pizza (Reg)', price: 150, category: 'Pizza' },
        { id: '609M', name: 'Paneer Schezwan Pizza (Med)', price: 260, category: 'Pizza' },
        { id: '609L', name: 'Paneer Schezwan Pizza (Lrg)', price: 360, category: 'Pizza' },
        { id: '610R', name: 'Country Pizza (Reg)', price: 150, category: 'Pizza' },
        { id: '610M', name: 'Country Pizza (Med)', price: 260, category: 'Pizza' },
        { id: '610L', name: 'Country Pizza (Lrg)', price: 360, category: 'Pizza' },
        { id: '611R', name: 'Paneer Makhani Pizza (Reg)', price: 150, category: 'Pizza' },
        { id: '611M', name: 'Paneer Makhani Pizza (Med)', price: 260, category: 'Pizza' },
        { id: '611L', name: 'Paneer Makhani Pizza (Lrg)', price: 360, category: 'Pizza' },
        { id: '612R', name: 'Tandoori Pizza (Reg)', price: 150, category: 'Pizza' },
        { id: '612M', name: 'Tandoori Pizza (Med)', price: 270, category: 'Pizza' },
        { id: '612L', name: 'Tandoori Pizza (Lrg)', price: 380, category: 'Pizza' },
        { id: '613R', name: 'Paneer Tikka Pizza (Reg)', price: 160, category: 'Pizza' },
        { id: '613M', name: 'Paneer Tikka Pizza (Med)', price: 280, category: 'Pizza' },
        { id: '613L', name: 'Paneer Tikka Pizza (Lrg)', price: 390, category: 'Pizza' }
    ];

    if (tempUploadBtn) {
        tempUploadBtn.addEventListener('click', async () => {
            tempUploadBtn.disabled = true;
            tempUploadBtn.innerText = "Uploading... ⏳";
            let count = 0;
            try {
                for (const item of fullMenu) {
                    await setDoc(doc(db, "menu_items", item.id), item);
                    count++;
                }
                alert(`🔥 SUCCESS! ${count} items Firebase me upload ho gaye. Ab index.html se Upload Button hata de aur page refresh kar le.`);
            } catch (error) {
                console.error("Upload error:", error);
                alert("Upload me error aa gaya. Network check kar le.");
            } finally {
                tempUploadBtn.innerText = "Done!";
            }
        });
    }

    // ==========================================
    // AB REGULAR CLOUD FETCHING WALA CODE
    // ==========================================
    let allMenuItems = [];
    let activeCategories = [];
    let activeCategory = 'Pizza'; 

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

    loadMenuFromCloud();

    // --- RENDERING LOGIC ---
    function renderCategories() {
        categoryList.innerHTML = '';
        categoryOptionsList.innerHTML = ''; 

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

    // --- QUICK ADD MODALS ---
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

        try {
            saveBtn.innerText = "Saving to Cloud... ☁️";
            saveBtn.disabled = true;

            await setDoc(doc(db, "menu_items", newItem.id), newItem);

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

    