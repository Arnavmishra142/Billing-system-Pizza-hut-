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
    const getKotTimeKey = () => `kotTime_${getCurrentTable()}_${getCurrentCustomer()}`;

    const getLocalCart = () => {
        const data = localStorage.getItem(getCartKey());
        return data ? JSON.parse(data) : [];
    };

    const saveLocalCart = (cartData) => {
        const key = getCartKey();
        if (cartData.length === 0) {
            localStorage.removeItem(key);
            localStorage.removeItem(getKotTimeKey()); 
        } else {
            localStorage.setItem(key, JSON.stringify(cartData));
        }
        window.dispatchEvent(new Event('cart-updated'));
    };

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
            }
        } else {
            if(holdBtn) holdBtn.style.display = 'block';
            if(kotBtn) kotBtn.style.display = 'block';
            if(saveExitBtn) {
                saveExitBtn.innerText = "SAVE & EXIT";
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

    window.addEventListener('set-cart-quantity', (e) => {
        const item = e.detail;
        currentCart = getLocalCart();
        const existingIndex = currentCart.findIndex(i => i.id === item.id);

        if (item.qty <= 0) {
            if (existingIndex > -1) currentCart.splice(existingIndex, 1);
        } else if (existingIndex > -1) {
            currentCart[existingIndex].qty = item.qty;
            if ((currentCart[existingIndex].printedQty || 0) > item.qty) {
                currentCart[existingIndex].printedQty = item.qty;
            }
        } else {
            currentCart.push({ id: item.id, name: item.name, price: item.price, qty: item.qty, printedQty: 0 });
        }

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

    // =====================================
    // RENDER CART (COMPLETE FUNCTION)
    // =====================================
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
            
            // Insert right after KOT: View Details | KOT | PRINT FULL K.O.T | SAVE & EXIT
            kotBtn.insertAdjacentElement('afterend', fullKotBtn);
            
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
                <button class="cart-item-remove" data-id="${item.id}" title="Remove item">✕</button>
                <div class="cart-item-header">
                    <span>${item.name} ${unprintedTag}</span>
                    <span class="editable-price" data-id="${item.id}" style="cursor:pointer; color:#10b981; font-weight:bold; border-bottom:1px dashed #10b981;">
                        ₹${itemTotal}
                    </span>
                </div>
                <div class="cart-item-controls">
                    <span style="color: #4b5563; font-size: 1.1rem; font-weight: bold;">₹${item.price} × ${item.qty}</span>
                    <div class="quantity-control">
                        <button class="qty-btn qty-minus" data-id="${item.id}">−</button>
                        <input type="number" class="qty-input" data-id="${item.id}" value="${item.qty}" min="1">
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

        // Qty input: direct typing → update on change/blur
        document.querySelectorAll('.qty-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const id = e.target.dataset.id;
                const newQty = parseInt(e.target.value, 10);
                const idx = currentCart.findIndex(i => i.id === id);
                if (idx === -1) return;
                if (!isNaN(newQty) && newQty > 0) {
                    if ((currentCart[idx].printedQty || 0) > newQty) {
                        currentCart[idx].printedQty = newQty;
                    }
                    currentCart[idx].qty = newQty;
                } else {
                    currentCart.splice(idx, 1);
                }
                saveLocalCart(currentCart);
                renderCart();
            });
            // Prevent wheel from accidentally changing qty
            input.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
        });

        // Remove button: instant full removal
        document.querySelectorAll('.cart-item-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const idx = currentCart.findIndex(i => i.id === id);
                if (idx !== -1) {
                    currentCart.splice(idx, 1);
                    saveLocalCart(currentCart);
                    renderCart();
                }
            });
        });

        // ✅ CUSTOM MODAL WALA PRICE EDIT — RENDER CART KE ANDAR
        document.querySelectorAll('.editable-price').forEach(span => {
            span.addEventListener('click', (e) => {
                const itemId = e.target.dataset.id;
                let item = currentCart.find(i => i.id === itemId);
                
                const modal = document.getElementById('priceEditModal');
                const itemNameEl = document.getElementById('priceEditItemName');
                const inputEl = document.getElementById('newPriceInput');
                const saveBtn = document.getElementById('savePriceBtn');
                const cancelBtn = document.getElementById('cancelPriceEditBtn');
                
                itemNameEl.textContent = item.name;
                inputEl.value = item.price;
                modal.classList.remove('hidden');
                
                setTimeout(() => inputEl.focus(), 100);
                
                const handleSave = () => {
                    const newPrice = inputEl.value;
                    if (newPrice !== "" && !isNaN(newPrice) && Number(newPrice) > 0) {
                        item.price = Number(newPrice);
                        saveLocalCart(currentCart);
                        renderCart();
                    }
                    modal.classList.add('hidden');
                    cleanup();
                };
                
                const handleCancel = () => {
                    modal.classList.add('hidden');
                    cleanup();
                };
                
                const handleKey = (ev) => {
                    if (ev.key === 'Enter') handleSave();
                    if (ev.key === 'Escape') handleCancel();
                };
                
                const cleanup = () => {
                    saveBtn.removeEventListener('click', handleSave);
                    cancelBtn.removeEventListener('click', handleCancel);
                    inputEl.removeEventListener('keydown', handleKey);
                };
                
                saveBtn.addEventListener('click', handleSave);
                cancelBtn.addEventListener('click', handleCancel);
                inputEl.addEventListener('keydown', handleKey);
            });
        });
    } // renderCart() END

    const holdBtn = document.getElementById('holdBtn');
    const kotBtn = document.getElementById('kotBtn');
    const checkoutBtn = document.getElementById('checkoutBtn');
    const saveExitBtn = document.getElementById('saveExitBtn'); 
    const backToTablesBtn = document.getElementById('backToTablesBtn');

    const getDisplayTitle = () => {
        const tName = getCurrentTable();
        if(tName === 'Direct Entry') return 'Cash Sale';
        return tName; 
    };

    if (holdBtn) holdBtn.addEventListener('click', () => backToTablesBtn.click());

    const triggerRawBTPrint = (text) => {
        const uri = "rawbt:" + encodeURIComponent(text);
        const a = document.createElement('a');
        a.href = uri;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    const centerText = (text) => {
        if (text.length >= 32) return text.substring(0, 32);
        const spaces = Math.floor((32 - text.length) / 2);
        return " ".repeat(spaces) + text;
    };

    const getFormattedDate = () => {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yy = String(now.getFullYear()).slice(-2);
        let hours = now.getHours();
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        return `${dd}/${mm}/${yy} ${hours}:${minutes} ${ampm}`;
    };

    const formatBillRow = (name, qty, rate, total) => {
        let nameLines = [];
        let currentLine = "";
        let words = name.split(" ");
        
        for(let w of words) {
            if((currentLine + w).length > 14) {
                if(currentLine) nameLines.push(currentLine.trim());
                currentLine = w + " ";
            } else {
                currentLine += w + " ";
            }
        }
        if(currentLine) nameLines.push(currentLine.trim());

        let res = "";
        for(let i=0; i<nameLines.length; i++) {
            let line = nameLines[i].padEnd(14, " ");
            if(i === 0) {
                let q = String(qty).padStart(3, " ");
                let r = String(rate).padStart(4, " ");
                let t = String(total).padStart(6, " ");
                res += `${line} ${q} ${r}  ${t}\n`;
            } else {
                res += `${line}\n`;
            }
        }
        return res;
    };

    const printKOT = (isFullKot = false) => {
        if (!currentCart || currentCart.length === 0) return;
        
        const itemsToPrint = isFullKot 
            ? currentCart.map(item => ({name: item.name, printQty: item.qty}))
            : currentCart
                .filter(item => item.qty > (item.printedQty || 0))
                .map(item => ({name: item.name, printQty: item.qty - (item.printedQty || 0)}));

        if (itemsToPrint.length === 0) {
            alert("Koi naya item nahi hai! Puraana order print karne ke liye 'PRINT FULL K.O.T' dabayein.");
            return;
        }

        const kotTimeKey = getKotTimeKey();
        if (!localStorage.getItem(kotTimeKey)) {
            localStorage.setItem(kotTimeKey, Date.now().toString());
        }

        const BOLD_ON = '\x1B\x45\x01';
        const BOLD_OFF = '\x1B\x45\x00';
        const now = new Date();
        const timeStr = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getFullYear()).slice(-2)} ${now.getHours()%12||12}:${String(now.getMinutes()).padStart(2,'0')} ${now.getHours()>=12?'PM':'AM'}`;
        
        let kotText = BOLD_ON;
        if (isFullKot) kotText += "FULL K.O.T\n";
        kotText += `KOT No: ${Math.floor(Math.random()*900)+100}\n`;
        kotText += `Time: ${timeStr}\n`;
        kotText += `Table: ${getDisplayTitle()}\n\n`;
        
        for (const item of itemsToPrint) {
            kotText += `${item.name} (${item.printQty})\n`;
        }
        
        kotText += "\n\n\n" + BOLD_OFF;

        triggerRawBTPrint(kotText);

        setTimeout(() => {
            for (const item of currentCart) {
                item.printedQty = item.qty;
            }
            saveLocalCart(currentCart);
            renderCart();
        }, 0);
    };

    if (kotBtn) {
        kotBtn.addEventListener('click', () => printKOT(false));
    }

    if (checkoutBtn) {
        checkoutBtn.addEventListener('click', async () => {
            if (currentCart.length === 0) return;
            const tableName = getCurrentTable();
            const customerName = getCurrentCustomer();
            const total = currentCart.reduce((sum, item) => sum + (item.price * item.qty), 0);

            // ── Build bill text immediately (no network wait) ──
            const BOLD_ON = '\x1B\x45\x01';
            const BOLD_OFF = '\x1B\x45\x00';
            let shortOrderId = String(Date.now()).slice(-5);
            let billText = BOLD_ON;
            billText += centerText("NEW PIZZA HUT AND LIVE CAKE") + "\n";
            billText += centerText("in front of SBI bank ke tik") + "\n";
            billText += centerText("samne salempur Deoria, UP") + "\n";
            billText += centerText("FSSAI: 30230324113093042") + "\n";
            billText += centerText("Phone: 9628548655") + "\n\n";
            billText += `Bill No: ${shortOrderId}\n`;
            billText += `Created On: ${getFormattedDate()}\n`;
            billText += `Bill To: ${getDisplayTitle()}\n\n`;
            billText += "Item Name      Qty Rate  Total\n\n";
            let totalQty = 0;
            currentCart.forEach(item => {
                totalQty += item.qty;
                billText += formatBillRow(item.name, item.qty, item.price, item.price * item.qty);
            });
            billText += "\n";
            billText += `Total Items: ${currentCart.length}\n`;
            billText += `Total Quantity: ${totalQty}\n`;
            billText += `Sub Total`.padEnd(25, ' ') + String(total).padStart(7, ' ') + "\n\n";
            billText += centerText(`TOTAL: Rs ${total}`) + "\n\n";
            billText += centerText("Thank You! Visit Again!") + "\n\n\n\n" + BOLD_OFF;

            // ── Snapshot cart before clearing ──
            const cartSnapshot = currentCart.slice();

            // ── Instant actions — no Firestore wait ──
            triggerRawBTPrint(billText);           // print fires immediately
            saveLocalCart([]);
            currentCart = [];
            renderCart();
            setTimeout(() => { if (backToTablesBtn) backToTablesBtn.click(); }, 300);

            // ── Save to Firestore in background (fire & forget) ──
            const billId = `SALE_${Date.now()}`;
            setDoc(doc(db, "sales_history", billId), {
                table: tableName,
                customer: customerName,
                items: cartSnapshot,
                total: total,
                timestamp: new Date().toISOString()
            }).catch(err => console.error("Bill save failed:", err));

            if (window.saveToGhostHistory) {
                let orderId = tableName.includes('Parcel') ? tableName : `${tableName} [${customerName}]`;
                window.saveToGhostHistory(orderId, total, cartSnapshot);
            }
        });
    }

    if (saveExitBtn) {
        saveExitBtn.addEventListener('click', () => {
            if (currentCart.length === 0) {
                if (backToTablesBtn) backToTablesBtn.click();
                return;
            }
            const tableName    = getCurrentTable();
            const customerName = getCurrentCustomer();
            const total        = currentCart.reduce((sum, item) => sum + (item.price * item.qty), 0);

            // ── Snapshot cart before clearing ──
            const cartSnapshot = currentCart.slice();

            // ── Instant UI — go back immediately, no network wait ──
            saveLocalCart([]);
            currentCart = [];
            renderCart();
            if (backToTablesBtn) backToTablesBtn.click();

            // ── Save to Firestore in background (fire & forget) ──
            setDoc(doc(db, "sales_history", `SALE_${Date.now()}`), {
                table: tableName,
                customer: customerName,
                items: cartSnapshot,
                total: total,
                timestamp: new Date().toISOString()
            }).catch(err => console.error("Save & Exit Firestore failed:", err));

            if (window.saveToGhostHistory) {
                let orderId = tableName.includes('Parcel') ? tableName : `${tableName} [${customerName}]`;
                window.saveToGhostHistory(orderId + " (HOLD)", total, cartSnapshot);
            }
        });
    }
});
