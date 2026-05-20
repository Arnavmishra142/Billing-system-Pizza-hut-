document.addEventListener('DOMContentLoaded', () => {
    const cartItemsContainer = document.getElementById('cartItems');
    const cartTotalElement = document.getElementById('cartTotal');

    // Cart array jisme saare selected items rahenge
    let cart = [];

    // 1. LISTEN FOR CLICKS FROM MENU.JS
    // Jab menu.js me item par click hoga, wo ek signal bhejega jo hum yahan catch kar rahe hain
    window.addEventListener('add-to-cart', (e) => {
        const item = e.detail;
        addToCart(item);
    });

    // 2. ADD TO CART LOGIC (Handle 1x, 2x, 3x)
    function addToCart(newItem) {
        // Check karo ki item pehle se cart me hai kya (ID ke base par)
        const existingItem = cart.find(item => item.id === newItem.id);

        if (existingItem) {
            // Agar pehle se hai, toh sirf quantity badhao
            existingItem.qty += 1;
        } else {
            // Agar naya hai, toh array me naya object push karo with qty: 1
            cart.push({
                id: newItem.id,
                name: newItem.name,
                price: newItem.price,
                qty: 1
            });
        }
        
        // Cart UI ko update karo
        renderCart();
    }

    // 3. INCREASE / DECREASE QUANTITY LOGIC (+ / - Buttons)
    function updateQuantity(id, delta) {
        const itemIndex = cart.findIndex(item => item.id === id);
        
        if (itemIndex > -1) {
            cart[itemIndex].qty += delta;
            
            // Agar quantity 0 ya usse kam ho jaye, toh item ko cart se hata do
            if (cart[itemIndex].qty <= 0) {
                cart.splice(itemIndex, 1);
            }
            
            renderCart();
        }
    }

    // 4. RENDER CART ON SCREEN
    function renderCart() {
        cartItemsContainer.innerHTML = ''; // Pehle purana HTML clear karo
        let totalAmount = 0;

        // Agar cart khali hai toh ek simple message dikhao
        if (cart.length === 0) {
            cartItemsContainer.innerHTML = `
                <div style="text-align: center; color: #9ca3af; margin-top: 50px; font-weight: bold;">
                    Cart is empty <br> <span style="font-size: 0.8rem; font-weight: normal;">Click items to add</span>
                </div>
            `;
            cartTotalElement.innerText = '₹0.00';
            return;
        }

        // Cart ke har item ka HTML box generate karo
        cart.forEach(item => {
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

        // Niche Grand Total update karo
        cartTotalElement.innerText = `₹${totalAmount.toFixed(2)}`;

        // Naye generated + aur - buttons par click event lagao
        document.querySelectorAll('.qty-minus').forEach(btn => {
            btn.addEventListener('click', (e) => {
                updateQuantity(e.target.dataset.id, -1);
            });
        });

        document.querySelectorAll('.qty-plus').forEach(btn => {
            btn.addEventListener('click', (e) => {
                updateQuantity(e.target.dataset.id, 1);
            });
        });
    }

    // Load hote hi ek baar khali cart render kar do
    renderCart();
});
