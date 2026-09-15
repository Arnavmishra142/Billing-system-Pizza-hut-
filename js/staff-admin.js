// js/staff-admin.js
// AI UPDATE [2026-09-15]: NEW FILE — Admin Panel side of the Staff Management
// feature ("Staff" tab in admin/index.html bottom nav).
//
// All Firestore access goes through js/staff-shared.js — the SAME module
// staff.html / js/staff-pos.js uses, so the Admin Panel and POS always read
// and write identical staff/{id} and staff/{id}/dailyRecords/{date} data.
// There is no separate "adminStaff" collection.
//
// Follows the existing self-contained-module pattern used by
// js/admin-menu.js and js/customers.js: renders everything into a single
// container (#staffCardGrid) and builds its own modals (Add/Edit Staff,
// Staff Detail + History) via _appendModal(), reusing the existing
// admin.css classes (modal-overlay, modal-box, form-group, bill-card,
// stat-card, filter-pill, date-pill, etc.) rather than inventing a parallel
// style system.
//
// Exports: initStaffManagement(), destroyStaffManagement()
// Called from: js/admin.js switchTab('staff', ...)

import { showAlert, showConfirm } from './dialog.js';
import {
    fetchStaffList, addStaffMember, updateStaffMember, deleteStaffMember,
    fetchAllDailyRecords, filterRecordsInRange, summarizeRecords, formatDateLabel
} from './staff-shared.js';

// ── Module state ────────────────────────────────────────────────────────────
let _built     = false;
let _staffList = [];
let _search    = '';

// Detail-overlay state (reset each time a staff member's detail is opened)
let _detailStaff       = null;
let _detailAllRecords  = [];
let _detailMode        = 'all'; // 'all' | 'date' | 'range'
let _detailDateSel     = '';
let _detailFrom        = '';
let _detailTo          = '';

// ── Public exports (called by admin.js) ────────────────────────────────────
export function initStaffManagement() {
    if (!_built) {
        _built = true;
        _renderSection();
    }
    _refreshList();
}

export function destroyStaffManagement() {
    // No live onSnapshot listeners in this module — nothing to tear down.
}

// ── Section scaffold ────────────────────────────────────────────────────────
function _renderSection() {
    const grid = document.getElementById('staffCardGrid');
    if (!grid) return;
    if (grid.querySelector('#stCardList')) return; // already built

    grid.innerHTML = `
        <div class="filter-scroll-row" style="align-items:center; gap:8px;">
            <div class="cust-search-wrap">
                <span class="cust-search-icon">🔍</span>
                <input id="stSearchInput" class="cust-search-input" type="search"
                       placeholder="Search staff by name…" autocomplete="off">
            </div>
            <button class="icon-btn" id="stRefreshBtn" title="Refresh">↻</button>
        </div>
        <div class="section-action-bar">
            <span class="list-title" style="margin-bottom:0;">All Staff</span>
            <button class="btn btn-primary btn-sm" id="stAddBtn">+ Add Staff</button>
        </div>
        <div id="stCardList" class="bills-list"><div class="loading-state">Loading…</div></div>
    `;

    document.getElementById('stAddBtn').addEventListener('click', () => _openStaffForm(null));
    document.getElementById('stRefreshBtn').addEventListener('click', _refreshList);
    document.getElementById('stSearchInput').addEventListener('input', (e) => {
        _search = e.target.value.trim().toLowerCase();
        _renderList();
    });
}

// ── List load / render ───────────────────────────────────────────────────────
async function _refreshList() {
    const listEl = document.getElementById('stCardList');
    if (listEl) listEl.innerHTML = '<div class="loading-state">Loading…</div>';
    try {
        _staffList = await fetchStaffList();
    } catch (e) {
        console.error('[staff-admin] fetchStaffList failed:', e);
        if (listEl) listEl.innerHTML = '<div class="empty-state">Could not load staff. Check internet & refresh.</div>';
        return;
    }
    _renderList();
}

