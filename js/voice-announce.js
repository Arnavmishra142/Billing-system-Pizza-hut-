// js/voice-announce.js
// ─────────────────────────────────────────────────────────────────────────
// AI UPDATE [2026-09-22] — Push-to-Talk Voice Announcement
//
// Staff-only "walkie talkie" mic button in the Recent Bills (24h) drawer
// header. Press-and-hold captures the operator's microphone and relays it
// LIVE, locally, in real time to the browser's current default audio output
// (e.g. a paired Bluetooth speaker) so staff can make an announcement
// through the restaurant's speaker. Release stops it immediately.
//
// This module is intentionally self-contained:
//   - No imports from / exports to any other POS module.
//   - Touches only #voiceAnnounceBtn / #vaStatusText (new elements in the
//     Recent Bills drawer header).
//   - Never reads or writes bills, orders, customers, KOT, or payment state.
//   - Nothing is recorded, buffered to disk, or sent anywhere — the audio
//     graph is mic → (optional) gain/limiter → speakers, in memory only.
// ─────────────────────────────────────────────────────────────────────────

(function initVoiceAnnounce() {
    const micBtn = document.getElementById('voiceAnnounceBtn');
    const statusEl = document.getElementById('vaStatusText');
    if (!micBtn) return; // Recent Bills header not present on this page — no-op.

    /** @type {MediaStream|null} */
    let activeStream = null;
    /** @type {AudioContext|null} */
    let audioCtx = null;
    /** @type {MediaStreamAudioSourceNode|null} */
    let sourceNode = null;
    /** @type {GainNode|null} */
    let gainNode = null;
    /** @type {DynamicsCompressorNode|null} */
    let limiterNode = null;

    let isListening = false;   // true while mic is actually open & routed to speaker
    let isStarting = false;    // guards against overlapping press events / double streams

    const supportsMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

    function setStatus(text, kind) {
        if (!statusEl) return;
        statusEl.textContent = text || '';
        statusEl.classList.toggle('va-visible', !!text);
        statusEl.classList.toggle('va-error-text', kind === 'error');
    }

    function setVisualState(state) {
        // state: 'idle' | 'listening' | 'unsupported' | 'denied'
        micBtn.classList.remove('va-active', 'va-unsupported', 'va-denied');
        if (state === 'listening') micBtn.classList.add('va-active');
        if (state === 'unsupported') micBtn.classList.add('va-unsupported');
        if (state === 'denied') micBtn.classList.add('va-denied');
    }

    if (!supportsMic) {
        setVisualState('unsupported');
        setStatus('Mic not supported', 'error');
        micBtn.disabled = true;
        micBtn.title = 'Microphone capture is not supported in this browser';
        return;
    }

    // Tears down the mic stream and audio graph. Safe to call multiple times.
    function teardownAudio() {
        try {
            if (sourceNode) { sourceNode.disconnect(); }
        } catch (_) {}
        try {
            if (limiterNode) { limiterNode.disconnect(); }
        } catch (_) {}
        try {
            if (gainNode) { gainNode.disconnect(); }
        } catch (_) {}
        sourceNode = null;
        limiterNode = null;
        gainNode = null;

        if (activeStream) {
            activeStream.getTracks().forEach((track) => {
                try { track.stop(); } catch (_) {}
            });
            activeStream = null;
        }

        if (audioCtx) {
            // close() releases the underlying hardware/output resources.
            audioCtx.close().catch(() => {});
            audioCtx = null;
        }
    }

    function stopListening() {
        if (!isListening && !isStarting) return;
        isListening = false;
        isStarting = false;
        teardownAudio();
        setVisualState('idle');
        setStatus('');
    }

    async function startListening() {
        // Hard guard: never allow a second concurrent mic stream/context.
        if (isListening || isStarting) return;
        isStarting = true;
        setStatus('Starting…');

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            // If the button was released while permission was pending, or a
            // second press slipped through, discard this stream immediately.
            if (!isStarting) {
                stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
                return;
            }

            activeStream = stream;

            // 'interactive' hints the browser to minimize output latency,
            // which matters for a live push-to-talk relay.
            const Ctx = window.AudioContext || window.webkitAudioContext;
            audioCtx = new Ctx({ latencyHint: 'interactive' });
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume().catch(() => {});
            }

            sourceNode = audioCtx.createMediaStreamSource(stream);

            // Small gain stage + soft limiter: guards against clipping/feedback
            // spikes when relaying live mic audio through a nearby speaker.
            // This is local, real-time DSP only — nothing is stored.
            gainNode = audioCtx.createGain();
            gainNode.gain.value = 1.0;

            limiterNode = audioCtx.createDynamicsCompressor();
            limiterNode.threshold.value = -12;
            limiterNode.knee.value = 20;
            limiterNode.ratio.value = 12;
            limiterNode.attack.value = 0.002;
            limiterNode.release.value = 0.15;

            // Routes to audioCtx.destination, i.e. whatever the browser/OS
            // currently treats as the default audio output. We deliberately
            // never call setSinkId() with a hardcoded device id — the active
            // Bluetooth speaker (or whichever output the tablet is using) is
            // whatever the OS currently has selected as default.
            sourceNode.connect(gainNode);
            gainNode.connect(limiterNode);
            limiterNode.connect(audioCtx.destination);

            // If the OS/browser drops the mic track (e.g. Bluetooth mic
            // disconnects), stop cleanly instead of leaving a dead stream open.
            stream.getAudioTracks().forEach((track) => {
                track.addEventListener('ended', () => stopListening());
            });

            isListening = true;
            isStarting = false;
            setVisualState('listening');
            setStatus('Listening…');
        } catch (err) {
            isStarting = false;
            isListening = false;
            teardownAudio();

            if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
                setVisualState('denied');
                setStatus('Mic permission denied', 'error');
            } else if (err && err.name === 'NotFoundError') {
                setVisualState('denied');
                setStatus('No microphone found', 'error');
            } else {
                setVisualState('denied');
                setStatus('Mic unavailable', 'error');
            }

            // Let the button recover after a moment so it can be retried
            // (e.g. after the user grants permission in the browser UI).
            setTimeout(() => {
                if (!isListening) { setVisualState('idle'); setStatus(''); }
            }, 2500);
        }
    }

    // ── Press-and-hold wiring (Pointer Events cover mouse + touch + pen in
    // one handler, which is what a tablet POS needs). ──────────────────────
    micBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { micBtn.setPointerCapture(e.pointerId); } catch (_) {}
        startListening();
    });

    ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach((evt) => {
        micBtn.addEventListener(evt, () => stopListening());
    });

    // Belt-and-suspenders for older mobile browsers that fire touch events
    // without full Pointer Events support.
    micBtn.addEventListener('touchend', () => stopListening(), { passive: true });
    micBtn.addEventListener('contextmenu', (e) => e.preventDefault());

    // Keyboard accessibility: hold Space/Enter to talk (mirrors press-and-hold).
    micBtn.addEventListener('keydown', (e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            startListening();
        }
    });
    micBtn.addEventListener('keyup', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            stopListening();
        }
    });

    // Safety nets: never leave a mic stream open if the tab/app is hidden,
    // the drawer/page unloads, or the window loses focus mid-announcement.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopListening();
    });
    window.addEventListener('pagehide', stopListening);
    window.addEventListener('beforeunload', stopListening);
})();
