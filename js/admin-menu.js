// admin-menu.js
// Hierarchical Menu Management for the Admin Panel.
// Architecture: categories → products → variants (subcollection) + extras (array)
//
// AI UPDATE [2026-08-03]: Complete architectural redesign.
//   Replaces the flat menu_items card grid in admin/index.html with a
//   two-level progressive disclosure:
//     Level 1 — Categories (first-class entities with image, order, active)
//     Level 2 — Products within a category (name, image, flags, extras)
//     Level 3 — Variants panel inside each product (price, image, inStock)
//   Also provides a one-time migration tool from legacy menu_items to the
//   new hierarchy.
//
// Exports: initAdminMenu(), destroyAdminMenu()
// Called from: js/admin.js switchTab('menu', ...)

import { db, auth } from './firebase-config.js';
import {
    collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc,
    getDocs, getDoc, writeBatch, setDoc, serverTimestamp, orderBy, query
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { uploadMenuImage, deleteMenuImage, extractCloudinaryPublicId } from './cloudinary-upload.js';
import { showAlert, showConfirm } from './dialog.js';

// ─── State ────────────────────────────────────────────────────────────────────
let _categories        = [];
let _products          = [];
let _currentCatId      = null;
let _currentCatName    = '';
let _unsubCategories   = null;
let _unsubProducts     = null;
let _initted           = false;
// AI FIX: tracks whether the one-time auto-migration from menu_items has been
// attempted so the check never runs more than once per initAdminMenu() lifecycle.
let _migrationAttempted = false;

// Product modal state
let _editingProductId  = null;   // null = new product
let _editingCatId      = null;   // category for new/edited product
let _prodImageUrl      = null;
let _prodImagePublicId = null;
let _prodUploadedThisSession = null;
let _prodUploadInProgress    = false;
let _variantEditors    = [];     // [{_key, id, name, price, imageUrl, active, inStock, displayOrder, _deleted, _dirty, _isNew}]
let _extraEditors      = [];     // [{_key, name, price, active, _deleted}]
let _variantKeySeq     = 0;

// Category modal state
let _editingCategoryId    = null;
let _catImageUrl          = null;
let _catImagePublicId     = null;
let _catUploadedThisSession = null;
let _catUploadInProgress    = false;

// Move-product modal state
let _movingProductId   = null;

// ─── CSS ──────────────────────────────────────────────────────────────────────
(function injectCSS() {
    if (document.getElementById('admin-menu-style')) return;
    const s = document.createElement('style');
    s.id = 'admin-menu-style';
    s.textContent = `
    /* ── Section layout ── */
    #amCatView, #amProdView { display: block; }
    #amProdView.am-hidden   { display: none; }

    /* ── Breadcrumb / toolbar ── */
    .am-toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 0 14px;
        flex-wrap: wrap;
    }
    .am-toolbar-title {
        flex: 1;
        font-size: 0.9rem;
        font-weight: 700;
        color: #e2e8f0;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .am-btn {
        padding: 7px 14px;
        border-radius: 8px;
        border: none;
        font-size: 0.82rem;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.15s;
        white-space: nowrap;
    }
    .am-btn:hover { opacity: 0.85; }
    .am-btn-primary   { background: #6366f1; color: #fff; }
    .am-btn-secondary { background: rgba(255,255,255,0.08); color: #e2e8f0; }
    .am-btn-danger    { background: rgba(239,68,68,0.15); color: #ef4444; }
    .am-btn-back      { background: transparent; color: #6366f1; padding-left: 0; font-size: 0.88rem; }
    .am-btn-migrate   { background: rgba(245,158,11,0.12); color: #f59e0b; font-size: 0.78rem; }

    /* ── Category card ── */
    .am-cat-card {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 12px;
        margin-bottom: 8px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.07);
        cursor: pointer;
        transition: background 0.15s;
    }
    .am-cat-card:hover { background: rgba(255,255,255,0.07); }
    .am-cat-thumb {
        width: 44px; height: 44px;
        border-radius: 10px;
        object-fit: cover;
        flex-shrink: 0;
        background: rgba(255,255,255,0.06);
        display: flex; align-items: center; justify-content: center;
        font-size: 1.4rem;
        overflow: hidden;
    }
    .am-cat-thumb img { width: 100%; height: 100%; object-fit: cover; border-radius: 10px; }
    .am-cat-info { flex: 1; min-width: 0; }
    .am-cat-name {
        font-size: 0.95rem;
        font-weight: 700;
        color: #f1f5f9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .am-cat-meta { font-size: 0.78rem; color: rgba(255,255,255,0.4); margin-top: 2px; }
    .am-cat-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
    }
    .am-icon-btn {
        width: 30px; height: 30px;
        border-radius: 8px;
        border: none;
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.6);
        font-size: 0.85rem;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.15s;
        flex-shrink: 0;
    }
    .am-icon-btn:hover { background: rgba(255,255,255,0.12); }
    .am-icon-btn.danger:hover { background: rgba(239,68,68,0.2); color: #ef4444; }
    .am-inactive { opacity: 0.45; }

    /* ── Product card ── */
    .am-prod-card {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 12px;
        margin-bottom: 7px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.07);
    }
    .am-prod-thumb {
        width: 40px; height: 40px;
        border-radius: 8px;
        flex-shrink: 0;
        background: rgba(255,255,255,0.06);
        display: flex; align-items: center; justify-content: center;
        font-size: 1.2rem;
        overflow: hidden;
    }
    .am-prod-thumb img { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }
    .am-prod-info { flex: 1; min-width: 0; }
    .am-prod-name {
        font-size: 0.88rem;
        font-weight: 600;
        color: #f1f5f9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .am-prod-meta { font-size: 0.75rem; color: rgba(255,255,255,0.4); margin-top: 2px; }
    .am-prod-flags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
    .am-flag-chip {
        font-size: 0.65rem;
        font-weight: 700;
        padding: 2px 7px;
        border-radius: 20px;
        background: rgba(99,102,241,0.2);
        color: #a5b4fc;
        border: 1px solid rgba(99,102,241,0.3);
    }
    .am-prod-actions {
        display: flex;
        align-items: center;
        gap: 5px;
        flex-shrink: 0;
    }

    /* ── Toggle (reuse menu-management style) ── */
    .am-toggle { position: relative; width: 40px; height: 22px; flex-shrink: 0; }
    .am-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .am-slider {
        position: absolute; inset: 0;
        background: rgba(255,255,255,0.12);
        border-radius: 22px;
        cursor: pointer;
        transition: background 0.2s;
    }
    .am-slider::before {
        content: '';
        position: absolute;
        width: 16px; height: 16px;
        background: rgba(255,255,255,0.55);
        border-radius: 50%;
        top: 3px; left: 3px;
        transition: transform 0.2s, background 0.2s;
    }
    .am-toggle input:checked + .am-slider { background: #10b981; }
    .am-toggle input:checked + .am-slider::before { background: #fff; transform: translateX(18px); }

    /* ── Modals ── */
    .am-modal-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.6);
        z-index: 2000;
        display: flex; align-items: flex-end; justify-content: center;
    }
    @media (min-width: 600px) {
        .am-modal-overlay { align-items: center; }
    }
    .am-modal-box {
        background: #1e2533;
        border-radius: 20px 20px 0 0;
        width: 100%;
        max-height: 92dvh;
        overflow-y: auto;
        padding: 20px;
        box-sizing: border-box;
    }
    @media (min-width: 600px) {
        .am-modal-box { border-radius: 16px; max-width: 520px; max-height: 90dvh; }
    }
    .am-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 18px;
    }
    .am-modal-title { font-size: 1.05rem; font-weight: 700; color: #f1f5f9; }
    .am-modal-close {
        width: 30px; height: 30px;
        border-radius: 50%;
        border: none;
        background: rgba(255,255,255,0.08);
        color: #94a3b8;
        font-size: 1rem;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
    }
    .am-form-group { margin-bottom: 14px; }
    .am-form-group label {
        display: block;
        font-size: 0.78rem;
        font-weight: 600;
        color: rgba(255,255,255,0.5);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
    }
    .am-form-group input, .am-form-group textarea, .am-form-group select {
        width: 100%;
        box-sizing: border-box;
        padding: 10px 14px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 10px;
        color: #f1f5f9;
        font-size: 0.92rem;
        outline: none;
        transition: border-color 0.2s;
    }
    .am-form-group input:focus,
    .am-form-group textarea:focus,
    .am-form-group select:focus { border-color: #6366f1; }
    .am-form-group textarea { resize: vertical; min-height: 60px; }
    .am-form-group select option { background: #1e2533; }
    .am-form-row { display: flex; gap: 10px; }
    .am-form-row .am-form-group { flex: 1; }

    /* ── Variant row ── */
    .am-variant-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 10px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.07);
        border-radius: 10px;
        margin-bottom: 7px;
    }
    .am-variant-row input {
        padding: 6px 10px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        color: #f1f5f9;
        font-size: 0.85rem;
        outline: none;
        min-width: 0;
    }
    .am-variant-row input:focus { border-color: #6366f1; }
    .am-variant-name  { flex: 2; }
    .am-variant-price { flex: 1; }
    .am-variant-del {
        width: 26px; height: 26px;
        border-radius: 6px;
        border: none;
        background: rgba(239,68,68,0.12);
        color: #ef4444;
        font-size: 0.8rem;
        cursor: pointer;
        flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
    }

    /* ── Extras row ── */
    .am-extra-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.07);
        border-radius: 10px;
        margin-bottom: 6px;
    }
    .am-extra-row input {
        padding: 5px 9px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        color: #f1f5f9;
        font-size: 0.82rem;
        outline: none;
        min-width: 0;
    }
    .am-extra-row input:focus { border-color: #6366f1; }

    /* ── Flags grid ── */
    .am-flags-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
    }
    .am-flag-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.07);
        border-radius: 8px;
        cursor: pointer;
    }
    .am-flag-item input[type="checkbox"] { accent-color: #6366f1; width: 15px; height: 15px; cursor: pointer; }
    .am-flag-label { font-size: 0.82rem; color: #cbd5e1; }

    /* ── Image upload ── */
    .am-img-area {
        position: relative;
        width: 80px; height: 80px;
        border-radius: 12px;
        border: 2px dashed rgba(255,255,255,0.2);
        background: rgba(255,255,255,0.04);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        overflow: hidden;
        flex-shrink: 0;
        transition: border-color 0.2s;
    }
    .am-img-area:hover { border-color: #6366f1; }
    .am-img-area img { width: 100%; height: 100%; object-fit: cover; }
    .am-img-area .am-img-placeholder { font-size: 0.7rem; color: rgba(255,255,255,0.35); text-align: center; line-height: 1.4; }
    .am-img-spinner {
        position: absolute; inset: 0;
        background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        font-size: 1rem;
    }
    .am-img-row {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 14px;
    }
    .am-img-btns { display: flex; flex-direction: column; gap: 7px; }
    .am-img-upload-btn, .am-img-remove-btn {
        padding: 6px 13px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.12);
        background: transparent;
        color: #94a3b8;
        font-size: 0.8rem;
        cursor: pointer;
        transition: background 0.15s;
    }
    .am-img-upload-btn:hover { background: rgba(255,255,255,0.07); }
    .am-img-remove-btn { color: #ef4444; border-color: rgba(239,68,68,0.25); }
    .am-img-remove-btn:hover { background: rgba(239,68,68,0.1); }

    /* ── Section divider ── */
    .am-section-divider {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 16px 0 10px;
    }
    .am-section-divider span {
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: rgba(255,255,255,0.4);
        white-space: nowrap;
    }
    .am-section-divider hr {
        flex: 1;
        border: none;
        border-top: 1px solid rgba(255,255,255,0.07);
    }

    /* ── Modal actions ── */
    .am-modal-actions {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
        margin-top: 18px;
        padding-top: 14px;
        border-top: 1px solid rgba(255,255,255,0.07);
    }

    /* ── Empty state ── */
    .am-empty {
        text-align: center;
        padding: 40px 20px;
        color: rgba(255,255,255,0.3);
        font-size: 0.9rem;
    }
    .am-empty-icon { font-size: 2.5rem; margin-bottom: 10px; }

    /* ── Migration panel ── */
    .am-migrate-panel {
        background: rgba(245,158,11,0.06);
        border: 1px solid rgba(245,158,11,0.2);
        border-radius: 12px;
        padding: 14px 16px;
        margin-bottom: 14px;
    }
    .am-migrate-title {
        font-size: 0.88rem;
        font-weight: 700;
        color: #f59e0b;
        margin-bottom: 6px;
    }
    .am-migrate-desc {
        font-size: 0.8rem;
        color: rgba(255,255,255,0.5);
        line-height: 1.5;
        margin-bottom: 10px;
    }

    /* ── Inline toggle label ── */
    .am-toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 0;
    }
    .am-toggle-label { font-size: 0.88rem; color: #cbd5e1; }

    /* ── Move product select ── */
    .am-select-cat {
        width: 100%;
        padding: 10px 14px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 10px;
        color: #f1f5f9;
        font-size: 0.92rem;
        outline: none;
        box-sizing: border-box;
    }
    .am-select-cat option { background: #1e2533; }

    /* ── Light mode ── */
    .light-mode .am-cat-card,
    .light-mode .am-prod-card { background: rgba(0,0,0,0.03); border-color: rgba(0,0,0,0.08); }
    .light-mode .am-cat-card:hover { background: rgba(0,0,0,0.06); }
    .light-mode .am-cat-name,
    .light-mode .am-prod-name,
    .light-mode .am-toolbar-title { color: #1e293b; }
    .light-mode .am-modal-box { background: #ffffff; }
    .light-mode .am-form-group input,
    .light-mode .am-form-group textarea,
    .light-mode .am-form-group select {
        background: rgba(0,0,0,0.04);
        border-color: rgba(0,0,0,0.12);
        color: #1e293b;
    }
    .light-mode .am-variant-row, .light-mode .am-extra-row { background: rgba(0,0,0,0.02); border-color: rgba(0,0,0,0.08); }
    .light-mode .am-variant-row input, .light-mode .am-extra-row input {
        background: rgba(0,0,0,0.04);
        border-color: rgba(0,0,0,0.1);
        color: #1e293b;
    }
    .light-mode .am-img-area { border-color: rgba(0,0,0,0.2); background: rgba(0,0,0,0.03); }
    .light-mode .am-icon-btn { background: rgba(0,0,0,0.06); color: #475569; }
    .light-mode .am-modal-title { color: #1e293b; }
    .light-mode .am-toggle-label { color: #374151; }
    .light-mode .am-flag-item { background: rgba(0,0,0,0.02); border-color: rgba(0,0,0,0.08); }
    .light-mode .am-flag-label { color: #374151; }
    .light-mode .am-btn-secondary { background: rgba(0,0,0,0.06); color: #374151; }
    `;
    document.head.appendChild(s);
})();

// ─── Public API ───────────────────────────────────────────────────────────────

export function initAdminMenu() {
    if (!_initted) {
        _initted = true;
        _renderMenuSection();
        _startCategoryListener();
    } else {
        _renderMenuSection();
        if (_currentCatId) {
            _renderProductsView();
        } else {
            _renderCategoriesView();
        }
    }
}

export function destroyAdminMenu() {
    if (_unsubCategories) { _unsubCategories(); _unsubCategories = null; }
    if (_unsubProducts)   { _unsubProducts();   _unsubProducts   = null; }
    _initted             = false;
    _migrationAttempted  = false;
    _categories          = [];
    _products            = [];
    _currentCatId        = null;
    _currentCatName      = '';
}

// ─── Section scaffold ─────────────────────────────────────────────────────────
function _renderMenuSection() {
    const grid = document.getElementById('menuCardGrid');
    if (!grid) return;
    if (grid.querySelector('#amCatView')) return; // already built

    grid.innerHTML = `
        <div id="amCatView">
            <div class="am-toolbar">
                <span class="am-toolbar-title">📁 Categories</span>
                <button class="am-btn am-btn-migrate" id="amMigrateBtn" title="Convert legacy menu_items to new structure">🔄 Migrate Legacy</button>
                <button class="am-btn am-btn-primary" id="amAddCatBtn">+ Category</button>
            </div>
            <div id="amCatList"><div class="am-empty"><div class="am-empty-icon">⏳</div><div>Loading…</div></div></div>
        </div>
        <div id="amProdView" class="am-hidden">
            <div class="am-toolbar">
                <button class="am-btn am-btn-back" id="amBackBtn">← Back</button>
                <span class="am-toolbar-title" id="amProdTitle"></span>
                <button class="am-btn am-btn-primary" id="amAddProdBtn">+ Product</button>
            </div>
            <div id="amProdList"><div class="am-empty"><div class="am-empty-icon">⏳</div><div>Loading…</div></div></div>
        </div>
    `;

    document.getElementById('amAddCatBtn').addEventListener('click', () => _openCategoryModal(null));
    document.getElementById('amBackBtn').addEventListener('click', _closeProductsView);
    document.getElementById('amAddProdBtn').addEventListener('click', () => _openProductModal(null));
    document.getElementById('amMigrateBtn').addEventListener('click', _showMigratePanel);
}

// ─── Category listener ────────────────────────────────────────────────────────
// AI FIX [2026-08-03]: When the first snapshot returns 0 categories, auto-check
// whether menu_items still holds the data (i.e. the code architecture changed but
// the one-time data migration was never run). If menu_items is non-empty, silently
// run the migration so the categories view populates without user intervention.
// The onSnapshot will re-fire automatically after categories are written, showing
// the migrated data. _migrationAttempted prevents this from looping.
function _startCategoryListener() {
    if (_unsubCategories) { _unsubCategories(); _unsubCategories = null; }
    _unsubCategories = onSnapshot(
        collection(db, 'categories'),
        async (snap) => {
            _categories = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0) || (a.name || '').localeCompare(b.name || ''));

            // Auto-migrate from menu_items if categories is empty on first load
            if (_categories.length === 0 && !_migrationAttempted && _initted) {
                _migrationAttempted = true;
                try {
                    const miSnap = await getDocs(collection(db, 'menu_items'));
                    if (!miSnap.empty) {
                        console.log('[admin-menu] categories empty — auto-migrating from menu_items…');
                        _showToast('Migrating menu data… please wait', 'info');
                        await _runSilentMigration(miSnap.docs.map(d => ({ id: d.id, ...d.data() })));
                        // onSnapshot fires again automatically once categories are written
                        return;
                    }
                } catch (e) {
                    console.warn('[admin-menu] auto-migration check failed:', e);
                }
            }

            if (!_currentCatId) _renderCategoriesView();
        },
        (err) => {
            console.error('[admin-menu] categories listener error:', err);
            _unsubCategories = null;
            setTimeout(() => { if (_initted && !_unsubCategories) _startCategoryListener(); }, 5000);
        }
    );
}

