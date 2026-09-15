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
    fetchAllDailyRecords, filterRecordsInRange, summarizeRecords, formatDateLabel,
    getDailyRecord, saveDailyRecord, updateStaffPhoto
} from './staff-shared.js';
// AI UPDATE [2026-09-15] session 3: Staff profile photo — reuses the
// EXISTING Cloudinary unsigned-upload helper (same module js/admin-menu.js
// uses for category/product images). No second Cloudinary config, no new
// upload provider.
import { uploadMenuImage, extractCloudinaryPublicId } from './cloudinary-upload.js';

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
let _photoUploadBusy   = false; // guards against double-tap / double-select while an upload is in flight

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
            <div class="cust-av">${s.profileImageUrl
                ? `<img src="${esc(s.profileImageUrl)}" alt="">`
                : esc(_avatarLetter(s.name))}</div>
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

                <div class="staff-detail-photo-row">
                    <div class="staff-detail-photo" id="stDetailPhotoBox">
                        ${staff.profileImageUrl
                            ? `<img id="stDetailPhotoImg" src="${esc(staff.profileImageUrl)}" alt="">`
                            : `<span class="staff-detail-photo-initial">${esc(_avatarLetter(staff.name))}</span>`}
                    </div>
                    <button class="img-upload-btn" id="stDetailPhotoBtn" type="button">
                        📤 ${staff.profileImageUrl ? 'Change Photo' : 'Upload Photo'}
                    </button>
                    <input type="file" id="stDetailPhotoInput" accept="image/*" hidden>
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
                <!-- AI UPDATE [2026-09-15] session 2: Working is now the implicit
                     default for any date with no saved record — clarify this
                     directly in the UI rather than showing a bare "no data" state. -->
                <div style="font-size:0.75rem;color:#8b949e;margin:-4px 0 10px;">
                    A date with no saved record defaults to <strong style="color:#8b949e;">Working, ₹0</strong>.
                    Pick a date above (or tap any row below) to add/correct a historical entry.
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

    const photoBtn   = document.getElementById('stDetailPhotoBtn');
    const photoInput = document.getElementById('stDetailPhotoInput');
    photoBtn.addEventListener('click', () => { if (!_photoUploadBusy) photoInput.click(); });
    photoInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        e.target.value = ''; // allow re-selecting the same file later
        if (file) _uploadStaffPhoto(file);
    });

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

// ── Staff profile photo — upload/change via the EXISTING Cloudinary unsigned
// upload system (js/cloudinary-upload.js — the same helper js/admin-menu.js
// uses for category/product images). Persisted immediately on success via
// staff-shared.js's updateStaffPhoto(), independent of the Add/Edit Staff
// form — this never touches name/workType/dailyRecords. ──
async function _uploadStaffPhoto(file) {
    if (!_detailStaff || _photoUploadBusy) return;
    _photoUploadBusy = true;

    const box = document.getElementById('stDetailPhotoBox');
    const btn = document.getElementById('stDetailPhotoBtn');
    if (btn) btn.disabled = true;
    const spinner = document.createElement('div');
    spinner.className = 'img-spinner';
    box?.appendChild(spinner);

    try {
        const blob         = await _toWebP(file);
        const oldPublicId  = _detailStaff.profileImagePublicId || extractCloudinaryPublicId(_detailStaff.profileImageUrl) || null;
        const result       = await uploadMenuImage(blob, oldPublicId);

        await updateStaffPhoto(_detailStaff.id, { url: result.url, publicId: result.publicId });

        // Update in-memory state so the open Detail overlay AND the card
        // grid behind it both reflect the new photo immediately, without a
        // full network refetch.
        _detailStaff.profileImageUrl       = result.url;
        _detailStaff.profileImagePublicId  = result.publicId;
        const listEntry = _staffList.find(s => s.id === _detailStaff.id);
        if (listEntry) {
            listEntry.profileImageUrl      = result.url;
            listEntry.profileImagePublicId = result.publicId;
        }
        _refreshDetailPhotoUI();
        _renderList();
    } catch (e) {
        console.error('[staff-admin] staff photo upload failed:', e);
        await showAlert('Photo upload nahi hua. Internet check karo.', 'error', 'Upload Failed');
    } finally {
        _photoUploadBusy = false;
        if (document.getElementById('stDetailPhotoBtn')) document.getElementById('stDetailPhotoBtn').disabled = false;
        document.getElementById('stDetailPhotoBox')?.querySelector('.img-spinner')?.remove();
    }
}

