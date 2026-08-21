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
    expect(CLIENT).toContain('live.message = await live.channel.send(next)');
  });

  it('drops the preview when a turn ends with nothing to say', () => {
    // An empty final text deletes the preview rather than leaving a
    // half-written sentence standing as the answer.
    const fin = CLIENT.slice(CLIENT.indexOf('export async function finishLiveResponse('));
    expect(fin).toMatch(/if \(!body\) \{[\s\S]*?for \(const message of live\.messages\) await message\.delete\(\)/);
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
    const deltas = EVENTS.indexOf('void enqueueLive()');
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
    expect(block).toContain('enqueueLive()');
  });

  /**
   * Regression: the `pending` chain exists so messages arrive in event order.
   * The streamed reply opens a real message, and sending it outside that chain
   * let it jump ahead of a thinking block whose send was still in flight — the
   * answer showed up above the thinking that produced it.
   */
  it('sends the reply through the same ordering queue as thinking and tools', () => {
    expect(EVENTS).toMatch(/const enqueueLive = \(\) => \{\s*pending = pending/);
    // No unserialized send may remain.
    expect(EVENTS).not.toContain('void updateLiveResponse(');
    const handler = EVENTS.slice(EVENTS.indexOf("=== 'text_delta'"));
    expect(handler.slice(0, 300)).toContain('enqueueLive()');
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

/**
 * A Discord message's position is fixed when it is created, but a streamed
 * reply keeps growing. In a multi-step turn (text, tool, thinking, more text)
 * the reply therefore opened above the thinking that came later in the same
 * turn, and the finished answer sat above the thinking that produced it.
 */
describe('ordering against thinking and tool messages', () => {
  it('seals the reply before each thinking or tool message', () => {
    const enqueue = EVENTS.slice(EVENTS.indexOf('const enqueueSend ='), EVENTS.indexOf('const enqueueLive ='));
    // Sealing must happen before the send, and on the same ordered chain.
    expect(enqueue.indexOf('sealLiveResponse(jid)')).toBeGreaterThan(enqueue.indexOf('pending = pending'));
    expect(enqueue.indexOf('sealLiveResponse(jid)')).toBeLessThan(enqueue.indexOf('sendResponse(jid, text'));
  });

  it('carries `consumed` across a seal so nothing is delivered twice', () => {
    const seal = CLIENT.slice(CLIENT.indexOf('export async function sealLiveResponse('));
    expect(seal.slice(0, 900)).toContain('sealed.consumed += sealed.shown.length');
    // The entry survives; only the message handle is dropped.
    expect(seal.slice(0, 900)).toContain('sealed.message = undefined');
    expect(seal.slice(0, 900)).not.toContain('liveMessages.delete');
  });

  it('flushes throttled text before sealing, or it would be lost', () => {
    const seal = CLIENT.slice(CLIENT.indexOf('export async function sealLiveResponse('));
    expect(seal.indexOf('pushLive(jid, live.latest)')).toBeLessThan(
      seal.indexOf('sealed.consumed +='),
    );
  });

  it('resumes into a new message below, not by editing the sealed one', () => {
    const open = CLIENT.slice(CLIENT.indexOf('async function openLive('));
    expect(open.slice(0, 900)).toContain('const consumed = existing?.consumed ?? 0');
    expect(open.slice(0, 900)).toContain('full.slice(consumed, consumed + DISCORD_MAX_LENGTH)');
  });

  it('sends the tail after the last seal instead of losing it', () => {
    const fin = CLIENT.slice(CLIENT.indexOf('export async function finishLiveResponse('));
    // Sealed => no message handle => the remainder needs a fresh message.
    expect(fin).toMatch(/} else if \(chunks\[0\]\) \{\s*\/\/[\s\S]*?await live\.channel\.send\(chunks\[0\]\);/);
  });
});

/**
 * Sealing splits one reply across several messages, so `consumed` is now the
 * only thing keeping the pieces from overlapping or leaving a hole. This
 * replays the real bookkeeping — grow, seal, resume, finalise — and reassembles
 * what the channel would hold.
 */
describe('reply integrity across seals', () => {
  const MAX = 2000;

  /**
   * Replays the real functions, including their refusals: pushLive writes
   * nothing while sealed, and openLive caps its first body at MAX.
   */
  function deliver(full: string, sealAfter: number[]): string[] {
    const messages: string[] = [];
    let consumed = 0;
    let shown: string | null = null; // null = sealed, or not yet open

    const openLive = (upTo: number) => {
      if (shown !== null) return;
      const body = full.slice(consumed, Math.min(upTo, consumed + MAX));
      if (!body.trim()) return;
      shown = body;
      messages.push(body);
    };

    const pushLive = (upTo: number) => {
      if (shown === null) return; // sealed: refuses to write
      let slice = full.slice(consumed, upTo);
      while (slice.length > MAX) {
        const head = splitMessage(slice, MAX)[0];
        messages[messages.length - 1] = head;
        consumed += liveConsumedBy(slice, head);
        slice = full.slice(consumed, upTo);
        shown = splitMessage(slice, MAX)[0] || '…';
        messages.push(shown);
      }
      if (slice === shown || !slice) return;
      shown = slice;
      messages[messages.length - 1] = shown;
    };

    for (const at of sealAfter) {
      openLive(at);
      pushLive(at);
      if (shown !== null) {
        consumed += (shown as string).length; // sealLiveResponse
        shown = null;
      }
    }
    openLive(full.length);
    pushLive(full.length);

    const rest = full.slice(consumed); // finishLiveResponse
    const chunks = rest.length > MAX ? splitMessage(rest, MAX) : [rest];
    if (shown !== null) messages[messages.length - 1] = chunks[0] || '…';
    else if (chunks[0]) messages.push(chunks[0]);
    messages.push(...chunks.slice(1));
    return messages.filter((m) => m !== '');
  }

  const REPLY = Array.from({ length: 300 }, (_, i) => `第 ${i} 行 ${'字'.repeat(15)}`).join('\n');

  it('delivers every character exactly once across seals', () => {
    // Compared without newlines: an overflow split drops the newline it split
    // on, while a seal drops nothing, so the two boundaries rejoin differently.
    // What must hold either way is that every character arrives exactly once.
    const delivered = deliver(REPLY, [500, 1200, 4000, 9000]).join('');
    expect(delivered.replace(/\n/g, '')).toBe(REPLY.replace(/\n/g, ''));
  });

  it('holds with no seals, and with a seal at every boundary', () => {
    const bare = REPLY.replace(/\n/g, '');
    expect(deliver(REPLY, []).join('').replace(/\n/g, '')).toBe(bare);
    const every = Array.from({ length: 20 }, (_, i) => (i + 1) * 400);
    expect(deliver(REPLY, every).join('').replace(/\n/g, '')).toBe(bare);
  });

  it('never emits a message over the Discord cap', () => {
    for (const m of deliver(REPLY, [500, 4000, 9000])) {
      expect(m.length).toBeLessThanOrEqual(MAX);
    }
  });

  it('does not re-send text that a sealed message already holds', () => {
    const messages = deliver(REPLY, [3000]);
    const first = messages[0];
    expect(messages.slice(1).some((m) => m.includes(first.slice(0, 200)))).toBe(false);
  });
});

/**
 * Measured on qwen3.6-35b through pi's RPC stream:
 *
 *   18:22:08.401  thinking_start
 *   18:22:08-11   thinking_delta x140
 *   18:22:11.475  text_start
 *   18:22:11.933  reply message created
 *   18:22:12.957  thinking_end   <- carries the text, same ms as text_end
 *
 * A Discord message's position is fixed when it is created, so posting the
 * thinking when its text finally arrived put it below a reply that had started
 * streaming three seconds earlier. thinking_start is the only early signal.
 */
describe('thinking blocks that resolve after the reply has started', () => {
  it('claims the position at thinking_start, before any text exists', () => {
    const block = EVENTS.slice(EVENTS.indexOf("=== 'thinking_start'"));
    expect(block.slice(0, 400)).toContain('openThinkingMessage(jid)');
    // On the ordered queue, like everything else that creates a message.
    expect(block.slice(0, 400)).toContain('pending = pending');
  });

  it('fills that message at thinking_end rather than sending a new one', () => {
    const block = EVENTS.slice(EVENTS.indexOf("=== 'thinking_end'"));
    expect(block).toContain('finishThinkingMessage(jid, rendered)');
    // Falls back to a plain send only when no reservation exists.
    expect(block).toMatch(/if \(await finishThinkingMessage\(jid, rendered\)\) return;/);
  });

  it('reserves before the reply, so no seal splits the answer', () => {
    // thinking_start precedes text_start, so the reply opens below the
    // reservation and nothing needs to be sealed for it.
    const start = EVENTS.indexOf("=== 'thinking_start'");
    const end = EVENTS.indexOf("=== 'thinking_end'");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(end);
  });

  it('removes a reservation whose content never arrived', () => {
    const QUEUE = readFileSync(resolve(__dirname, '../src/agent/queue.ts'), 'utf8');
    expect(QUEUE.match(/void discardThinkingMessage\(jid\);/g)?.length).toBe(2);
    expect(CLIENT).toContain('export async function discardThinkingMessage(');
  });

  it('keeps the reservation to one message per channel', () => {
    const open = CLIENT.slice(CLIENT.indexOf('export async function openThinkingMessage('));
    expect(open.slice(0, 300)).toContain('thinkingMessages.has(jid)');
  });
});

/**
 * `consumed` indexes the text that was STREAMED, but the text handed to
 * finishLiveResponse is produced separately by the queue. In a multi-run turn
 * — text, tool calls, more text — those are not the same string, and slicing
 * one by the other's offset re-sent a whole block of the answer into the
 * channel underneath the copy that was already there.
 */
describe('final text that differs from what was streamed', () => {
  it('checks the offset is meaningful before slicing by it', () => {
    const fin = CLIENT.slice(CLIENT.indexOf('export async function finishLiveResponse('));
    expect(fin).toContain('body.slice(0, live.consumed) !== streamed.slice(0, live.consumed)');
    // The check must precede the slice it guards.
    expect(fin.indexOf('streamed.slice(0, live.consumed)')).toBeLessThan(
      fin.indexOf('const rest = body.slice(live.consumed)'),
    );
  });

  it('withdraws the preview and defers to the normal send on a mismatch', () => {
    const fin = CLIENT.slice(CLIENT.indexOf('export async function finishLiveResponse('));
    const guard = fin.slice(fin.indexOf('withdrawing the preview'));
    expect(guard.slice(0, 300)).toContain('for (const message of live.messages) await message.delete()');
    // false => sendResponse posts the whole reply itself.
    expect(guard.slice(0, 300)).toContain('return false;');
  });

  it('keeps a handle on every message so all of them can be withdrawn', () => {
    expect(CLIENT).toContain('messages: Message[]');
    expect(CLIENT).toContain('live.messages.push(live.message)');
    // A resumed message joins the same list rather than starting a new one.
    expect(CLIENT).toContain('messages: [...(existing?.messages ?? []), message]');
  });
});

/**
 * Measured on a three-tool turn: streamed 505 chars, final 368, and the final
 * text was the TAIL of the stream — the queue hands back only the last run's
 * text while the stream carried every run. The reply is already complete on
 * screen, so re-sending the "final" text would duplicate the answer.
 */
describe('multi-run turns where the final text is the tail of the stream', () => {
  it('settles in place instead of re-sending the answer', () => {
    const fin = CLIENT.slice(CLIENT.indexOf('export async function finishLiveResponse('));
    const tail = fin.slice(fin.indexOf('streamed.trim().endsWith(body)'));
    expect(tail.slice(0, 400)).toContain('pushLive(jid, streamed)');
    expect(tail.slice(0, 400)).toContain('return true;');
    // It must not delete anything in this branch — the answer is on screen.
    expect(tail.slice(0, 400)).not.toContain('message.delete()');
  });

  it('checks the tail case before withdrawing anything', () => {
    const fin = CLIENT.slice(CLIENT.indexOf('export async function finishLiveResponse('));
    expect(fin.indexOf('streamed.trim().endsWith(body)')).toBeLessThan(
      fin.indexOf('withdrawing the preview'),
    );
  });

  it('keeps the entry alive until the flush has run', () => {
    const fin = CLIENT.slice(CLIENT.indexOf('export async function finishLiveResponse('));
    // Deleting on entry would make the flush a no-op: pushLive reads the map.
    expect(fin.indexOf('pushLive(jid, streamed)')).toBeLessThan(
      fin.indexOf('liveMessages.delete(jid)'),
    );
    expect(fin).toMatch(/} finally \{[\s\S]*?liveMessages\.delete\(jid\);/);
  });

  it('blocks updates that arrive after the reply was settled', () => {
    expect(CLIENT).toContain('const liveClosed = new Set<string>()');
    const update = CLIENT.slice(CLIENT.indexOf('export async function updateLiveResponse('));
    expect(update.slice(0, 200)).toContain('liveClosed.has(jid)');
    // And a new turn must clear it, or streaming stops after the first reply.
    expect(CLIENT).toContain('export function beginLiveResponse(');
    expect(EVENTS).toContain('beginLiveResponse(jid)');
  });
});