// ─── Silent migration (auto-triggered) ───────────────────────────────────────
// Mirrors _runMigration() but without DOM dependencies — uses console + toast
// instead of the on-screen log panel. Called automatically when categories is
// found empty but menu_items has data (post-architecture-change first load).
async function _runSilentMigration(items) {
    const user = await _waitForAuth();
    if (!user) {
        console.warn('[admin-menu] auto-migration: auth not available, skipping.');
        _showToast('Auto-migration skipped — please log in and refresh.', 'warning');
        return;
    }

    const VARIANT_RE = /\s*\(\s*(regular|medium|large|half|full|small|standard|family)\s*\)\s*$/i;
    const getBase    = (name) => (name || '').replace(VARIANT_RE, '').trim();
    const getVariant = (name) => { const m = (name || '').match(VARIANT_RE); return m ? m[1] : null; };

    // Group by category → base product name
    const catMap = {};
    items.forEach(item => {
        const cat  = item.category || 'Other';
        const base = getBase(item.name);
        if (!catMap[cat]) catMap[cat] = {};
        if (!catMap[cat][base]) catMap[cat][base] = [];
        catMap[cat][base].push(item);
    });

    // Step 1: Create categories (skip if already exists)
    const catIdMap  = {};
    const catNames  = Object.keys(catMap).sort();
    const existSnap = await getDocs(collection(db, 'categories'));
    existSnap.docs.forEach(d => { catIdMap[d.data().name] = d.id; });

    for (let i = 0; i < catNames.length; i++) {
        const catName = catNames[i];
        if (catIdMap[catName]) continue; // already exists
        try {
            const ref = await addDoc(collection(db, 'categories'), {
                name: catName, imageUrl: null, active: true,
                displayOrder: i, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
            });
            catIdMap[catName] = ref.id;
            console.log(`[admin-menu] auto-migration: created category "${catName}"`);
        } catch (e) {
            console.error(`[admin-menu] auto-migration: category "${catName}" failed:`, e);
        }
    }

    // Step 2: Create products + variants (skip products whose base name already exists in that category)
    let prodCount = 0, varCount = 0;
    for (const [catName, products] of Object.entries(catMap)) {
        const catId = catIdMap[catName];
        if (!catId) continue;
        let prodIdx = 0;
        for (const [baseName, variants] of Object.entries(products)) {
            try {
                const first      = variants[0];
                const hasVariants = variants.length > 1 || !!getVariant(first.name);
                const productData = {
                    categoryId: catId, categoryName: catName,
                    name: baseName,
                    description: first.description || '',
                    imageUrl: first.imageUrl || first.image || null,
                    active: first.active !== false,
                    inStock: first.inStock !== false,
                    hasVariants: !!hasVariants,
                    price: hasVariants ? 0 : (Number(first.price) || 0),
                    flags: { recommended: false, mostOrdered: false, chefPick: false, casualSnack: false, newArrival: false },
                    extras: (first.extraOptions || []).map(eo => ({ name: eo.name || '', price: eo.price || 0, active: true })),
                    displayOrder: prodIdx++,
                    variantsList: [],
                    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
                };
                const prodRef = await addDoc(collection(db, 'products'), productData);
                prodCount++;

                if (hasVariants) {
                    const variantsList = [];
                    const vBatch = writeBatch(db);
                    variants.forEach((item, vi) => {
                        const varName  = getVariant(item.name) || 'Standard';
                        const varLabel = varName.charAt(0).toUpperCase() + varName.slice(1).toLowerCase();
                        const varRef   = doc(db, 'products', prodRef.id, 'variants', item.id);
                        const varData  = {
                            name: varLabel, price: Number(item.price) || 0,
                            imageUrl: item.imageUrl || item.image || null,
                            active: item.active !== false, inStock: item.inStock !== false,
                            displayOrder: vi, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
                        };
                        vBatch.set(varRef, varData);
                        variantsList.push({ id: item.id, name: varLabel, price: Number(item.price) || 0,
                            imageUrl: varData.imageUrl, active: varData.active, inStock: varData.inStock, displayOrder: vi });
                        varCount++;
                    });
                    await vBatch.commit();
                    await updateDoc(prodRef, { variantsList });
                }
            } catch (e) {
                console.error(`[admin-menu] auto-migration: product "${baseName}" failed:`, e);
            }
        }
    }

    console.log(`[admin-menu] auto-migration complete: ${prodCount} products, ${varCount} variants.`);
    _showToast(`Migration complete — ${prodCount} products loaded ✓`, 'success');
    // The categories onSnapshot listener fires automatically now
}