function _renderList() {
    const listEl = document.getElementById('stCardList');
    if (!listEl) return;

    let list = _staffList;
    if (_search) list = list.filter(s => (s.name || '').toLowerCase().includes(_search));

    if (list.length === 0) {
        listEl.innerHTML = `<div class="empty-state">${
            _staffList.length === 0
                ? '👥 No staff added yet. Tap + Add Staff to get started.'
                : '🔍 No staff match your search.'
        }</div>`;
        return;
    }

    listEl.innerHTML = list.map(s => `
        <div class="bill-card cust-bill-card" data-id="${esc(s.id)}">
            <div class="cust-av">${esc(_avatarLetter(s.name))}</div>
            <div class="bill-card-left" style="flex:1;min-width:0;margin-left:2px;">
                <div class="bill-card-name">${esc(s.name || 'Unnamed')}</div>
                <div class="bill-card-time">${esc(s.workType || '')}</div>
            </div>
            <div class="bill-card-right">
                <button class="btn-edit-sm" data-action="edit" data-id="${esc(s.id)}" title="Edit">✏️</button>
                <button class="btn-del-sm" data-action="delete" data-id="${esc(s.id)}" title="Delete">🗑️</button>
            </div>
        </div>
    `).join('');

    listEl.querySelectorAll('.bill-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            _openStaffDetail(card.dataset.id);
        });
    });
    listEl.querySelectorAll('[data-action="edit"]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); _openStaffForm(btn.dataset.id); });
    });
    listEl.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); _confirmDeleteStaff(btn.dataset.id); });
    });
}

// ── Add / Edit Staff modal ───────────────────────────────────────────────────
function _openStaffForm(staffId) {
    const staff = staffId ? _staffList.find(s => s.id === staffId) : null;
    const title = staffId ? 'Edit Staff' : 'Add Staff';
    const html = `
        <div class="modal-overlay" id="stFormModal">
            <div class="modal-box">
                <div class="modal-header">
                    <h2>${title}</h2>
                    <button class="modal-close-x" id="stFormCloseBtn">✕</button>
                </div>
                <div class="form-group">
                    <label>Name</label>
                    <input type="text" id="stFormNameInput" value="${esc(staff ? staff.name || '' : '')}" placeholder="e.g. Dilkusha">
                </div>
                <div class="form-group">
                    <label>Work Type</label>
                    <input type="text" id="stFormWorkTypeInput" value="${esc(staff ? staff.workType || '' : '')}" placeholder="e.g. Waiter, Chef, Manager">
                </div>
                <div class="modal-actions">
                    <button class="btn btn-cancel" id="stFormCancelBtn">Cancel</button>
                    <button class="btn btn-primary" id="stFormSaveBtn">${staffId ? 'Update' : 'Add Staff'}</button>
                </div>
            </div>
        </div>
    `;
    _appendModal('stFormModalHost', html);
    document.getElementById('stFormCloseBtn').addEventListener('click', _closeStaffForm);
    document.getElementById('stFormCancelBtn').addEventListener('click', _closeStaffForm);
    document.getElementById('stFormSaveBtn').addEventListener('click', () => _saveStaffForm(staffId));
    setTimeout(() => document.getElementById('stFormNameInput')?.focus(), 60);
}

function _closeStaffForm() {
    document.getElementById('stFormModalHost')?.remove();
}

async function _saveStaffForm(staffId) {
    const name     = document.getElementById('stFormNameInput').value.trim();
    const workType = document.getElementById('stFormWorkTypeInput').value.trim();
    if (!name || !workType) {
        await showAlert('Name and Work Type are both required.', 'warning', 'Missing Fields');
        return;
    }
    const btn = document.getElementById('stFormSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
        if (staffId) {
            await updateStaffMember(staffId, { name, workType });
        } else {
            await addStaffMember({ name, workType });
        }
        _closeStaffForm();
        await _refreshList();
        // If the Detail overlay for this staff member is currently open, refresh
        // its header so an edited name/work type shows immediately.
        if (_detailStaff && _detailStaff.id === staffId) {
            const updated = _staffList.find(s => s.id === staffId);
            if (updated) { _detailStaff = updated; _updateDetailHeader(); }
        }
    } catch (e) {
        console.error('[staff-admin] save staff failed:', e);
        await showAlert('Save nahi hua. Internet check karo.', 'error', 'Save Failed');
        btn.disabled = false;
        btn.textContent = staffId ? 'Update' : 'Add Staff';
    }
}

