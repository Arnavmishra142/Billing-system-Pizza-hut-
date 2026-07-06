// Database import (Firebase aage ke sync ke liye)
import { db } from './firebase-config.js';

document.addEventListener('DOMContentLoaded', () => {
    
    // ==========================================
    // DOM ELEMENTS
    // ==========================================
    // Screens
    const screenHome = document.getElementById('screen-home');
    const screenGrid = document.getElementById('screen-grid');
    const screenPos = document.getElementById('screen-pos');
    
    // Grid Elements
    const dynamicGrid = document.getElementById('dynamicGrid');
    const gridTitle = document.getElementById('gridTitle');
    
    // POS Elements
    const activeTableName = document.getElementById('activeTableName');
    const customerTabsContainer = document.getElementById('customerTabsContainer');
    
    // Buttons
    const btnTables = document.getElementById('btn-tables');
    const btnParcel = document.getElementById('btn-parcel');
    const backToHomeBtn = document.getElementById('backToHomeBtn');
    const backToTablesBtn = document.getElementById('backToTablesBtn');

    // ==========================================
    // 1. GENERATE GRID LOGIC (Tables / Parcels)
    // ==========================================
    function loadGrid(type) {
        dynamicGrid.innerHTML = ''; // Pehle ka clear karo
        
        let totalCount = 10;
        let prefix = type === 'table' ? 'Table' : 'Parcel';
        
        gridTitle.innerText = `Select ${prefix}`;

        for (let i = 1; i <= totalCount; i++) {
            const card = document.createElement('div');
            
            // Check karo agar is table ka pehle se order running hai
            const existingCart = JSON.parse(localStorage.getItem(`cart_${prefix} ${i}`));
            if (existingCart && existingCart.length > 0) {
                card.className = 'table-card status-hold'; // Yellow border agar occupied hai
            } else {
                card.className = 'table-card status-empty'; // Green border agar khali hai
            }
            
            card.innerText = `${prefix} ${i}`;
            
            // Click karne par POS screen khulegi
            card.addEventListener('click', () => {
                openPOS(`${prefix} ${i}`);
            });
            
            dynamicGrid.appendChild(card);
        }

        // Screen switch: Home -> Grid
        screenHome.classList.remove('active');
        screenHome.classList.add('hidden');
        
        screenGrid.classList.remove('hidden');
        screenGrid.classList.add('active');
    }

    // Home button events
    btnTables.addEventListener('click', () => loadGrid('table'));
    btnParcel.addEventListener('click', () => loadGrid('parcel'));

    // Back to Home event
    backToHomeBtn.addEventListener('click', () => {
        screenGrid.classList.remove('active');
        screenGrid.classList.add('hidden');
        
        screenHome.classList.remove('hidden');
        screenHome.classList.add('active');
    });


    // ==========================================
    // 2. OPEN POS SCREEN LOGIC
    // ==========================================
    function openPOS(name) {
        // Table/Parcel ka naam header me update karo
        activeTableName.innerText = name;
        
        // Screen Switch: Grid/Home -> POS
        screenGrid.classList.remove('active');
        screenGrid.classList.add('hidden');
        screenHome.classList.remove('active'); // Agar direct running order se click kiya ho
        screenHome.classList.add('hidden');
        
        screenPos.classList.remove('hidden');
        screenPos.classList.add('active');
        
        // Naya table khulne pe default C1 tab set karo
        resetTabs();
        
        // cart.js ko signal bhejo ki is naye table ka data LocalStorage se load kare
        window.dispatchEvent(new Event('load-table-cart'));
    }

    // Back to Grid from POS event
    backToTablesBtn.addEventListener('click', () => {
        screenPos.classList.remove('active');
        screenPos.classList.add('hidden');
        
        // Wapas grid pe jate waqt title ke hisaab se reload karo (taki status colours update ho jaye)
        const isTable = gridTitle.innerText.includes('Table');
        loadGrid(isTable ? 'table' : 'parcel');
    });


    // ==========================================
    // 3. CUSTOMER TABS (C1, C2) LOGIC
    // ==========================================
    let customerCount = 1;

    function handleTabClick(e) {
        if(e.target.id === 'addCustomerBtn') return; 
        
        document.querySelectorAll('.customer-tabs .tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        
        console.log(`Switched to: ${e.target.dataset.id}`);
    }

    function resetTabs() {
        customerCount = 1;
        customerTabsContainer.innerHTML = `
            <button class="tab active" data-id="C1">Customer 1</button>
            <button class="tab add-tab-btn" id="addCustomerBtn">+</button>
        `;
        
        document.querySelector('.tab[data-id="C1"]').addEventListener('click', handleTabClick);
        
        const newAddBtn = document.getElementById('addCustomerBtn');
        newAddBtn.addEventListener('click', () => {
            customerCount++;
            const newTabId = `C${customerCount}`;
            
            const newTab = document.createElement('button');
            newTab.className = 'tab';
            newTab.dataset.id = newTabId;
            newTab.innerText = `Customer ${customerCount}`;
            newTab.addEventListener('click', handleTabClick);
            
            customerTabsContainer.insertBefore(newTab, newAddBtn);
            newTab.click(); 
        });
    }

    // ==========================================
    // 4. RUNNING ORDERS (HOME SCREEN) LOGIC
    // ==========================================
    function renderRunningOrders() {
        const container = document.getElementById('runningOrdersContainer');
        if(!container) return;
        
        container.innerHTML = ''; // Pehle ka data clear karo
        let hasRunningOrders = false;

        // LocalStorage me jitne bhi cart_ wale item hain unko dhundo
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            
            if (key.startsWith('cart_')) {
                const tableName = key.replace('cart_', '');
                const cartData = JSON.parse(localStorage.getItem(key));

                // Agar cart me actually items hain
                if (cartData && cartData.length > 0) {
                    hasRunningOrders = true;
                    
                    let total = cartData.reduce((sum, item) => sum + (item.price * item.qty), 0);
                    let itemCount = cartData.reduce((sum, item) => sum + item.qty, 0);

                    const card = document.createElement('div');
                    card.className = 'running-card';
                    card.innerHTML = `
                        <span class="rc-title">${tableName}</span>
                        <span class="rc-amount">₹${total.toFixed(2)}</span>
                        <span class="rc-items">${itemCount} Items</span>
                    `;

                    // Card pe click karte hi direct POS khul jayega
                    card.addEventListener('click', () => {
                        openPOS(tableName);
                    });

                    container.appendChild(card);
                }
            }
        }

        // Agar ek bhi running order nahi hai toh message dikhao
        if (!hasRunningOrders) {
            container.innerHTML = `<span style="color: #6b7280; padding-left: 10px; font-style: italic;">No active orders right now.</span>`;
        }
    }

    // App load hote hi running orders render karo
    renderRunningOrders();
    
    // Jab bhi cart.js me kuch add/remove ho, yeh auto-refresh hoga
    window.addEventListener('cart-updated', renderRunningOrders);

});