// ─── Categories view ──────────────────────────────────────────────────────────
function _renderCategoriesView() {
    const el = document.getElementById('amCatList');
    if (!el) return;

    if (!_categories.length) {
        el.innerHTML = `<div class="am-empty">
            <div class="am-empty-icon">📁</div>
            <div>No categories yet.<br>Add one to get started.</div>
        </div>`;
        return;
    }

    el.innerHTML = _categories.map((cat, idx) => {
        const thumb = cat.imageUrl
            ? `<div class="am-cat-thumb"><img src="${esc(cat.imageUrl)}" alt=""></div>`
            : `<div class="am-cat-thumb">📂</div>`;
        const prodCount = cat._productCount != null ? `${cat._productCount} products` : '';
        const activeClass = cat.active === false ? 'am-inactive' : '';
        return `
            <div class="am-cat-card ${activeClass}" data-catid="${esc(cat.id)}">
                ${thumb}
                <div class="am-cat-info">
                    <div class="am-cat-name">${esc(cat.name || 'Unnamed')}</div>
                    <div class="am-cat-meta">${prodCount}${cat.active === false ? ' · Inactive' : ''}</div>
                </div>
                <div class="am-cat-actions" onclick="event.stopPropagation()">
                    <button class="am-icon-btn" data-action="cat-up" data-idx="${idx}" title="Move up">↑</button>
                    <button class="am-icon-btn" data-action="cat-down" data-idx="${idx}" title="Move down">↓</button>
                    <button class="am-icon-btn" data-action="cat-edit" data-catid="${esc(cat.id)}" title="Edit">✏️</button>
                    <button class="am-icon-btn danger" data-action="cat-del" data-catid="${esc(cat.id)}" title="Delete">🗑️</button>
                </div>
            </div>
        `;
    }).join('');

    // Wire clicks
    el.querySelectorAll('.am-cat-card').forEach(card => {
        card.addEventListener('click', () => _openProductsView(card.dataset.catid));
    });
    el.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const action = btn.dataset.action;
            if (action === 'cat-up')   _moveCategoryOrder(Number(btn.dataset.idx), -1);
            if (action === 'cat-down') _moveCategoryOrder(Number(btn.dataset.idx), +1);
            if (action === 'cat-edit') _openCategoryModal(btn.dataset.catid);
            if (action === 'cat-del')  _deleteCategoryById(btn.dataset.catid);
        });
    });
}