// ── Delete Staff (soft delete — see staff-shared.js deleteStaffMember) ──────
async function _confirmDeleteStaff(staffId) {
    const staff = _staffList.find(s => s.id === staffId);
    const ok = await showConfirm(
        `This removes "${staff ? staff.name : 'this staff member'}" from the Staff Management lists on both POS and Admin. ` +
        `Their historical Holiday/Advance records are kept for your business records and are NOT deleted.`,
        { title: 'Delete Staff?', confirmText: 'Delete', cancelText: 'Cancel', type: 'error' }
    );
    if (!ok) return;

    try {
        await deleteStaffMember(staffId);
        document.getElementById('stDetailModalHost')?.remove(); // close detail overlay if it was open for this staff
        await _refreshList();
    } catch (e) {
        console.error('[staff-admin] delete staff failed:', e);
        await showAlert('Delete nahi hua. Internet check karo.', 'error', 'Delete Failed');
    }
}

// ── Staff Detail overlay (profile + full history + date/range filters) ─────
async function _openStaffDetail(staffId) {
    const staff = _staffList.find(s => s.id === staffId);
    if (!staff) return;

    _detailStaff      = staff;
    _detailAllRecords = [];
    _detailMode       = 'all';
    _detailDateSel    = '';
    _detailFrom       = '';
    _detailTo         = '';

    _appendModal('stDetailModalHost', _detailShellHtml(staff));
    _wireDetailShell();

    const recordsEl = document.getElementById('stDetailRecords');
    if (recordsEl) recordsEl.innerHTML = '<div class="loading-state">Loading history…</div>';

    try {
        _detailAllRecords = await fetchAllDailyRecords(staffId);
    } catch (e) {
        console.error('[staff-admin] fetchAllDailyRecords failed:', e);
        if (recordsEl) recordsEl.innerHTML = '<div class="empty-state">Could not load history. Check internet & reopen.</div>';
        return;
    }
    _renderDetailStats();
    _renderDetailRecords();
}

function _detailShellHtml(staff) {
    return `
        <div class="modal-overlay" id="stDetailModal">
            <div class="modal-box" style="max-height:92dvh;overflow-y:auto;max-width:600px;">
                <div class="modal-header">
                    <h2 id="stDetailNameHeader">${esc(staff.name || 'Unnamed')}</h2>
                    <button class="modal-close-x" id="stDetailCloseBtn">✕</button>
                </div>

                <div class="staff-detail-profile">
                    <div class="staff-detail-profile-field">
                        <span class="stat-label">Work Type</span>
                        <div id="stDetailWorkType" class="staff-detail-profile-value">${esc(staff.workType || '—')}</div>
                    </div>
                    <div class="staff-detail-profile-field">
                        <span class="stat-label">Joined</span>
                        <div class="staff-detail-profile-value">${_fmtTimestamp(staff.joinedAt)}</div>
                    </div>
                    <div class="staff-detail-profile-actions">
                        <button class="btn-edit-sm" id="stDetailEditBtn">✏️ Edit</button>
                        <button class="btn-del-sm" id="stDetailDeleteBtn">🗑️ Delete</button>
                    </div>
                </div>

                <div class="stats-row" id="stDetailStats"></div>

                <div class="list-title">History &amp; Filters</div>
                <div class="filter-scroll-row" style="align-items:center; gap:8px;">
                    <span class="exp-range-label">Date</span>
                    <input type="date" id="stDetailDateSel" class="date-pill">
                    <span class="exp-range-label">From</span>
                    <input type="date" id="stDetailFrom" class="date-pill">
                    <span class="exp-range-label">To</span>
                    <input type="date" id="stDetailTo" class="date-pill">
                    <button class="filter-pill" id="stDetailClearBtn" title="Clear filters">✕ Clear</button>
                </div>

                <div id="stDetailRangeSummary" class="staff-range-summary hidden"></div>

                <div id="stDetailRecords" class="staff-record-list"></div>
            </div>
        </div>
    `;
}

function _wireDetailShell() {
    document.getElementById('stDetailCloseBtn').addEventListener('click', () => {
        document.getElementById('stDetailModalHost')?.remove();
    });
    document.getElementById('stDetailEditBtn').addEventListener('click', () => _openStaffForm(_detailStaff.id));
    document.getElementById('stDetailDeleteBtn').addEventListener('click', () => _confirmDeleteStaff(_detailStaff.id));

    const dateSel  = document.getElementById('stDetailDateSel');
    const fromSel  = document.getElementById('stDetailFrom');
    const toSel    = document.getElementById('stDetailTo');
    const clearBtn = document.getElementById('stDetailClearBtn');

    dateSel.addEventListener('change', () => {
        _detailDateSel = dateSel.value;
        _detailFrom = ''; _detailTo = ''; fromSel.value = ''; toSel.value = '';
        _detailMode = _detailDateSel ? 'date' : 'all';
        _renderDetailRecords();
    });

    const onRangeChange = () => {
        _detailFrom = fromSel.value;
        _detailTo   = toSel.value;
        if (_detailFrom && _detailTo) {
            _detailDateSel = ''; dateSel.value = '';
            _detailMode = 'range';
        } else if (!_detailFrom && !_detailTo) {
            _detailMode = 'all';
        }
        _renderDetailRecords();
    };
    fromSel.addEventListener('change', onRangeChange);
    toSel.addEventListener('change', onRangeChange);

    clearBtn.addEventListener('click', () => {
        _detailDateSel = ''; _detailFrom = ''; _detailTo = '';
        dateSel.value = ''; fromSel.value = ''; toSel.value = '';
        _detailMode = 'all';
        _renderDetailRecords();
    });
}

