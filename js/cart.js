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

    // ==========================================
    // ACTION BUTTONS (HOLD, KOT, BILL) LOGIC
    // ==========================================
    const holdBtn = document.getElementById('holdBtn');
    const kotBtn = document.getElementById('kotBtn');
    const checkoutBtn = document.getElementById('checkoutBtn');
    const printArea = document.getElementById('printArea');
    const backToTablesBtn = document.getElementById('backToTablesBtn');

    // 1. HOLD: Wapas Table Selection par bhej do (Data LocalStorage me safe rahega)
    holdBtn.addEventListener('click', () => {
        backToTablesBtn.click();
    });

    // 2. KOT: Kitchen Order Ticket
    kotBtn.addEventListener('click', () => {
        if (currentCart.length === 0) {
            alert("Cart empty hai! Pehle item add karo.");
            return;
        }
        
        const tableName = getCurrentTable();
        
        // KOT ka HTML design
        let kotHtml = `
            <div class="print-header">
                <h2>K.O.T</h2>
                <p>${tableName}</p>
                <p>Time: ${new Date().toLocaleTimeString()}</p>
            </div>
            <div class="print-divider"></div>
            <div class="print-item" style="font-weight: bold;">
                <span style="flex:1;">Item</span>
                <span style="width: 30px; text-align: right;">Qty</span>
            </div>
            <div class="print-divider"></div>
        `;
        
        currentCart.forEach(item => {
            kotHtml += `
                <div class="print-item">
                    <span style="flex:1; padding-right: 5px;">${item.name}</span>
                    <span style="width: 30px; text-align: right;">x${item.qty}</span>
                </div>
            `;
        });
        
        kotHtml += `<div class="print-divider"></div>`;
        
        // Print Area me dal kar Print dialogue open karo
        printArea.innerHTML = kotHtml;
        window.print();
    });

    // 3. BILL & SETTLE: Final Bill Parchi
    checkoutBtn.addEventListener('click', () => {
        if (currentCart.length === 0) {
            alert("Cart empty hai!");
            return;
        }

        const tableName = getCurrentTable();
        let total = 0;
        
        // Final Bill ka HTML design
        let billHtml = `
            <div class="print-header">
                <h2>NEW PIZZA HUT</h2>
                <p style="font-size: 10px;">Live Cake | Salempur, Deoria</p>
                <p style="margin-top:5px;">Bill: ${tableName}</p>
                <p>Date: ${new Date().toLocaleDateString()}</p>
            </div>
            <div class="print-divider"></div>
            <div class="print-item" style="font-weight: bold;">
                <span style="flex:2;">Item</span>
                <span style="flex:1; text-align:center;">Qty</span>
                <span style="flex:1; text-align:right;">Amt</span>
            </div>
            <div class="print-divider"></div>
        `;
        
        currentCart.forEach(item => {
            let amt = item.price * item.qty;
            total += amt;
            billHtml += `
                <div class="print-item">
                    <span style="flex:2; padding-right: 5px;">${item.name}</span>
                    <span style="flex:1; text-align:center;">${item.qty}</span>
                    <span style="flex:1; text-align:right;">${amt}</span>
                </div>
            `;
        });
        
        billHtml += `
            <div class="print-divider"></div>
            <div class="print-total">
                <span>TOTAL</span>
                <span>Rs ${total}</span>
            </div>
            <div style="text-align:center; margin-top:15px; font-size:10px;">
                Thank you for visiting!
            </div>
        `;
        
        printArea.innerHTML = billHtml;
        window.print(); // Print preview popup

        // Parchi ban gayi, ab table ka khata clear karo
        saveLocalCart(tableName, []); // Save empty array
        currentCart = [];
        renderCart(); // UI Khali karo
        
        // 0.5 sec baad user ko wapas grid pe le jao (Print lagne ke baad)
        setTimeout(() => {
            backToTablesBtn.click();
        }, 500); 
    });

});