async function _moveCategoryOrder(idx, delta) {
    const swapIdx = idx + delta;
    if (swapIdx < 0 || swapIdx >= _categories.length) return;
    const user = await _waitForAuth();
    if (!user) return;
    try {
        const batch = writeBatch(db);
        const a = _categories[idx];
        const b = _categories[swapIdx];
        batch.update(doc(db, 'categories', a.id), { displayOrder: swapIdx });
        batch.update(doc(db, 'categories', b.id), { displayOrder: idx });
        await batch.commit();
    } catch (e) {
        console.error('[admin-menu] reorder failed:', e);
        _showToast('Reorder failed. Try again.', 'error');
    }
}

// ─── Products view ────────────────────────────────────────────────────────────
function _openProductsView(catId) {
    const cat = _categories.find(c => c.id === catId);
    _currentCatId   = catId;
    _currentCatName = cat ? (cat.name || '') : '';

    document.getElementById('amCatView').style.display  = 'none';
    document.getElementById('amProdView').classList.remove('am-hidden');
    document.getElementById('amProdTitle').textContent  = _currentCatName;

    if (_unsubProducts) { _unsubProducts(); _unsubProducts = null; }
    _startProductsListener(catId);
}

function _closeProductsView() {
    if (_unsubProducts) { _unsubProducts(); _unsubProducts = null; }
    _currentCatId   = null;
    _currentCatName = '';
    document.getElementById('amProdView').classList.add('am-hidden');
    document.getElementById('amCatView').style.display  = '';
}

function _startProductsListener(catId) {
    if (_unsubProducts) { _unsubProducts(); _unsubProducts = null; }
    const q = query(collection(db, 'products'),
        orderBy('categoryId'), orderBy('displayOrder'));
    _unsubProducts = onSnapshot(q,
        (snap) => {
            _products = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(p => p.categoryId === catId)
                .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0) || (a.name || '').localeCompare(b.name || ''));
            _renderProductsView();
        },
        (err) => {
            console.error('[admin-menu] products listener error:', err);
            _unsubProducts = null;
            setTimeout(() => { if (_initted && _currentCatId && !_unsubProducts) _startProductsListener(_currentCatId); }, 5000);
        }
    );
}

function _renderProductsView() {
    const el = document.getElementById('amProdList');
    if (!el) return;

    if (!_products.length) {
        el.innerHTML = `<div class="am-empty">
            <div class="am-empty-icon">🍽️</div>
            <div>No products in this category.<br>Tap + Product to add one.</div>
        </div>`;
        return;
    }

    const FLAG_LABELS = {
        recommended: '⭐ Recommended', mostOrdered: '🔥 Most Ordered',
        chefPick: '👨‍🍳 Chef Pick', casualSnack: '🥪 Casual Snack', newArrival: '🆕 New'
    };

    el.innerHTML = _products.map(prod => {
        const thumb = prod.imageUrl
            ? `<div class="am-prod-thumb"><img src="${esc(prod.imageUrl)}" alt=""></div>`
            : `<div class="am-prod-thumb">🍽️</div>`;
        const activeClass = (prod.active === false) ? 'am-inactive' : '';
        const flags = Object.entries(FLAG_LABELS)
            .filter(([k]) => prod.flags && prod.flags[k])
            .map(([,v]) => `<span class="am-flag-chip">${v}</span>`).join('');
        const variantMeta = prod.hasVariants
            ? `${(prod.variantsList || []).length} variants`
            : `₹${prod.price || 0}`;
        const stockMeta = prod.inStock === false ? ' · <span style="color:#ef4444">Out of Stock</span>' : '';
        return `
            <div class="am-prod-card ${activeClass}">
                ${thumb}
                <div class="am-prod-info">
                    <div class="am-prod-name">${esc(prod.name || 'Unnamed')}</div>
                    <div class="am-prod-meta">${variantMeta}${stockMeta}</div>
                    ${flags ? `<div class="am-prod-flags">${flags}</div>` : ''}
                </div>
                <div class="am-prod-actions">
                    <label class="am-toggle" title="${prod.inStock === false ? 'Out of stock' : 'In stock'}">
                        <input type="checkbox" ${prod.inStock !== false ? 'checked' : ''} data-prodid="${esc(prod.id)}" data-action="prod-stock">
                        <span class="am-slider"></span>
                    </label>
                    <button class="am-icon-btn" data-action="prod-edit" data-prodid="${esc(prod.id)}" title="Edit">✏️</button>
                    <button class="am-icon-btn" data-action="prod-dup"  data-prodid="${esc(prod.id)}" title="Duplicate">⎘</button>
                    <button class="am-icon-btn" data-action="prod-move" data-prodid="${esc(prod.id)}" title="Move to category">↗</button>
                    <button class="am-icon-btn danger" data-action="prod-del" data-prodid="${esc(prod.id)}" title="Delete">🗑️</button>
                </div>
            </div>
        `;
    }).join('');

    el.querySelectorAll('[data-action]').forEach(el2 => {
        el2.addEventListener('change', async (e) => {
            if (el2.dataset.action === 'prod-stock') {
                await _toggleProductStock(el2.dataset.prodid, el2.checked);
            }
        });
        el2.addEventListener('click', async (e) => {
            const action = el2.dataset.action;
            if (action === 'prod-edit') _openProductModal(el2.dataset.prodid);
            if (action === 'prod-dup')  _duplicateProductById(el2.dataset.prodid);
            if (action === 'prod-del')  _deleteProductById(el2.dataset.prodid);
            if (action === 'prod-move') _openMoveProductModal(el2.dataset.prodid);
        });
    });
}

async function _toggleProductStock(productId, isInStock) {
    const user = await _waitForAuth();
    if (!user) return;
    try {
        await updateDoc(doc(db, 'products', productId), { inStock: isInStock, updatedAt: serverTimestamp() });
    } catch (e) {
        console.error('[admin-menu] stock toggle failed:', e);
        _showToast('Stock update failed.', 'error');
    }
}

// ─── Category modal ───────────────────────────────────────────────────────────
function _openCategoryModal(catId) {
    _editingCategoryId       = catId;
    const cat                = catId ? _categories.find(c => c.id === catId) : null;
    _catImageUrl             = cat ? (cat.imageUrl || null) : null;
    _catImagePublicId        = _catImageUrl ? extractCloudinaryPublicId(_catImageUrl) : null;
    _catUploadedThisSession  = null;
    _catUploadInProgress     = false;

    const title = catId ? 'Edit Category' : 'Add Category';
    const html = `
        <div class="am-modal-overlay" id="amCatModal">
            <div class="am-modal-box">
                <div class="am-modal-header">
                    <span class="am-modal-title">${title}</span>
                    <button class="am-modal-close" id="amCatModalClose">✕</button>
                </div>
                <div class="am-img-row">
                    <div class="am-img-area" id="amCatImgArea">
                        ${_catImageUrl
                            ? `<img id="amCatImgPreview" src="${esc(_catImageUrl)}" alt="">`
                            : `<div class="am-img-placeholder" id="amCatImgPreview">📷<br>Image</div>`}
                    </div>
                    <div class="am-img-btns">
                        <button class="am-img-upload-btn" id="amCatImgUploadBtn">📤 Upload</button>
                        <button class="am-img-remove-btn ${_catImageUrl ? '' : 'hidden'}" id="amCatImgRemoveBtn">✕ Remove</button>
                    </div>
                    <input type="file" id="amCatImgInput" accept="image/*" hidden>
                </div>
                <div class="am-form-group">
                    <label>Category Name</label>
                    <input type="text" id="amCatNameInput" value="${esc(cat ? (cat.name || '') : '')}" placeholder="e.g. Pizza">
                </div>
                <div class="am-toggle-row">
                    <span class="am-toggle-label">Active (visible to customers)</span>
                    <label class="am-toggle">
                        <input type="checkbox" id="amCatActiveChk" ${cat && cat.active === false ? '' : 'checked'}>
                        <span class="am-slider"></span>
                    </label>
                </div>
                <div class="am-modal-actions">
                    <button class="am-btn am-btn-secondary" id="amCatCancelBtn">Cancel</button>
                    <button class="am-btn am-btn-primary" id="amCatSaveBtn">${catId ? 'Update' : 'Add Category'}</button>
                </div>
            </div>
        </div>
    `;
    _appendModal('amCatModalHost', html);

    document.getElementById('amCatModalClose').addEventListener('click', _closeCatModal);
    document.getElementById('amCatCancelBtn').addEventListener('click', _closeCatModal);
    document.getElementById('amCatSaveBtn').addEventListener('click', _saveCategoryModal);

    const imgArea       = document.getElementById('amCatImgArea');
    const imgUploadBtn  = document.getElementById('amCatImgUploadBtn');
    const imgRemoveBtn  = document.getElementById('amCatImgRemoveBtn');
    const imgInput      = document.getElementById('amCatImgInput');

    imgArea.addEventListener('click', () => { if (!_catUploadInProgress) imgInput.click(); });
    imgUploadBtn.addEventListener('click', () => { if (!_catUploadInProgress) imgInput.click(); });
    imgRemoveBtn.addEventListener('click', () => {
        if (_catUploadedThisSession) { deleteMenuImage(_catUploadedThisSession); _catUploadedThisSession = null; }
        _catImageUrl = null; _catImagePublicId = null;
        _refreshCatImageUI();
    });
    imgInput.addEventListener('change', (e) => {
        const file = e.target.files[0]; imgInput.value = '';
        if (file) _uploadCatImage(file);
    });
}

