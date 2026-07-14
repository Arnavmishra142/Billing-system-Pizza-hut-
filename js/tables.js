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

        // Generate Grid (Tables / Parcels) with Live Items
    let currentGridType = 'table';

    const switchGridBtn = document.getElementById('switchGridBtn');
    switchGridBtn.addEventListener('click', () => {
        loadGrid(currentGridType === 'table' ? 'parcel' : 'table');
    });

    function loadGrid(type) {
        currentGridType = type;
        dynamicGrid.innerHTML = ''; 
        let totalCount = 10;
        let prefix = type === 'table' ? 'Table' : 'Parcel';

        // Update switch button to show the opposite destination
        switchGridBtn.textContent = type === 'table' ? '📦 Parcels' : '🪑 Tables';

        gridTitle.innerText = `Select ${prefix}`;

        for (let i = 1; i <= totalCount; i++) {
            const card = document.createElement('div');
            let tableName = type === 'parcel' ? `${prefix} ${String.fromCharCode(64 + i)}` : `${prefix} ${i}`;
            
            let isOccupied = false;
            let tableItemsHTML = "";
            let itemCount = 0;
            let earliestKotTime = null; // Sabse purana KOT time is table ke liye

            // LocalStorage se is table ka cart data nikalo
            for (let j = 0; j < localStorage.length; j++) {
                const key = localStorage.key(j);
                if (key.startsWith(`cart_${tableName}_`)) {
                    isOccupied = true;
                    try {
                        let cartData = JSON.parse(localStorage.getItem(key));
                        if (cartData && cartData.length > 0) {
                            cartData.forEach(item => {
                                itemCount++;
                                // Sirf shuruat ke 4 items dikhayenge, baki ko hide karenge
                                if (itemCount <= 7) {
                                    tableItemsHTML += `<div class="table-item-row">${item.name} <span style="font-weight:bold; color:#059669;">x${item.qty}</span></div>`;
                                }
                            });
                        }
                    } catch(e) {}
                }
                if (key.startsWith(`kotTime_${tableName}_`)) {
                    const ts = parseInt(localStorage.getItem(key));
                    if (!isNaN(ts) && (earliestKotTime === null || ts < earliestKotTime)) {
                        earliestKotTime = ts;
                    }
                }
            }

            let timerBadgeHTML = earliestKotTime ? `<span class="order-timer" data-start="${earliestKotTime}">⏱ 0m</span>` : '';

            // Agar 4 se zyada items hain, toh "See more" dikhao
            if (itemCount > 4) {
                tableItemsHTML += `<div class="table-item-more">+ ${itemCount - 4} more items...</div>`;
            }

            card.className = isOccupied ? 'table-card status-hold' : 'table-card status-empty'; 
            
            // Card ke andar ka HTML structure (Table name + Items list)
            card.innerHTML = `
                <div class="table-name-header"><span>${tableName}</span>${timerBadgeHTML}</div>
                <div class="table-items-container">
                    ${isOccupied && itemCount > 0 ? tableItemsHTML : '<div class="table-empty-text">Empty</div>'}
                </div>
            `;
            
            card.addEventListener('click', () => {
                openPOS(tableName);
            });
            
            dynamicGrid.appendChild(card);
        }

        screenHome.classList.remove('active');
        screenHome.classList.add('hidden');
        screenGrid.classList.remove('hidden');
        screenGrid.classList.add('active');

        refreshTimers();
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
        renderRunningOrders(); // Home dikh raha hai, isliye ab list fresh honi chahiye
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

    // Render Running Orders List (Tables left, Parcels right, divider beech mein)
    function renderRunningOrders() {
        const container = document.getElementById('runningOrdersContainer');
        if(!container) return;

        // Skeleton: do columns + thin divider
        container.innerHTML = `
            <div class="running-split">
                <div class="running-col">
                    <div class="running-col-title">🍽️ Tables</div>
                    <div class="running-col-body" id="runningTablesCol"></div>
                </div>
                <div class="running-col-divider"></div>
                <div class="running-col">
                    <div class="running-col-title">📦 Parcels</div>
                    <div class="running-col-body" id="runningParcelsCol"></div>
                </div>
            </div>
        `;

        const tablesCol = document.getElementById('runningTablesCol');
        const parcelsCol = document.getElementById('runningParcelsCol');
        let hasTableOrders = false;
        let hasParcelOrders = false;

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
                    let total = cartData.reduce((sum, item) => sum + (item.price * item.qty), 0);
                    let itemCount = cartData.reduce((sum, item) => sum + item.qty, 0);
                    
                    const isParcel = tableName.includes('Parcel');
                    let displayName = tableName;
                    if (!isParcel) {
                        displayName += ` (${customerId})`; 
                    }

                    // Is specific order ka KOT time (agar KOT print ho chuka hai)
                    const kotTs = parseInt(localStorage.getItem(`kotTime_${tableName}_${customerId}`));
                    const rcTimerHTML = !isNaN(kotTs) ? `<span class="order-timer" data-start="${kotTs}">⏱ 0m</span>` : '';

                    const card = document.createElement('div');
                    card.className = 'running-card';
                    card.innerHTML = `
                        <span class="rc-title">${displayName}</span>
                        <span class="rc-amount">₹${total.toFixed(2)}</span>
                        <span class="rc-items">${itemCount} Items</span>
                        ${rcTimerHTML}
                    `;
                    card.addEventListener('click', () => {
                        openPOS(tableName, customerId);
                    });

                    if (isParcel) {
                        hasParcelOrders = true;
                        parcelsCol.appendChild(card);
                    } else {
                        hasTableOrders = true;
                        tablesCol.appendChild(card);
                    }
                }
            }
        }
        if (!hasTableOrders) {
            tablesCol.innerHTML = `<span class="running-col-empty">No active tables</span>`;
        }
        if (!hasParcelOrders) {
            parcelsCol.innerHTML = `<span class="running-col-empty">No active parcels</span>`;
        }

        refreshTimers();
    }

    // =====================================
    // ⏱ LIVE ORDER TIMER (KOT print hone ke baad se)
    // =====================================
    function refreshTimers() {
        document.querySelectorAll('.order-timer').forEach(el => {
            const start = parseInt(el.dataset.start);
            if (isNaN(start)) return;

            const mins = Math.max(0, Math.floor((Date.now() - start) / 60000));
            el.innerText = `⏱ ${mins}m`;

            el.classList.remove('timer-ok', 'timer-warn', 'timer-danger');
            if (mins >= 30) {
                el.classList.add('timer-danger');
            } else if (mins >= 15) {
                el.classList.add('timer-warn');
            } else {
                el.classList.add('timer-ok');
            }
        });
    }

    setInterval(refreshTimers, 30000); // Har 30 sec mein sab timers live update honge

    renderRunningOrders();

    // Running Orders sirf tab rebuild karo jab home screen actually dikh raha ho.
    // Pehle ye HAR cart change (item add, qty+/-, KOT ke baad) pe chalta tha,
    // chahe user POS screen ke andar ho - isi wajah se Full KOT print karte
    // waqt lag/lag mehsoos hota tha, kyunki ye heavy rebuild beech mein aa jaata tha.
    window.addEventListener('cart-updated', () => {
        if (screenHome.classList.contains('active')) {
            renderRunningOrders();
        }
    });
});
