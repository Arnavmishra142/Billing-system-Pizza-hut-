// menu-management.js
// Real-time menu management panel for the admin drawer.
// Uses onSnapshot so changes appear instantly on the customer panel.

import { db } from './firebase-config.js';
import {
    collection,
    onSnapshot,
    doc,
    updateDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ── State ─────────────────────────────────────────────────────────────────────
let _allItems    = [];
let _search      = '';
let _activeCat   = 'All';
let _unsubscribe = null;
let _initted     = false;
let _toggling    = new Set(); // IDs currently being saved (prevent double-tap)

// ── CSS ───────────────────────────────────────────────────────────────────────
(function injectCSS() {
    if (document.getElementById('menu-mgmt-style')) return;
    const s = document.createElement('style');
    s.id = 'menu-mgmt-style';
    s.textContent = `
        /* ── Search bar ── */
        #menuMgmtSearch {
            display: block;
            width: 100%;
            padding: 10px 16px 10px 40px;
            background: rgba(255,255,255,0.07);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 10px;
            color: inherit;
            font-size: 0.95rem;
            outline: none;
            transition: border-color 0.2s;
        }
        #menuMgmtSearch:focus { border-color: #6366f1; }
        #menuMgmtSearch::placeholder { color: rgba(255,255,255,0.35); }
        .mm-search-wrap {
            position: relative;
            padding: 12px 16px 8px;
            flex-shrink: 0;
        }
        .mm-search-icon {
            position: absolute;
            left: 28px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 0.95rem;
            opacity: 0.45;
            pointer-events: none;
        }

        /* ── Category pills ── */
        .mm-cats {
            display: flex;
            gap: 8px;
            padding: 0 16px 10px;
            overflow-x: auto;
            flex-shrink: 0;
            scrollbar-width: none;
        }
        .mm-cats::-webkit-scrollbar { display: none; }
        .mm-cat-pill {
            flex-shrink: 0;
            padding: 5px 14px;
            border-radius: 20px;
            border: 1px solid rgba(255,255,255,0.15);
            background: transparent;
            color: rgba(255,255,255,0.65);
            font-size: 0.82rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.18s;
            white-space: nowrap;
        }
        .mm-cat-pill.active {
            background: #6366f1;
            border-color: #6366f1;
            color: #fff;
        }

        /* ── Items container ── */
        #menuMgmtItems {
            flex: 1;
            overflow-y: auto;
            padding: 4px 16px 24px;
        }

        /* ── Category header ── */
        .mm-cat-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 14px 0 8px;
            font-size: 0.78rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: rgba(255,255,255,0.4);
            border-bottom: 1px solid rgba(255,255,255,0.06);
            margin-bottom: 6px;
        }
        .mm-cat-header .mm-cat-stats {
            font-weight: 500;
            font-size: 0.75rem;
            color: rgba(255,255,255,0.3);
            text-transform: none;
            letter-spacing: 0;
        }

        /* ── Item row ── */
        .mm-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 11px 14px;
            border-radius: 10px;
            margin-bottom: 6px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.06);
            transition: background 0.15s, opacity 0.2s;
        }
        .mm-item.mm-off {
            opacity: 0.5;
        }
        .mm-item-info { flex: 1; min-width: 0; }
        .mm-item-name {
            font-size: 0.92rem;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: #f1f5f9;
        }
        .mm-item-meta {
            font-size: 0.78rem;
            color: rgba(255,255,255,0.45);
            margin-top: 2px;
        }
        .mm-item-price {
            font-weight: 700;
            color: #34d399;
            font-size: 0.9rem;
        }
        .mm-oos-badge {
            font-size: 0.7rem;
            font-weight: 700;
            color: #ef4444;
            background: rgba(239,68,68,0.12);
            border: 1px solid rgba(239,68,68,0.25);
            border-radius: 5px;
            padding: 1px 6px;
            margin-left: 6px;
            vertical-align: middle;
        }

        /* ── Toggle switch ── */
        .mm-toggle { position: relative; width: 48px; height: 26px; flex-shrink: 0; }
        .mm-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
        .mm-slider {
            position: absolute; inset: 0;
            background: rgba(255,255,255,0.12);
            border-radius: 26px;
            cursor: pointer;
            transition: background 0.25s;
        }
        .mm-slider::before {
            content: '';
            position: absolute;
            width: 20px; height: 20px;
            background: rgba(255,255,255,0.55);
            border-radius: 50%;
            top: 3px; left: 3px;
            transition: transform 0.25s, background 0.25s;
        }
        .mm-toggle input:checked + .mm-slider { background: #10b981; }
        .mm-toggle input:checked + .mm-slider::before {
            background: #fff;
            transform: translateX(22px);
        }
        .mm-toggle.saving .mm-slider { opacity: 0.6; cursor: not-allowed; }

        /* ── Empty state ── */
        .mm-empty {
            text-align: center;
            padding: 40px 20px;
            color: rgba(255,255,255,0.3);
            font-size: 0.9rem;
        }
        .mm-empty-icon { font-size: 2.5rem; margin-bottom: 10px; }

        /* ── Loading state ── */
        .mm-loading {
            text-align: center;
            padding: 40px 20px;
            color: rgba(255,255,255,0.35);
            font-size: 0.9rem;
        }

        /* ── Light mode overrides ── */
        .light-mode #menuMgmtSearch {
            background: rgba(0,0,0,0.05);
            border-color: rgba(0,0,0,0.12);
            color: #1f2937;
        }
        .light-mode #menuMgmtSearch::placeholder { color: rgba(0,0,0,0.35); }
        .light-mode .mm-cat-pill {
            border-color: rgba(0,0,0,0.15);
            color: rgba(0,0,0,0.55);
        }
        .light-mode .mm-cat-pill.active { color: #fff; }
        .light-mode .mm-item {
            background: rgba(0,0,0,0.03);
            border-color: rgba(0,0,0,0.07);
        }
        .light-mode .mm-item-name { color: #1e293b; }
        .light-mode .mm-item-meta { color: rgba(0,0,0,0.45); }
        .light-mode .mm-cat-header { color: rgba(0,0,0,0.4); border-color: rgba(0,0,0,0.08); }
        .light-mode .mm-slider { background: rgba(0,0,0,0.15); }
        .light-mode .mm-slider::before { background: rgba(0,0,0,0.4); }
        .light-mode .mm-toggle input:checked + .mm-slider::before { background: #fff; }
    `;
    document.head.appendChild(s);
})();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call once when the Menu tab is first opened.
 * On subsequent opens it just re-renders from the cached _allItems.
 */
export function initMenuManagement() {
    if (!_initted) {
        _initted = true;
        _setupSearch();
        _showLoading();
        _startListener();
    } else {
        _render();
    }
}

/** Stop the Firestore listener (e.g. on drawer close). */
export function destroyMenuManagement() {
    if (_unsubscribe) {
        _unsubscribe();
        _unsubscribe = null;
    }
    _initted     = false;
    _allItems    = [];
    _search      = '';
    _activeCat   = 'All';
    _toggling.clear();
}

// ── Firestore listener ────────────────────────────────────────────────────────
function _startListener() {
    if (_unsubscribe) { _unsubscribe(); }

    _unsubscribe = onSnapshot(
        collection(db, 'menu_items'),
        (snap) => {
            _allItems = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => {
                    const ca = (a.category || 'Other').toLowerCase();
                    const cb = (b.category || 'Other').toLowerCase();
                    if (ca !== cb) return ca < cb ? -1 : 1;
                    return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1;
                });
            _render();
        },
        (err) => {
            console.error('[menu-mgmt] listener error:', err);
            const container = document.getElementById('menuMgmtItems');
            if (container) {
                container.innerHTML = `<div class="mm-empty">
                    <div class="mm-empty-icon">⚠️</div>
                    <div>Failed to load menu.<br>Check your connection and try again.</div>
                </div>`;
            }
        }
    );
}