async function _uploadCatImage(file) {
    _catUploadInProgress = true;
    document.getElementById('amCatImgUploadBtn').disabled = true;
    const area = document.getElementById('amCatImgArea');
    const spinner = document.createElement('div');
    spinner.className = 'am-img-spinner'; spinner.textContent = '⏳';
    area.appendChild(spinner);
    try {
        const blob     = await _toWebP(file);
        const oldToDelete = _catUploadedThisSession || _catImagePublicId || null;
        const result   = await uploadMenuImage(blob, oldToDelete);
        _catImageUrl   = result.url;
        _catImagePublicId = result.publicId;
        _catUploadedThisSession = result.publicId;
        _refreshCatImageUI();
    } catch (e) {
        console.error('[admin-menu] cat image upload failed:', e);
        _showToast('Image upload failed.', 'error');
    } finally {
        _catUploadInProgress = false;
        if (document.getElementById('amCatImgUploadBtn')) document.getElementById('amCatImgUploadBtn').disabled = false;
        area.querySelector('.am-img-spinner')?.remove();
    }
}

function _refreshCatImageUI() {
    const area = document.getElementById('amCatImgArea');
    const btn  = document.getElementById('amCatImgRemoveBtn');
    if (!area) return;
    if (_catImageUrl) {
        area.innerHTML = `<img id="amCatImgPreview" src="${esc(_catImageUrl)}" alt="">`;
        if (btn) btn.classList.remove('hidden');
    } else {
        area.innerHTML = `<div class="am-img-placeholder" id="amCatImgPreview">📷<br>Image</div>`;
        if (btn) btn.classList.add('hidden');
    }
}

async function _saveCategoryModal() {
    if (_catUploadInProgress) { _showToast('Wait for image to finish uploading.', 'warning'); return; }
    const name   = document.getElementById('amCatNameInput').value.trim();
    const active = document.getElementById('amCatActiveChk').checked;
    if (!name) { _showToast('Category name is required.', 'warning'); return; }

    const user = await _waitForAuth();
    if (!user) { _showToast('Auth failed. Reload page.', 'error'); return; }

    const saveBtn = document.getElementById('amCatSaveBtn');
    saveBtn.textContent = 'Saving…'; saveBtn.disabled = true;
    try {
        if (_editingCategoryId) {
            await updateDoc(doc(db, 'categories', _editingCategoryId), {
                name, active, imageUrl: _catImageUrl || null, updatedAt: serverTimestamp()
            });
        } else {
            const order = _categories.length;
            await addDoc(collection(db, 'categories'), {
                name, active, imageUrl: _catImageUrl || null,
                displayOrder: order, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
            });
        }
        _closeCatModal();
    } catch (e) {
        console.error('[admin-menu] save category failed:', e);
        _showToast('Save failed. Check connection.', 'error');
    } finally {
        if (document.getElementById('amCatSaveBtn')) {
            saveBtn.textContent = _editingCategoryId ? 'Update' : 'Add Category';
            saveBtn.disabled = false;
        }
    }
}

function _closeCatModal() { document.getElementById('amCatModalHost')?.remove(); }

async function _deleteCategoryById(catId) {
    const cat = _categories.find(c => c.id === catId);
    const productCount = _products.filter(p => p.categoryId === catId).length;

    // Check if category has products
    let prodCount = 0;
    try {
        const snap = await getDocs(query(collection(db, 'products'), orderBy('categoryId')));
        prodCount = snap.docs.filter(d => d.data().categoryId === catId).length;
    } catch(e) {}

    const msg = prodCount > 0
        ? `"${cat?.name}" has ${prodCount} product(s). Deleting the category will NOT delete products — they will become uncategorised. Continue?`
        : `Delete category "${cat?.name}"? This cannot be undone.`;

    if (!await showConfirm(msg, { title: 'Delete Category?', confirmText: 'Delete', type: 'error' })) return;
    const user = await _waitForAuth();
    if (!user) return;
    try {
        await deleteDoc(doc(db, 'categories', catId));
        _showToast('Category deleted.', 'success');
    } catch (e) {
        console.error('[admin-menu] delete category failed:', e);
        _showToast('Delete failed.', 'error');
    }
}

// ─── Product modal ────────────────────────────────────────────────────────────
async function _openProductModal(productId) {
    _editingProductId        = productId;
    _editingCatId            = _currentCatId;
    _prodImageUrl            = null;
    _prodImagePublicId       = null;
    _prodUploadedThisSession = null;
    _prodUploadInProgress    = false;
    _variantEditors          = [];
    _extraEditors            = [];
    _variantKeySeq           = 0;

    let prod = null;
    if (productId) {
        prod = _products.find(p => p.id === productId);
        if (!prod) {
            try { const d = await getDoc(doc(db, 'products', productId)); if (d.exists()) prod = { id: d.id, ...d.data() }; } catch(e) {}
        }
    }

    if (prod) {
        _prodImageUrl       = prod.imageUrl || null;
        _prodImagePublicId  = _prodImageUrl ? extractCloudinaryPublicId(_prodImageUrl) : null;

        // Load variants from subcollection
        try {
            const varSnap = await getDocs(query(collection(db, 'products', productId, 'variants'), orderBy('displayOrder')));
            _variantEditors = varSnap.docs.map((d, i) => ({
                _key: ++_variantKeySeq, id: d.id, _isNew: false, _deleted: false, _dirty: false,
                name: d.data().name || '', price: d.data().price || 0,
                imageUrl: d.data().imageUrl || null, active: d.data().active !== false,
                inStock: d.data().inStock !== false, displayOrder: d.data().displayOrder ?? i
            }));
        } catch(e) { console.warn('[admin-menu] load variants failed:', e); }

        // Load extras from product doc
        (prod.extras || []).forEach((ex, i) => {
            _extraEditors.push({ _key: ++_variantKeySeq, name: ex.name || '', price: ex.price || 0, active: ex.active !== false, _deleted: false });
        });
    }

    _renderProductModal(prod);
}

