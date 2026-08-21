/**
 * Live-stream pi's intermediate session events into a Discord channel.
 *
 * pi emits a JSON event per line in `--mode json` — thinking blocks, tool
 * calls, tool results, turn boundaries. We forward the human-interesting ones
 * (gated by config) as separate Discord messages so the user can watch the
 * agent's reasoning and actions in real time inside its auto-thread.
 *
 * The FINAL assistant text is NOT streamed from here — it flows through the
 * caller's existing outbox/marker path so attachments keep working.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  beginLiveResponse,
  finishThinkingMessage,
  updateThinkingMessage,
  openThinkingMessage,
  sealLiveResponse,
  sendResponse,
  updateLiveResponse,
} from './client.js';

/** Discord caps a single message at 2000 chars. We leave headroom for the prefix. */
function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap - 3) + '...';
}

/** Tag-pretty a tool argument summary; values get squashed to one line. */
function summarizeToolArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args.replace(/\s+/g, ' ').slice(0, 200);
  try {
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 197) + '...' : s;
  } catch {
    return String(args).slice(0, 200);
  }
}

/**
 * Build a per-jid event handler. The returned function is meant to be passed
 * to `invokeAgent` as `onEvent`. It is async-but-fire-and-forget on Discord
 * sends so it never back-pressures pi.
 */
