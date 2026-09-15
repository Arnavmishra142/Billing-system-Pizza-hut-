// js/staff-pos.js
// AI UPDATE [2026-09-15]: NEW FILE — POS / Manager side of Staff Management.
// AI UPDATE [2026-09-15] session 2: CORRECTED per updated task spec —
//   1. POS is now TODAY-ONLY. Removed all previous/next-day navigation —
//      historical date browsing/editing belongs exclusively to the Admin
//      Panel's Staff tab (js/staff-admin.js).
//   2. Default status is now explicitly "Working": a staff member with no
//      Firestore dailyRecords/{today} document is displayed as Working,
//      Holiday OFF, Advance ₹0 — the manager never has to press Save just to
//      mark someone Working. Saving only happens when there is something to
//      actually record (Holiday ON, an advance, and/or a note).
//   3. The current date auto-advances at midnight without a page reload
//      (checked every 60s) so a tablet left open overnight shows the new
//      day's (empty-by-default) staff list automatically.
//
// Loaded by staff.html only. All Firestore access goes through
// js/staff-shared.js — the SAME module the Admin Panel's Staff tab uses, so
// both sides always read/write identical data.
//
// Screens:
//   #screenList   — today's staff list (each defaulting to Working)
//   #screenDetail — one staff member's TODAY record (Holiday / Advance / Note)

import { showAlert } from './dialog.js';
import {
    dateKey, formatDateLabel,
    fetchStaffList, getDailyRecord, saveDailyRecord
} from './staff-shared.js';

let _staffList      = [];
let _currentDateKey = dateKey();
let _selectedStaff  = null; // { id, name, workType }
let _holidayValue   = false;

// ── DOM refs ──
const dateLabelEl   = document.getElementById('dateLabel');
const screenList    = document.getElementById('screenList');
const screenDetail  = document.getElementById('screenDetail');
const staffListArea = document.getElementById('staffListArea');
const detailBackBtn = document.getElementById('detailBackBtn');
const detailPhoto   = document.getElementById('detailPhoto');
const detailName    = document.getElementById('detailName');
const detailType    = document.getElementById('detailType');
const detailDate    = document.getElementById('detailDate');
const holidayOffBtn = document.getElementById('holidayOffBtn');
const holidayOnBtn  = document.getElementById('holidayOnBtn');
const advanceInput  = document.getElementById('advanceInput');
const noteInput     = document.getElementById('noteInput');
const saveRecordBtn = document.getElementById('saveRecordBtn');

