// js/review-qr.js
// Google Review QR — opens/closes the "Scan to Review" modal from the compact trigger in the cart drawer.
//
// AI UPDATE [2026-09-21] (v2): NEW FILE. Standalone on purpose — it only toggles #googleReviewModal and
// never reads or writes the cart, pricing, coupon or order state (js/cart.js is untouched).
//
// The QR is a static inline SVG in index.html that encodes EXACTLY data-review-url (no redirect page,
// no customer data, no tracking parameters).
//
// TRACKING HOOK (inactive): each time the modal opens a `review-qr-opened` event is dispatched on window
// with { url }. A future scan-tracking flow can listen for it without editing this file or the markup:
//   window.addEventListener('review-qr-opened', (e) => { /* e.detail.url */ });

(function () {
    const btn      = document.getElementById('googleReviewBtn');
    const modal    = document.getElementById('googleReviewModal');
    const closeBtn = document.getElementById('googleReviewCloseBtn');
    if (!btn || !modal || !closeBtn) return;

    const isOpen = () => !modal.classList.contains('hidden');

    function openModal() {
        modal.classList.remove('hidden');
        closeBtn.focus({ preventScroll: true });
        window.dispatchEvent(new CustomEvent('review-qr-opened', { detail: { url: modal.dataset.reviewUrl } }));
    }
    function closeModal() {
        modal.classList.add('hidden');
        btn.focus({ preventScroll: true });
    }

    btn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (ev) => { if (ev.target === modal) closeModal(); }); // backdrop
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && isOpen()) { ev.preventDefault(); closeModal(); }
    });
})();