function _updateDetailHeader() {
    const h  = document.getElementById('stDetailNameHeader');
    const wt = document.getElementById('stDetailWorkType');
    if (h)  h.textContent  = _detailStaff.name || 'Unnamed';
    if (wt) wt.textContent = _detailStaff.workType || '—';
}

function _renderDetailStats() {
    const statsEl = document.getElementById('stDetailStats');
    if (!statsEl) return;
    const allTime = summarizeRecords(_detailAllRecords);
    statsEl.innerHTML = `
        <div class="stat-card green">
            <div class="stat-label">All-Time Total Advance</div>
            <div class="stat-value">₹${allTime.totalAdvance}</div>
        </div>
        <div class="stat-card blue">
            <div class="stat-label">All-Time Holiday Days</div>
            <div class="stat-value">${allTime.holidayDays}</div>
        </div>
    `;
}

// Renders the date-wise list per the active filter mode ('all' | 'date' | 'range').
// Only dates that actually have a saved record are ever shown — no synthetic
// rows are invented for days without a record.
function _renderDetailRecords() {
    const listEl    = document.getElementById('stDetailRecords');
    const summaryEl = document.getElementById('stDetailRangeSummary');
    if (!listEl) return;

    let records = _detailAllRecords;

    if (_detailMode === 'date' && _detailDateSel) {
        records = records.filter(r => r.id === _detailDateSel);
        summaryEl.classList.add('hidden');
        if (records.length === 0) {
            listEl.innerHTML = `<div class="empty-state">No daily record exists for ${esc(formatDateLabel(_detailDateSel))}.</div>`;
            return;
        }
    } else if (_detailMode === 'range' && _detailFrom && _detailTo) {
        records = filterRecordsInRange(_detailAllRecords, _detailFrom, _detailTo);
        const s = summarizeRecords(records);
        summaryEl.classList.remove('hidden');
        summaryEl.innerHTML = `
            <div class="staff-range-summary-range">${esc(formatDateLabel(_detailFrom))} → ${esc(formatDateLabel(_detailTo))}</div>
            <div class="staff-range-summary-stats">
                <span>Holiday Days: <strong>${s.holidayDays}</strong></span>
                <span>Total Advance: <strong>₹${s.totalAdvance}</strong></span>
            </div>
        `;
    } else {
        summaryEl.classList.add('hidden');
    }

    if (records.length === 0) {
        listEl.innerHTML = `<div class="empty-state">No daily records ${_detailMode === 'range' ? 'in this range' : 'yet'}.</div>`;
        return;
    }

    listEl.innerHTML = records.map(r => `
        <div class="staff-record-row">
            <div class="staff-record-date">${esc(formatDateLabel(r.id))}</div>
            <div class="staff-record-mid">
                <span class="status-pill-sm ${r.holiday ? 'on' : 'off'}">${r.holiday ? 'Holiday' : 'Working'}</span>
                ${r.note ? `<span class="staff-record-note">${esc(r.note)}</span>` : ''}
            </div>
            <div class="staff-record-advance">${r.advance ? '₹' + r.advance : '—'}</div>
        </div>
    `).join('');
}

// ── Small helpers ─────────────────────────────────────────────────────────
function _avatarLetter(name = '') {
    const t = String(name).trim();
    return t ? t.charAt(0).toUpperCase() : '?';
}

function _fmtTimestamp(ts) {
    const ms = ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null;
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function _appendModal(hostId, html) {
    document.getElementById(hostId)?.remove();
    const div = document.createElement('div');
    div.id = hostId;
    div.innerHTML = html;
    document.body.appendChild(div);
}

function esc(s = '') {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
