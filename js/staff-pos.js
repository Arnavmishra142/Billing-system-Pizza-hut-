// js/staff-pos.js
// AI UPDATE [2026-09-15]: NEW FILE — POS / Manager side of Staff Management.
// Loaded by staff.html only. All Firestore access goes through
// js/staff-shared.js — the SAME module the Admin Panel's Staff tab
// (js/staff-admin.js) uses, so both sides always read/write identical data.
//
// Screens:
//   #screenList   — today's (or selected date's) staff list
//   #screenDetail — one staff member's daily record (Holiday / Advance / Note)
//
// Date-wise storage rule (see staff-shared.js): each date has its own
// dailyRecords/{date} document. Switching dates never overwrites another
// date's record, and a date with no saved record simply shows the defaults
// (Holiday OFF, Advance empty, Note empty) until Save is pressed.

import { showAlert } from './dialog.js';
import {
    dateKey, formatDateLabel, addDaysToKey,
    fetchStaffList, getDailyRecord, saveDailyRecord
} from './staff-shared.js';

let _staffList     = [];
let _currentDateKey = dateKey();
let _selectedStaff  = null; // { id, name, workType }
let _holidayValue   = false;

// ── DOM refs ──
const dateLabelEl   = document.getElementById('dateLabel');
const prevDayBtn    = document.getElementById('prevDayBtn');
const nextDayBtn    = document.getElementById('nextDayBtn');
const screenList    = document.getElementById('screenList');
const screenDetail  = document.getElementById('screenDetail');
const staffListArea = document.getElementById('staffListArea');
const detailBackBtn = document.getElementById('detailBackBtn');
const detailName    = document.getElementById('detailName');
const detailType    = document.getElementById('detailType');
const detailDate    = document.getElementById('detailDate');
const holidayOffBtn = document.getElementById('holidayOffBtn');
const holidayOnBtn  = document.getElementById('holidayOnBtn');
const advanceInput  = document.getElementById('advanceInput');
const noteInput     = document.getElementById('noteInput');
const saveRecordBtn = document.getElementById('saveRecordBtn');

function esc(s = '') { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Date bar ──
function renderDateBar() {
    const isToday = _currentDateKey === dateKey();
    dateLabelEl.innerHTML = `${formatDateLabel(_currentDateKey)}${isToday ? ' <span class="date-today-pill">TODAY</span>' : ''}`;
    nextDayBtn.disabled = isToday; // never navigate into the future
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

    // Fetch each staff member's record for the currently selected date so the
    // list shows at-a-glance Holiday/Advance status (small staff count in a
    // restaurant POS, so fetching in parallel is cheap).
    const records = await Promise.all(
        _staffList.map(s => getDailyRecord(s.id, _currentDateKey).catch(() => null))
    );

    staffListArea.innerHTML = _staffList.map((s, i) => {
        const rec = records[i];
        const holiday = !!(rec && rec.holiday);
        const advance = rec ? Number(rec.advance) || 0 : 0;
        const initial = (s.name || '?').trim().charAt(0).toUpperCase() || '?';
        return `
            <div class="staff-row" data-id="${esc(s.id)}">
                <div class="staff-av">${initial}</div>
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

// ── Daily record detail ──
async function openStaffDetail(staffId) {
    const staff = _staffList.find(s => s.id === staffId);
    if (!staff) return;
    _selectedStaff = staff;

    detailName.textContent = staff.name || 'Unnamed';
    detailType.textContent = staff.workType || '';
    detailDate.textContent = formatDateLabel(_currentDateKey);
    advanceInput.value = '';
    noteInput.value = '';
    setHoliday(false);

    showDetailScreen();

    try {
        const rec = await getDailyRecord(staffId, _currentDateKey);
        if (rec) {
            setHoliday(!!rec.holiday);
            advanceInput.value = rec.advance ? rec.advance : '';
            noteInput.value = rec.note || '';
        }
    } catch (e) {
        console.error('[staff-pos] getDailyRecord failed:', e);
    }
}

async function reloadDetailForDateChange() {
    if (!_selectedStaff) return;
    detailDate.textContent = formatDateLabel(_currentDateKey);
    advanceInput.value = '';
    noteInput.value = '';
    setHoliday(false);
    try {
        const rec = await getDailyRecord(_selectedStaff.id, _currentDateKey);
        if (rec) {
            setHoliday(!!rec.holiday);
            advanceInput.value = rec.advance ? rec.advance : '';
            noteInput.value = rec.note || '';
        }
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
prevDayBtn.addEventListener('click', async () => {
    _currentDateKey = addDaysToKey(_currentDateKey, -1);
    renderDateBar();
    if (screenDetail.classList.contains('active')) {
        await reloadDetailForDateChange();
    } else {
        await renderStaffList();
    }
});

nextDayBtn.addEventListener('click', async () => {
    if (nextDayBtn.disabled) return;
    _currentDateKey = addDaysToKey(_currentDateKey, 1);
    renderDateBar();
    if (screenDetail.classList.contains('active')) {
        await reloadDetailForDateChange();
    } else {
        await renderStaffList();
    }
});

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

// ── Start ──
document.addEventListener('DOMContentLoaded', () => {
    renderDateBar();
    loadStaffList();
});