function _refreshDetailPhotoUI() {
    const box = document.getElementById('stDetailPhotoBox');
    const btn = document.getElementById('stDetailPhotoBtn');
    if (box) {
        box.innerHTML = _detailStaff.profileImageUrl
            ? `<img id="stDetailPhotoImg" src="${esc(_detailStaff.profileImageUrl)}" alt="">`
            : `<span class="staff-detail-photo-initial">${esc(_avatarLetter(_detailStaff.name))}</span>`;
    }
    if (btn) btn.textContent = `📤 ${_detailStaff.profileImageUrl ? 'Change Photo' : 'Upload Photo'}`;
}

// Client-side downscale/convert to WebP before upload — mirrors the private
// helper of the same name in js/admin-menu.js (kept as a local copy since
// that one isn't exported; behavior is identical). Falls back to the
// original file untouched if canvas/WebP isn't available for any reason.
function _toWebP(file) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(file), 10000);
        const cleanup = (r) => { clearTimeout(timer); resolve(r); };
        try {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(url);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || 1;
                    canvas.height = img.naturalHeight || 1;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) { cleanup(file); return; }
                    ctx.drawImage(img, 0, 0);
                    canvas.toBlob((blob) => cleanup(blob && blob.size > 0 ? blob : file), 'image/webp', 0.85);
                } catch (_) { cleanup(file); }
            };
            img.onerror = () => { URL.revokeObjectURL(url); cleanup(file); };
            img.src = url;
        } catch (_) { cleanup(file); }
    });
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
// AI UPDATE [2026-09-15] session 2: Working is now the DEFAULT state — a date
// with no explicit Firestore record is synthesized as {holiday:false,
// advance:0, note:''} for display (never shown as "no data"/"unknown"), and
// every row (including a synthesized default one) is editable so Admin can
// add a missed historical advance or correct a Working/Holiday mistake.
function _renderDetailRecords() {
    const listEl    = document.getElementById('stDetailRecords');
    const summaryEl = document.getElementById('stDetailRangeSummary');
    if (!listEl) return;

    // ── Particular-date mode: always show exactly one row (real record or the
    //    default Working/₹0), plus a direct Edit affordance for that date. ──
    if (_detailMode === 'date' && _detailDateSel) {
        summaryEl.classList.add('hidden');
        const rec = _detailAllRecords.find(r => r.id === _detailDateSel)
            || { id: _detailDateSel, holiday: false, advance: 0, note: '' };
        listEl.innerHTML = `
            <div class="staff-record-row">
                <div class="staff-record-date">${esc(formatDateLabel(rec.id))}</div>
                <div class="staff-record-mid">
                    <span class="status-pill-sm ${rec.holiday ? 'on' : 'off'}">${rec.holiday ? 'Holiday' : 'Working'}</span>
                    ${rec.note ? `<span class="staff-record-note">${esc(rec.note)}</span>` : ''}
                </div>
                <div class="staff-record-advance">${rec.advance ? '₹' + rec.advance : '—'}</div>
            </div>
            <button class="btn btn-primary btn-sm" id="stEditDateBtn" style="width:100%;margin-top:10px;">
                ✏️ Edit ${esc(formatDateLabel(rec.id))}
            </button>
        `;
        document.getElementById('stEditDateBtn').addEventListener('click', () => _openEditDateModal(rec.id));
        return;
    }

    // ── "All history" / range mode: only dates with an EXPLICIT saved record
    //    are listed (keeps the database — and this list — clean; every other
    //    date in between is implicitly Working/₹0 and is not itemized here).
    //    Holiday-count / total-advance below are always computed from this
    //    same explicit-records list, so missing dates correctly count as
    //    Working and never inflate the holiday count. ──
    let records = _detailAllRecords;

    if (_detailMode === 'range' && _detailFrom && _detailTo) {
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
        listEl.innerHTML = `<div class="empty-state">No explicit daily records ${_detailMode === 'range' ? 'in this range' : 'yet'} — every date defaults to Working, ₹0. Use the Date field above to add one.</div>`;
        return;
    }

    listEl.innerHTML = records.map(r => `
        <div class="staff-record-row" data-date="${esc(r.id)}" style="cursor:pointer;" title="Tap to edit this date">
            <div class="staff-record-date">${esc(formatDateLabel(r.id))}</div>
            <div class="staff-record-mid">
                <span class="status-pill-sm ${r.holiday ? 'on' : 'off'}">${r.holiday ? 'Holiday' : 'Working'}</span>
                ${r.note ? `<span class="staff-record-note">${esc(r.note)}</span>` : ''}
            </div>
            <div class="staff-record-advance">${r.advance ? '₹' + r.advance : '—'}</div>
        </div>
    `).join('');

    listEl.querySelectorAll('.staff-record-row').forEach(row => {
        row.addEventListener('click', () => _openEditDateModal(row.dataset.date));
    });
}

