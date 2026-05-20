// Database import (aage status update karne ke liye kaam aayega)
import { db } from './firebase-config.js';

document.addEventListener('DOMContentLoaded', () => {
    
    // DOM Elements
    const tableGrid = document.getElementById('tableGrid');
    const screenTables = document.getElementById('screen-tables');
    const screenPos = document.getElementById('screen-pos');
    const activeTableName = document.getElementById('activeTableName');
    const backToTablesBtn = document.getElementById('backToTablesBtn');
    
    const customerTabsContainer = document.getElementById('customerTabsContainer');
    const addCustomerBtn = document.getElementById('addCustomerBtn');

    // ==========================================
    // 1. GENERATE TABLES & PACKING CARDS
    // ==========================================
    const totalTables = 10;
    const totalPacking = 5;

    // Generate Table 1 to 10
    for (let i = 1; i <= totalTables; i++) {
        createCard(`Table ${i}`);
    }

    // Generate Packing 1 to 5
    for (let i = 1; i <= totalPacking; i++) {
        createCard(`Packing ${i}`);
    }

    // Function to create HTML card and add click event
    function createCard(name) {
        const card = document.createElement('div');
        card.className = 'table-card status-empty'; // Default empty (Green line)
        card.innerText = name;
        
        // Click karne par POS screen khulegi
        card.addEventListener('click', () => {
            openPOS(name);
        });
        
        tableGrid.appendChild(card);
    }

    // ==========================================
    // 2. SCREEN SWITCHING LOGIC
    // ==========================================
    function openPOS(name) {
        // Upar header me table ka naam update karo
        activeTableName.innerText = name;
        
        // Screen 1 ko chupa do
        screenTables.classList.remove('active');
        screenTables.classList.add('hidden');
        
        // Screen 2 ko dikha do
        screenPos.classList.remove('hidden');
        screenPos.classList.add('active');
        
        // Default tab ko C1 par set karo jab bhi naya table khule
        resetTabs();
    }

    // Back button dabane par wapas Grid par aana
    backToTablesBtn.addEventListener('click', () => {
        screenPos.classList.remove('active');
        screenPos.classList.add('hidden');
        
        screenTables.classList.remove('hidden');
        screenTables.classList.add('active');
    });

    // ==========================================
    // 3. CUSTOMER TABS (C1, C2) LOGIC
    // ==========================================
    let customerCount = 1; // Default 1 customer

    // Function to handle tab click (Active color change karna)
    function handleTabClick(e) {
        if(e.target.id === 'addCustomerBtn') return; // Plus button ignore karo
        
        // Sab tabs se 'active' hatao
        document.querySelectorAll('.customer-tabs .tab').forEach(t => t.classList.remove('active'));
        // Jispe click kiya uspe 'active' lagao
        e.target.classList.add('active');
        
        // TODO: Aage yahan par Cart refresh karne ka logic aayega (C1 ki cart ya C2 ki cart)
        console.log(`Switched to: ${e.target.dataset.id}`);
    }

    // Naya tab (+) add karne ka logic
    addCustomerBtn.addEventListener('click', () => {
        customerCount++;
        const newTabId = `C${customerCount}`;
        
        const newTab = document.createElement('button');
        newTab.className = 'tab';
        newTab.dataset.id = newTabId;
        newTab.innerText = `Customer ${customerCount}`;
        newTab.addEventListener('click', handleTabClick);
        
        // Plus button se pehle naya tab daal do
        customerTabsContainer.insertBefore(newTab, addCustomerBtn);
        
        // Naye tab ko automatically active kar do
        newTab.click();
    });

    // Jab naya table khule toh purane tabs clear karke wapas sirf C1 kar dena
    function resetTabs() {
        customerCount = 1;
        customerTabsContainer.innerHTML = `
            <button class="tab active" data-id="C1">Customer 1</button>
            <button class="tab add-tab-btn" id="addCustomerBtn">+</button>
        `;
        // Naye buttons par events wapas attach karo
        document.querySelector('.tab[data-id="C1"]').addEventListener('click', handleTabClick);
        document.getElementById('addCustomerBtn').addEventListener('click', () => {
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
    }

    // Default C1 par event listener lagana
    document.querySelector('.tab[data-id="C1"]').addEventListener('click', handleTabClick);
});
