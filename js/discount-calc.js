// js/discount-calc.js
// Quick calculator helper for the "Custom Instant Discount" modal (Billing Panel POS).
//
// AI UPDATE [2026-09-21]: NEW FILE. Standalone on purpose — it never reads or writes the cart, pricing,
// coupon or discount state (js/cart.js is untouched). It only:
//   • opens #discountCalcModal ABOVE #customDiscountModal (the discount modal stays open, its input keeps
//     whatever the user typed), and
//   • when — and only when — the user taps "Use Result", copies the result into #customDiscountInput and
//     fires that input's normal `input` event so the existing live preview / validation runs. Applying the
//     discount is still the user's own tap on "Apply Discount".
//
// Supports + − × ÷, decimals, =, C, ⌫ and % (no eval — a small tokenizer/parser):
//   150 + 75 = 225      500 × 10% = 50      200 + 10% = 220 (10% of the running total)
//   200 − 10% = 180     0.1 + 0.2 = 0.3     ÷ 0 -> "Can't divide by 0"
// Physical keyboard works too while the calculator is open (digits, . + - * / % Enter Backspace Esc).

const OPS = ['+', '−', '×', '÷'];
const isDigit = (c) => c >= '0' && c <= '9';

// ── Pure calculation ─────────────────────────────────────────────────────────
// Returns { ok:true, value } or { ok:false, error }.
function evaluate(str) {
    const toks = [];
    let i = 0, sign = 1;
    while (i < str.length) {
        const ch = str[i];
        if (isDigit(ch) || ch === '.') {
            let j = i;
            while (j < str.length && (isDigit(str[j]) || str[j] === '.')) j++;
            const n = Number(str.slice(i, j));
            if (!Number.isFinite(n)) return { ok: false, error: 'Invalid number' };
            toks.push({ t: 'n', v: sign * n, pct: false });
            sign = 1;
            i = j;
        } else if (ch === '%') {
            const last = toks[toks.length - 1];
            if (!last || last.t !== 'n' || last.pct) return { ok: false, error: 'Invalid %' };
            last.pct = true;
            i++;
        } else if (ch === '−' && toks.length === 0 && sign === 1) {
            sign = -1;                       // leading minus = negative first number
            i++;
        } else if (OPS.includes(ch)) {
            toks.push({ t: 'o', v: ch });
            i++;
        } else {
            return { ok: false, error: 'Invalid input' };
        }
    }
    if (sign === -1) return { ok: false, error: 'Incomplete' };

    let pos = 0;
    const fail = (error) => { throw Object.assign(new Error(error), { calc: true }); };
    const factor = () => {
        const t = toks[pos];
        if (!t || t.t !== 'n') fail('Incomplete');
        pos++;
        return t;
    };
    // term := factor (('×' | '÷') factor)*      (n% inside × / ÷ means n/100)
    const term = () => {
        const first = factor();
        let val = first.pct ? first.v / 100 : first.v;
        let chained = false;
        while (toks[pos] && toks[pos].t === 'o' && (toks[pos].v === '×' || toks[pos].v === '÷')) {
            const op = toks[pos++].v;
            const f = factor();
            const rv = f.pct ? f.v / 100 : f.v;
            if (op === '×') val *= rv;
            else { if (rv === 0) fail("Can't divide by 0"); val /= rv; }
            chained = true;
        }
        return { val, pctOnly: !chained && first.pct, raw: first.v };
    };
    // expression := term (('+' | '−') term)*     ("a + n%" / "a − n%" = n% of the running total a)
    const expression = () => {
        let acc = term().val;
        // (first term's own % already applied inside term())
        while (toks[pos] && toks[pos].t === 'o') {
            const op = toks[pos++].v;
            const r = term();
            const rv = r.pctOnly ? (acc * r.raw) / 100 : r.val;
            acc = op === '+' ? acc + rv : acc - rv;
        }
        return acc;
    };

    try {
        const value = expression();
        if (pos !== toks.length) return { ok: false, error: 'Incomplete' };
        if (!Number.isFinite(value)) return { ok: false, error: 'Error' };
        return { ok: true, value: Number(value.toFixed(10)) };   // trims 0.30000000000000004 -> 0.3
    } catch (err) {
        return { ok: false, error: err && err.calc ? err.message : 'Error' };
    }
}

const fmtNum = (v) => v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 });

