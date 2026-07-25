// menu-management.js
// Real-time menu management panel for the admin drawer.
// Pizza availability is managed by size (Regular / Medium / Large) via
// settings/pizza_sizes. All other items are toggled individually via inStock.

import { db } from './firebase-config.js';
import {
    collection,
    onSnapshot,
    doc,
    updateDoc,
    setDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ── State ─────────────────────────────────────────────────────────────────────
let _allItems          = [];
let _pizzaSizes        = { regular: true, medium: true, large: true };
let _search            = '';
let _activeCat         = 'All';
let _unsubItems        = null;
let _unsubPizzaSizes   = null;
let _initted           = false;
let _toggling          = new Set(); // item IDs currently saving
let _pizzaSizeSaving   = new Set(); // size keys currently saving ('regular'|'medium'|'large')

// ── Pizza helpers ─────────────────────────────────────────────────────────────
function _isPizzaVariant(item) {
    return (item.category || '').toLowerCase() === 'pizza' &&
        /\(\s*(regular|medium|large)\s*\)/i.test(item.name || '');
}

function _getPizzaSize(item) {
    if (/\(\s*regular\s*\)/i.test(item.name || '')) return 'regular';
    if (/\(\s*medium\s*\)/i.test(item.name || ''))  return 'medium';
    if (/\(\s*large\s*\)/i.test(item.name || ''))   return 'large';
    return null;
}

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

        /* ── Pizza size card ── */
        .mm-pizza-size-card {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 13px 14px;
            border-radius: 10px;
            margin-bottom: 6px;
            border: 1px solid rgba(255,255,255,0.08);
            background: rgba(245,158,11,0.06);
            transition: opacity 0.2s;
        }
        .mm-pizza-size-card.mm-off {
            opacity: 0.5;
            background: rgba(255,255,255,0.03);
        }
        .mm-pizza-size-icon {
            font-size: 1.6rem;
            flex-shrink: 0;
            width: 36px;
            text-align: center;
        }
        .mm-pizza-size-label {
            font-size: 1rem;
            font-weight: 700;
            color: #f1f5f9;
        }
        .mm-pizza-size-desc {
            font-size: 0.78rem;
            color: rgba(255,255,255,0.4);
            margin-top: 2px;
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

        /* ── Empty / loading state ── */
        .mm-empty, .mm-loading {
            text-align: center;
            padding: 40px 20px;
            color: rgba(255,255,255,0.3);
            font-size: 0.9rem;
        }
        .mm-empty-icon { font-size: 2.5rem; margin-bottom: 10px; }

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
        .light-mode .mm-pizza-size-card {
            background: rgba(245,158,11,0.08);
            border-color: rgba(0,0,0,0.08);
        }
        .light-mode .mm-pizza-size-card.mm-off { background: rgba(0,0,0,0.03); }
        .light-mode .mm-item-name, .light-mode .mm-pizza-size-label { color: #1e293b; }
        .light-mode .mm-item-meta, .light-mode .mm-pizza-size-desc { color: rgba(0,0,0,0.45); }
        .light-mode .mm-cat-header { color: rgba(0,0,0,0.4); border-color: rgba(0,0,0,0.08); }
        .light-mode .mm-slider { background: rgba(0,0,0,0.15); }
        .light-mode .mm-slider::before { background: rgba(0,0,0,0.4); }
        .light-mode .mm-toggle input:checked + .mm-slider::before { background: #fff; }
    `;
    document.head.appendChild(s);
})();

// ── Public API ────────────────────────────────────────────────────────────────

export function initMenuManagement() {
    if (!_initted) {
        _initted = true;
        _setupSearch();
        _showLoading();
        _startItemsListener();
        _startPizzaSizesListener();
    } else {
        _render();
    }
}

export function destroyMenuManagement() {
    if (_unsubItems)      { _unsubItems();      _unsubItems      = null; }
    if (_unsubPizzaSizes) { _unsubPizzaSizes(); _unsubPizzaSizes = null; }
    _initted          = false;
    _allItems         = [];
    _pizzaSizes       = { regular: true, medium: true, large: true };
    _search           = '';
    _activeCat        = 'All';
    _toggling.clear();
    _pizzaSizeSaving.clear();
}

// ── Firestore listeners ───────────────────────────────────────────────────────

function _startItemsListener() {
    if (_unsubItems) { _unsubItems(); }
    _unsubItems = onSnapshot(
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
            console.error('[menu-mgmt] items listener error:', err);
            const el = document.getElementById('menuMgmtItems');
            if (el) el.innerHTML = `<div class="mm-empty">
                <div class="mm-empty-icon">⚠️</div>
                <div>Failed to load menu. Check connection.</div>
            </div>`;
        }
    );
}

function _startPizzaSizesListener() {
    if (_unsubPizzaSizes) { _unsubPizzaSizes(); }
    _unsubPizzaSizes = onSnapshot(
        doc(db, 'settings', 'pizza_sizes'),
        (snap) => {
            _pizzaSizes = snap.exists()
                ? { regular: true, medium: true, large: true, ...snap.data() }
                : { regular: true, medium: true, large: true };
            _render();
        },
        (err) => console.error('[menu-mgmt] pizza sizes listener error:', err)
    );
}

// ── Toggles ───────────────────────────────────────────────────────────────────

async function _toggle(id) {
    if (_toggling.has(id)) return;
    const item = _allItems.find(i => i.id === id);
    if (!item) return;

    const wasOn = item.inStock !== false;
    item.inStock = !wasOn;
    _toggling.add(id);
    _render();

    try {
        await updateDoc(doc(db, 'menu_items', id), { inStock: !wasOn });
    } catch (e) {
        console.error('[menu-mgmt] item toggle failed:', e);
        item.inStock = wasOn;
        _render();
        _showToastError(`Could not update "${item.name}". Try again.`);
    } finally {
        _toggling.delete(id);
    }
}

async function _togglePizzaSize(size) {
    if (_pizzaSizeSaving.has(size)) return;

    const wasOn = _pizzaSizes[size] !== false;
    _pizzaSizes[size] = !wasOn;
    _pizzaSizeSaving.add(size);
    _render();

    try {
        // setDoc with merge so the doc is created if it doesn't exist yet
        await setDoc(doc(db, 'settings', 'pizza_sizes'), { [size]: !wasOn }, { merge: true });
    } catch (e) {
        console.error('[menu-mgmt] pizza size toggle failed:', e);
        _pizzaSizes[size] = wasOn;
        _render();
        _showToastError(`Could not update ${size} size. Try again.`);
    } finally {
        _pizzaSizeSaving.delete(size);
    }
}

// ── Render ────────────────────────────────────────────────────────────────────

function _render() {
    const catContainer  = document.getElementById('menuMgmtCats');
    const itemContainer = document.getElementById('menuMgmtItems');
    if (!itemContainer) return;

    _renderCategoryPills(catContainer);

    const scrollTop    = itemContainer.scrollTop;
    const showPizza    = (_activeCat === 'All' || _activeCat === 'Pizza');
    const showOthers   = (_activeCat !== 'Pizza');
    const filteredNonPizza = showOthers ? _getFilteredNonPizza() : [];

    let html = '';

    if (showPizza) {
        html += _buildPizzaSizesHtml();
    }

    if (showOthers && filteredNonPizza.length > 0) {
        html += _buildItemsHtml(filteredNonPizza);
    }

    if (!html) {
        html = `<div class="mm-empty">
            <div class="mm-empty-icon">${_search ? '🔍' : '🍽️'}</div>
            <div>${_search ? `No items match "${_search}"` : 'No items in this category.'}</div>
        </div>`;
    }

    itemContainer.innerHTML = html;

    // Wire pizza size toggle events
    itemContainer.querySelectorAll('input[data-size]').forEach(cb => {
        cb.addEventListener('change', () => _togglePizzaSize(cb.dataset.size));
    });
    // Wire item toggle events
    itemContainer.querySelectorAll('input[data-id]').forEach(cb => {
        cb.addEventListener('change', () => _toggle(cb.dataset.id));
    });

    itemContainer.scrollTop = scrollTop;
}

function _getFilteredNonPizza() {
    return _allItems.filter(item => {
        if (_isPizzaVariant(item)) return false; // pizza variants shown via sizes section
        const matchSearch = !_search || (item.name || '').toLowerCase().includes(_search);
        const matchCat    = _activeCat === 'All' || item.category === _activeCat;
        return matchSearch && matchCat;
    });
}

// ── Pizza sizes section builder ───────────────────────────────────────────────

function _buildPizzaSizesHtml() {
    const SIZE_META = [
        { key: 'regular', icon: '🍕', label: 'Regular',  desc: 'All Regular-size pizzas' },
        { key: 'medium',  icon: '🍕', label: 'Medium',   desc: 'All Medium-size pizzas'  },
        { key: 'large',   icon: '🍕', label: 'Large',    desc: 'All Large-size pizzas'   },
    ];

    const offCount = SIZE_META.filter(s => _pizzaSizes[s.key] === false).length;
    const stats    = offCount > 0
        ? `3 sizes · <span style="color:#ef4444;">${offCount} off</span>`
        : '3 sizes';

    const rows = SIZE_META.map(({ key, icon, label, desc }) => {
        const isOn     = _pizzaSizes[key] !== false;
        const isSaving = _pizzaSizeSaving.has(key);
        return `
            <div class="mm-pizza-size-card ${isOn ? '' : 'mm-off'}">
                <div class="mm-pizza-size-icon">${icon}</div>
                <div class="mm-item-info">
                    <div class="mm-pizza-size-label">
                        ${label}
                        ${!isOn ? '<span class="mm-oos-badge">OFF</span>' : ''}
                    </div>
                    <div class="mm-pizza-size-desc">${desc}</div>
                </div>
                <label class="mm-toggle ${isSaving ? 'saving' : ''}"
                       title="${isOn ? 'Turn off — marks all ' + label + ' pizzas out of stock' : 'Turn on — makes all ' + label + ' pizzas available'}">
                    <input type="checkbox" ${isOn ? 'checked' : ''} data-size="${key}" ${isSaving ? 'disabled' : ''}>
                    <span class="mm-slider"></span>
                </label>
            </div>
        `;
    }).join('');

    return `
        <div class="mm-cat-header">
            <span>🍕 Pizza Sizes</span>
            <span class="mm-cat-stats">${stats}</span>
        </div>
        ${rows}
    `;
}

// ── Non-pizza items section builder ──────────────────────────────────────────

function _buildItemsHtml(items) {
    const _esc = (s = '') => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Group by category
    const groups = {};
    items.forEach(item => {
        const cat = item.category || 'Other';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(item);
    });

    return Object.entries(groups).map(([cat, catItems]) => {
        const offCount  = catItems.filter(i => i.inStock === false).length;
        const statsText = offCount > 0
            ? `${catItems.length} items · <span style="color:#ef4444;">${offCount} off</span>`
            : `${catItems.length} items`;

        const rows = catItems.map(item => {
            const isOn     = item.inStock !== false;
            const isSaving = _toggling.has(item.id);
            return `
                <div class="mm-item ${isOn ? '' : 'mm-off'}">
                    <div class="mm-item-info">
                        <div class="mm-item-name">
                            ${_esc(item.name)}
                            ${!isOn ? '<span class="mm-oos-badge">OFF</span>' : ''}
                        </div>
                        <div class="mm-item-meta mm-item-price">₹${item.price || 0}</div>
                    </div>
                    <label class="mm-toggle ${isSaving ? 'saving' : ''}"
                           title="${isOn ? 'Turn off (out of stock)' : 'Turn on (available)'}">
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
}

// ── Category pills ────────────────────────────────────────────────────────────

function _renderCategoryPills(el) {
    if (!el) return;
    // Include 'Pizza' as a category pill (shows the 3-size section)
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
