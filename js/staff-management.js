import { db, auth } from './firebase-config.js';
import { showAlert, showConfirm } from './dialog.js';
import {
    collection, getDocs, addDoc, deleteDoc, doc, setDoc, serverTimestamp,
    query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';

let initialized = false;
let staffMembers = [];
let selectedStaff = null;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function waitForAuth(timeoutMs = 5000) {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            if (user) { unsubscribe(); resolve(user); }
        });
        setTimeout(() => { unsubscribe(); resolve(null); }, timeoutMs);
    });
}

function todayKey() {
    const date = new Date();
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function formatDate(key) {
    return new Date(`${key}T00:00:00`).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
    });
}

function renderStaffList() {
    const list = document.getElementById('staffCardList');
    if (!list) return;
    if (!staffMembers.length) {
        list.innerHTML = '<div class="empty-state">No staff members added yet.</div>';
        return;
    }
    list.innerHTML = staffMembers.map((staff) => `
        <article class="staff-card">
            <button class="staff-card-main" onclick="window.openStaffDetails('${staff.id}')">
                <span class="staff-avatar">${escapeHtml(staff.name.slice(0, 1).toUpperCase())}</span>
                <span class="staff-card-info">
                    <strong>${escapeHtml(staff.name)}</strong>
                    <span>${escapeHtml(staff.role || 'Staff')}${staff.phone ? ` · ${escapeHtml(staff.phone)}` : ''}</span>
                </span>
                <span class="staff-chevron">›</span>
            </button>
            <button class="btn-del-sm" onclick="window.deleteStaff('${staff.id}', event)">Delete</button>
        </article>
    `).join('');
}

export async function refreshStaffManagement() {
    const list = document.getElementById('staffCardList');
    if (!list) return;
    list.innerHTML = '<div class="loading-state">Loading staff…</div>';
    try {
        const snapshot = await getDocs(query(collection(db, 'staff'), orderBy('name')));
        staffMembers = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        renderStaffList();
    } catch (error) {
        console.error('[Staff] load failed:', error);
        list.innerHTML = '<div class="empty-state">Could not load staff records.</div>';
    }
}

export function initStaffManagement() {
    if (initialized) return;
    initialized = true;
    refreshStaffManagement();
}

window.openStaffForm = function () {
    document.getElementById('staffFormOverlay').classList.remove('hidden');
    document.getElementById('staffNameInput').focus();
};

window.closeStaffForm = function () {
    document.getElementById('staffFormOverlay').classList.add('hidden');
    document.getElementById('staffForm').reset();
};

document.getElementById('staffForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.getElementById('staffNameInput').value.trim();
    const phone = document.getElementById('staffPhoneInput').value.trim();
    const role = document.getElementById('staffRoleInput').value.trim();
    if (!name) return;
    if (!await waitForAuth()) return showAlert('Admin session is not ready. Please try again.', 'error', 'Auth Error');
    const button = event.submitter;
    button.disabled = true;
    try {
        await addDoc(collection(db, 'staff'), { name, phone, role, createdAt: serverTimestamp() });
        window.closeStaffForm();
        await refreshStaffManagement();
    } catch (error) {
        console.error('[Staff] add failed:', error);
        await showAlert('Could not add staff member.', 'error', 'Save Failed');
    } finally { button.disabled = false; }
});

window.deleteStaff = async function (staffId, event) {
    event?.stopPropagation();
    const staff = staffMembers.find((item) => item.id === staffId);
    if (!await showConfirm(`Delete ${staff?.name || 'this staff member'}? Daily history will also be removed.`, {
        title: 'Delete staff member?', confirmText: 'Delete', type: 'error'
    })) return;
    if (!await waitForAuth()) return showAlert('Admin session is not ready. Please try again.', 'error', 'Auth Error');
    try {
        const records = await getDocs(collection(db, 'staff', staffId, 'daily_records'));
        await Promise.all(records.docs.map((record) => deleteDoc(record.ref)));
        await deleteDoc(doc(db, 'staff', staffId));
        await refreshStaffManagement();
    } catch (error) {
        console.error('[Staff] delete failed:', error);
        await showAlert('Could not delete staff member.', 'error', 'Delete Failed');
    }
};

window.openStaffDetails = async function (staffId) {
    selectedStaff = staffMembers.find((item) => item.id === staffId);
    if (!selectedStaff) return;
    document.getElementById('staffDetailOverlay').classList.remove('hidden');
    document.getElementById('staffDetailTitle').textContent = selectedStaff.name;
    document.getElementById('staffDetailMeta').textContent = [selectedStaff.role || 'Staff', selectedStaff.phone].filter(Boolean).join(' · ');
    document.getElementById('staffDateInput').value = todayKey();
    await loadStaffRecords();
};

window.closeStaffDetails = function () {
    document.getElementById('staffDetailOverlay').classList.add('hidden');
    selectedStaff = null;
};

document.getElementById('staffDateInput').addEventListener('change', loadStaffRecordForDate);

document.getElementById('staffDailyForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedStaff || !await waitForAuth()) return;
    const date = document.getElementById('staffDateInput').value;
    const holiday = document.getElementById('staffHolidayInput').checked;
    const advance = Math.max(0, Number(document.getElementById('staffAdvanceInput').value) || 0);
    const button = event.submitter;
    button.disabled = true;
    try {
        await setDoc(doc(db, 'staff', selectedStaff.id, 'daily_records', date), {
            date, holiday, advance, updatedAt: serverTimestamp()
        });
        await loadStaffRecords();
        await showAlert(`Record saved for ${formatDate(date)}.`, 'success', 'Saved');
    } catch (error) {
        console.error('[Staff] record save failed:', error);
        await showAlert('Could not save daily record.', 'error', 'Save Failed');
    } finally { button.disabled = false; }
});

async function loadStaffRecordForDate() {
    if (!selectedStaff) return;
    const date = document.getElementById('staffDateInput').value;
    const snapshot = await getDocs(collection(db, 'staff', selectedStaff.id, 'daily_records'));
    const record = snapshot.docs.find((item) => item.id === date)?.data();
    document.getElementById('staffHolidayInput').checked = Boolean(record?.holiday);
    document.getElementById('staffAdvanceInput').value = record?.advance ?? 0;
}

async function loadStaffRecords() {
    if (!selectedStaff) return;
    const snapshot = await getDocs(collection(db, 'staff', selectedStaff.id, 'daily_records'));
    const records = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        .sort((a, b) => b.id.localeCompare(a.id));
    const total = records.reduce((sum, record) => sum + (Number(record.advance) || 0), 0);
    document.getElementById('staffTotalAdvance').textContent = `₹${total.toFixed(0)}`;
    document.getElementById('staffHistoryList').innerHTML = records.length ? records.map((record) => `
        <div class="staff-history-row">
            <div><strong>${formatDate(record.id)}</strong><span>${record.holiday ? 'Holiday / Leave' : 'Worked normally'}</span></div>
            <strong class="staff-advance">₹${(Number(record.advance) || 0).toFixed(0)}</strong>
        </div>
    `).join('') : '<div class="empty-state">No daily records yet.</div>';
    await loadStaffRecordForDate();
}

window.refreshStaffManagement = refreshStaffManagement;
