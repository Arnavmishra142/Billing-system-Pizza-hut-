// 1. FIREBASE IMPORTS SABSE UPAR DAAL
import { db } from './firebase-config.js';
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', () => {

    // ... Tera purana DOM Elements code ...
    const categoryList = document.getElementById('categoryList');
    // ... baaki sab same ...

    // TEMPORARY UPLOAD BUTTON KA LOGIC
    const tempUploadBtn = document.getElementById('tempUploadBtn');
    
    // Yahan teri wo lambi wali `menuItems` array honi chahiye jo tune pehle banayi thi
    const defaultItems = [
        // Apne saare 70-80 items yahan ensure karna ki hain
        { id: '101', name: 'Veg Burger', price: 50, category: 'Burger' },
        { id: '601R', name: 'Margherita Pizza (Reg)', price: 75, category: 'Pizza' },
        // ...
    ];

    if (tempUploadBtn) {
        tempUploadBtn.addEventListener('click', async () => {
            // Button ko disable kardo taaki double click na ho
            tempUploadBtn.disabled = true;
            tempUploadBtn.innerText = "Uploading...";

            try {
                let count = 0;
                for (const item of defaultItems) {
                    // Firebase me 'menu_items' collection ke andar item.id ke naam se document save hoga
                    await setDoc(doc(db, "menu_items", item.id), {
                        id: item.id,
                        name: item.name,
                        price: item.price,
                        category: item.category
                    });
                    count++;
                }
                alert(`🔥 Success! ${count} items Firebase me upload ho gaye. Ab Firebase Console check kar.`);
            } catch (error) {
                console.error("Upload error:", error);
                alert("Upload fail ho gaya. Console check kar.");
            } finally {
                tempUploadBtn.innerText = "Done!";
            }
        });
    }

    // ... Tera baaki ka `menu.js` ka code (Render Items, Quick Add modals) yahan niche waise ka waisa hi rahega ...

});


document.addEventListener('DOMContentLoaded', () => {

    const categoryList = document.getElementById('categoryList');
    const itemsGrid = document.getElementById('itemsGrid');
    const searchInput = document.getElementById('searchInput');

    // 1. ALL CATEGORIES FROM YOUR MENU
    const categories = [
        'Pizza', 'Burger', 'Sandwich', 'French Fries', 
        'Chinese Starter', 'Noodles', 'Fried Rice', 
        'Cake', 'Pastry', 'Garlic Bread', 'Combo'
    ];
    
    // 2. COMPLETE MENU ITEMS WITH EXACT PRICES
    const menuItems = [
        // === BURGER ===
        { id: '101', name: 'Veg Burger', price: 50, category: 'Burger' },
        { id: '102', name: 'Mexican Burger', price: 60, category: 'Burger' },
        { id: '103', name: 'Cheese Burger', price: 70, category: 'Burger' },
        { id: '104', name: 'Double Decker Burger', price: 100, category: 'Burger' },

        // === SANDWICH ===
        { id: '111', name: 'Classic Sandwich', price: 60, category: 'Sandwich' },
        { id: '112', name: 'Mexican Sandwich', price: 70, category: 'Sandwich' },
        { id: '113', name: 'Cheese Overload Sandwich', price: 90, category: 'Sandwich' },
        { id: '114', name: 'Paneer Sandwich', price: 110, category: 'Sandwich' },

        // === FRENCH FRIES ===
        { id: '121', name: 'French Fry', price: 50, category: 'French Fries' },
        { id: '122', name: 'Masala Fresh Fry', price: 60, category: 'French Fries' },
        { id: '123', name: 'Peri Peri Fry', price: 70, category: 'French Fries' },

        // === GARLIC BREAD ===
        { id: '131', name: 'Plain Garlic Bread', price: 50, category: 'Garlic Bread' },
        { id: '132', name: 'Stuffed Garlic Bread', price: 60, category: 'Garlic Bread' },
        { id: '133', name: 'Cheese Garlic Bread', price: 70, category: 'Garlic Bread' },

        // === PASTRY ===
        { id: '141', name: 'Pineapple Pastry', price: 50, category: 'Pastry' },
        { id: '142', name: 'Strawberry Pastry', price: 50, category: 'Pastry' },
        { id: '143', name: 'Butterscotch Pastry', price: 50, category: 'Pastry' },
        { id: '144', name: 'White Forest Pastry', price: 50, category: 'Pastry' },
        { id: '145', name: 'Choco Chips Pastry', price: 50, category: 'Pastry' },
        { id: '146', name: 'Chocolate Flax Pastry', price: 60, category: 'Pastry' },

        // === COMBOS ===
        { id: '151', name: 'Margherita + Fries + Burger + Drink', price: 200, category: 'Combo' },
        { id: '152', name: 'Hakka Noodle + Manchurian + Pastry + Drink', price: 200, category: 'Combo' },

        // === CAKES ===
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

        // === CHINESE STARTERS (With Half/Full Splitting) ===
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

        // === NOODLES ===
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

        // === FRIED RICE ===
        { id: '501H', name: 'Veg Fried Rice (Half)', price: 50, category: 'Fried Rice' },
        { id: '501F', name: 'Veg Fried Rice (Full)', price: 90, category: 'Fried Rice' },
        { id: '502H', name: 'Schezwan Fried Rice (Half)', price: 70, category: 'Fried Rice' },
        { id: '502F', name: 'Schezwan Fried Rice (Full)', price: 110, category: 'Fried Rice' },
        { id: '503H', name: 'Paneer Fried Rice (Half)', price: 80, category: 'Fried Rice' },
        { id: '503F', name: 'Paneer Fried Rice (Full)', price: 140, category: 'Fried Rice' },

        // === PIZZA (With Regular/Medium/Large Splitting) ===
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

    let activeCategory = 'Pizza'; // Default category set to Pizza

    // 3. RENDER CATEGORIES LIST
    function renderCategories() {
        categoryList.innerHTML = '';
        categories.forEach(cat => {
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
        });
    }

    // 4. RENDER ITEMS GRID
    function renderItems(filterCategory = '', searchQuery = '') {
        itemsGrid.innerHTML = '';
        let filteredItems = menuItems;

        if (searchQuery !== '') {
            filteredItems = menuItems.filter(item => 
                item.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                item.id.includes(searchQuery)
            );
        } else if (filterCategory) {
            filteredItems = menuItems.filter(item => item.category === filterCategory);
        }

        if(filteredItems.length === 0) {
            itemsGrid.innerHTML = '<p style="grid-column: 1 / -1; text-align:center; padding: 20px; color:#6b7280;">No items found.</p>';
            return;
        }

        filteredItems.forEach(item => {
            const card = document.createElement('div');
            card.className = 'item-card';
            card.innerHTML = `
                <div class="item-image"></div>
                <div class="item-title">${item.id} | ${item.name}</div>
                <div class="item-price">₹${item.price}</div>
            `;
            
            // Item selection event trigger for cart.js
            card.addEventListener('click', () => {
                const event = new CustomEvent('add-to-cart', { detail: item });
                window.dispatchEvent(event);
            });
            
            itemsGrid.appendChild(card);
        });
    }

    // 5. SEARCH LISTENER
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value;
        if(query.trim() !== '') {
            renderItems('', query);
        } else {
            renderItems(activeCategory);
        }
    });

    // Run on Load
    renderCategories();
    renderItems(activeCategory);
});
