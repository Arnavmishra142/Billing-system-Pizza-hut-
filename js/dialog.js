// js/dialog.js
// Reusable custom dialog system for the Billing Panel.
// Replaces browser-native alert(), confirm(), and prompt() with custom UI
// that matches the Billing Panel dark design system.
//
// AI UPDATE [2026-07-30]:
//   Created — provides showAlert(), showConfirm(), showPrompt().
//   All functions return Promises so existing async code stays clean.
//   CSS is injected once into <head> on first use — no external stylesheet needed.
//   window.BillingDialog is set at module initialisation so non-module inline
//   scripts (index.html, details.html) can access the same API via the global.
//
// Usage (ES module):
//   import { showAlert, showConfirm, showPrompt } from './dialog.js';
//   await showAlert('Something went wrong!', 'error');
//   const ok = await showConfirm('Delete this item?', { type: 'error', confirmText: 'Delete' });
//   const val = await showPrompt('Enter value', { placeholder: 'Type here…' });
//
// Usage (non-module inline script after dialog.js has been loaded as a module):
//   await window.BillingDialog.showAlert(…);
//   const ok = await window.BillingDialog.showConfirm(…);

'use strict';

// ── Inject CSS once ────────────────────────────────────────────────────────────
const DIALOG_CSS = `
/* ── Billing Panel Custom Dialog System ──────────────────────────────────── */
.bp-overlay {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.78);
    backdrop-filter: blur(5px);
    -webkit-backdrop-filter: blur(5px);
    opacity: 0;
    transition: opacity 0.18s ease;
}
.bp-overlay.bp-visible {
    opacity: 1;
}

/* Dialog box */
.bp-dialog {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 16px;
    padding: 28px 24px 22px;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 25px 60px -10px rgba(0, 0, 0, 0.75),
                0 0 0 1px rgba(255, 255, 255, 0.04);
    text-align: center;
    transform: scale(0.88) translateY(18px);
    opacity: 0;
    transition: transform 0.24s cubic-bezier(0.34, 1.56, 0.64, 1),
                opacity 0.18s ease;
    position: relative;
}
.bp-overlay.bp-visible .bp-dialog {
    transform: scale(1) translateY(0);
    opacity: 1;
}

/* Icon */
.bp-dialog-icon {
    font-size: 2.2rem;
    line-height: 1;
    margin-bottom: 14px;
    display: block;
}

/* Title */
.bp-dialog-title {
    font-size: 1.1rem;
    font-weight: 800;
    color: #e6edf3;
    margin-bottom: 8px;
    line-height: 1.3;
}

/* Message */
.bp-dialog-message {
    font-size: 0.95rem;
    color: #8b949e;
    line-height: 1.55;
    margin-bottom: 22px;
    white-space: pre-line;
}

/* Input (prompt) */
.bp-dialog-input {
    width: 100%;
    padding: 11px 14px;
    background: #0d1117;
    border: 1.5px solid #30363d;
    border-radius: 10px;
    color: #e6edf3;
    font-size: 0.97rem;
    font-family: inherit;
    outline: none;
    margin-bottom: 18px;
    transition: border-color 0.15s, box-shadow 0.15s;
    box-sizing: border-box;
}
.bp-dialog-input::placeholder { color: #4a5568; }
.bp-dialog-input:focus {
    border-color: #388bfd;
    box-shadow: 0 0 0 3px rgba(56, 139, 253, 0.18);
}

/* Action buttons row */
.bp-dialog-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
}
.bp-dialog-actions.bp-actions-col {
    flex-direction: column;
}

/* Base button */
.bp-btn {
    flex: 1;
    min-width: 0;
    padding: 11px 18px;
    border: none;
    border-radius: 10px;
    font-size: 0.95rem;
    font-weight: 700;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
    white-space: nowrap;
    outline: none;
}
.bp-btn:active { transform: scale(0.95); }
.bp-btn:focus-visible {
    box-shadow: 0 0 0 3px rgba(56, 139, 253, 0.45);
}

/* Button variants */
.bp-btn-ok {
    background: #1f6feb;
    color: #fff;
}
.bp-btn-ok:hover { background: #388bfd; }

.bp-btn-success {
    background: #238636;
    color: #fff;
}
.bp-btn-success:hover { background: #2ea043; }

.bp-btn-danger {
    background: #da3633;
    color: #fff;
}
.bp-btn-danger:hover { background: #f85149; }

.bp-btn-warning {
    background: #9e6a03;
    color: #fff;
}
.bp-btn-warning:hover { background: #b07f00; }

.bp-btn-cancel {
    background: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
}
.bp-btn-cancel:hover { background: #30363d; }

/* Accent bars for dialog types */
.bp-dialog.bp-type-success { border-top: 3px solid #10b981; }
.bp-dialog.bp-type-error   { border-top: 3px solid #ef4444; }
.bp-dialog.bp-type-warning { border-top: 3px solid #f59e0b; }
.bp-dialog.bp-type-info    { border-top: 3px solid #3b82f6; }

/* Mobile-friendly */
@media (max-width: 480px) {
    .bp-dialog {
        padding: 22px 18px 18px;
        border-radius: 14px;
    }
    .bp-dialog-actions {
        flex-direction: column;
    }
    .bp-btn {
        width: 100%;
    }
}
`;