// ── Toggle ────────────────────────────────────────────────────────────────────
async function _toggle(id) {
    if (_toggling.has(id)) return;

    const item = _allItems.find(i => i.id === id);
    if (!item) return;

    const wasOn = item.inStock !== false; // treat undefined as true
    const newVal = !wasOn;

    // Optimistic update
    item.inStock = newVal;
    _toggling.add(id);
    _render();

    try {
        await updateDoc(doc(db, 'menu_items', id), { inStock: newVal });
    } catch (e) {
        console.error('[menu-mgmt] toggle failed:', e);
        // Revert on error
        item.inStock = wasOn;
        _render();
        _showToastError(`Could not update "${item.name}". Try again.`);
    } finally {
        _toggling.delete(id);
        // No need to re-render here; onSnapshot will confirm and re-render
    }
}

// ── Render ────────────────────────────────────────────────────────────────────
function _render() {
    const catContainer  = document.getElementById('menuMgmtCats');
    const itemContainer = document.getElementById('menuMgmtItems');
    if (!itemContainer) return;

    const filtered = _getFiltered();
    _renderCategoryPills(catContainer);
    _renderItems(itemContainer, filtered);
}

function _getFiltered() {
    return _allItems.filter(item => {
        const matchSearch = !_search || (item.name || '').toLowerCase().includes(_search);
        const matchCat    = _activeCat === 'All' || item.category === _activeCat;
        return matchSearch && matchCat;
    });
}

