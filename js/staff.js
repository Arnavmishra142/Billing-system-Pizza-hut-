import { db, auth } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { showAlert, showConfirm } from './dialog.js';
import {
    collection, addDoc, deleteDoc, doc, getDocs, setDoc,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';

let staffMembers = [];
let selectedStaff = null;

const $ = (id) => document.getElementById(id);
const rupees = (value) => `₹${(Number(value) || 0).toLocaleString('en-IN')}`;
const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
}[char]));

function openOverlay(id) { $(id).classList.remove('hidden'); }
function closeOverlay(id) { $(id).classList.add('hidden'); }

async function loadStaff() {
    const list = $('staffCardList');
    list.innerHTML = '<div class="loading-state">Loading staff…</div>';
    try {
        const snap = await getDocs(collection(db, 'staff'));
        staffMembers = snap.docs.map((item) => ({ id: item.id, ...item.data() }))
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        renderStaff();
    } catch (error) {
        console.error('[staff] load failed:', error);
        list.innerHTML = '<div class="empty-state">Staff could not be loaded.</div>';
        await showAlert('Staff load nahi hua. Internet check karo.', 'error', 'Load Failed');
    }
}

function renderStaff() {
    const list = $('staffCardList');
    if (!staffMembers.length) {
        list.innerHTML = '<div class="empty-state">No staff members yet. Add the first staff member.</div>';
        return;
    }
    list.innerHTML = staffMembers.map((staff) => `
        <div class="staff-card" data-id="${escapeHtml(staff.id)}">
            <div class="staff-avatar">${escapeHtml((staff.name || '?').charAt(0).toUpperCase())}</div>
            <div class="staff-card-info">
                <div class="staff-card-name">${escapeHtml(staff.name)}</div>
                <div class="staff-card-role">${escapeHtml(staff.role || 'Staff member')}</div>
            </div>
            <button class="btn btn-edit-sm staff-open-btn" data-id="${escapeHtml(staff.id)}">Open</button>
            <button class="btn-del-sm staff-delete-btn" data-id="${escapeHtml(staff.id)}" title="Delete staff">Delete</button>
        </div>
    `).join('');
    list.querySelectorAll('.staff-open-btn').forEach((button) => button.addEventListener('click', () => openStaff(button.dataset.id)));
    list.querySelectorAll('.staff-delete-btn').forEach((button) => button.addEventListener('click', () => removeStaff(button.dataset.id)));
}