function esc(s = '') { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Date bar (today only — no navigation) ──
function renderDateBar() {
    dateLabelEl.innerHTML = `${formatDateLabel(_currentDateKey)} <span class="date-today-pill">TODAY</span>`;
}

// ── Screen switching ──
function showListScreen() {
    screenDetail.classList.remove('active');
    screenList.classList.remove('hidden');
    _selectedStaff = null;
}
function showDetailScreen() {
    screenList.classList.add('hidden');
    screenDetail.classList.add('active');
}

// ── Staff list ──
async function loadStaffList() {
    staffListArea.innerHTML = '<div class="loading-state">Loading staff… ⏳</div>';
    try {
        _staffList = await fetchStaffList();
    } catch (e) {
        console.error('[staff-pos] fetchStaffList failed:', e);
        staffListArea.innerHTML = '<div class="empty-state">Could not load staff. Check internet & reload.</div>';
        return;
    }
    await renderStaffList();
}

async function renderStaffList() {
    if (_staffList.length === 0) {
        staffListArea.innerHTML = '<div class="empty-state">No staff added yet.<br>Add staff from the Admin Panel first.</div>';
        return;
    }

    // Fetch each staff member's record for TODAY only (small staff count in a
    // restaurant POS, so fetching in parallel is cheap). A staff member with
    // no document for today is — by design — Working / Holiday OFF / ₹0, so
    // a missing record is never an error state, just the default.
    const records = await Promise.all(
        _staffList.map(s => getDailyRecord(s.id, _currentDateKey).catch(() => null))
    );

    staffListArea.innerHTML = _staffList.map((s, i) => {
        const rec = records[i];
        const holiday = !!(rec && rec.holiday);
        const advance = rec ? Number(rec.advance) || 0 : 0;
        const initial = (s.name || '?').trim().charAt(0).toUpperCase() || '?';
        // AI UPDATE [2026-09-15] session 3: staff profile photo. POS only
        // DISPLAYS the image stored on the staff profile (via staff-shared.js
        // fetchStaffList) — uploading/changing the photo is Admin-only, per
        // spec. No image is missing → broken; a staff member with no
        // profileImageUrl simply falls back to the existing initial avatar.
        const avatarHtml = s.profileImageUrl
            ? `<img src="${esc(s.profileImageUrl)}" alt="">`
            : initial;
        return `
            <div class="staff-row" data-id="${esc(s.id)}">
                <div class="staff-av">${avatarHtml}</div>
                <div class="staff-row-info">
                    <div class="staff-row-name">${esc(s.name || 'Unnamed')}</div>
                    <div class="staff-row-type">${esc(s.workType || '')}</div>
                </div>
                <div class="staff-row-status">
                    <span class="status-pill ${holiday ? 'on' : 'off'}">${holiday ? 'Holiday' : 'Working'}</span>
                    ${advance > 0 ? `<span class="status-advance">₹${advance}</span>` : ''}
                </div>
            </div>
        `;
    }).join('');

    staffListArea.querySelectorAll('.staff-row').forEach(row => {
        row.addEventListener('click', () => openStaffDetail(row.dataset.id));
    });
}

// ── Daily record detail (always TODAY — _currentDateKey never changes via UI) ──
async function openStaffDetail(staffId) {
    const staff = _staffList.find(s => s.id === staffId);
    if (!staff) return;
    _selectedStaff = staff;

    if (detailPhoto) {
        const initial = (staff.name || '?').trim().charAt(0).toUpperCase() || '?';
        detailPhoto.innerHTML = staff.profileImageUrl
            ? `<img src="${esc(staff.profileImageUrl)}" alt="">`
            : `<span class="detail-photo-initial">${esc(initial)}</span>`;
    }
    detailName.textContent = staff.name || 'Unnamed';
    detailType.textContent = staff.workType || '';
    detailDate.textContent = formatDateLabel(_currentDateKey);
    advanceInput.value = '';
    noteInput.value = '';
    setHoliday(false); // default: Working (Holiday OFF) until the actual record loads

    showDetailScreen();

    try {
        const rec = await getDailyRecord(staffId, _currentDateKey);
        if (rec) {
            setHoliday(!!rec.holiday);
            advanceInput.value = rec.advance ? rec.advance : '';
            noteInput.value = rec.note || '';
        }
        // No record → defaults already applied above (Working / ₹0 / no note).
    } catch (e) {
        console.error('[staff-pos] getDailyRecord failed:', e);
    }
}

function setHoliday(val) {
    _holidayValue = !!val;
    holidayOffBtn.classList.toggle('active-off', !_holidayValue);
    holidayOnBtn.classList.toggle('active-on', _holidayValue);
}

// ── Event wiring ──
detailBackBtn.addEventListener('click', async () => {
    showListScreen();
    await renderStaffList();
});

holidayOffBtn.addEventListener('click', () => setHoliday(false));
holidayOnBtn.addEventListener('click', () => setHoliday(true));

saveRecordBtn.addEventListener('click', async () => {
    if (!_selectedStaff) return;
    saveRecordBtn.disabled = true;
    saveRecordBtn.textContent = 'Saving…';
    try {
        // Holiday ON and/or Advance/Note can coexist freely — never mutually
        // exclusive (Holiday and Advance are independent fields on the same
        // daily record).
        await saveDailyRecord(_selectedStaff.id, _currentDateKey, {
            holiday: _holidayValue,
            advance: advanceInput.value,
            note: noteInput.value,
        });
        showListScreen();
        await renderStaffList();
    } catch (e) {
        console.error('[staff-pos] saveDailyRecord failed:', e);
        await showAlert('Save nahi hua. Internet check karo.', 'error', 'Save Failed');
    } finally {
        saveRecordBtn.disabled = false;
        saveRecordBtn.textContent = '💾 Save';
    }
});

// ── Midnight rollover ──
// If this tablet/page is left open across midnight, automatically switch to
// the new day's (fresh, all-Working-by-default) staff list without requiring
// a manual reload. Checked every 60s — cheap and simple, matches the "keep
// POS simple" instruction better than a precise setTimeout-to-midnight timer.
setInterval(() => {
    const nowKey = dateKey();
    if (nowKey !== _currentDateKey) {
        _currentDateKey = nowKey;
        renderDateBar();
        if (screenDetail.classList.contains('active')) {
            // Currently viewing a staff member's record when the day rolled
            // over — return to the list so the manager isn't left editing
            // what is now yesterday's (already-saved) record by mistake.
            showListScreen();
        }
        renderStaffList();
    }
}, 60 * 1000);

// ── Start ──
document.addEventListener('DOMContentLoaded', () => {
    renderDateBar();
    loadStaffList();
});
