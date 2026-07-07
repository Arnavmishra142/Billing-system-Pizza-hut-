import { db } from './firebase-config.js';
import { collection, getDocs, addDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ==========================================
// STATE VARIABLES (Cloud Data yahan store hoga)
// ==========================================
let allItems = [];
let categories = ['All']; 
let cart = [];
let currentCategory = 'All';

// ==========================================
// INITIALIZE & FETCH FROM FIREBASE
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    // Shuruwat me loading dikhao
    document.getElementById('itemsGrid').innerHTML = '<div style="padding: 20px; color: gray;">Cloud se Menu aa raha hai... ☁️⏳</div>';
    fetchMenuFromCloud();
    renderCart(); // Cart ko empty state me load karo
});

// 1. CLOUD SE MENU MANGWANA
async function fetchMenuFromCloud() {
    try {
        const querySnapshot = await getDocs(collection(db, "menu_items"));
        allItems = [];
        let catSet = new Set(['All']); // 'All' category hamesha rahegi

        querySnapshot.forEach((docSnap) => {
            let item = docSnap.data();
            item.id = docSnap.id;
            
            // Sirf IN-STOCK items dikhao
            if(item.inStock !== false) {
                allItems.push(item);
                if(item.category) catSet.add(item.category);
            }
        });

        categories = Array.from(catSet); // Unique categories ban gayi
        
        loadCategories();
        loadItems('All'); // Pura menu render karo
        
    } catch (e) {
        console.error("Menu fetch error:", e);
        document.getElementById('itemsGrid').innerHTML = '<div style="color: red;">Menu load fail hua. Internet check karo!</div>';
    }
}

// ==========================================
// UI RENDER LOGIC
// ==========================================

// 2. LOAD CATEGORIES (Dynamic)
function loadCategories() {
    const list = document.getElementById('categoryList');
    list.innerHTML = ''; // Purana clear karo

    categories.forEach(cat => {
        let li = document.createElement('li');
        li.innerText = cat;
        // Jo category select ho, usko active class do (UI ke liye)
        if(cat === currentCategory) li.style.fontWeight = "bold"; 
        
        li.onclick = () => {
            currentCategory = cat;
            loadCategories(); // Bold styling update karne ke liye
            loadItems(cat);
        };
        list.appendChild(li);
    });
}

// 3. LOAD ITEMS IN GRID (Filtered)
function loadItems(categoryFilter) {
    const grid = document.getElementById('itemsGrid');
    grid.innerHTML = '';

    // Filter logic
    let itemsToShow = allItems;
    if(categoryFilter !== 'All') {
        itemsToShow = allItems.filter(item => item.category === categoryFilter);
    }

    if(itemsToShow.length === 0) {
        grid.innerHTML = '<div style="padding: 20px; color: gray;">Is category me koi item nahi hai.</div>';
        return;
    }

    itemsToShow.forEach(item => {
        let card = document.createElement('div');
        card.className = 'item-card';
        
        // Agar image hai toh wo dikhao, warna default gray box
        let bgImage = item.image ? `url('${item.image}')` : 'none';
        let bgText = item.image ? '' : '<span style="color:#aaa; font-size:10px;">No Image</span>';

        card.innerHTML = `
            <div class="item-image" style="background-image: ${bgImage}; display:flex; align-items:center; justify-content:center; background-size:cover; background-position:center;">
                ${bgText}
            </div>
            <div class="item-title">${item.name}</div>
            <div class="item-price">₹${item.price}</div>
        `;
        
        // Item click karne par cart me add ho
        card.onclick = () => addToCart(item);
        grid.appendChild(card);
    });
}

// ==========================================
// CART LOGIC
// ==========================================

function addToCart(item) {
    let existingItem = cart.find(c => c.id === item.id);
    if(existingItem) {
        existingItem.qty += 1;
    } else {
        cart.push({ ...item, qty: 1 });
    }
    renderCart();
}

function updateQty(itemId, change) {
    let item = cart.find(c => c.id === itemId);
    if(item) {
        item.qty += change;
        if(item.qty <= 0) {
            cart = cart.filter(c => c.id !== itemId); // Remove item
        }
    }
    renderCart();
}

function renderCart() {
    const cartContainer = document.getElementById('cartItems');
    cartContainer.innerHTML = '';
    
    let totalAmount = 0;

    if(cart.length === 0) {
        cartContainer.innerHTML = '<div style="padding:20px; text-align:center; color:gray;">Cart is empty</div>';
        // Agar tera UI me Total ka alag box hai, toh usey update kar (e.g. document.getElementById('cartTotal').innerText = '₹0')
        return;
    }

    cart.forEach(item => {
        let itemTotal = item.price * item.qty;
        totalAmount += itemTotal;

        let cartItem = document.createElement('div');
        cartItem.className = 'cart-item';
        cartItem.innerHTML = `
            <div class="cart-item-header">
                <span style="font-weight:bold;">${item.name}</span>
                <span style="color:#10b981; font-weight:bold;">₹${itemTotal}</span>
            </div>
            <div class="cart-item-controls" style="display:flex; justify-content:space-between; align-items:center; margin-top:5px;">
                <span style="color: #6b7280; font-size: 0.8rem;">₹${item.price} x ${item.qty}</span>
                <div class="quantity-control" style="display:flex; gap:10px; align-items:center;">
                    <button class="qty-btn qty-minus" style="padding:2px 8px; cursor:pointer;">-</button>
                    <span>${item.qty}</span>
                    <button class="qty-btn qty-plus" style="padding:2px 8px; cursor:pointer;">+</button>
                </div>
            </div>
        `;
        
        // Plus aur Minus buttons par click events
        cartItem.querySelector('.qty-minus').onclick = () => updateQty(item.id, -1);
        cartItem.querySelector('.qty-plus').onclick = () => updateQty(item.id, 1);
        
        cartContainer.appendChild(cartItem);
    });

    // Total Update karne ka logic (Agar tere HTML me total ka span hai toh yahan ID daal dena)
    // document.getElementById('cartTotalSpan').innerText = `₹${totalAmount}`;
}

// ==========================================
// QUICK ADD (GLOBAL) LOGIC
// ==========================================
// Note: Agar tere HTML me ID "quickAddBtn" hai toh ye chalega
const quickBtn = document.getElementById('quickAddBtn');
if(quickBtn) {
    quickBtn.addEventListener('click', async () => {
        // IDs apne HTML se match kar lena
        const itemName = document.getElementById('quickAddName').value.trim();
        const itemPrice = document.getElementById('quickAddPrice').value.trim();
        
        if(!itemName || !itemPrice) {
            alert("Bhai naam aur price daalna zaroori hai!");
            return;
        }

        quickBtn.innerText = "Adding...⏳";
        quickBtn.disabled = true;

        try {
            await addDoc(collection(db, "menu_items"), {
                name: itemName,
                price: Number(itemPrice),
                category: "Custom Item", // Default category for quick add
                image: null, 
                inStock: true
            });

            // Inputs saaf karo
            document.getElementById('quickAddName').value = '';
            document.getElementById('quickAddPrice').value = '';

            // Cloud se naya data laao aur UI refresh karo
            await fetchMenuFromCloud();

        } catch(e) {
            console.error("Quick Add Error:", e);
            alert("Item add nahi ho paya!");
        } finally {
            quickBtn.innerText = "+ QUICK ADD";
            quickBtn.disabled = false;
        }
    });
}