// ── Edit a specific date's daily record (create, correct Holiday/Working,
// add a missed/late advance, edit the note). This is the ONLY write path for
// historical dates — it calls the exact same saveDailyRecord() used by the
// POS, so "one staff + one date = one daily record" holds identically here:
// saving 14 Sep can never touch 15 Sep's already-saved document. ──
async function _openEditDateModal(dateStr) {
    if (!_detailStaff) return;

    // Re-fetch fresh (rather than trusting the possibly-stale in-memory
    // _detailAllRecords) in case the POS or another Admin tab wrote to this
    // exact date in the meantime.
    let rec = null;
    try {
        rec = await getDailyRecord(_detailStaff.id, dateStr);
    } catch (e) {
        console.error('[staff-admin] getDailyRecord failed:', e);
    }
    const holiday = !!(rec && rec.holiday);
    const advance = rec && rec.advance ? rec.advance : '';
    const note    = rec && rec.note ? rec.note : '';

    const html = `
        <div class="modal-overlay" id="stEditDateModal">
            <div class="modal-box">
                <div class="modal-header">
                    <h2>${esc(formatDateLabel(dateStr))}</h2>
                    <button class="modal-close-x" id="stEditDateCloseBtn">✕</button>
                </div>
                <div class="form-group">
                    <label>Status</label>
                    <div style="display:flex;gap:10px;">
                        <button type="button" class="btn ${!holiday ? 'btn-primary' : 'btn-cancel'}" id="stEditWorkingBtn" style="flex:1;">Working</button>
                        <button type="button" class="btn ${holiday ? 'btn-primary' : 'btn-cancel'}" id="stEditHolidayBtn" style="flex:1;">Holiday</button>
                    </div>
                </div>
                <div class="form-group">
                    <label>Advance (₹)</label>
                    <input type="number" id="stEditAdvanceInput" value="${esc(String(advance))}" placeholder="0">
                </div>
                <div class="form-group">
                    <label>Note (optional)</label>
                    <input type="text" id="stEditNoteInput" value="${esc(note)}" placeholder="e.g. Personal emergency">
                </div>
                <div class="modal-actions">
                    <button class="btn btn-cancel" id="stEditDateCancelBtn">Cancel</button>
                    <button class="btn btn-primary" id="stEditDateSaveBtn">Save</button>
                </div>
            </div>
        </div>
    `;
    _appendModal('stEditDateModalHost', html);

    let _editHoliday = holiday;
    const workingBtn = document.getElementById('stEditWorkingBtn');
    const holidayBtn = document.getElementById('stEditHolidayBtn');
    const setStatus = (h) => {
        _editHoliday = h;
        workingBtn.className = `btn ${!h ? 'btn-primary' : 'btn-cancel'}`;
        holidayBtn.className = `btn ${h ? 'btn-primary' : 'btn-cancel'}`;
    };
    // Holiday and Advance are independent — toggling Status never clears the
    // Advance/Note fields, so both can be saved together on the same date.
    workingBtn.addEventListener('click', () => setStatus(false));
    holidayBtn.addEventListener('click', () => setStatus(true));

    const close = () => document.getElementById('stEditDateModalHost')?.remove();
    document.getElementById('stEditDateCloseBtn').addEventListener('click', close);
    document.getElementById('stEditDateCancelBtn').addEventListener('click', close);
    document.getElementById('stEditDateSaveBtn').addEventListener('click', async () => {
        const btn = document.getElementById('stEditDateSaveBtn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            await saveDailyRecord(_detailStaff.id, dateStr, {
                holiday: _editHoliday,
                advance: document.getElementById('stEditAdvanceInput').value,
                note: document.getElementById('stEditNoteInput').value,
            });
            close();
            // Refresh the overlay's full history + stats so the edit is
            // reflected immediately in both the All-Time totals and any
            // currently-active date/range view.
            _detailAllRecords = await fetchAllDailyRecords(_detailStaff.id);
            _renderDetailStats();
            _renderDetailRecords();
        } catch (e) {
            console.error('[staff-admin] saveDailyRecord failed:', e);
            await showAlert('Save nahi hua. Internet check karo.', 'error', 'Save Failed');
            btn.disabled = false;
            btn.textContent = 'Save';
        }
    });
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