let _cssInjected = false;
function _injectCSS() {
    if (_cssInjected) return;
    const style = document.createElement('style');
    style.id = 'bp-dialog-css';
    style.textContent = DIALOG_CSS;
    document.head.appendChild(style);
    _cssInjected = true;
}

// ── Type configuration ─────────────────────────────────────────────────────────
const _TYPE = {
    success: { icon: '✅', btnClass: 'bp-btn-success', label: 'Success' },
    error:   { icon: '❌', btnClass: 'bp-btn-danger',  label: 'Error'   },
    warning: { icon: '⚠️', btnClass: 'bp-btn-warning', label: 'Warning' },
    info:    { icon: 'ℹ️', btnClass: 'bp-btn-ok',      label: 'Info'    },
};

// ── Internal overlay factory ───────────────────────────────────────────────────
function _makeOverlay(innerHTML) {
    _injectCSS();
    const overlay = document.createElement('div');
    overlay.className = 'bp-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = innerHTML;
    return overlay;
}

function _open(overlay) {
    document.body.appendChild(overlay);
    // Force reflow so the CSS transition plays
    void overlay.offsetWidth;
    overlay.classList.add('bp-visible');
}

function _close(overlay, resolve, value) {
    overlay.classList.remove('bp-visible');
    overlay.addEventListener('transitionend', () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
    }, { once: true });
    // Safety timeout in case transitionend never fires
    setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
    }, 400);
}

// ── showAlert ─────────────────────────────────────────────────────────────────
/**
 * Show an informational / success / error / warning alert dialog.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} [type='info']
 * @param {string} [title] Optional title. Defaults to the type label.
 * @returns {Promise<void>}
 */
export function showAlert(message, type = 'info', title = '') {
    return new Promise(resolve => {
        const cfg   = _TYPE[type] || _TYPE.info;
        const label = title || cfg.label;
        const overlay = _makeOverlay(`
            <div class="bp-dialog bp-type-${type}" role="alertdialog" aria-label="${label}">
                <span class="bp-dialog-icon">${cfg.icon}</span>
                <h3 class="bp-dialog-title">${_esc(label)}</h3>
                <p class="bp-dialog-message">${_esc(message)}</p>
                <div class="bp-dialog-actions">
                    <button class="bp-btn ${cfg.btnClass}" data-action="ok">OK</button>
                </div>
            </div>
        `);

        const done = () => _close(overlay, resolve, undefined);

        overlay.querySelector('[data-action="ok"]').addEventListener('click', done);

        // ESC or Enter to dismiss
        const onKey = (e) => {
            if (e.key === 'Escape' || e.key === 'Enter') {
                document.removeEventListener('keydown', onKey);
                done();
            }
        };
        document.addEventListener('keydown', onKey);

        // Click backdrop to dismiss
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) done();
        });

        _open(overlay);
        setTimeout(() => overlay.querySelector('[data-action="ok"]')?.focus(), 60);
    });
}

// ── showConfirm ───────────────────────────────────────────────────────────────
/**
 * Show a confirmation dialog. Returns true if confirmed, false if cancelled.
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.title='Are you sure?']
 * @param {'info'|'success'|'error'|'warning'} [opts.type='warning']
 * @param {string} [opts.confirmText='Confirm']
 * @param {string} [opts.cancelText='Cancel']
 * @param {boolean} [opts.danger=true]  Makes confirm button red when true
 * @returns {Promise<boolean>}
 */
