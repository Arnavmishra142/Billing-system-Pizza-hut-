document.addEventListener('DOMContentLoaded', () => {
    const cartItemsContainer = document.getElementById('cartItems');
    const cartTotalElement = document.getElementById('cartTotal');
    const activeTableNameEl = document.getElementById('activeTableName');

    let currentCart = [];

    // Table ka naam laane ka helper
    const getCurrentTable = () => activeTableNameEl.innerText;

    // LocalStorage se fetch karne ka helper
    const getLocalCart = (tableName) => {
        const data = localStorage.getItem(`cart_${tableName}`);
        return data ? JSON.parse(data) : [];
    };

    // LocalStorage me save karne ka helper
    const saveLocalCart = (tableName, cartData) => {
        if (cartData.length === 0) {
            localStorage.removeItem(`cart_${tableName}`);
        } else {
            localStorage.setItem(`cart_${tableName}`, JSON.stringify(cartData));
        }
        // Signal bhejo ki cart update hua hai taaki Home screen pe active cards update ho
        window.dispatchEvent(new Event('cart-updated'));
    };

    // 1. Jab Menu se item add ho
    window.addEventListener('add-to-cart', (e) => {
        const item = e.detail;
        const tableName = getCurrentTable();
        
        // Pehle current table ka updated cart fetch karo
        currentCart = getLocalCart(tableName);

        const existingItem = currentCart.find(i => i.id === item.id);
        if (existingItem) {
            existingItem.qty += 1;
        } else {
            currentCart.push({
                id: item.id,
                name: item.name,
                price: item.price,
                qty: 1
            });
        }
        
        saveLocalCart(tableName, currentCart);
        renderCart();
    });
    // Jab Quick Add -> "Add to Bill Only" se koi item aaye
    window.addEventListener('add-custom-item-to-bill', (e) => {
        const item = e.detail;
        const tableName = getCurrentTable();
        currentCart = getLocalCart(tableName);

        // Naya item humesha unique hota hai (ID temp hogi)
        currentCart.push({
            id: item.id,
            name: item.name,
            price: item.price,
            qty: 1
        });
        
        saveLocalCart(tableName, currentCart);
        renderCart();
    });

    // 2. Quantity Update (+/-)
    function updateQuantity(id, delta) {
        const tableName = getCurrentTable();
        currentCart = getLocalCart(tableName);
        const itemIndex = currentCart.findIndex(item => item.id === id);
        
        if (itemIndex > -1) {
            currentCart[itemIndex].qty += delta;
            if (currentCart[itemIndex].qty <= 0) {
                currentCart.splice(itemIndex, 1);
            }
            saveLocalCart(tableName, currentCart);
            renderCart();
        }
    }

    // 3. Jab Table badle, toh uska specific cart render ho
    window.addEventListener('load-table-cart', () => {
        currentCart = getLocalCart(getCurrentTable());
        renderCart();
    });

    // 4. Render UI
    function renderCart() {
        cartItemsContainer.innerHTML = '';
        let totalAmount = 0;

        if (currentCart.length === 0) {
            cartItemsContainer.innerHTML = `
                <div style="text-align: center; color: #9ca3af; margin-top: 50px; font-weight: bold;">
                    Cart is empty <br> <span style="font-size: 0.8rem; font-weight: normal;">Click items to add</span>
                </div>
            `;
            cartTotalElement.innerText = '₹0.00';
            return;
        }

        currentCart.forEach(item => {
            const itemTotal = item.price * item.qty;
            totalAmount += itemTotal;

            const cartItemDiv = document.createElement('div');
            cartItemDiv.className = 'cart-item';
            cartItemDiv.innerHTML = `
                <div class="cart-item-header">
                    <span>${item.name}</span>
                    <span>₹${itemTotal}</span>
                </div>
                <div class="cart-item-controls">
                    <span style="color: #6b7280; font-size: 0.85rem;">₹${item.price} x ${item.qty}</span>
                    <div class="quantity-control">
                        <button class="qty-btn qty-minus" data-id="${item.id}">-</button>
                        <span style="font-weight: bold;">${item.qty}</span>
                        <button class="qty-btn qty-plus" data-id="${item.id}">+</button>
                    </div>
                </div>
            `;
            cartItemsContainer.appendChild(cartItemDiv);
        });

        cartTotalElement.innerText = `₹${totalAmount.toFixed(2)}`;

        // Button Events Attach Karo
        document.querySelectorAll('.qty-minus').forEach(btn => {
            btn.addEventListener('click', (e) => updateQuantity(e.target.dataset.id, -1));
        });
        document.querySelectorAll('.qty-plus').forEach(btn => {
            btn.addEventListener('click', (e) => updateQuantity(e.target.dataset.id, 1));
        });
    }
});
