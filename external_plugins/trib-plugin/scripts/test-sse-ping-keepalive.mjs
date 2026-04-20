/**
 * Tests for anthropic-oauth parseSSEStream — SSE `:ping` comment-frame
 * keepalive handling.
 *
 * Regression guard for the bridge-stall-watchdog false-positive bug: during
 * Opus extended-thinking pauses Anthropic emits `:ping` comment frames as
 * keepalive. The HTML Standard SSE parser silently ignores them, but our
 * loop needs to surface them to onStreamDelta so the watchdog's
 * lastStreamDeltaAt timestamp gets refreshed and the stream is not
 * mistakenly torn down.
 *
 * Builds a synthetic ReadableStream with a mix of `:ping` frames, a
 * message_start header, a text_delta body, and a message_stop footer.
 * Asserts:
 *   • onStreamDelta fires at least 3 times from the pings alone.
 *   • onStreamDelta fires additional times for content_block_delta /
 *     content_block_stop (pre-existing behavior must be preserved).
 *   • Parsed content === "hi" (the `:ping` branch must not leak into content).
 *   • No exception thrown while parsing.
 */

import { parseSSEStream } from '../src/agent/orchestrator/providers/anthropic-oauth.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log(`  ok  ${msg}`); }
    else       { failed++; console.error(`  FAIL  ${msg}`); }
}

// ── Build synthetic SSE payload ────────────────────────────────────────
// Interleave three `:ping` comment frames with the real events. The
// ordering matters: we want pings BEFORE, BETWEEN, and AFTER real frames
// to confirm the branch survives in every position.
const frames = [
    ':ping\n\n',
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-7","usage":{"input_tokens":10}}}\n\n',
    ':ping\n\n',
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    ':ping\n\n',
    'event: message_stop\n' +
    'data: {"type":"message_stop"}\n\n',
];
const payload = frames.join('');

// Build a minimal fetch-Response-like object whose .body is a ReadableStream.
const encoder = new TextEncoder();
function makeResponse(text) {
    const body = new ReadableStream({
        start(controller) {
            // Push in two chunks to exercise the buffer-split path.
            const bytes = encoder.encode(text);
            const mid = Math.floor(bytes.length / 2);
            controller.enqueue(bytes.slice(0, mid));
            controller.enqueue(bytes.slice(mid));
            controller.close();
        },
    });
    return { body };
}

// ── Run parser ─────────────────────────────────────────────────────────
let deltaCalls = 0;
const onStreamDelta = () => { deltaCalls++; };
const onToolCall = () => {};

// Signal with a NO-OP addEventListener so parseSSEStream's branch is happy
// if it tries to install an abort listener.
const abortController = new AbortController();

let result;
let threw = null;
try {
    result = await parseSSEStream(
        makeResponse(payload),
        abortController.signal,
        () => abortController.abort(),
        onStreamDelta,
        onToolCall,
    );
} catch (err) {
    threw = err;
}

// ── Assertions ─────────────────────────────────────────────────────────
assert(threw === null, `parseSSEStream did not throw (saw ${threw?.message || 'null'})`);
assert(result && typeof result === 'object', 'parseSSEStream returned a result object');
assert(result?.content === 'hi', `content === "hi" (got ${JSON.stringify(result?.content)})`);

// We pushed 3 `:ping` frames. The pre-existing path also fires
// onStreamDelta once for the text_delta. So we expect >= 4 total; at
// least 3 of those must come from pings — verified indirectly by the
// total being >= 3 even if we discount the text_delta path.
assert(deltaCalls >= 3, `onStreamDelta fired at least 3 times (saw ${deltaCalls})`);
assert(deltaCalls >= 4, `onStreamDelta fired >= 4 times total (3 pings + 1 text_delta) (saw ${deltaCalls})`);

// Sanity: content must not have absorbed the `:ping` literal.
assert(!result?.content?.includes('ping'), 'content does not leak the `:ping` literal');
assert(!result?.content?.includes(':'), 'content does not leak a stray colon from comment frames');

// ── Report ────────────────────────────────────────────────────────────
const total = passed + failed;
console.log();
console.log(`PASS ${passed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
