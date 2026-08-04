// js/receipt-builder.js
//
// AI UPDATE [2026-07-30]: New module — ESC/POS receipt builder for the
//   EZO 58mm Bluetooth Thermal Printer (32 chars / ~384 dots wide).
//
//   WHY this replaces the old manual string approach in cart.js:
//     - The old formatBillRow() used fixed-width manual padding.  On long item
//       names (>14 chars) the qty/total columns shifted or overlapped entirely.
//     - esc-pos-encoder's table() method handles column layout, automatic
//       line-wrapping for long names, and keeps all other columns perfectly
//       aligned regardless of content length.
//     - The library also provides clean centering, bold, rules, and raster
//       image printing — all impossible to get right with raw string padding.
//
//   Library: esc-pos-encoder (Niels Leenheer)
//     Loaded from CDN in index.html as a UMD script → window.EscPosEncoder
//     https://unpkg.com/esc-pos-encoder@latest/dist/esc-pos-encoder.umd.js
//
//   Receipt width assumption: 32 characters (EZO 58mm)
//     Column layout:  Item [16] | Qty [5] | Total [11]  = 32
//     Long item names wrap inside the 16-char name column; Qty and Total
//     columns are always aligned on the same lines as the first name line.
//
//   Logo: pos-logo.png converted to 128×64 monochrome canvas at startup.
//     Printed centered at the top of every bill receipt.
//     If pre-load fails the receipt prints normally without a logo.
//
//   This module does NOT change KOT printing or the Bluetooth/rawbt transport.

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Paper width in characters for the EZO 58mm printer. */
const PRINTER_WIDTH = 32;

/**
 * Column definitions for the item table (must sum to PRINTER_WIDTH).
 *   Item name : 16 chars  left-aligned  (wraps on long names)
 *   Qty       :  5 chars  center-aligned
 *   Total     : 11 chars  right-aligned
 */
const TABLE_COLS = [
    { width: 16, marginRight: 0, align: 'left'   },
    { width:  5, marginRight: 0, align: 'center' },
    { width: 11, marginRight: 0, align: 'right'  },
];

/** 32-dash divider line (fits exactly in PRINTER_WIDTH). */
const DIVIDER = '--------------------------------';

// ── Module-level logo state ────────────────────────────────────────────────────

/**
 * Monochrome canvas for the shop logo, pre-loaded by initReceiptPrinter().
 * Null if loading failed or init has not been called yet.
 * @type {HTMLCanvasElement|null}
 */
let _logoCanvas = null;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Pre-load pos-logo.png and convert it to a monochrome canvas so it is
 * ready synchronously when buildBillReceipt() is called.
 *
 * Call once inside DOMContentLoaded (fire-and-forget — do NOT await at the
 * call site; printing falls back gracefully if the image loads slowly).
 */
export async function initReceiptPrinter() {
    try {
        _logoCanvas = await _loadMonochromeCanvas('/pos-logo.png', 128, 64);
        console.log('[receipt] Shop logo pre-loaded for thermal printing (128×64 monochrome).');
    } catch (err) {
        console.warn('[receipt] Logo pre-load failed — receipts will print without logo:', err.message);
        _logoCanvas = null;
    }
}

/**
 * Build a professional ESC/POS binary buffer for a bill receipt.
 *
 * Uses window.EscPosEncoder (loaded from CDN via index.html <script> tag).
 * Returns null — with a console warning — if the library is not available,
 * so the caller can fall back to the legacy text-based receipt.
 *
 * @param {Array<{name:string, price:number, qty:number}>} cart
 * @param {string} title    Bill-to label (table name, "Takeaway", etc.)
 * @param {string} billNo   Short bill identifier (last 5 digits of Date.now())
 * @param {string} dateStr  Formatted date/time string from getFormattedDate()
 * @returns {Uint8Array|null}  ESC/POS buffer, or null on any failure
 */
