/**
 * activity-bus — tiny leaf module so orchestrator-layer code can signal
 * "session is actively doing something" without importing the channels
 * Scheduler instance (which would create a module cycle).
 *
 * channels/index.mjs registers a listener at boot that forwards into
 * scheduler.noteActivity(). ai-wrapped-dispatch (and any other
 * orchestrator-side producers) call notifyActivity() near the point
 * where work is kicked off.
 *
 * All failures are swallowed — an activity ping is never load-bearing.
 */

let _listener = null;

export function setListener(fn) {
  _listener = typeof fn === 'function' ? fn : null;
}

export function notifyActivity() {
  if (!_listener) return;
  try { _listener(); } catch { /* best-effort */ }
}
