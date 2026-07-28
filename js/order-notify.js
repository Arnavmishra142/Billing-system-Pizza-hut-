// order-notify.js
// Looping audio alert + browser push notification for new incoming orders.
//
// ── What this module does ─────────────────────────────────────────────────────
//  • Plays sounds/notification.mp3 in a continuous loop when a new order arrives.
//  • Shows a browser Notification (if permission granted) with the table name.
//  • The alert (sound + notification) stops ONLY when:
//      1. The admin opens the Incoming Orders drawer, OR
//      2. The admin clicks the browser notification.
//  • Multiple simultaneous orders share ONE audio loop — no overlapping sounds.
//  • Audio autoplay is unlocked on the admin's first interaction with the page
//    (click / touchstart / keydown).  Only one unlock attempt per session.
//
// ── What this module does NOT do ─────────────────────────────────────────────
//  • Does not modify billing workflow, KOT, Save & Exit, or Bill & Settle.
//  • Does not touch Firestore or any order data.
//  • Does not change any existing UI.
//
// AI UPDATE [2026-07-28]: Created — looping audio + browser notification alert
// system for new incoming customer orders.

// ── Audio element ─────────────────────────────────────────────────────────────
const _audio       = new Audio('sounds/notification.mp3');
_audio.loop        = true;
_audio.preload     = 'auto';

let _audioUnlocked = false;   // true after first user gesture unlocks autoplay
let _alertActive   = false;   // true while the loop is playing

// ── Autoplay unlock ───────────────────────────────────────────────────────────
// Modern browsers block audio.play() until a user gesture has occurred on the
// page.  We hook the first click/touch/keydown to play-then-immediately-pause
// the audio element.  This "warms" the AudioContext so that future play() calls
// triggered by Firestore events (no gesture in scope) succeed without error.
// The listeners are registered once and removed after the first fire.
function _unlockAudio() {
    if (_audioUnlocked) return;
    _audioUnlocked = true;
    _audio.play()
        .then(() => { _audio.pause(); _audio.currentTime = 0; })
        .catch(() => { /* nothing to do — will retry on next triggerAlert */ });
    document.removeEventListener('click',      _unlockAudio);
    document.removeEventListener('touchstart', _unlockAudio);
    document.removeEventListener('keydown',    _unlockAudio);
}

document.addEventListener('click',      _unlockAudio, { passive: true });
document.addEventListener('touchstart', _unlockAudio, { passive: true });
document.addEventListener('keydown',    _unlockAudio, { passive: true });

// ── Browser Notification permission ──────────────────────────────────────────
// Requested lazily on the first new order — not on page load — so it doesn't
// interrupt the admin before they've done anything.
let _permissionRequested = false;

async function _ensureNotificationPermission() {
    if (!('Notification' in window))           return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied')  return false;
    if (_permissionRequested)                  return false; // already asked once
    _permissionRequested = true;
    const result = await Notification.requestPermission();
    return result === 'granted';
}

// ── Show / refresh browser notification ──────────────────────────────────────
// tag: 'incoming-order' means the OS replaces the previous notification rather
// than stacking multiple ones when several orders arrive in quick succession.
function _showBrowserNotification(tableId) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const n = new Notification('🔔 New Order Received!', {
        body:            `${tableId} has placed a new order!`,
        tag:             'incoming-order',   // replace previous, no stacking
        icon:            'pos-logo.png',
        requireInteraction: true             // stays on screen until dismissed
    });

    n.onclick = () => {
        n.close();
        stopAlert();
        window.focus();
        // Signal incoming-orders.js to open the drawer
        window.dispatchEvent(new Event('orders-open-drawer'));
    };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * triggerAlert(tableId)
 *
 * Call when a brand-new order arrives.
 *   • If no alert is active: starts the looping audio and shows a notification.
 *   • If an alert is already active: refreshes the browser notification (new
 *     table name) but does NOT start a second audio loop.
 *
 * Safe to call repeatedly — at most one audio loop ever runs at a time.
 */
export async function triggerAlert(tableId) {
    // Request permission the first time (non-blocking)
    _ensureNotificationPermission();

    // Always (re-)show the browser notification so the admin sees the latest
    // table even while a previous alert is already sounding.
    _showBrowserNotification(tableId);

    if (_alertActive) return; // already looping — notification updated above
    _alertActive = true;

    _audio.currentTime = 0;
    _audio.play().catch(err => {
        // Autoplay still blocked (admin hasn't interacted yet).
        // _unlockAudio will fire on their next click/touch/keydown and
        // stopAlert will have already been called before that, so we just
        // reset the flag so the next order can try again.
        console.warn('[order-notify] Audio play blocked:', err.name);
        // Keep _alertActive = true so the notification state stays consistent;
        // the admin can still dismiss via the browser notification click.
    });
}

/**
 * stopAlert()
 *
 * Stops the looping audio and resets alert state.
 * Called by incoming-orders.js when the drawer is opened, and by the browser
 * notification's onclick handler.
 */
export function stopAlert() {
    if (!_alertActive) return;
    _alertActive = false;
    _audio.pause();
    _audio.currentTime = 0;
}