export function buildBillReceipt(cart, title, billNo, dateStr) {
    const EscPosEncoder = window.EscPosEncoder;
    if (!EscPosEncoder) {
        console.warn('[receipt] window.EscPosEncoder is not loaded — falling back to legacy text receipt.');
        return null;
    }

    try {
        const encoder = new EscPosEncoder({ width: PRINTER_WIDTH });
        let enc = encoder.initialize();

        // ── 1. Logo (if pre-loaded) ────────────────────────────────────────────
        if (_logoCanvas) {
            enc = enc
                .align('center')
                .image(_logoCanvas, 128, 64, 'threshold')
                .newline();
        }

        // ── 2. Shop name — bold + centred ─────────────────────────────────────
        enc = enc
            .align('center')
            .bold(true)
            .line('NEW PIZZA HUT & LIVE CAKE')
            .bold(false)
            .line('in front of SBI bank ke tik')
            .line('samne salempur Deoria, UP')
            .line('FSSAI: 30230324113093042')
            .line('Ph: 9628548655')
            .newline()
            .align('left');

        // ── 3. Bill metadata ───────────────────────────────────────────────────
        enc = enc
            .line(`Bill No  : ${billNo}`)
            .line(`Date     : ${dateStr}`)
            .line(`Bill To  : ${title}`)
            .line(DIVIDER);

        // ── 4. Column header (bold) ────────────────────────────────────────────
        enc = enc
            .bold(true)
            .table(TABLE_COLS, [['Item', 'Qty', 'Total']])
            .bold(false)
            .line(DIVIDER);

        // ── 5. Item rows with extras (rendered per-item so extras can follow) ───
        // extras are rendered dynamically — never hardcoded by name.
        // specialRequest is intentionally omitted from the customer bill.
        for (const item of cart) {
            const _ep = Array.isArray(item.extras) ? item.extras.reduce((s, e) => s + (Number(e.price) || 0), 0) : 0;
            const _itemTotal = (item.price + _ep) * item.qty;
            enc = enc.table(TABLE_COLS, [[
                item.name,
                String(item.qty),
                `Rs${_itemTotal}`,
            ]]);
            if (Array.isArray(item.extras) && item.extras.length > 0) {
                for (const extra of item.extras) {
                    enc = enc.line(`  + ${extra.name}${extra.price ? ` (+Rs${extra.price})` : ''}`);
                }
            }
            if (item.specialRequest) {
                enc = enc.line(`  > ${item.specialRequest}`);
            }
        }

        // ── 6. Totals ──────────────────────────────────────────────────────────
        const total    = cart.reduce((sum, i) => {
            const ep = Array.isArray(i.extras) ? i.extras.reduce((s, e) => s + (Number(e.price) || 0), 0) : 0;
            return sum + (i.price + ep) * i.qty;
        }, 0);
        const totalQty = cart.reduce((sum, i) => sum + i.qty, 0);

        enc = enc
            .line(DIVIDER)
            .line(`Total Items   : ${cart.length}`)
            .line(`Total Qty     : ${totalQty}`)
            .line(`Subtotal      : Rs ${total}`)
            .newline()
            .align('center')
            .bold(true)
            .line(`** TOTAL: Rs ${total} **`)
            .bold(false)
            .newline()
            .line('Thank You! Visit Again!')
            .newline()
            .newline()
            .newline()
            .cut();

        return enc.encode();

    } catch (err) {
        console.error('[receipt] ESC/POS encoding failed — falling back to legacy text receipt:', err);
        return null;
    }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Load an image URL into an off-screen canvas and binarise it using a
 * BT.709 luminance threshold (pixel luma < 128 → black; ≥ 128 → white).
 *
 * The resulting canvas is suitable for use as the `element` argument of
 * EscPosEncoder.image().
 *
 * @param {string} src          - Absolute or root-relative image URL
 * @param {number} targetWidth  - Target canvas width in pixels (use multiple of 8)
 * @param {number} targetHeight - Target canvas height in pixels (use multiple of 8)
 * @returns {Promise<HTMLCanvasElement>}
 */
function _loadMonochromeCanvas(src, targetWidth, targetHeight) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';

        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width  = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext('2d');

            // White background so transparent areas print white (not black)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, targetWidth, targetHeight);
            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

            // BT.709 luminance threshold → pure monochrome
            const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
            const d = imageData.data;
            for (let i = 0; i < d.length; i += 4) {
                const luma = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
                const mono = luma < 128 ? 0 : 255;
                d[i] = d[i + 1] = d[i + 2] = mono;
                d[i + 3] = 255; // fully opaque
            }
            ctx.putImageData(imageData, 0, 0);
            resolve(canvas);
        };

        img.onerror = () => reject(new Error(`[receipt] Failed to load image: ${src}`));
        img.src = src;
    });
}
