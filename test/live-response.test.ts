import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { liveConsumedBy, splitMessage } from '../src/discord/client.js';
import { resolve } from 'node:path';

const CLIENT = readFileSync(resolve(__dirname, '../src/discord/client.ts'), 'utf8');
const EVENTS = readFileSync(resolve(__dirname, '../src/discord/stream-events.ts'), 'utf8');

/**
 * Discord has no server-push, so a streamed reply is one message being edited.
 * The risk is posting the reply twice — once streamed, once at the end.
 */
describe('streamed Discord replies', () => {
  it('settles the streamed message instead of sending a second copy', () => {
    const send = CLIENT.slice(CLIENT.indexOf('export async function sendResponse('));
    // Must return early, or the reply lands twice.
    expect(send.slice(0, 900)).toMatch(
      /if \(options\.settleLive !== false && \(await finishLiveResponse\(jid, text\)\)\) return true;/,
    );
  });

  /**
   * Regression: the event streamer posts thinking blocks and tool status
   * through sendResponse too. While that also settled the live reply, the first
   * thinking block after the reply started streaming rewrote the half-written
   * reply with thinking text — the message visibly mutated into something else.
   */
  it('never lets thinking or tool messages take over the reply', () => {
    expect(EVENTS).toMatch(/sendResponse\(jid, text, \{ settleLive: false \}\)/);
    // Only the caller delivering the answer may settle, and it does so by default.
    const queue = readFileSync(resolve(__dirname, '../src/agent/queue.ts'), 'utf8');
    expect(queue).not.toContain('settleLive');
  });

  it('settles it on the attachment path too, sending only the files', () => {
    const files = CLIENT.slice(CLIENT.indexOf('export async function sendFilesResponse('));
    expect(files).toContain('const streamed = await finishLiveResponse(jid, text)');
    expect(files).toContain('const bodyText = streamed ? \'\' : text');
    // A streamed reply with no surviving attachment must not append "(empty response)".
    expect(files).toContain('if (streamed && !responseText) return true;');
  });

  it('throttles edits rather than editing per token', () => {
    expect(CLIENT).toMatch(/LIVE_EDIT_MS\s*=\s*\d{3,}/);
    const push = CLIENT.slice(CLIENT.indexOf('export async function updateLiveResponse('));
    expect(push).toContain('LIVE_EDIT_MS - (Date.now() - live.lastEditAt)');
  });

  it('continues into a new message when one fills up', () => {
    expect(CLIENT).toContain('live.consumed += liveConsumedBy(slice, head)');
    // The continuation is a message this code opened, not one already there.
    expect(CLIENT).toContain('live.message = await channel.send(next)');
  });

  it('drops the preview when a turn ends with nothing to say', () => {
    // An empty final text deletes the preview rather than leaving a
    // half-written sentence standing as the answer.
    const fin = CLIENT.slice(CLIENT.indexOf('export async function finishLiveResponse('));
    expect(fin).toMatch(/if \(!body\) \{[\s\S]*?live\.message\.delete\(\)/);
  });

  /**
   * Regression: `agent_end` closes one low-level run and `turn_end` follows it,
   * so a turn-boundary branch runs several times per user turn. Resetting the
   * buffer on the first and discarding on the second (now empty) deleted a
   * perfectly good streamed reply, which was then posted again as a new
   * message — the log said "Response sent", never "finalised (streamed)".
   */
  it('does not discard on turn boundaries, which fire more than once', () => {
    expect(EVENTS).not.toContain('discardLiveResponse');
    const deltas = EVENTS.indexOf('updateLiveResponse(jid, liveText)');
    expect(EVENTS.slice(deltas)).not.toMatch(/liveText = '';/);
  });

  it('discards the preview when the run is aborted instead of answered', () => {
    const QUEUE = readFileSync(resolve(__dirname, '../src/agent/queue.ts'), 'utf8');
    // Both abort branches, not just one.
    expect(QUEUE.match(/void discardLiveResponse\(jid\);/g)?.length).toBe(2);
  });

  /**
   * Regression: the first message is opened asynchronously while callers
   * fire-and-forget one update per delta. Reading `liveMessages` synchronously
   * made four rapid deltas open four messages, and a short reply finalised
   * before any of them landed — so the reply was posted twice and the log said
   * "Response sent" instead of "Response finalised (streamed)".
   */
  it('tracks the in-flight first send so concurrent deltas do not race it', () => {
    expect(CLIENT).toContain('const liveOpening = new Map<string, Promise<void>>()');
    const update = CLIENT.slice(
      CLIENT.indexOf('export async function updateLiveResponse('),
      CLIENT.indexOf('export async function finishLiveResponse('),
    );
    // Registered before it is awaited, or a second delta still starts its own.
    expect(update.indexOf('liveOpening.set(jid, opening)')).toBeLessThan(
      update.indexOf('await opening'),
    );
    expect(update).toContain('await awaitLiveOpen(jid)');
  });

  it('settles and discards only after the opening send has landed', () => {
    for (const fn of ['finishLiveResponse', 'discardLiveResponse']) {
      const body = CLIENT.slice(CLIENT.indexOf(`export async function ${fn}(`));
      expect(body.indexOf('await awaitLiveOpen(jid)')).toBeLessThan(
        body.indexOf('liveMessages.get(jid)'),
      );
    }
  });

  it('feeds text deltas, not thinking deltas, into the reply', () => {
    const block = EVENTS.slice(EVENTS.indexOf('// ── Streaming reply'), EVENTS.indexOf('// ── Thinking blocks'));
    expect(block).toContain("=== 'text_delta'");
    expect(block).toContain('updateLiveResponse(jid, liveText)');
  });
});

/**
 * Streaming splits a long reply across messages incrementally, while a
 * non-streamed reply is split in one go by splitMessage. They must agree, or a
 * reply changes shape depending on whether it happened to be streamed.
 */
describe('streamed replies at the Discord character cap', () => {
  const MAX = 2000;

  function streamSplit(text: string): string[] {
    // Mirrors pushLive's loop: commit a head, advance `consumed`, continue.
    const out: string[] = [];
    let consumed = 0;
    let slice = text.slice(consumed);
    while (slice.length > MAX) {
      const head = splitMessage(slice, MAX)[0];
      out.push(head);
      consumed += liveConsumedBy(slice, head);
      slice = text.slice(consumed);
    }
    if (slice) out.push(slice);
    return out;
  }

  it('steps over the newline splitMessage swallows', () => {
    expect(liveConsumedBy('abc\ndef', 'abc')).toBe(4);
    // A hard split (no newline in range) consumes exactly the head.
    expect(liveConsumedBy('abcdef', 'abc')).toBe(3);
  });

  it('never leaves a continuation starting with a blank line', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    for (const chunk of streamSplit(text)) {
      expect(chunk.startsWith('\n')).toBe(false);
      expect(chunk.length).toBeLessThanOrEqual(MAX);
    }
  });

  it('produces exactly the same chunks as a non-streamed reply', () => {
    for (const text of [
      Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n'),
      'x'.repeat(6543), // no newline at all: hard splits
      `${'a'.repeat(1999)}\n${'b'.repeat(3000)}`,
    ]) {
      expect(streamSplit(text)).toEqual(splitMessage(text, MAX));
    }
  });

  it('drains a backlog longer than one message in a single push', () => {
    // Edits are throttled, so the reply can grow by several messages between
    // pushes; an `if` instead of a `while` would strand the overflow.
    const push = CLIENT.slice(CLIENT.indexOf('async function pushLive('));
    expect(push).toMatch(/while \(slice\.length > DISCORD_MAX_LENGTH\)/);
  });
});