(function wireDiscountCalculator() {
    const openBtn   = document.getElementById('discountCalcBtn');
    const modal     = document.getElementById('discountCalcModal');
    const mainEl    = document.getElementById('calcMain');
    const subEl     = document.getElementById('calcSub');
    const keysEl    = document.getElementById('calcKeys');
    const closeBtn  = document.getElementById('calcCloseBtn');
    const useBtn    = document.getElementById('calcUseBtn');
    const discModal = document.getElementById('customDiscountModal');
    const discInput = document.getElementById('customDiscountInput');
    if (!openBtn || !modal || !mainEl || !subEl || !keysEl || !closeBtn || !useBtn || !discInput) return;

    let expr  = '';      // what the user has typed, e.g. "150+75"
    let fresh = false;   // true right after "=": expr holds the result
    let hist  = '';      // "150 + 75 =" shown above a fresh result
    let error = '';      // message from the last "="

    const isOpen = () => !modal.classList.contains('hidden');
    const last = () => expr[expr.length - 1] || '';
    const hasOp = () => /[+−×÷%]/.test(expr.replace(/^−/, ''));
    const pretty = (s) => s.replace(/([+×÷])/g, ' $1 ').replace(/(.)−/g, '$1 − ').trim();
    const trimmed = () => {
        let s = expr;
        while (s && (OPS.includes(s[s.length - 1]) || s[s.length - 1] === '.')) s = s.slice(0, -1);
        return s;
    };
    function currentNumber() {
        let j = expr.length;
        while (j > 0 && (isDigit(expr[j - 1]) || expr[j - 1] === '.')) j--;
        return expr.slice(j);
    }
    // Numeric value of what is on screen right now (or null).
    function currentValue() {
        const s = trimmed();
        if (!s) return null;
        const r = evaluate(s);
        return r.ok ? r.value : null;
    }

    function press(k) {
        error = '';
        if (k === 'C') { expr = ''; fresh = false; hist = ''; return; }
        if (k === 'BS') { fresh = false; hist = ''; expr = expr.slice(0, -1); return; }
        if (k === '=') {
            if (!hasOp() || !trimmed()) return;
            const r = evaluate(trimmed());
            if (!r.ok) { error = r.error; return; }
            hist = pretty(trimmed()) + ' =';
            expr = fmtNum(r.value);
            fresh = true;
            return;
        }
        if (k === '%') { if (isDigit(last())) { fresh = false; hist = ''; expr += '%'; } return; }
        if (isDigit(k)) {
            if (fresh) { expr = ''; fresh = false; hist = ''; }
            if (last() === '%') return;
            const cur = currentNumber();
            if (cur === '0') expr = expr.slice(0, -1) + k;          // no leading zeros
            else if (cur.replace('.', '').length >= 12) return;      // sane length
            else expr += k;
            return;
        }
        if (k === '.') {
            if (fresh) { expr = ''; fresh = false; hist = ''; }
            if (last() === '%') return;
            const cur = currentNumber();
            if (cur.includes('.')) return;
            expr += cur === '' ? '0.' : '.';
            return;
        }
        if (OPS.includes(k)) {
            fresh = false; hist = '';
            if (expr === '') { if (k === '−') expr = '−'; return; }   // only a leading minus is allowed
            if (expr === '−') return;
            if (OPS.includes(last())) { expr = expr.slice(0, -1) + k; return; }   // replace the operator
            if (last() === '.') expr = expr.slice(0, -1);
            expr += k;
        }
    }

    function render() {
        mainEl.textContent = expr ? pretty(expr) : '0';
        subEl.className = 'calc-sub';
        if (error) {
            subEl.textContent = error;
            subEl.classList.add('calc-error');
        } else if (fresh && hist) {
            subEl.textContent = hist;
            subEl.classList.add('calc-muted');
        } else if (hasOp()) {
            const v = currentValue();
            subEl.textContent = v === null ? '' : `= ${fmtNum(v)}`;
        } else {
            subEl.textContent = '';
        }
        const v = currentValue();
        useBtn.disabled = !(v !== null && Math.round(v * 100) > 0);   // a discount must be > 0
        mainEl.scrollLeft = mainEl.scrollWidth;
    }

    function reset() { expr = ''; fresh = false; hist = ''; error = ''; render(); }

    function openCalc() {
        // Drop focus from the discount input so a phone's soft keyboard doesn't cover the calculator.
        if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
        modal.classList.remove('hidden');
        render();
    }
    function closeCalc() {
        modal.classList.add('hidden');
        openBtn.focus({ preventScroll: true });
    }

    // Copies the on-screen result into the discount input (rounded to paise, the input's own limit).
    // Does NOT apply the discount.
    function useResult() {
        const v = currentValue();
        if (v === null) return;
        const rounded = Math.round(v * 100) / 100;
        if (!(rounded > 0)) return;
        discInput.value = String(rounded);
        discInput.dispatchEvent(new Event('input', { bubbles: true }));   // existing live preview / validation runs
        reset();
        modal.classList.add('hidden');
    }

    openBtn.addEventListener('click', openCalc);
    closeBtn.addEventListener('click', closeCalc);
    useBtn.addEventListener('click', useResult);
    keysEl.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-k]');
        if (!b) return;
        press(b.dataset.k);
        render();
    });
    modal.addEventListener('click', (ev) => { if (ev.target === modal) closeCalc(); });   // backdrop closes ONLY the calculator

    // Keyboard, only while the calculator is open. Capture phase + stopPropagation so the discount modal's own
    // document-level Esc handler (and its Enter-to-apply) can never fire from a calculator keypress.
    const KEYMAP = { '-': '−', '*': '×', 'x': '×', 'X': '×', '/': '÷', ',': '.', 'Enter': '=', 'Backspace': 'BS', 'Delete': 'C', 'c': 'C', 'C': 'C' };
    document.addEventListener('keydown', (ev) => {
        if (!isOpen()) return;
        ev.stopPropagation();
        if (ev.key === 'Escape') { ev.preventDefault(); closeCalc(); return; }
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const k = KEYMAP[ev.key] || ev.key;
        if (isDigit(k) || k === '.' || k === '=' || k === 'BS' || k === 'C' || k === '%' || OPS.includes(k)) {
            ev.preventDefault();
            press(k);
            render();
        }
    }, true);

    // If the discount modal closes (Cancel / Apply / Esc), forget any half-done calculation.
    if (discModal) {
        new MutationObserver(() => {
            if (discModal.classList.contains('hidden')) { modal.classList.add('hidden'); reset(); }
        }).observe(discModal, { attributes: true, attributeFilter: ['class'] });
    }

    render();
})();