function _renderProductModal(prod) {
    const FLAG_DEFS = [
        { key: 'recommended', label: '⭐ Recommended' },
        { key: 'mostOrdered', label: '🔥 Most Ordered' },
        { key: 'chefPick',    label: '👨‍🍳 Chef Pick' },
        { key: 'casualSnack', label: '🥪 Casual Snack' },
        { key: 'newArrival',  label: '🆕 New Arrival' },
    ];
    const flags = prod?.flags || {};
    const title = prod ? 'Edit Product' : 'Add Product';

    const html = `
        <div class="am-modal-overlay" id="amProdModal">
            <div class="am-modal-box">
                <div class="am-modal-header">
                    <span class="am-modal-title">${title}</span>
                    <button class="am-modal-close" id="amProdModalClose">✕</button>
                </div>
                <div class="am-img-row">
                    <div class="am-img-area" id="amProdImgArea">
                        ${_prodImageUrl
                            ? `<img id="amProdImgPreview" src="${esc(_prodImageUrl)}" alt="">`
                            : `<div class="am-img-placeholder" id="amProdImgPreview">📷<br>Product Image</div>`}
                    </div>
                    <div class="am-img-btns">
                        <button class="am-img-upload-btn" id="amProdImgUploadBtn">📤 Upload</button>
                        <button class="am-img-remove-btn ${_prodImageUrl ? '' : 'hidden'}" id="amProdImgRemoveBtn">✕ Remove</button>
                    </div>
                    <input type="file" id="amProdImgInput" accept="image/*" hidden>
                </div>
                <div class="am-form-group">
                    <label>Product Name *</label>
                    <input type="text" id="amProdNameInput" value="${esc(prod?.name || '')}" placeholder="e.g. Margherita Pizza">
                </div>
                <div class="am-form-group">
                    <label>Description <span style="font-weight:400;font-size:0.75rem;opacity:0.5;">(optional)</span></label>
                    <textarea id="amProdDescInput" placeholder="Ingredients, notes…">${esc(prod?.description || '')}</textarea>
                </div>
                <div class="am-section-divider"><span>Status</span><hr></div>
                <div class="am-toggle-row">
                    <span class="am-toggle-label">Active</span>
                    <label class="am-toggle"><input type="checkbox" id="amProdActiveChk" ${prod?.active === false ? '' : 'checked'}><span class="am-slider"></span></label>
                </div>
                <div class="am-toggle-row">
                    <span class="am-toggle-label">In Stock</span>
                    <label class="am-toggle"><input type="checkbox" id="amProdStockChk" ${prod?.inStock === false ? '' : 'checked'}><span class="am-slider"></span></label>
                </div>

                <div class="am-section-divider"><span>Smart Sections</span><hr></div>
                <div class="am-flags-grid">
                    ${FLAG_DEFS.map(f => `
                        <label class="am-flag-item">
                            <input type="checkbox" data-flag="${f.key}" ${flags[f.key] ? 'checked' : ''}>
                            <span class="am-flag-label">${f.label}</span>
                        </label>
                    `).join('')}
                </div>

                <div class="am-section-divider"><span>Variants <span style="font-size:0.7rem;text-transform:none;opacity:0.6;">(leave empty for single-price product)</span></span><hr></div>
                <div id="amVariantList"></div>
                <button class="am-btn am-btn-secondary" id="amAddVariantBtn" style="width:100%;margin-bottom:8px;">+ Add Variant</button>

                <div class="am-section-divider"><span>Extras (Add-ons)</span><hr></div>
                <div id="amExtraList"></div>
                <button class="am-btn am-btn-secondary" id="amAddExtraBtn" style="width:100%;margin-bottom:8px;">+ Add Extra</button>

                <div class="am-modal-actions">
                    <button class="am-btn am-btn-secondary" id="amProdCancelBtn">Cancel</button>
                    <button class="am-btn am-btn-primary" id="amProdSaveBtn">${prod ? 'Update Product' : 'Add Product'}</button>
                </div>
            </div>
        </div>
    `;
    _appendModal('amProdModalHost', html);
    _refreshVariantList();
    _refreshExtraList();

    document.getElementById('amProdModalClose').addEventListener('click', _closeProdModal);
    document.getElementById('amProdCancelBtn').addEventListener('click', _closeProdModal);
    document.getElementById('amProdSaveBtn').addEventListener('click', _saveProductModal);
    document.getElementById('amAddVariantBtn').addEventListener('click', _addVariantRow);
    document.getElementById('amAddExtraBtn').addEventListener('click', _addExtraRow);

    const imgArea   = document.getElementById('amProdImgArea');
    const imgUpBtn  = document.getElementById('amProdImgUploadBtn');
    const imgRmBtn  = document.getElementById('amProdImgRemoveBtn');
    const imgInput  = document.getElementById('amProdImgInput');

    imgArea.addEventListener('click', () => { if (!_prodUploadInProgress) imgInput.click(); });
    imgUpBtn.addEventListener('click', () => { if (!_prodUploadInProgress) imgInput.click(); });
    imgRmBtn.addEventListener('click', () => {
        if (_prodUploadedThisSession) { deleteMenuImage(_prodUploadedThisSession); _prodUploadedThisSession = null; }
        _prodImageUrl = null; _prodImagePublicId = null; _refreshProdImageUI();
    });
    imgInput.addEventListener('change', (e) => {
        const file = e.target.files[0]; imgInput.value = '';
        if (file) _uploadProdImage(file);
    });
}

async function _uploadProdImage(file) {
    _prodUploadInProgress = true;
    document.getElementById('amProdImgUploadBtn').disabled = true;
    const area = document.getElementById('amProdImgArea');
    const spinner = document.createElement('div');
    spinner.className = 'am-img-spinner'; spinner.textContent = '⏳';
    area.appendChild(spinner);
    try {
        const blob   = await _toWebP(file);
        const result = await uploadMenuImage(blob, _prodUploadedThisSession || _prodImagePublicId || null);
        _prodImageUrl = result.url; _prodImagePublicId = result.publicId; _prodUploadedThisSession = result.publicId;
        _refreshProdImageUI();
    } catch (e) {
        console.error('[admin-menu] prod image upload failed:', e);
        _showToast('Image upload failed.', 'error');
    } finally {
        _prodUploadInProgress = false;
        if (document.getElementById('amProdImgUploadBtn')) document.getElementById('amProdImgUploadBtn').disabled = false;
        area.querySelector('.am-img-spinner')?.remove();
    }
}

function _refreshProdImageUI() {
    const area = document.getElementById('amProdImgArea');
    const btn  = document.getElementById('amProdImgRemoveBtn');
    if (!area) return;
    if (_prodImageUrl) {
        area.innerHTML = `<img id="amProdImgPreview" src="${esc(_prodImageUrl)}" alt="">`;
        if (btn) btn.classList.remove('hidden');
    } else {
        area.innerHTML = `<div class="am-img-placeholder" id="amProdImgPreview">📷<br>Product Image</div>`;
        if (btn) btn.classList.add('hidden');
    }
}

// ── Variant list ──────────────────────────────────────────────────────────────
function _refreshVariantList() {
    const el = document.getElementById('amVariantList');
    if (!el) return;
    const active = _variantEditors.filter(v => !v._deleted);
    if (!active.length) {
        el.innerHTML = `<div style="font-size:0.8rem;color:rgba(255,255,255,0.3);padding:6px 0;margin-bottom:8px;">
            No variants — product has a single price. Add a variant to enable size/portion selection.</div>`;
        return;
    }
    el.innerHTML = active.map(v => `
        <div class="am-variant-row" data-vkey="${v._key}">
            <input type="text" class="am-variant-name"  placeholder="Name (e.g. Regular)" value="${esc(v.name)}" data-field="name">
            <input type="number" class="am-variant-price" placeholder="₹Price" value="${v.price || ''}" data-field="price" min="0" step="1">
            <button class="am-variant-del" data-vkey="${v._key}" title="Remove variant">✕</button>
        </div>
    `).join('');
    el.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', (e) => {
            const row = inp.closest('.am-variant-row');
            const key = Number(row.dataset.vkey);
            const v   = _variantEditors.find(x => x._key === key);
            if (!v) return;
            if (inp.dataset.field === 'name')  { v.name  = inp.value; v._dirty = true; }
            if (inp.dataset.field === 'price') { v.price = Number(inp.value) || 0; v._dirty = true; }
        });
    });
    el.querySelectorAll('.am-variant-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = Number(btn.dataset.vkey);
            const v   = _variantEditors.find(x => x._key === key);
            if (v) v._deleted = true;
            _refreshVariantList();
        });
    });
}

function _addVariantRow() {
    _variantEditors.push({
        _key: ++_variantKeySeq, id: null, _isNew: true, _deleted: false, _dirty: true,
        name: '', price: 0, imageUrl: null, active: true, inStock: true, displayOrder: _variantEditors.length
    });
    _refreshVariantList();
}

// ── Extras list ───────────────────────────────────────────────────────────────
function _refreshExtraList() {
    const el = document.getElementById('amExtraList');
    if (!el) return;
    const active = _extraEditors.filter(x => !x._deleted);
    if (!active.length) {
        el.innerHTML = `<div style="font-size:0.8rem;color:rgba(255,255,255,0.3);padding:6px 0;margin-bottom:8px;">
            No extras for this product.</div>`;
        return;
    }
    el.innerHTML = active.map(ex => `
        <div class="am-extra-row" data-xkey="${ex._key}">
            <input type="text" placeholder="Extra name" value="${esc(ex.name)}" data-field="name" style="flex:2;">
            <input type="number" placeholder="₹" value="${ex.price || ''}" data-field="price" min="0" step="1" style="flex:1;max-width:80px;">
            <button class="am-variant-del" data-xkey="${ex._key}" title="Remove">✕</button>
        </div>
    `).join('');
    el.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', () => {
            const row = inp.closest('.am-extra-row');
            const key = Number(row.dataset.xkey);
            const ex  = _extraEditors.find(x => x._key === key);
            if (!ex) return;
            if (inp.dataset.field === 'name')  ex.name  = inp.value;
            if (inp.dataset.field === 'price') ex.price = Number(inp.value) || 0;
        });
    });
    el.querySelectorAll('.am-variant-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = Number(btn.dataset.xkey);
            const ex  = _extraEditors.find(x => x._key === key);
            if (ex) ex._deleted = true;
            _refreshExtraList();
        });
    });
}

