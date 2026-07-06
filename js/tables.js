import { db } from './firebase-config.js';

document.addEventListener('DOMContentLoaded', () => {
    
    const screenHome = document.getElementById('screen-home');
    const screenGrid = document.getElementById('screen-grid');
    const screenPos = document.getElementById('screen-pos');
    
    const dynamicGrid = document.getElementById('dynamicGrid');
    const gridTitle = document.getElementById('gridTitle');
    
    const activeTableName = document.getElementById('activeTableName');
    const customerTabsContainer = document.getElementById('customerTabsContainer');
    
    const btnTables = document.getElementById('btn-tables');
    const btnParcel = document.getElementById('btn-parcel');
    const btnDirectSale = document.getElementById('btn-direct-sale'); // Naya button
    const backToHomeBtn = document.getElementById('backToHomeBtn');
    const backToTablesBtn = document.getElementById('backToTablesBtn');

    // Generate Grid (Tables / Parcels)
    function loadGrid(type) {
        dynamicGrid.innerHTML = ''; 
        let totalCount = 10;
        let prefix = type === 'table' ? 'Table' : 'Parcel';
        
        gridTitle.innerText = `Select ${prefix}`;

        for (let i = 1; i <= totalCount; i++) {
            const card = document.createElement('div');
            
            let isOccupied = false;
            for (let j = 0; j < localStorage.length; j++) {
                if (localStorage.key(j).startsWith(`cart_${prefix} ${i}_`)) {
                    isOccupied = true;
                    break;
                }
            }

            card.className = isOccupied ? 'table-card status-hold' : 'table-card status-empty'; 
            card.innerText = `${prefix} ${i}`;
            
            card.addEventListener('click', () => {
                openPOS(`${prefix} ${i}`);
            });
            
            dynamicGrid.appendChild(card);
        }

        screenHome.classList.remove('active');
        screenHome.classList.add('hidden');
        screenGrid.classList.remove('hidden');
        screenGrid.classList.add('active');
    }

    btnTables.addEventListener('click', () => loadGrid('table'));
    btnParcel.addEventListener('click', () => loadGrid('parcel'));

    // NAYA: DIRECT EXPRESS ENTRY LOGIC (Bypasses Table Grid)
    if(btnDirectSale) {
        btnDirectSale.addEventListener('click', () => {
            openPOS('Direct Entry', 'C1');
        });
    }

    backToHomeBtn.addEventListener('click', () => {
        screenGrid.classList.remove('active');
        screenGrid.classList.add('hidden');
        screenHome.classList.remove('hidden');
        screenHome.classList.add('active');
    });

    // Open POS Screen
    function openPOS(name, targetTab = 'C1') {
        activeTableName.innerText = name;
        activeTableName.dataset.customer = targetTab; 
        
        // Signal grid/cart types to check for button hides
        window.dispatchEvent(new CustomEvent('pos-opened', { detail: { name: name } }));
        
        // Hide tabs for Parcel or Direct Entry
        if (name.includes('Parcel') || name === 'Direct Entry') {
            customerTabsContainer.style.display = 'none';
        } else {
            customerTabsContainer.style.display = 'flex';
        }
        
        screenGrid.classList.remove('active');
        screenGrid.classList.add('hidden');
        screenHome.classList.remove('active'); 
        screenHome.classList.add('hidden');
        
        screenPos.classList.remove('hidden');
        screenPos.classList.add('active');
        
        if (name !== 'Direct Entry') {
            resetTabs(targetTab);
        }
        window.dispatchEvent(new Event('load-table-cart'));
    }

    backToTablesBtn.addEventListener('click', () => {
        screenPos.classList.remove('active');
        screenPos.classList.add('hidden');
        
        if(activeTableName.innerText === 'Direct Entry') {
            // Direct sale se sidha home screen par wapas jao
            screenHome.classList.remove('hidden');
            screenHome.classList.add('active');
            renderRunningOrders();
        } else {
            const isTable = gridTitle.innerText.includes('Table');
            loadGrid(isTable ? 'table' : 'parcel');
        }
    });

    // Customer Tabs Generator
    let customerCount = 1;
    function handleTabClick(e) {
        if(e.target.id === 'addCustomerBtn') return; 
        document.querySelectorAll('.customer-tabs .tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        activeTableName.dataset.customer = e.target.dataset.id;
        window.dispatchEvent(new Event('load-table-cart'));
    }

    function resetTabs(targetTab = 'C1') {
        const tableName = activeTableName.innerText;
        if(tableName === 'Direct Entry') return;

        let maxC = 1;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith(`cart_${tableName}_C`)) {
                const cNum = parseInt(key.split('_C')[1]);
                if (cNum > maxC) maxC = cNum;
            }
        }
        
        const targetNum = parseInt(targetTab.replace('C', ''));
        if (targetNum > maxC) maxC = targetNum;

        customerCount = maxC;
        customerTabsContainer.innerHTML = '';
        
        for(let i = 1; i <= maxC; i++) {
            const btn = document.createElement('button');
            btn.className = `tab ${targetTab === 'C'+i ? 'active' : ''}`;
            btn.dataset.id = `C${i}`;
            btn.innerText = `Customer ${i}`;
            btn.addEventListener('click', handleTabClick);
            customerTabsContainer.appendChild(btn);
        }
        
        const addBtn = document.createElement('button');
        addBtn.className = 'tab add-tab-btn';
        addBtn.id = 'addCustomerBtn';
        addBtn.innerText = '+';
        addBtn.addEventListener('click', () => {
            customerCount++;
            const newTabId = `C${customerCount}`;
            const newTab = document.createElement('button');
            newTab.className = 'tab';
            newTab.dataset.id = newTabId;
            newTab.innerText = `Customer ${customerCount}`;
            newTab.addEventListener('click', handleTabClick);
            customerTabsContainer.insertBefore(newTab, document.getElementById('addCustomerBtn'));
            newTab.click(); 
        });
        customerTabsContainer.appendChild(addBtn);
    }

    // Render Running Orders List
    function renderRunningOrders() {
        const container = document.getElementById('runningOrdersContainer');
        if(!container) return;
        container.innerHTML = ''; 
        let hasRunningOrders = false;

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('cart_')) {
                const parts = key.split('_'); 
                if(parts.length !== 3) continue;

                const tableName = parts[1];
                const customerId = parts[2];
                
                if(tableName === 'Direct Entry') continue; // Direct entry carts ignore karo home orders screen par

                const cartData = JSON.parse(localStorage.getItem(key));
                if (cartData && cartData.length > 0) {
                    hasRunningOrders = true;
                    let total = cartData.reduce((sum, item) => sum + (item.price * item.qty), 0);
                    let itemCount = cartData.reduce((sum, item) => sum + item.qty, 0);
                    
                    let displayName = tableName;
                    if (!tableName.includes('Parcel')) {
                        displayName += ` (${customerId})`; 
                    }

                    const card = document.createElement('div');
                    card.className = 'running-card';
                    card.innerHTML = `
                        <span class="rc-title">${displayName}</span>
                        <span class="rc-amount">₹${total.toFixed(2)}</span>
                        <span class="rc-items">${itemCount} Items</span>
                    `;
                    card.addEventListener('click', () => {
                        openPOS(tableName, customerId);
                    });
                    container.appendChild(card);
                }
            }
        }
        if (!hasRunningOrders) {
            container.innerHTML = `<span style="color: #6b7280; font-style: italic;">No active table orders right now.</span>`;
        }
    }

    renderRunningOrders();
    window.addEventListener('cart-updated', renderRunningOrders);
});