async function addStaff() {
    const name = $('staffNameInput').value.trim();
    const role = $('staffRoleInput').value.trim();
    if (!name) {
        await showAlert('Staff name is required.', 'error', 'Missing Name');
        return;
    }
    const button = $('saveStaffBtn');
    button.disabled = true;
    try {
        await addDoc(collection(db, 'staff'), { name, role, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        $('staffNameInput').value = '';
        $('staffRoleInput').value = '';
        closeOverlay('staffAddOverlay');
        await loadStaff();
    } catch (error) {
        console.error('[staff] add failed:', error);
        await showAlert('Staff add nahi hua. Check permissions or internet.', 'error', 'Save Failed');
    } finally { button.disabled = false; }
}

async function removeStaff(id) {
    const staff = staffMembers.find((item) => item.id === id);
    if (!staff || !await showConfirm(`Delete ${staff.name} and all their daily records?`, { title: 'Delete staff member?', confirmText: 'Delete', type: 'error' })) return;
    try {
        const records = await getDocs(collection(db, 'staff', id, 'daily_records'));
        await Promise.all(records.docs.map((record) => deleteDoc(record.ref)));
        await deleteDoc(doc(db, 'staff', id));
        if (selectedStaff?.id === id) closeOverlay('staffDetailOverlay');
        await loadStaff();
    } catch (error) {
        console.error('[staff] delete failed:', error);
        await showAlert('Staff delete nahi hua.', 'error', 'Delete Failed');
    }
}

async function openStaff(id) {
    selectedStaff = staffMembers.find((item) => item.id === id);
    if (!selectedStaff) return;
    $('staffDetailTitle').textContent = selectedStaff.name;
    $('staffDetailBody').innerHTML = '<div class="loading-state">Loading daily history…</div>';
    openOverlay('staffDetailOverlay');
    try {
        const snap = await getDocs(collection(db, 'staff', id, 'daily_records'));
        const records = snap.docs.map((item) => ({ id: item.id, ...item.data() }))
            .sort((a, b) => String(b.date || b.id).localeCompare(String(a.date || a.id)));
        renderStaffDetail(records);
    } catch (error) {
        console.error('[staff] history failed:', error);
        $('staffDetailBody').innerHTML = '<div class="empty-state">History could not be loaded.</div>';
    }
}

function renderStaffDetail(records) {
    const total = records.reduce((sum, record) => sum + (Number(record.advance) || 0), 0);
    const date = todayKey();
    const current = records.find((record) => record.date === date) || { holiday: false, advance: 0 };
    $('staffDetailBody').innerHTML = `
        <div class="staff-summary-card"><span>Total Advance</span><strong>${rupees(total)}</strong></div>
        <div class="staff-record-editor">
            <div class="list-title">Daily Record</div>
            <div class="form-group"><label for="staffRecordDate">Date</label><input type="date" id="staffRecordDate" value="${date}"></div>
            <label class="staff-toggle-row"><span>Holiday / Leave</span><input type="checkbox" id="staffHolidayToggle" ${current.holiday ? 'checked' : ''}><span class="staff-toggle-switch"></span></label>
            <div class="form-group"><label for="staffAdvanceInput">Advance Amount (₹)</label><input type="number" id="staffAdvanceInput" min="0" step="1" inputmode="numeric" value="${Number(current.advance) || 0}"></div>
            <button class="btn btn-primary full-width" id="saveStaffRecordBtn">Save Daily Record</button>
        </div>
        <div class="list-title staff-history-title">Complete History</div>
        <div class="staff-history-list">${records.length ? records.map((record) => `
            <div class="staff-history-row"><div><strong>${escapeHtml(record.date || record.id)}</strong><span>${record.holiday ? 'Holiday / Leave' : 'Worked normally'}</span></div><b>${rupees(record.advance)}</b></div>
        `).join('') : '<div class="empty-state">No daily records yet.</div>'}</div>
    `;
    $('staffRecordDate').addEventListener('change', (event) => {
        const record = records.find((item) => item.date === event.target.value);
        $('staffHolidayToggle').checked = Boolean(record?.holiday);
        $('staffAdvanceInput').value = Number(record?.advance) || 0;
    });
    $('saveStaffRecordBtn').addEventListener('click', () => saveDailyRecord(records));
}

async function saveDailyRecord(records) {
    const date = $('staffRecordDate').value;
    const advance = Number($('staffAdvanceInput').value);
    if (!date || !Number.isFinite(advance) || advance < 0) {
        await showAlert('Enter a valid date and advance amount.', 'error', 'Invalid Record');
        return;
    }
    const button = $('saveStaffRecordBtn');
    button.disabled = true;
    try {
        await setDoc(doc(db, 'staff', selectedStaff.id, 'daily_records', date), {
            date, holiday: $('staffHolidayToggle').checked, advance, updatedAt: serverTimestamp()
        });
        await openStaff(selectedStaff.id);
    } catch (error) {
        console.error('[staff] record save failed:', error);
        await showAlert('Daily record save nahi hua.', 'error', 'Save Failed');
    } finally { button.disabled = false; }
}

window.initStaffManagement = loadStaff;
$('addStaffBtn').addEventListener('click', () => openOverlay('staffAddOverlay'));
$('closeStaffAddBtn').addEventListener('click', () => closeOverlay('staffAddOverlay'));
$('cancelStaffAddBtn').addEventListener('click', () => closeOverlay('staffAddOverlay'));
$('saveStaffBtn').addEventListener('click', addStaff);
$('closeStaffDetailBtn').addEventListener('click', () => closeOverlay('staffDetailOverlay'));

if (auth.currentUser) loadStaff();
else onAuthStateChanged(auth, (user) => { if (user) loadStaff(); });