export function showConfirm(message, {
    title       = 'Are you sure?',
    type        = 'warning',
    confirmText = 'Confirm',
    cancelText  = 'Cancel',
    danger      = true,
} = {}) {
    return new Promise(resolve => {
        const cfg        = _TYPE[type] || _TYPE.warning;
        const confirmCls = danger ? 'bp-btn-danger' : cfg.btnClass;

        const overlay = _makeOverlay(`
            <div class="bp-dialog bp-type-${type}" role="alertdialog" aria-label="${_esc(title)}">
                <span class="bp-dialog-icon">${cfg.icon}</span>
                <h3 class="bp-dialog-title">${_esc(title)}</h3>
                <p class="bp-dialog-message">${_esc(message)}</p>
                <div class="bp-dialog-actions">
                    <button class="bp-btn bp-btn-cancel" data-action="cancel">${_esc(cancelText)}</button>
                    <button class="bp-btn ${confirmCls}" data-action="confirm">${_esc(confirmText)}</button>
                </div>
            </div>
        `);

        const confirm = () => _close(overlay, resolve, true);
        const cancel  = () => _close(overlay, resolve, false);

        overlay.querySelector('[data-action="confirm"]').addEventListener('click', confirm);
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', cancel);

        // ESC cancels (does NOT confirm — safety for destructive actions)
        const onKey = (e) => {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', onKey);
                cancel();
            }
        };
        document.addEventListener('keydown', onKey);

        // No click-outside-to-close for confirm dialogs (prevent accidental dismissal)

        _open(overlay);
        // Focus cancel by default (safer for destructive actions)
        setTimeout(() => overlay.querySelector('[data-action="cancel"]')?.focus(), 60);
    });
}

// ── showPrompt ────────────────────────────────────────────────────────────────
/**
 * Show an input prompt dialog. Returns the entered string, or null if cancelled.
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.title='']
 * @param {string} [opts.placeholder='']
 * @param {string} [opts.defaultValue='']
 * @param {string} [opts.confirmText='OK']
 * @param {string} [opts.cancelText='Cancel']
 * @param {'text'|'number'} [opts.inputType='text']
 * @returns {Promise<string|null>} Resolves to the value string or null if cancelled
 */
export function showPrompt(message, {
    title        = '',
    placeholder  = '',
    defaultValue = '',
    confirmText  = 'OK',
    cancelText   = 'Cancel',
    inputType    = 'text',
} = {}) {
    return new Promise(resolve => {
        const overlay = _makeOverlay(`
            <div class="bp-dialog bp-type-info" role="dialog" aria-label="${_esc(title || message)}">
                <span class="bp-dialog-icon">✏️</span>
                ${title ? `<h3 class="bp-dialog-title">${_esc(title)}</h3>` : ''}
                <p class="bp-dialog-message">${_esc(message)}</p>
                <input
                    class="bp-dialog-input"
                    type="${inputType}"
                    placeholder="${_esc(placeholder)}"
                    value="${_esc(defaultValue)}"
                    autocomplete="off"
                    spellcheck="false"
                />
                <div class="bp-dialog-actions">
                    <button class="bp-btn bp-btn-cancel"  data-action="cancel">${_esc(cancelText)}</button>
                    <button class="bp-btn bp-btn-ok"      data-action="confirm">${_esc(confirmText)}</button>
                </div>
            </div>
        `);

        const input   = overlay.querySelector('.bp-dialog-input');
        const confirm = () => _close(overlay, resolve, input.value);
        const cancel  = () => _close(overlay, resolve, null);

        overlay.querySelector('[data-action="confirm"]').addEventListener('click', confirm);
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', cancel);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirm();
        });

        const onKey = (e) => {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', onKey);
                cancel();
            }
        };
        document.addEventListener('keydown', onKey);

        _open(overlay);
        setTimeout(() => { input?.focus(); input?.select(); }, 60);
    });
}

// ── HTML escape helper ────────────────────────────────────────────────────────
function _esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Global exposure for non-module inline scripts ─────────────────────────────
// Any <script> block that loads after this module can use window.BillingDialog.*
window.BillingDialog = { showAlert, showConfirm, showPrompt };
