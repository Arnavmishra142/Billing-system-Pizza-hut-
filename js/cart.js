import { db } from './firebase-config.js';
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', () => {
    const cartItemsContainer = document.getElementById('cartItems');
    const cartTotalElement = document.getElementById('cartTotal');
    const activeTableNameEl = document.getElementById('activeTableName');

    let currentCart = [];

    const getCurrentTable = () => activeTableNameEl.innerText;
    const getCurrentCustomer = () => activeTableNameEl.dataset.customer || 'C1';
    
    const getCartKey = () => `cart_${getCurrentTable()}_${getCurrentCustomer()}`;

    const getLocalCart = () => {
        const data = localStorage.getItem(getCartKey());
        return data ? JSON.parse(data) : [];
    };

    const saveLocalCart = (cartData) => {
        const key = getCartKey();
        if (cartData.length === 0) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, JSON.stringify(cartData));
        }
        window.dispatchEvent(new Event('cart-updated'));
    };

    // UI Updates based on POS mode
    window.addEventListener('pos-opened', (e) => {
        const name = e.detail.name;
        const holdBtn = document.getElementById('holdBtn');
        const kotBtn = document.getElementById('kotBtn');
        const saveExitBtn = document.getElementById('saveExitBtn');

        if (name === 'Direct Entry') {
            if(holdBtn) holdBtn.style.display = 'none';
            if(kotBtn) kotBtn.style.display = 'none';
            if(saveExitBtn) {
                saveExitBtn.innerText = "SAVE ENTRY"; 
                saveExitBtn.style.gridColumn = "span 2"; 
            }
        } else {
            if(holdBtn) holdBtn.style.display = 'block';
            if(kotBtn) kotBtn.style.display = 'block';
            if(saveExitBtn) {
                saveExitBtn.innerText = "SAVE & EXIT";
                saveExitBtn.style.gridColumn = "auto";
            }
        }
    });

    window.addEventListener('add-to-cart', (e) => {
        const item = e.detail;
        currentCart = getLocalCart();
        const existingItem = currentCart.find(i => i.id === item.id);
        if (existingItem) {
            existingItem.qty += 1;
        } else {
            currentCart.push({ id: item.id, name: item.name, price: item.price, qty: 1, printedQty: 0 });
        }
        saveLocalCart(currentCart);
        renderCart();
    });

    window.addEventListener('add-custom-item-to-bill', (e) => {
        const item = e.detail;
        currentCart = getLocalCart();
        currentCart.push({ id: item.id, name: item.name, price: item.price, qty: 1, printedQty: 0 });
        saveLocalCart(currentCart);
        renderCart();
    });

    function updateQuantity(id, delta) {
        currentCart = getLocalCart();
        const itemIndex = currentCart.findIndex(item => item.id === id);
        if (itemIndex > -1) {
            currentCart[itemIndex].qty += delta;
            
            if ((currentCart[itemIndex].printedQty || 0) > currentCart[itemIndex].qty) {
                currentCart[itemIndex].printedQty = currentCart[itemIndex].qty;
            }

            if (currentCart[itemIndex].qty <= 0) currentCart.splice(itemIndex, 1);
            saveLocalCart(currentCart);
            renderCart();
        }
    }

    window.addEventListener('load-table-cart', () => {
        currentCart = getLocalCart();
        renderCart();
    });

    function renderCart() {
        cartItemsContainer.innerHTML = '';
        let totalAmount = 0;

        let fullKotBtn = document.getElementById('fullKotBtn');
        const kotBtn = document.getElementById('kotBtn');
        
        if(!fullKotBtn && kotBtn) {
            fullKotBtn = document.createElement('button');
            fullKotBtn.id = 'fullKotBtn';
            fullKotBtn.className = 'btn';
            fullKotBtn.style.background = '#8b5cf6'; 
            fullKotBtn.innerText = 'PRINT FULL K.O.T';
            fullKotBtn.style.display = 'none';
            fullKotBtn.style.gridColumn = 'span 2'; 
            
            const actionGrid = kotBtn.parentNode;
            if(actionGrid) {
                actionGrid.insertBefore(fullKotBtn, actionGrid.firstChild);
            }
            
            fullKotBtn.addEventListener('click', () => printKOT(true)); 
        }

        let hasPrintedItems = currentCart.some(item => (item.printedQty || 0) > 0);
        
        if (fullKotBtn) {
            if (hasPrintedItems && activeTableNameEl.innerText !== 'Direct Entry') {
                fullKotBtn.style.display = 'block';
            } else {
                fullKotBtn.style.display = 'none';
            }
        }

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

            let unprintedQty = item.qty - (item.printedQty || 0);
            let unprintedTag = unprintedQty > 0 ? `<span style="background: #ef4444; color: white; font-size: 0.7rem; padding: 2px 5px; border-radius: 4px; margin-left: 5px;">+${unprintedQty} New</span>` : '';

            const cartItemDiv = document.createElement('div');
            cartItemDiv.className = 'cart-item';
            cartItemDiv.innerHTML = `
                <div class="cart-item-header">
                    <span>${item.name} ${unprintedTag}</span>
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

        document.querySelectorAll('.qty-minus').forEach(btn => {
            btn.addEventListener('click', (e) => updateQuantity(e.target.dataset.id, -1));
        });
        document.querySelectorAll('.qty-plus').forEach(btn => {
            btn.addEventListener('click', (e) => updateQuantity(e.target.dataset.id, 1));
        });
    }

    const holdBtn = document.getElementById('holdBtn');
    const kotBtn = document.getElementById('kotBtn');
    const checkoutBtn = document.getElementById('checkoutBtn');
    const saveExitBtn = document.getElementById('saveExitBtn'); 
    const backToTablesBtn = document.getElementById('backToTablesBtn');

    const getDisplayTitle = () => {
        const tName = getCurrentTable();
        if(tName === 'Direct Entry') return tName;
        return tName.includes('Parcel') ? tName : `${tName} [${getCurrentCustomer()}]`;
    };

    if (holdBtn) holdBtn.addEventListener('click', () => backToTablesBtn.click());

    const centerText = (text) => {
        if (text.length >= 32) return text.substring(0, 32);
        const spaces = Math.floor((32 - text.length) / 2);
        return " ".repeat(spaces) + text;
    };

    const rightText = (text) => {
        if (text.length >= 32) return text.substring(0, 32);
        const spaces = 32 - text.length;
        return " ".repeat(spaces) + text;
    };

    const printKOT = (isFullKot = false) => {
        if (currentCart.length === 0) return;
        
        let itemsToPrint = [];
        
        if (isFullKot) {
            itemsToPrint = currentCart.map(item => ({...item, printQty: item.qty}));
        } else {
            itemsToPrint = currentCart
                .filter(item => item.qty > (item.printedQty || 0))
                .map(item => ({...item, printQty: item.qty - (item.printedQty || 0)}));
        }

        if (itemsToPrint.length === 0) {
            alert("Koi naya item nahi hai! Agar puraana order print karna hai toh 'PRINT FULL K.O.T' dabayein.");
            return;
        }

        let kotText = "\n";
        kotText += centerText(isFullKot ? "--- FULL K.O.T ---" : "------- K.O.T -------") + "\n";
        kotText += centerText(`Table: ${getDisplayTitle()}`) + "\n";
        kotText += centerText(`Time: ${new Date().toLocaleTimeString('en-IN')}`) + "\n";
        kotText += "--------------------------------\n";
        kotText += "Item                         Qty\n";
        kotText += "--------------------------------\n";
        
        itemsToPrint.forEach(item => {
            let n = item.name.length > 25 ? item.name.substring(0, 23) + ".." : item.name.padEnd(25, " ");
            let q = String(item.printQty).padStart(2, " ") + "x ";
            kotText += `${n}  ${q}\n`;
        });
        
        kotText += "--------------------------------\n";
        kotText += "\n\n\n"; 
        
        currentCart.forEach(item => {
            item.printedQty = item.qty; 
        });
        saveLocalCart(currentCart); 
        renderCart(); 

        window.location.href = "rawbt:" + encodeURIComponent(kotText);
    };

    if (kotBtn) kotBtn.addEventListener('click', () => printKOT(false));

    // =====================================
    // CHECKOUT LOGIC
    // =====================================
    if (checkoutBtn) {
        checkoutBtn.addEventListener('click', async () => {
            if (currentCart.length === 0) return;
            const tableName = getCurrentTable();
            const customerName = getCurrentCustomer();
            const total = currentCart.reduce((sum, item) => sum + (item.price * item.qty), 0);
            checkoutBtn.innerText = "Processing...";
            checkoutBtn.disabled = true;

            try {
                await setDoc(doc(db, "sales_history", `SALE_${Date.now()}`), {
                    table: tableName,
                    customer: customerName,
                    items: currentCart,
                    total: total,
                    timestamp: new Date().toISOString()
                });

                // GLOBAL GHOST HISTORY MEIN SAVE KARO (For Drawer)
                if(window.saveToGhostHistory) {
                    let orderId = tableName.includes('Parcel') ? tableName : `${tableName} [${customerName}]`;
                    window.saveToGhostHistory(orderId, total, currentCart);
                }

                let billText = "\n";
                billText += centerText("NEW PIZZA HUT") + "\n";
                billText += centerText("Live Cake | Salempur") + "\n";
                billText += "--------------------------------\n";
                billText += `Bill: ${getDisplayTitle()}\n`;
                billText += `Date: ${new Date().toLocaleString('en-IN')}\n`;
                billText += "--------------------------------\n";
                billText += "Item                Qty      Amt\n";
                billText += "--------------------------------\n";
                
                currentCart.forEach(item => {
                    let n = item.name.length > 16 ? item.name.substring(0, 14) + ".." : item.name.padEnd(16, " ");
                    let q = String(item.qty).padStart(2, " ") + "x";
                    let a = String(item.price * item.qty).padStart(6, " ");
                    billText += `${n}    ${q}   ${a}\n`;
                });
                
                billText += "--------------------------------\n";
                billText += rightText(`TOTAL: Rs ${total}`) + "\n";
                billText += "--------------------------------\n";
                billText += centerText("Thank You! Visit Again") + "\n\n";
                
                billText += centerText("--- UPI PAYMENT ---") + "\n";
                billText += centerText("6393349498@fam") + "\n";
                billText += centerText("(Pay via PhonePe/GPay)") + "\n";
                
                billText += "\n\n\n\n";
                
                window.location.href = "rawbt:" + encodeURIComponent(billText);

                saveLocalCart([]); 
                currentCart = [];
                renderCart(); 
                setTimeout(() => { if(backToTablesBtn) backToTablesBtn.click() }, 500); 
            } catch (error) {
                alert("Database error!");
            } finally {
                checkoutBtn.innerText = "Bill & Settle";
                checkoutBtn.disabled = false;
            }
        });
    }

    // =====================================
    // SAVE & EXIT LOGIC
    // =====================================
    if (saveExitBtn) {
        saveExitBtn.addEventListener('click', async () => {
            if (currentCart.length === 0) {
                if (backToTablesBtn) backToTablesBtn.click(); 
                return;
            }
            const tableName = getCurrentTable();
            const customerName = getCurrentCustomer();
            const total = currentCart.reduce((sum, item) => sum + (item.price * item.qty), 0);
            
            const textBackup = saveExitBtn.innerText;
            saveExitBtn.innerText = "Saving...";
            saveExitBtn.disabled = true;

            try {
                await setDoc(doc(db, "sales_history", `SALE_${Date.now()}`), {
                    table: tableName,
                    customer: customerName,
                    items: currentCart,
                    total: total,
                    timestamp: new Date().toISOString()
                });

                // GLOBAL GHOST HISTORY MEIN SAVE KARO (For Drawer)
                if(window.saveToGhostHistory) {
                    let orderId = tableName.includes('Parcel') ? tableName : `${tableName} [${customerName}]`;
                    window.saveToGhostHistory(orderId + " (HOLD)", total, currentCart);
                }

                saveLocalCart([]); 
                currentCart = [];
                renderCart();
                if (backToTablesBtn) backToTablesBtn.click();
            } catch (e) {
                alert("Database save fail!");
            } finally {
                saveExitBtn.innerText = textBackup;
                saveExitBtn.disabled = false;
            }
        });
    }
});