function _addExtraRow() {
    _extraEditors.push({ _key: ++_variantKeySeq, name: '', price: 0, active: true, _deleted: false });
    _refreshExtraList();
}

// ── Save product ──────────────────────────────────────────────────────────────
async function _saveProductModal() {
    if (_prodUploadInProgress) { _showToast('Wait for image to finish uploading.', 'warning'); return; }
    const name   = document.getElementById('amProdNameInput').value.trim();
    const desc   = document.getElementById('amProdDescInput').value.trim();
    const active = document.getElementById('amProdActiveChk').checked;
    const inStock= document.getElementById('amProdStockChk').checked;

    if (!name) { _showToast('Product name is required.', 'warning'); return; }

    // Collect flags
    const flags = {};
    document.querySelectorAll('[data-flag]').forEach(chk => { flags[chk.dataset.flag] = chk.checked; });

    // Collect variants (non-deleted, non-empty name)
    const variantsToKeep = _variantEditors.filter(v => !v._deleted && v.name.trim());
    const hasVariants    = variantsToKeep.length > 0;

    // Build variantsList for denormalized billing panel reads
    const variantsList = variantsToKeep.map((v, i) => ({
        id: v.id || `var_${Date.now()}_${i}`,
        name: v.name.trim(), price: v.price || 0,
        imageUrl: v.imageUrl || null, active: v.active, inStock: v.inStock, displayOrder: i
    }));

    // Collect extras (non-deleted, non-empty name)
    const extras = _extraEditors.filter(x => !x._deleted && x.name.trim())
        .map(x => ({ name: x.name.trim(), price: x.price || 0, active: x.active }));

    const user = await _waitForAuth();
    if (!user) { _showToast('Auth failed. Reload page.', 'error'); return; }

    const saveBtn = document.getElementById('amProdSaveBtn');
    saveBtn.textContent = 'Saving…'; saveBtn.disabled = true;

    try {
        let productId = _editingProductId;

        // Build product doc
        const productData = {
            categoryId:   _editingCatId,
            categoryName: _currentCatName,
            name, description: desc,
            imageUrl: _prodImageUrl || null,
            active, inStock,
            flags,
            hasVariants,
            variantsList,   // denormalized for fast billing panel reads
            extras,
            // future: modifierGroupIds: []
            displayOrder: _editingProductId
                ? (_products.find(p => p.id === _editingProductId)?.displayOrder ?? _products.length)
                : _products.length,
            updatedAt: serverTimestamp()
        };

        if (!hasVariants) {
            // For single-price products, get price from the first variant if transitioning,
            // or preserve existing price, or set 0
            const existing = _editingProductId ? _products.find(p => p.id === _editingProductId) : null;
            productData.price = existing?.price ?? 0;
        }

        if (_editingProductId) {
            await updateDoc(doc(db, 'products', _editingProductId), productData);
        } else {
            productData.createdAt = serverTimestamp();
            const ref = await addDoc(collection(db, 'products'), productData);
            productId = ref.id;
        }

        // Write variants to subcollection
        const batch = writeBatch(db);
        for (let i = 0; i < variantsToKeep.length; i++) {
            const v = variantsToKeep[i];
            const varRef = v.id
                ? doc(db, 'products', productId, 'variants', v.id)
                : doc(collection(db, 'products', productId, 'variants'));
            const varData = {
                name: v.name.trim(), price: v.price || 0, imageUrl: v.imageUrl || null,
                active: v.active, inStock: v.inStock, displayOrder: i, updatedAt: serverTimestamp()
            };
            if (!v.id) varData.createdAt = serverTimestamp();
            batch.set(varRef, varData, { merge: true });
        }

        // Delete removed variants
        for (const v of _variantEditors.filter(x => x._deleted && x.id)) {
            batch.delete(doc(db, 'products', productId, 'variants', v.id));
        }

        await batch.commit();

        // Update variantsList on product with real IDs (after subcollection write)
        if (hasVariants) {
            const updatedVarSnap = await getDocs(query(collection(db, 'products', productId, 'variants'), orderBy('displayOrder')));
            const realList = updatedVarSnap.docs.map(d => ({
                id: d.id, name: d.data().name, price: d.data().price || 0,
                imageUrl: d.data().imageUrl || null, active: d.data().active !== false,
                inStock: d.data().inStock !== false, displayOrder: d.data().displayOrder || 0
            }));
            await updateDoc(doc(db, 'products', productId), { variantsList: realList });
        }

        _closeProdModal();
        _showToast(`Product ${_editingProductId ? 'updated' : 'added'}.`, 'success');
    } catch (e) {
        console.error('[admin-menu] save product failed:', e.code, e.message, e);
        _showToast('Save failed. Check connection.', 'error');
    } finally {
        if (document.getElementById('amProdSaveBtn')) {
            saveBtn.textContent = _editingProductId ? 'Update Product' : 'Add Product';
            saveBtn.disabled = false;
        }
    }
}

function _closeProdModal() { document.getElementById('amProdModalHost')?.remove(); }

async function _deleteProductById(productId) {
    const prod = _products.find(p => p.id === productId);
    if (!await showConfirm(`Delete "${prod?.name || 'this product'}"? This will also delete all its variants. This cannot be undone.`, {
        title: 'Delete Product?', confirmText: 'Delete', type: 'error'
    })) return;

    const user = await _waitForAuth();
    if (!user) return;
    try {
        // Delete variants subcollection first
        const varSnap = await getDocs(collection(db, 'products', productId, 'variants'));
        const batch = writeBatch(db);
        varSnap.docs.forEach(d => batch.delete(d.ref));
        batch.delete(doc(db, 'products', productId));
        await batch.commit();
        _showToast('Product deleted.', 'success');
    } catch (e) {
        console.error('[admin-menu] delete product failed:', e);
        _showToast('Delete failed.', 'error');
    }
}

