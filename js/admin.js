import { db } from './firebase-config.js';
import { collection, getDocs, doc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ==========================================
// LOGIN & SESSION LOGIC
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('adminLoggedIn') === 'true') {
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('adminContent').style.display = 'flex';
        loadSalesData('days', 1);
    }
});

document.getElementById('loginBtn').addEventListener('click', () => {
    const pin = document.getElementById('pinInput').value;
    if(pin === "1414") { 
        localStorage.setItem('adminLoggedIn', 'true');
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('adminContent').style.display = 'flex';
        loadSalesData('days', 1); 
    } else {
        alert("Incorrect PIN!");
        document.getElementById('pinInput').value = '';
    }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('adminLoggedIn');
    document.getElementById('adminContent').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('pinInput').value = ''; 
});

window.switchTab = function(tabName) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    
    document.getElementById(tabName + 'Section').classList.add('active');
    event.target.classList.add('active');
}

// ==========================================
// SALES LOGIC & FIREBASE FETCH
// ==========================================
let allSales = []; 

async function fetchAllSalesFromDB() {
    try {
        document.getElementById('salesTableBody').innerHTML = '<tr><td colspan="3" class="loading">Fetching data from Cloud... ☁️</td></tr>';
        document.getElementById('billsTableBody').innerHTML = '<tr><td colspan="4" class="loading">Fetching bills...</td></tr>';
        
        const querySnapshot = await getDocs(collection(db, "sales_history"));
        allSales = [];
        querySnapshot.forEach((doc) => {
            let data = doc.data();
            data.id = doc.id; 
            allSales.push(data);
        });
    } catch (error) {
        console.error("Error fetching sales: ", error);
        alert("Sales fetch karne me error aayi.");
    }
}

window.loadSalesData = async function(filterType, filterValue) {
    await fetchAllSalesFromDB();

    const now = new Date();
    let filteredSales = [];

    allSales.forEach(sale => {
        // Fallback in case timestamp is missing
        if(!sale.timestamp) return; 

        const saleDate = new Date(sale.timestamp);
        
        if (filterType === 'date') {
            const pickedDate = new Date(filterValue).toDateString();
            if (saleDate.toDateString() === pickedDate) {
                filteredSales.push(sale);
            }
        } 
        else if (filterType === 'days') {
            const diffTime = Math.abs(now - saleDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

            if (filterValue === 1) {
                if (saleDate.toDateString() === now.toDateString()) filteredSales.push(sale);
            } else {
                if (diffDays <= filterValue) filteredSales.push(sale);
            }
        }
    });

    filteredSales.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    let totalRevenue = 0;
    let itemStats = {}; 

    const billsTbody = document.getElementById('billsTableBody');
    billsTbody.innerHTML = '';

    if (filteredSales.length === 0) {
        billsTbody.innerHTML = '<tr><td colspan="4" class="text-center" style="padding:20px; color:#64748b;">No bills found for this period.</td></tr>';
    } else {
        filteredSales.forEach(sale => {
            // SAFETY CHECKS (Ye loop crash hone se bachaenge)
            const saleTotal = Number(sale.total) || 0;
            totalRevenue += saleTotal;
            
            const itemsArray = sale.items || [];
            
            itemsArray.forEach(item => {
                const itemName = item.name || 'Unknown Item';
                const itemQty = Number(item.qty) || 0;
                const itemPrice = Number(item.price) || 0;

                if (!itemStats[itemName]) itemStats[itemName] = { qty: 0, rev: 0 };
                itemStats[itemName].qty += itemQty;
                itemStats[itemName].rev += (itemQty * itemPrice);
            });

            // Date formatting
            let timeString = 'Unknown Time';
            if(sale.timestamp) {
                timeString = new Date(sale.timestamp).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
            }

            // Table Name formatting
            let tableName = sale.table || 'Unknown';
            if(!tableName.includes('Parcel')) {
                tableName = `${tableName} [${sale.customer || 'C1'}]`;
            }
            
            billsTbody.innerHTML += `
                <tr>
                    <td style="color: #94a3b8; white-space: nowrap;">${timeString}</td>
                    <td style="font-weight: bold; color: #f8fafc; white-space: nowrap;">${tableName}</td>
                    <td class="text-right" style="color: #10b981; font-weight: bold; white-space: nowrap;">₹${saleTotal.toFixed(2)}</td>
                    <td class="text-center" style="white-space: nowrap;">
                        <button class="btn btn-danger" style="padding: 6px 12px; font-size: 0.9rem;" onclick="deleteSale('${sale.id}')">🗑️ Delete</button>
                    </td>
                </tr>
            `;
        });
    }

    // UPDATE STATS
    document.getElementById('totalRevenueBox').innerText = `₹${totalRevenue.toFixed(2)}`;
    document.getElementById('totalOrdersBox').innerText = filteredSales.length;

    // UPDATE ITEM TABLE
    const salesTbody = document.getElementById('salesTableBody');
    salesTbody.innerHTML = '';

    let sortedItems = Object.keys(itemStats).map(key => {
        return { name: key, qty: itemStats[key].qty, rev: itemStats[key].rev };
    }).sort((a, b) => b.qty - a.qty);

    if (sortedItems.length === 0) {
        salesTbody.innerHTML = '<tr><td colspan="3" class="text-center" style="padding:30px; color:#64748b;">No items sold.</td></tr>';
    } else {
        sortedItems.forEach(stat => {
            salesTbody.innerHTML += `
                <tr>
                    <td style="font-weight: bold; color: #f8fafc; white-space: nowrap;">${stat.name}</td>
                    <td class="text-right" style="color: #38bdf8; font-weight: bold; white-space: nowrap;">${stat.qty}</td>
                    <td class="text-right" style="color: #10b981; font-weight: bold; white-space: nowrap;">₹${stat.rev.toFixed(2)}</td>
                </tr>
            `;
        });
    }
}

// ==========================================
// ACTIONS
// ==========================================
window.deleteSale = async function(saleId) {
    const confirmDelete = confirm("Are you sure you want to delete this bill? This cannot be undone.");
    if (confirmDelete) {
        try {
            await deleteDoc(doc(db, "sales_history", saleId));
            
            const activeBtn = document.querySelector('.filter-btn.active');
            if(activeBtn) {
                loadSalesData('days', parseInt(activeBtn.dataset.val)); 
            } else {
                const dateVal = document.getElementById('customDateSearch').value;
                loadSalesData('date', dateVal);
            }
        } catch (error) {
            console.error("Error deleting document: ", error);
            alert("Delete karne mein problem aayi.");
        }
    }
}

document.getElementById('refreshBtn').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.innerText = "🔄 Refreshing...";
    btn.disabled = true;
    
    const activeBtn = document.querySelector('.filter-btn.active');
    if(activeBtn) {
        await loadSalesData('days', parseInt(activeBtn.dataset.val));
    } else {
        const dateVal = document.getElementById('customDateSearch').value;
        if(dateVal) await loadSalesData('date', dateVal);
        else await loadSalesData('days', 1);
    }
    
    btn.innerText = "🔄 Refresh Data";
    btn.disabled = false;
});

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        document.getElementById('customDateSearch').value = ''; 
        
        const days = parseInt(e.target.dataset.val);
        loadSalesData('days', days);
    });
});

document.getElementById('customDateSearch').addEventListener('change', (e) => {
    if (e.target.value) {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        loadSalesData('date', e.target.value);
    }
});
