import { db, auth } from './firebase-config.js';
import { showAlert, showConfirm } from './dialog.js';
import {
    collection, addDoc, getDocs, getDoc, doc, setDoc, deleteDoc,
    serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';

const STAFF_COLLECTION = 'staff';
const RECORDS_COLLECTION = 'daily_records';
let currentStaff = null;
let currentRecords = [];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const dateText = (value) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '—';
const today = () => new Date().toISOString().slice(0, 10);
const joinedText = (data) => data.joinedAt?.toDate ? data.joinedAt.toDate().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : dateText(data.joinedDate);

async function ensureOperatorAuth() {
    if (!auth.currentUser) await signInAnonymously(auth).catch(() => {});
}

async function listStaff() {
    await ensureOperatorAuth();
    const snap = await getDocs(query(collection(db, STAFF_COLLECTION), orderBy('name')));
    return snap.docs.map(item => ({ id: item.id, ...item.data() }));
}

async function loadRecords(staffId) {
    const snap = await getDocs(query(collection(db, STAFF_COLLECTION, staffId, RECORDS_COLLECTION), orderBy('date', 'desc')));
    return snap.docs.map(item => ({ id: item.id, ...item.data() }));
}

function renderList(container, staff) {
    container.innerHTML = `<div class="staff-toolbar"><div><div class="section-page-title">Staff Management</div><div class="staff-muted">${staff.length} staff member${staff.length === 1 ? '' : 's'}</div></div><button class="btn btn-primary" id="staffAddBtn">+ Add Staff</button></div><div class="staff-list">${staff.length ? staff.map(item => `<button class="staff-card" data-staff-id="${esc(item.id)}"><span class="staff-avatar">${esc(item.name.slice(0, 1).toUpperCase())}</span><span><strong>${esc(item.name)}</strong><small>Joined: ${esc(joinedText(item))}</small></span><span class="staff-arrow">›</span></button>`).join('') : '<div class="empty-state">No staff members yet.</div>'}</div>`;
    container.querySelector('#staffAddBtn').onclick = () => renderAdd(container, staff);
    container.querySelectorAll('[data-staff-id]').forEach(button => button.onclick = async () => renderDetails(container, staff.find(item => item.id === button.dataset.staffId)));
}

function renderAdd(container, staff) {
    container.innerHTML = `<div class="staff-toolbar"><div><div class="section-page-title">Add Staff</div><div class="staff-muted">Create a basic staff profile</div></div><button class="btn btn-cancel" id="staffBackBtn">Back</button></div><form class="staff-form" id="staffForm"><label>Name<input id="staffNameInput" required maxlength="80" autocomplete="off" placeholder="e.g. Dilkusha"></label><div class="staff-form-actions"><button type="button" class="btn btn-cancel" id="staffCancelBtn">Cancel</button><button class="btn btn-primary" type="submit">Save Staff</button></div></form>`;
    const back = () => renderList(container, staff);
    container.querySelector('#staffBackBtn').onclick = back;
    container.querySelector('#staffCancelBtn').onclick = back;
    container.querySelector('#staffForm').onsubmit = async event => {
        event.preventDefault();
        const name = container.querySelector('#staffNameInput').value.trim();
        if (!name) return;
        const button = event.submitter;
        button.disabled = true;
        try { await addDoc(collection(db, STAFF_COLLECTION), { name, joinedAt: serverTimestamp() }); await showAlert('Staff member added.'); renderList(container, await listStaff()); }
        catch (error) { console.error('[Staff] add failed', error); await showAlert('Could not add staff member.'); button.disabled = false; }
    };
}

function renderDetails(container, staff) {
    currentStaff = staff;
    container.innerHTML = `<div class="staff-toolbar"><div><div class="section-page-title">${esc(staff.name)}</div><div class="staff-muted">Joined: ${esc(joinedText(staff))}</div></div><button class="btn btn-cancel" id="staffListBtn">Back</button></div><div id="staffDetailBody" class="staff-detail-body"><div class="loading-state">Loading history...</div></div>`;
    container.querySelector('#staffListBtn').onclick = async () => renderList(container, await listStaff());
    loadRecords(staff.id).then(records => { currentRecords = records; renderDetailBody(container, records); }).catch(() => { container.querySelector('#staffDetailBody').innerHTML = '<div class="empty-state">Could not load staff history.</div>'; });
}

function renderDetailBody(container, records) {
    const body = container.querySelector('#staffDetailBody');
    const total = records.reduce((sum, record) => sum + (Number(record.advance) || 0), 0);
    body.innerHTML = `<div class="staff-total-card"><span>Total Advance</span><strong>₹${total.toFixed(0)}</strong></div><form class="staff-record-form" id="staffRecordForm"><div class="staff-form-grid"><label>Date<input type="date" id="staffRecordDate" value="${today()}" required></label><label>Advance (₹)<input type="number" id="staffAdvance" min="0" step="1" value="0" inputmode="numeric" required></label></div><label class="staff-toggle"><input type="checkbox" id="staffHoliday"><span>Holiday / Leave</span></label><button class="btn btn-primary" type="submit">Save Record</button></form><div class="staff-history-title">Date-wise History</div><div class="staff-history">${records.length ? records.map(record => `<div class="staff-history-row"><span>${esc(dateText(record.date))}</span><span class="${record.holiday ? 'staff-holiday' : 'staff-worked'}">${record.holiday ? 'Holiday' : 'Worked'}</span><strong>₹${(Number(record.advance) || 0).toFixed(0)}</strong></div>`).join('') : '<div class="empty-state">No daily records saved.</div>'}</div><button class="btn btn-danger staff-delete-btn" id="staffDeleteBtn">Delete Staff</button>`;
    const dateInput = body.querySelector('#staffRecordDate');
    const advanceInput = body.querySelector('#staffAdvance');
    const holidayInput = body.querySelector('#staffHoliday');
    const loadSelected = () => { const record = records.find(item => item.date === dateInput.value); advanceInput.value = record?.advance ?? 0; holidayInput.checked = Boolean(record?.holiday); };
    dateInput.onchange = loadSelected;
    loadSelected();
    body.querySelector('#staffRecordForm').onsubmit = async event => {
        event.preventDefault();
        const advance = Number(advanceInput.value);
        if (!Number.isFinite(advance) || advance < 0) return showAlert('Enter a valid non-negative advance amount.');
        try { await setDoc(doc(db, STAFF_COLLECTION, currentStaff.id, RECORDS_COLLECTION, dateInput.value), { date: dateInput.value, holiday: holidayInput.checked, advance, updatedAt: serverTimestamp() }); currentRecords = await loadRecords(currentStaff.id); renderDetailBody(container, currentRecords); await showAlert('Daily record saved.'); }
        catch (error) { console.error('[Staff] record save failed', error); await showAlert('Could not save daily record.'); }
    };
    body.querySelector('#staffDeleteBtn').onclick = async () => {
        if (!(await showConfirm(`Delete ${staff.name} and its staff history?`))) return;
        try { for (const record of records) await deleteDoc(doc(db, STAFF_COLLECTION, staff.id, RECORDS_COLLECTION, record.id)); await deleteDoc(doc(db, STAFF_COLLECTION, staff.id)); await showAlert('Staff member deleted.'); renderList(container, await listStaff()); }
        catch (error) { console.error('[Staff] delete failed', error); await showAlert('Could not delete staff member.'); }
    };
}

export async function initStaffManagement(container) { try { renderList(container, await listStaff()); } catch (error) { console.error('[Staff] list failed', error); container.innerHTML = '<div class="empty-state">Staff Management is unavailable.</div>'; } }

window.openStaffManagement = () => {
    const overlay = document.getElementById('staffPosOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    initStaffManagement(document.getElementById('staffPosBody'));
};
window.closeStaffManagement = () => document.getElementById('staffPosOverlay')?.classList.add('hidden');

if (document.getElementById('staffPosBody')) document.getElementById('staffPosCloseBtn').onclick = window.closeStaffManagement;
export { listStaff, loadRecords };
