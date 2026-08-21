import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
    expect(send.slice(0, 400)).toContain('finishLiveResponse(jid, text)');
    // Must return early, or the reply lands twice.
    expect(send.slice(0, 400)).toMatch(/if \(await finishLiveResponse\(jid, text\)\) return true;/);
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
    expect(CLIENT).toContain('live.consumed += head.length');
    expect(CLIENT).toContain('DISCORD_MAX_LENGTH');
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
