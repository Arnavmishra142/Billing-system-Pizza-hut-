import { db } from './firebase-config.js';
import {
    collection, addDoc, deleteDoc, doc,
    getDocsFromCache, getDocsFromServer
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

let allExpenses = [];

// ── localStorage cache so list appears instantly on open ──
const EXP_LS_KEY = 'pos_expense_cache_v1';

function saveExpensesToLS(expenses) {
    try { localStorage.setItem(EXP_LS_KEY, JSON.stringify(expenses)); } catch (e) {}
}

function loadExpensesFromLS() {
    try {
        const raw = localStorage.getItem(EXP_LS_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

// ── Parse a Firestore snapshot into expense objects ──
function processExpenseSnapshot(snap) {
    const expenses = [];
    const uniqueNotes = new Set();
    snap.forEach((doc) => {
        const data = { ...doc.data(), id: doc.id };
        expenses.push(data);
        if (data.note) uniqueNotes.add(data.note.toLowerCase().trim());
    });
    return { expenses, uniqueNotes };
}

// ── Render today's list + fill datalist suggestions ──
function renderTodayExpenses(notes) {
    const listEl = document.getElementById('todayExpensesList');
    listEl.innerHTML = '';
    const today = new Date().toDateString();

    const todaysData = allExpenses
        .filter(e => new Date(e.timestamp).toDateString() === today)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (todaysData.length === 0) {
        listEl.innerHTML = '<div style="text-align:center;color:gray;margin-top:20px;">No expenses today! 🎉</div>';
        return;
    }

    todaysData.forEach(exp => {
        const timeStr = new Date(exp.timestamp).toLocaleTimeString('en-IN', { timeStyle: 'short' });
        const row = document.createElement('div');
        row.className = 'expense-item';
        row.innerHTML = `
            <div>
                <div class="expense-note" style="text-transform:capitalize;">${exp.note}</div>
                <div class="expense-time">${timeStr}</div>
            </div>
            <div style="display:flex;align-items:center;gap:12px;">
                <div class="expense-amt">₹${exp.amount}</div>
                <button class="delete-expense-btn" data-id="${exp.id}" title="Delete">🗑️</button>
            </div>
        `;
        listEl.appendChild(row);
    });

    // Attach delete handlers
    listEl.querySelectorAll('.delete-expense-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteExpense(btn.dataset.id));
    });

    // Refill datalist suggestions if notes provided
    if (notes) {
        const datalist = document.getElementById('pastNotes');
        datalist.innerHTML = '';
        notes.forEach(n => { datalist.innerHTML += `<option value="${n}">`; });
    }
}

// ── Load expenses: LS cache → Firestore cache → server ──
async function loadExpenseData() {
    const listEl = document.getElementById('todayExpensesList');

    // Phase 0: localStorage (instant)
    const cached = loadExpensesFromLS();
    if (cached && cached.length > 0) {
        allExpenses = cached;
        renderTodayExpenses(null);
    } else {
        listEl.innerHTML = '<div style="text-align:center;color:gray;margin-top:20px;">Loading... ⏳</div>';
    }

    // Phase 1: Firestore IndexedDB cache (near-instant, no network)
    try {
        const cacheSnap = await getDocsFromCache(collection(db, "daily_expenses"));
        if (!cacheSnap.empty) {
            const { expenses, uniqueNotes } = processExpenseSnapshot(cacheSnap);
            allExpenses = expenses;
            renderTodayExpenses(uniqueNotes);
            saveExpensesToLS(expenses);
        }
    } catch (e) { /* No cache yet — that's fine */ }

    // Phase 2: live server fetch
    try {
        const serverSnap = await getDocsFromServer(collection(db, "daily_expenses"));
        const { expenses, uniqueNotes } = processExpenseSnapshot(serverSnap);
        allExpenses = expenses;
        renderTodayExpenses(uniqueNotes);
        saveExpensesToLS(expenses);
    } catch (e) {
        console.error("Expense server fetch error:", e);
        if (!cached || cached.length === 0) {
            listEl.innerHTML = '<div style="color:red;text-align:center;">Load nahi hua. Internet check karo.</div>';
        }
    }
}

// ── Delete expense — optimistic: remove from UI instantly, then Firestore ──
async function deleteExpense(expId) {
    if (!confirm("Yeh expense delete karna hai?")) return;

    // Optimistic: remove from local state immediately
    allExpenses = allExpenses.filter(e => e.id !== expId);
    renderTodayExpenses(null);
    saveExpensesToLS(allExpenses);

    // Skip Firestore delete for temp items (not yet saved)
    if (expId.startsWith('temp_')) return;

    try {
        await deleteDoc(doc(db, "daily_expenses", expId));
    } catch (e) {
        console.error("Delete failed:", e);
        alert("Delete nahi hua. Internet check karo.");
        // Reload from server to restore correct state
        await loadExpenseData();
    }
}

// ── Save expense — OPTIMISTIC: update UI instantly, sync in background ──
document.getElementById('saveExpenseBtn').addEventListener('click', async () => {
    const amountEl = document.getElementById('expAmount');
    const noteEl   = document.getElementById('expNote');
    const btn      = document.getElementById('saveExpenseBtn');

    const amount = amountEl.value;
    const note   = noteEl.value.trim();

    if (!amount || !note) {
        alert("Amount aur Note dono daalna zaroori hai!");
        return;
    }

    const timestamp = new Date().toISOString();

    // ── Step 1: Update local state + UI immediately (feels instant) ──
    const tempItem = { id: 'temp_' + Date.now(), amount: Number(amount), note, timestamp };
    allExpenses.unshift(tempItem);
    renderTodayExpenses(null);
    saveExpensesToLS(allExpenses);

    // Clear inputs right away
    amountEl.value = '';
    noteEl.value = '';

    // ── Step 2: Persist to Firestore in background (no await blocking UI) ──
    btn.disabled = true;
    btn.innerText = "Saving...";

    try {
        const docRef = await addDoc(collection(db, "daily_expenses"), {
            amount: Number(amount),
            note,
            timestamp
        });

        // Replace temp item with real Firestore id
        const idx = allExpenses.findIndex(e => e.id === tempItem.id);
        if (idx !== -1) {
            allExpenses[idx] = { ...tempItem, id: docRef.id };
            saveExpensesToLS(allExpenses);
        }
    } catch (e) {
        console.error("Save error:", e);
        // Remove temp item from local list on failure
        allExpenses = allExpenses.filter(e => e.id !== tempItem.id);
        renderTodayExpenses(null);
        saveExpensesToLS(allExpenses);
        alert("Save nahi hua. Internet check karo.");
    } finally {
        btn.disabled = false;
        btn.innerText = "Save Expense";
    }
});

// ── Start ──
document.addEventListener('DOMContentLoaded', loadExpenseData);