async function _duplicateProductById(productId) {
    const prod = _products.find(p => p.id === productId);
    if (!prod) return;
    const user = await _waitForAuth();
    if (!user) return;
    try {
        // Get variants
        const varSnap = await getDocs(collection(db, 'products', productId, 'variants'));
        const variants = varSnap.docs.map(d => d.data());

        const newProdRef = await addDoc(collection(db, 'products'), {
            ...prod, id: undefined,
            name: prod.name + ' (Copy)',
            displayOrder: _products.length,
            createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });

        // Duplicate variants
        const batch = writeBatch(db);
        variants.forEach((v, i) => {
            const vRef = doc(collection(db, 'products', newProdRef.id, 'variants'));
            batch.set(vRef, { ...v, displayOrder: i, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        });
        await batch.commit();
        _showToast('Product duplicated.', 'success');
    } catch (e) {
        console.error('[admin-menu] duplicate product failed:', e);
        _showToast('Duplicate failed.', 'error');
    }
}

// ─── Move product modal ───────────────────────────────────────────────────────
function _openMoveProductModal(productId) {
    _movingProductId = productId;
    const prod = _products.find(p => p.id === productId);
    const otherCats = _categories.filter(c => c.id !== _currentCatId);

    if (!otherCats.length) { _showToast('No other categories to move to.', 'warning'); return; }

    const html = `
        <div class="am-modal-overlay" id="amMoveModal">
            <div class="am-modal-box" style="max-height:60dvh;">
                <div class="am-modal-header">
                    <span class="am-modal-title">Move "${esc(prod?.name || 'Product')}"</span>
                    <button class="am-modal-close" id="amMoveModalClose">✕</button>
                </div>
                <div class="am-form-group">
                    <label>Move to Category</label>
                    <select class="am-select-cat" id="amMoveCatSel">
                        ${otherCats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
                    </select>
                </div>
                <div class="am-modal-actions">
                    <button class="am-btn am-btn-secondary" id="amMoveCancelBtn">Cancel</button>
                    <button class="am-btn am-btn-primary" id="amMoveSaveBtn">Move</button>
                </div>
            </div>
        </div>
    `;
    _appendModal('amMoveModalHost', html);
    document.getElementById('amMoveModalClose').addEventListener('click', () => document.getElementById('amMoveModalHost')?.remove());
    document.getElementById('amMoveCancelBtn').addEventListener('click', () => document.getElementById('amMoveModalHost')?.remove());
    document.getElementById('amMoveSaveBtn').addEventListener('click', async () => {
        const newCatId = document.getElementById('amMoveCatSel').value;
        const newCat   = _categories.find(c => c.id === newCatId);
        const user     = await _waitForAuth();
        if (!user) return;
        try {
            await updateDoc(doc(db, 'products', _movingProductId), {
                categoryId: newCatId, categoryName: newCat?.name || '', updatedAt: serverTimestamp()
            });
            document.getElementById('amMoveModalHost')?.remove();
            _showToast('Product moved.', 'success');
        } catch (e) {
            console.error('[admin-menu] move failed:', e);
            _showToast('Move failed.', 'error');
        }
    });
}

// ─── Migration from menu_items ────────────────────────────────────────────────
function _showMigratePanel() {
    const grid = document.getElementById('menuCardGrid');
    if (!grid) return;

    const existing = document.getElementById('amMigratePanelHost');
    if (existing) { existing.remove(); return; }

    const div = document.createElement('div');
    div.id = 'amMigratePanelHost';
    div.innerHTML = `
        <div class="am-migrate-panel">
            <div class="am-migrate-title">🔄 Migrate Legacy menu_items → New Structure</div>
            <div class="am-migrate-desc">
                This reads all existing <code>menu_items</code> docs, groups them into
                <strong>categories → products → variants</strong>, and writes the new
                <code>categories</code> and <code>products</code> collections.<br><br>
                • Variant names like <em>"Pizza (Regular)"</em> are detected automatically.<br>
                • Existing <code>menu_items</code> are <strong>not deleted</strong> — this is safe to run and re-run.<br>
                • Run this once after upgrading. Check results in Categories view above.<br><br>
                <strong>⚠️ Clear any open bills before migrating</strong> (cart IDs will change for variant items).
            </div>
            <div id="amMigrateLog" style="font-size:0.78rem;color:#94a3b8;min-height:20px;max-height:120px;overflow-y:auto;margin-bottom:10px;font-family:monospace;"></div>
            <button class="am-btn am-btn-primary" id="amRunMigrateBtn" style="width:100%;">▶ Run Migration</button>
        </div>
    `;
    grid.insertBefore(div, grid.firstChild);
    document.getElementById('amRunMigrateBtn').addEventListener('click', _runMigration);
}

async function _runMigration() {
    const btn = document.getElementById('amRunMigrateBtn');
    const log = document.getElementById('amMigrateLog');
    if (!btn || !log) return;
    btn.disabled = true; btn.textContent = 'Running…';
    const addLog = (msg) => { log.innerHTML += msg + '<br>'; log.scrollTop = log.scrollHeight; };

    const user = await _waitForAuth();
    if (!user) { addLog('❌ Auth failed.'); btn.disabled = false; btn.textContent = '▶ Run Migration'; return; }

    addLog('📖 Reading menu_items…');
    let items = [];
    try {
        const snap = await getDocs(collection(db, 'menu_items'));
        items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        addLog(`✅ Found ${items.length} items.`);
    } catch (e) {
        addLog('❌ Failed to read menu_items: ' + e.message);
        btn.disabled = false; btn.textContent = '▶ Run Migration'; return;
    }

    if (!items.length) { addLog('ℹ️ No items to migrate.'); btn.disabled = false; btn.textContent = '✅ Done'; return; }

    // ── Step 1: Detect variants by name suffix ──
    const VARIANT_RE = /\s*\(\s*(regular|medium|large|half|full|small|standard|family)\s*\)\s*$/i;
    const getBase = (name) => (name || '').replace(VARIANT_RE, '').trim();
    const getVariant = (name) => { const m = (name || '').match(VARIANT_RE); return m ? m[1] : null; };

    // Group by category → base product name
    const catMap = {};
    items.forEach(item => {
        const cat  = item.category || 'Other';
        const base = getBase(item.name);
        if (!catMap[cat]) catMap[cat] = {};
        if (!catMap[cat][base]) catMap[cat][base] = [];
        catMap[cat][base].push(item);
    });

    // ── Step 2: Create categories ──
    addLog('📁 Creating categories…');
    const catIdMap = {};   // catName → Firestore catId
    const catNames = Object.keys(catMap).sort();
    for (let i = 0; i < catNames.length; i++) {
        const catName = catNames[i];
        try {
            // Check if category already exists
            const existingSnap = await getDocs(collection(db, 'categories'));
            const existing = existingSnap.docs.find(d => d.data().name === catName);
            if (existing) {
                catIdMap[catName] = existing.id;
                addLog(`  ↩ Category "${catName}" already exists.`);
            } else {
                const ref = await addDoc(collection(db, 'categories'), {
                    name: catName, imageUrl: null, active: true,
                    displayOrder: i, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
                });
                catIdMap[catName] = ref.id;
                addLog(`  ✅ Created category "${catName}"`);
            }
        } catch (e) { addLog(`  ❌ Category "${catName}": ${e.message}`); }
    }

    // ── Step 3: Create products + variants ──
    addLog('🍽️ Creating products…');
    let prodCount = 0, varCount = 0;
    for (const [catName, products] of Object.entries(catMap)) {
        const catId = catIdMap[catName];
        if (!catId) continue;
        let prodIdx = 0;
        for (const [baseName, variants] of Object.entries(products)) {
            try {
                const first = variants[0];
                const hasVariants = variants.length > 1 || getVariant(first.name);

                const productData = {
                    categoryId: catId, categoryName: catName,
                    name: baseName,
                    description: first.description || '',
                    imageUrl: first.imageUrl || first.image || null,
                    active: first.active !== false,
                    inStock: first.inStock !== false,
                    hasVariants: !!hasVariants,
                    price: hasVariants ? 0 : (Number(first.price) || 0),
                    flags: { recommended: false, mostOrdered: false, chefPick: false, casualSnack: false, newArrival: false },
                    extras: (first.extraOptions || []).map(eo => ({ name: eo.name || '', price: eo.price || 0, active: true })),
                    displayOrder: prodIdx++,
                    variantsList: [],
                    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
                };

                const prodRef = await addDoc(collection(db, 'products'), productData);
                prodCount++;

                // Write variants
                if (hasVariants) {
                    const variantsList = [];
                    const vBatch = writeBatch(db);
                    variants.forEach((item, vi) => {
                        const varName  = getVariant(item.name) || 'Standard';
                        const varLabel = varName.charAt(0).toUpperCase() + varName.slice(1).toLowerCase();
                        // Use original menu_items ID as variant ID for cart compat
                        const varRef = doc(db, 'products', prodRef.id, 'variants', item.id);
                        const varData = {
                            name: varLabel, price: Number(item.price) || 0,
                            imageUrl: item.imageUrl || item.image || null,
                            active: item.active !== false, inStock: item.inStock !== false,
                            displayOrder: vi, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
                        };
                        vBatch.set(varRef, varData);
                        variantsList.push({ id: item.id, name: varLabel, price: Number(item.price) || 0,
                            imageUrl: varData.imageUrl, active: varData.active, inStock: varData.inStock, displayOrder: vi });
                        varCount++;
                    });
                    await vBatch.commit();
                    await updateDoc(prodRef, { variantsList });
                }
            } catch (e) {
                addLog(`  ❌ Product "${baseName}": ${e.message}`);
            }
        }
    }

    addLog(`✅ Migration complete: ${prodCount} products, ${varCount} variants.`);
    addLog('ℹ️ Legacy menu_items preserved. New data is in categories + products.');
    btn.textContent = '✅ Done';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _waitForAuth(timeoutMs = 5000) {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise(resolve => {
        const unsub = onAuthStateChanged(auth, (user) => { if (user) { unsub(); resolve(user); } });
        setTimeout(() => { unsub(); resolve(null); }, timeoutMs);
    });
}

function _appendModal(hostId, html) {
    document.getElementById(hostId)?.remove();
    const div = document.createElement('div');
    div.id = hostId;
    div.innerHTML = html;
    document.body.appendChild(div);
}

function _showToast(msg, type = 'info') {
    const colors = { error: '#ef4444', success: '#10b981', warning: '#f59e0b', info: '#6366f1' };
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${colors[type]||colors.info};color:#fff;border-radius:10px;padding:10px 20px;font-size:0.88rem;font-weight:600;z-index:99999;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,0.3);`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
}

function esc(s = '') { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

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
                } catch(_) { cleanup(file); }
            };
            img.onerror = () => { URL.revokeObjectURL(url); cleanup(file); };
            img.src = url;
        } catch(_) { cleanup(file); }
    });
}