export function createEventStreamer(
  jid: string,
  options: { enabled?: boolean } = {},
): (event: any) => Promise<void> {
  // Serialize Discord sends per channel so messages arrive in event order
  // even when pi emits faster than the Discord API can accept.
  let pending: Promise<void> = Promise.resolve();
  const enqueueSend = (text: string) => {
    pending = pending
      // Seal first: a message's position is fixed when it is created, so the
      // reply written so far must stop growing before this one goes below it,
      // or the finished answer ends up above the thinking that produced it.
      .then(() => sealLiveResponse(jid))
      // settleLive: false — these are thinking/tool messages, not the answer,
      // and must never take over the streamed reply's message.
      .then(() => sendResponse(jid, text, { settleLive: false }).then(() => undefined))
      .catch((err) => logger.warn({ err: err?.message, jid }, 'stream-events: send failed'));
    return pending;
  };

  /**
   * The streamed reply goes through the SAME queue as thinking and tool
   * messages. It opens a real Discord message, so leaving it unserialized let
   * it jump ahead of a thinking block whose send was still in flight — the
   * answer appeared above the thinking that produced it.
   *
   * Throttled edits return immediately after arming a timer, so this does not
   * hold up the queue; only the first send, which is the one that fixes the
   * message's position in the channel, is actually waited on.
   */
  const enqueueLive = () => {
    pending = pending
      .then(() => updateLiveResponse(jid, liveText))
      .catch((err) => logger.warn({ err: err?.message, jid }, 'stream-events: live update failed'));
    return pending;
  };

  // A new turn: re-open streaming for this channel (see beginLiveResponse).
  beginLiveResponse(jid);

  // The reasoning as it is being written, and how it renders in Discord:
  // a quote block, so it shows as an indented grey aside.
  let thinkingText = '';
  const renderThinking = (text: string) =>
    `💭 *Thinking:*\n${truncate(text, config.maxEventChars - 50)
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')}`;

  // The reply as it is being written. Buffered here and pushed into the live
  // Discord message, which sendResponse later finalises in place.
  let liveText = '';

  return async (event: any) => {
    if (options.enabled === false || !event || typeof event !== 'object') return;

    // ── Streaming reply ─────────────────────────────────────────────────
    // Discord has no server-push, so the reply is streamed by editing one
    // message as it grows; updateLiveResponse throttles those edits.
    if (
      config.streamPartialText &&
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'text_delta'
    ) {
      liveText += String(event.assistantMessageEvent.delta ?? '');
      void enqueueLive();
      return;
    }

    // No turn-boundary handling here on purpose. `agent_end` closes one
    // low-level run and `turn_end` follows it, so any such branch runs several
    // times per user turn: an earlier version reset `liveText` on the first and
    // then, seeing it empty on the second, deleted the streamed message — so
    // sendResponse found nothing to settle and posted the reply as a fresh one.
    // This closure is built per message (queue.ts), so `liveText` is already
    // per-turn, and an empty turn is cleaned up by finishLiveResponse.

    // ── Thinking blocks ─────────────────────────────────────────────────
    // `thinking_start` fires as soon as the model begins reasoning, but the
    // text only arrives on `thinking_end`, which pi emits when the whole
    // assistant message completes — seconds after the reply started streaming.
    // Claim the position now, on the same ordered queue as everything else, and
    // fill it in below.
    if (
      config.streamThinking &&
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'thinking_start'
    ) {
      thinkingText = '';
      pending = pending
        .then(() => sealLiveResponse(jid))
        .then(() => openThinkingMessage(jid))
        .catch((err) => logger.warn({ err: err?.message, jid }, 'stream-events: reserve failed'));
      return;
    }
    // Fill the reserved message as the reasoning is written, so it is not
    // still saying "Thinking…" while the answer streams below it.
    if (
      config.streamThinking &&
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'thinking_delta'
    ) {
      const ev = event.assistantMessageEvent;
      // `delta` is incremental; some providers send a cumulative `content`
      // instead, which must replace rather than append.
      if (typeof ev.delta === 'string') thinkingText += ev.delta;
      else if (typeof ev.content === 'string') thinkingText = ev.content;
      else return;
      const rendered = renderThinking(thinkingText);
      pending = pending
        .then(() => updateThinkingMessage(jid, rendered))
        .catch((err) => logger.warn({ err: err?.message, jid }, 'stream-events: thinking update failed'));
      return;
    }

    // ── Thinking blocks ─────────────────────────────────────────────────
    // Each turn's thinking arrives as `*_start` / `*_delta` / `*_end`. We
    // fire only on `_end` (one Discord message per thinking block, not per
    // token), using the authoritative `content` field on the end event.
    if (
      config.streamThinking &&
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'thinking_end'
    ) {
      const text = String(event.assistantMessageEvent.content ?? '').trim();
      if (text) {
        const rendered = renderThinking(text);
        // Fill the message reserved at thinking_start; only fall back to
        // sending a new one if there was none (reservation failed, or the
        // provider emits no thinking_start).
        pending = pending
          .then(async () => {
            if (await finishThinkingMessage(jid, rendered)) return;
            await sealLiveResponse(jid);
            await sendResponse(jid, rendered, { settleLive: false });
          })
          .catch((err) => logger.warn({ err: err?.message, jid }, 'stream-events: send failed'));
      }
      return;
    }

    // ── Tool calls (when the assistant decides to invoke a tool) ────────
    // pi-ai's actual event type is `toolcall_end` (single word, not
    // `tool_call_end`). The end event carries the fully resolved ToolCall
    // object: `{ id, name, arguments, ... }`.
    if (
      config.streamTools &&
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'toolcall_end'
    ) {
      const tc = event.assistantMessageEvent.toolCall ?? {};
      const name = tc.name || 'tool';
      const argSummary = summarizeToolArgs(tc.arguments);
      const body = argSummary ? `\`${name}\` ${argSummary}` : `\`${name}\``;
      enqueueSend(truncate(`🔧 ${body}`, config.maxEventChars));
      return;
    }

    // ── Tool results — arrive as their own message (role=tool) after the
    // assistant's toolcall completes. Each content block is a ToolResult
    // referencing the originating tool by id; we forward the textual output.
    if (config.streamTools && event.type === 'message_end' && event.message?.role === 'tool') {
      const parts = event.message.content ?? [];
      const text = parts
        .map((c: any) => {
          // ToolResult content can be a string, an array of TextContent, or
          // an object with `.text` — be defensive.
          if (typeof c?.content === 'string') return c.content;
          if (Array.isArray(c?.content)) return c.content.map((p: any) => p?.text ?? '').join('\n');
          return c?.text ?? '';
        })
        .join('\n')
        .trim();
      if (text) {
        enqueueSend(truncate(`📤 ${text}`, config.maxEventChars));
      }
      return;
    }

    // Everything else (session header, agent_start/end, turn_*, text_*,
    // message_start/end, deltas, …) we intentionally don't surface — text
    // is delivered by the caller's normal final-response path; the rest is
    // bookkeeping. Log at debug for future expansion.
    if (event.type) {
      logger.debug(
        { jid, type: event.type, sub: event.assistantMessageEvent?.type },
        'stream-events: unhandled',
      );
    }
  };
}
