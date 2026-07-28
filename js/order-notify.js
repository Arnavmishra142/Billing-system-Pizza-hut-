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
//  • Audio autoplay is unlocked on the admin's first interaction with the page.
//
// ── Root cause of original bug (fixed here) ──────────────────────────────────
//  signInAnonymously() runs at module load time, so the Firestore snapshot fires
//  and triggerAlert() is called BEFORE the admin has clicked anything.
//  audio.play() fails (autoplay policy). When the admin first clicks (PIN digit),
//  _unlockAudio() was calling audio.play().then(pause) — immediately pausing the
//  audio even though an alert was pending. _alertActive stayed true but the audio
//  was silent. Fix: _unlockAudio() checks _alertActive; if true it plays WITHOUT
//  pausing so the pending alert finally sounds.
//
// AI UPDATE [2026-07-28]: Created — looping audio + browser notification.
// AI UPDATE [2026-07-28] v2: Fixed autoplay-unlock bug — _unlockAudio now resumes
//   a pending alert instead of always pausing after play().

// ── Audio element ─────────────────────────────────────────────────────────────
const _audio   = new Audio('sounds/notification.mp3');
_audio.loop    = true;
_audio.preload = 'auto';

console.log('[order-notify] Audio element created — sounds/notification.mp3');

let _audioUnlocked  = false;  // true after first user gesture unlocks autoplay
let _alertActive    = false;  // true while a pending alert exists (sound should loop)
let _pendingTableId = null;   // table name waiting to alert when audio gets unlocked

// ── Autoplay unlock ───────────────────────────────────────────────────────────
// Browsers block audio.play() until the user has interacted with the page.
// We listen for the first click/touch/keydown and use it to satisfy the policy.
//
// CRITICAL FIX: if _alertActive is true when the gesture fires, an order arrived
// before any interaction and audio.play() already failed. In that case we start
// the loop immediately (no pause). If there is no pending alert we play-then-pause
// just to warm the AudioContext for future calls.
function _unlockAudio() {
    if (_audioUnlocked) return;
    _audioUnlocked = true;
    console.log('[order-notify] Audio unlocked by user gesture');

    document.removeEventListener('click',      _unlockAudio);
    document.removeEventListener('touchstart', _unlockAudio);
    document.removeEventListener('keydown',    _unlockAudio);

    if (_alertActive) {
        // An order arrived before the first gesture — start the loop now
        console.log('[order-notify] Pending alert detected on unlock — starting loop for:', _pendingTableId);
        _audio.currentTime = 0;
        _audio.play()
            .then(() => console.log('[order-notify] audio.play() succeeded (post-unlock resume)'))
            .catch(err => console.warn('[order-notify] audio.play() failed on unlock:', err.name));
    } else {
        // No pending alert — just warm up the AudioContext so future play() calls succeed
        _audio.play()
            .then(() => { _audio.pause(); _audio.currentTime = 0; })
            .catch(() => {});
    }
}

document.addEventListener('click',      _unlockAudio, { passive: true });
document.addEventListener('touchstart', _unlockAudio, { passive: true });
document.addEventListener('keydown',    _unlockAudio, { passive: true });

// ── Browser Notification permission ──────────────────────────────────────────
let _permissionRequested = false;

async function _ensureNotificationPermission() {
    if (!('Notification' in window))           return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied')  return false;
    if (_permissionRequested)                  return false;
    _permissionRequested = true;
    const result = await Notification.requestPermission();
    console.log('[order-notify] Notification permission result:', result);
    return result === 'granted';
}

// ── Show / refresh browser notification ──────────────────────────────────────
// tag: 'incoming-order' replaces any existing notification — no stacking.
function _showBrowserNotification(tableId) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const n = new Notification('🔔 New Order Received!', {
        body:               `${tableId} has placed a new order!`,
        tag:                'incoming-order',
        icon:               'pos-logo.png',
        requireInteraction: true
    });

    n.onclick = () => {
        n.close();
        stopAlert();
        window.focus();
        window.dispatchEvent(new Event('orders-open-drawer'));
    };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * triggerAlert(tableId)
 * Called when a new order arrives.
 * - Starts looping audio (or queues it if audio not yet unlocked).
 * - Shows / replaces the browser notification.
 * - Safe to call multiple times — only one audio loop ever runs.
 */
export async function triggerAlert(tableId) {
    console.log('[order-notify] triggerAlert() called for:', tableId, '| _alertActive:', _alertActive, '| _audioUnlocked:', _audioUnlocked);

    _pendingTableId = tableId;

    // Request notification permission (non-blocking, first time only)
    _ensureNotificationPermission();

    // Always refresh the browser notification so the admin sees the latest table
    _showBrowserNotification(tableId);

    if (_alertActive) {
        console.log('[order-notify] Alert already active — notification updated, no new audio loop');
        return;
    }
    _alertActive = true;

    if (!_audioUnlocked) {
        // No user gesture yet — audio.play() will fail.
        // _unlockAudio() will start the loop when the admin next clicks/taps/keys.
        console.log('[order-notify] Audio not yet unlocked — queuing alert; will play on first gesture');
        return;
    }

    // Audio is unlocked — play immediately
    _audio.currentTime = 0;
    _audio.play()
        .then(() => console.log('[order-notify] audio.play() succeeded'))
        .catch(err => {
            console.warn('[order-notify] audio.play() failed:', err.name, err.message);
        });
}

/**
 * stopAlert()
 * Stops the looping audio and resets alert state.
 * Called when the admin opens the drawer or clicks the browser notification.
 */
export function stopAlert() {
    if (!_alertActive) return;
    console.log('[order-notify] stopAlert() called — stopping audio loop');
    _alertActive    = false;
    _pendingTableId = null;
    _audio.pause();
    _audio.currentTime = 0;
}
