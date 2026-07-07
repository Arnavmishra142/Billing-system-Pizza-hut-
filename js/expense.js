import { db } from './firebase-config.js';
import { collection, getDocs, addDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', () => {
    loadExpenseData();
});

let allExpenses = [];

async function loadExpenseData() {
    const listEl = document.getElementById('todayExpensesList');
    const datalist = document.getElementById('pastNotes');
    
    try {
        const querySnapshot = await getDocs(collection(db, "daily_expenses"));
        allExpenses = [];
        let uniqueNotes = new Set();

        querySnapshot.forEach((doc) => {
            let data = doc.data();
            data.id = doc.id;
            allExpenses.push(data);
            if(data.note) uniqueNotes.add(data.note.toLowerCase().trim());
        });

        // Smart Suggestion Datalist bharna
        datalist.innerHTML = '';
        uniqueNotes.forEach(note => {
            datalist.innerHTML += `<option value="${note}">`;
        });

        renderTodayExpenses();
    } catch (e) {
        console.error(e);
        listEl.innerHTML = '<div style="color:red; text-align:center;">Failed to load expenses.</div>';
    }
}

function renderTodayExpenses() {
    const listEl = document.getElementById('todayExpensesList');
    listEl.innerHTML = '';
    const today = new Date().toDateString();
    
    let todaysData = allExpenses.filter(e => new Date(e.timestamp).toDateString() === today);
    todaysData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // Newest first

    if (todaysData.length === 0) {
        listEl.innerHTML = '<div style="text-align: center; color: gray; margin-top: 20px;">No expenses today! 🎉</div>';
        return;
    }

    todaysData.forEach(exp => {
        let timeStr = new Date(exp.timestamp).toLocaleTimeString('en-IN', { timeStyle: 'short' });
        listEl.innerHTML += `
            <div class="expense-item">
                <div>
                    <div class="expense-note" style="text-transform: capitalize;">${exp.note}</div>
                    <div class="expense-time">${timeStr}</div>
                </div>
                <div class="expense-amt">₹${exp.amount}</div>
            </div>
        `;
    });
}

document.getElementById('saveExpenseBtn').addEventListener('click', async () => {
    const amount = document.getElementById('expAmount').value;
    const note = document.getElementById('expNote').value.trim();
    const btn = document.getElementById('saveExpenseBtn');

    if (!amount || !note) {
        alert("Amount aur Note dono daalna zaroori hai!");
        return;
    }

    btn.innerText = "Saving... ⏳";
    btn.disabled = true;

    try {
        await addDoc(collection(db, "daily_expenses"), {
            amount: Number(amount),
            note: note,
            timestamp: new Date().toISOString()
        });
        
        document.getElementById('expAmount').value = '';
        document.getElementById('expNote').value = '';
        await loadExpenseData(); // Refresh UI
    } catch (e) {
        console.error(e);
        alert("Save nahi hua, internet check kar.");
    } finally {
        btn.innerText = "Save Expense";
        btn.disabled = false;
    }
});