function _renderCategoryPills(el) {
    if (!el) return;
    const cats = ['All', ...[...new Set(_allItems.map(i => i.category || 'Other'))].sort()];
    el.innerHTML = cats.map(cat => `
        <button class="mm-cat-pill ${cat === _activeCat ? 'active' : ''}" data-cat="${cat}">
            ${cat}
        </button>
    `).join('');
    el.querySelectorAll('.mm-cat-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            _activeCat = btn.dataset.cat;
            _render();
        });
    });
}

function _renderItems(el, items) {
    if (!el) return;

    if (items.length === 0) {
        el.innerHTML = `<div class="mm-empty">
            <div class="mm-empty-icon">${_search ? '🔍' : '🍽️'}</div>
            <div>${_search ? `No items match "${_search}"` : 'No items in this category.'}</div>
        </div>`;
        return;
    }

    // Preserve scroll position
    const scrollTop = el.scrollTop;

    // Group by category
    const groups = {};
    items.forEach(item => {
        const cat = item.category || 'Other';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(item);
    });

    el.innerHTML = Object.entries(groups).map(([cat, catItems]) => {
        const offCount = catItems.filter(i => i.inStock === false).length;
        const statsText = offCount > 0
            ? `${catItems.length} items · <span style="color:#ef4444;">${offCount} off</span>`
            : `${catItems.length} items`;

        const rows = catItems.map(item => {
            const isOn      = item.inStock !== false;
            const isSaving  = _toggling.has(item.id);
            const esc       = (s = '') => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');

            return `
                <div class="mm-item ${isOn ? '' : 'mm-off'}">
                    <div class="mm-item-info">
                        <div class="mm-item-name">
                            ${esc(item.name)}
                            ${!isOn ? '<span class="mm-oos-badge">OFF</span>' : ''}
                        </div>
                        <div class="mm-item-meta mm-item-price">₹${item.price || 0}</div>
                    </div>
                    <label class="mm-toggle ${isSaving ? 'saving' : ''}" title="${isOn ? 'Turn off (mark out of stock)' : 'Turn on (mark available)'}">
                        <input type="checkbox" ${isOn ? 'checked' : ''} data-id="${item.id}" ${isSaving ? 'disabled' : ''}>
                        <span class="mm-slider"></span>
                    </label>
                </div>
            `;
        }).join('');

        return `
            <div class="mm-cat-header">
                <span>${cat}</span>
                <span class="mm-cat-stats">${statsText}</span>
            </div>
            ${rows}
        `;
    }).join('');

    // Wire toggle events
    el.querySelectorAll('.mm-toggle input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => _toggle(cb.dataset.id));
    });

    // Restore scroll
    el.scrollTop = scrollTop;
}

// ── Search setup ──────────────────────────────────────────────────────────────
function _setupSearch() {
    const input = document.getElementById('menuMgmtSearch');
    if (!input) return;
    input.addEventListener('input', (e) => {
        _search = e.target.value.toLowerCase().trim();
        _render();
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _showLoading() {
    const el = document.getElementById('menuMgmtItems');
    if (el) el.innerHTML = `<div class="mm-loading">Loading menu items…</div>`;
}

function _showToastError(msg) {
    const t = document.createElement('div');
    t.style.cssText = `
        position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
        background:#ef4444; color:#fff; border-radius:10px;
        padding:10px 20px; font-size:0.88rem; font-weight:600;
        z-index:99999; white-space:nowrap; box-shadow:0 4px 20px rgba(0,0,0,0.3);
    `;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
}
