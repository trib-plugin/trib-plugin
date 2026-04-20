/**
 * Bridge stall watchdog — per-session ticker that fires a `notifyFn` alert
 * when a bridge worker's SSE stream goes silent for too long.
 *
 * Motivation (v0.6.233):
 *   The global stream-watchdog already aborts on a hard 600s stall, but the
 *   bridge worker's `notifyFn` only fires on the completion path. A stall
 *   that never reaches the hard-abort boundary (e.g. provider goes quiet
 *   mid-iteration and the lead gives up waiting) left the lead waiting
 *   indefinitely with no "worker finished" notification.
 *
 *   This watchdog sits inside the bridge worker lifecycle, not the
 *   orchestrator. It uses the same staleness signal (lastStreamDeltaAt
 *   falling back to askStartedAt) and emits a user-facing notification
 *   via the existing notifyFn path once the per-session threshold is
 *   crossed — then aborts the session so the outer try/catch renders
 *   the normal error footer.
 *
 * Non-goals:
 *   - Does not replace the global stream-watchdog (that still runs at
 *     300s/600s for provider-level stalls that never dispatched via bridge).
 *   - Does not fire on long tool calls: `stage === 'tool_running'` is
 *     expected server silence, exactly like stream-watchdog.shouldSkip.
 */

const TICK_MS = 30_000;
const DEFAULT_THRESHOLD_S = 90;

function envThresholdSeconds() {
    const raw = process.env.STALL_TIMEOUT_S;
    if (!raw) return DEFAULT_THRESHOLD_S;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_THRESHOLD_S;
    return n;
}

/**
 * Decide whether an entry is stalled right now.
 * Pure function — exposed for tests so we can feed synthetic runtime shapes.
 *
 * Returns one of:
 *   'skip'  — entry missing, closed, or in tool_running / terminal stage.
 *   'ok'    — entry live but below threshold.
 *   'stall' — stale beyond threshold; caller should notify + abort.
 *
 * Never treats `tool_running` as a stall (client-side work, not server
 * silence). Terminal stages (idle/done/error/cancelling) are skipped too
 * since askSession has already returned or is unwinding.
 */
export function inspectBridgeEntry(entry, thresholdSeconds = DEFAULT_THRESHOLD_S, now = Date.now()) {
    if (!entry) return { verdict: 'skip' };
    if (entry.closed) return { verdict: 'skip' };
    const stage = entry.stage || null;
    if (stage === 'tool_running') return { verdict: 'skip' };
    if (stage === 'idle' || stage === 'done' || stage === 'error' || stage === 'cancelling') {
        return { verdict: 'skip' };
    }
    const ref = entry.lastStreamDeltaAt || entry.askStartedAt;
    if (!ref) return { verdict: 'skip' };
    const staleSeconds = Math.round((now - ref) / 1000);
    if (staleSeconds < thresholdSeconds) return { verdict: 'ok', staleSeconds, stage };
    return { verdict: 'stall', staleSeconds, stage };
}

/**
 * Start a per-session stall watchdog.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {() => object|null} params.getRuntime      returns manager.getSessionRuntime(sessionId)
 * @param {() => number} params.getIteration        returns latest known iteration count
 * @param {(reason: Error) => void} params.abort    aborts the session controller
 * @param {(msg: string) => void} params.notify     notifyFn-style emitter
 * @param {string} [params.modelTag]                `[model] ` prefix to match other bridge emits
 * @param {string} [params.role]
 * @param {number} [params.thresholdSeconds]        override for tests; falls back to env + default
 * @param {number} [params.tickMs]                  override for tests
 * @returns {{ stop: () => void, fired: () => boolean }}
 */
export function startBridgeStallWatchdog(params) {
    const {
        sessionId,
        getRuntime,
        getIteration,
        abort,
        notify,
        modelTag = '',
        role = 'worker',
        thresholdSeconds = envThresholdSeconds(),
        tickMs = TICK_MS,
    } = params;

    let fired = false;
    let handle = null;

    const tick = () => {
        if (fired) return;
        let entry = null;
        try { entry = getRuntime(); } catch { entry = null; }
        const res = inspectBridgeEntry(entry, thresholdSeconds);
        if (res.verdict !== 'stall') return;
        fired = true;
        const iter = (() => {
            try { return getIteration(); } catch { return null; }
        })();
        const iterPart = typeof iter === 'number' && iter > 0 ? ` at iter ${iter}` : '';
        const msg = `${modelTag}${role} stalled — no SSE delta for ${res.staleSeconds}s${iterPart}`;
        try { notify(msg); } catch { /* best-effort — match other bridge emits */ }
        try {
            const reason = new Error(`bridge stall watchdog: ${res.staleSeconds}s`);
            reason.name = 'BridgeStallAbortError';
            abort(reason);
        } catch { /* controller already gone / non-Error rejection — let outer flow finish */ }
        // Don't keep ticking once we've fired; outer finally will stop() us
        // but clear eagerly so a slow unwind can't double-notify.
        if (handle) { clearInterval(handle); handle = null; }
    };

    handle = setInterval(tick, tickMs);
    if (typeof handle.unref === 'function') handle.unref();

    return {
        stop() {
            if (handle) { clearInterval(handle); handle = null; }
        },
        fired() { return fired; },
    };
}

export const _internals = { TICK_MS, DEFAULT_THRESHOLD_S, envThresholdSeconds };
