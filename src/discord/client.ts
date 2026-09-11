/**
 * Discord channel adapter.
 *
 * Architecture borrowed from NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Handles all Discord I/O: receiving messages, sending responses, typing indicators.
 * Contains zero business logic — that lives in the pi agent.
 */

import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Interaction,
  type Message,
  type TextChannel,
  type DMChannel,
} from 'discord.js';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { type RegisteredChannel } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  createDmChannel,
  getChannel,
  registerChannel as dbRegisterChannel,
  enqueueMessage,
} from '../db.js';
import {
  buildAttachmentOnlyPrompt,
  selectAttachmentsWithinLimits,
  type AttachmentMeta,
} from './attachments.js';
import { handleAutocomplete, handleChatCommand, registerGlobalCommands } from './slash-commands.js';
import { isChannelProcessing, interruptChannelTask } from '../agent/queue.js';
import { persistAndSteerMessage } from '../agent/durable-steer.js';
import { rpcSessionIsStreaming } from '../agent/rpc-session.js';
import { formatAttachmentTooLargeNotice, isAttachmentTooLargeError } from './send.js';
import { startGpuPresenceMonitor, stopGpuPresenceMonitor } from './gpu-monitor.js';
import { executePiExtensionCommand } from '../agent/extension-runner.js';

let client: Client | null = null;
let triggerPattern: RegExp;
let botId: string;

export async function startDiscord(): Promise<void> {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Required for DM message events in discord.js.
    partials: [Partials.Channel],
  });

  client.on(Events.MessageCreate, handleMessage);
  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.Error, (err) => logger.error({ err: err.message }, 'Discord client error'));

  return new Promise<void>((resolve, reject) => {
    const onReady = async (ready: Client<true>) => {
      cleanup();
      botId = ready.user.id;

      // Build a trigger pattern that matches @pi, @pi-agent, or any guild nicknames
      const names = [config.triggerName, ready.user.username];
      for (const guild of ready.guilds.cache.values()) {
        const me = guild.members.me;
        if (me?.nickname) {
          names.push(me.nickname);
        }
      }
      const uniqueNames = [...new Set(names)].filter(Boolean);
      const namePattern = uniqueNames
        .map(escapeRegExp)
        .sort((a, b) => b.length - a.length)
        .join('|');
      triggerPattern = new RegExp(`^@(?:${namePattern})\\b`, 'i');

      logger.info(
        { tag: ready.user.tag, id: botId, triggerPattern: triggerPattern.toString() },
        'Discord bot connected',
      );

      try {
        await registerGlobalCommands(ready);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to register global slash commands');
      }

      if (config.gpuPresenceEnabled) {
        startGpuPresenceMonitor(ready, config.gpuPresenceIntervalSec);
      }

      resolve();
    };

    const onStartupError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      client?.off(Events.ClientReady, onReady);
      client?.off(Events.Error, onStartupError);
    };

    client!.once(Events.ClientReady, onReady);
    client!.once(Events.Error, onStartupError);
    client!.login(config.discordToken).catch(onStartupError);
  });
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleChatCommand(interaction);
    }
  } catch (err: any) {
    logger.error({ err: err.message, id: interaction.id }, 'Interaction handler failed');
  }
}

async function handleMessage(message: Message): Promise<void> {
  // Ignore our own messages only. Other bots are allowed to @-tag us so that
  // bot-to-bot handoffs (e.g. notifiers, webhooks) can drive a response —
  // the trigger check below stops random bot chatter from being processed.
  if (message.author.id === botId) return;

  const isDM = !message.guild;
  const channelId = message.channelId;
  const jid = `dc:${channelId}`;

  // ── Build content ──
  let content = message.content;
  const senderName =
    message.member?.displayName || message.author.displayName || message.author.username;
  const sender = message.author.id;
  const timestamp = message.createdAt.toISOString();

  // Translate @bot mentions / role mentions → trigger format
  if (client?.user) {
    const hasUserMention =
      message.mentions.users.has(botId) ||
      content.includes(`<@${botId}>`) ||
      content.includes(`<@!${botId}>`);

    const hasRoleMention = message.guild
      ? message.mentions.roles.some((role) => {
          const me = message.guild?.members.me;
          return me?.roles.cache.has(role.id) ?? false;
        })
      : false;

    const isMentioned = hasUserMention || hasRoleMention;

    if (isMentioned) {
      // Strip user mention
      content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();

      // Strip bot role mentions
      if (message.guild) {
        const me = message.guild.members.me;
        if (me) {
          for (const roleId of me.roles.cache.keys()) {
            content = content.replace(new RegExp(`<@&${roleId}>`, 'g'), '').trim();
          }
        }
      }

      if (!triggerPattern.test(content)) {
        content = `@${config.triggerName} ${content}`;
      }
    }
  }

  // Attachments → extract metadata for downstream download
  let acceptedAttachments: AttachmentMeta[] = [];
  let attachmentsJson: string | null = null;
  if (message.attachments.size > 0) {
    const metas: AttachmentMeta[] = [...message.attachments.values()].map((att) => ({
      url: att.url,
      name: att.name || 'file',
      contentType: att.contentType || '',
      size: att.size || 0,
    }));

    const selection = selectAttachmentsWithinLimits(metas, {
      maxFileBytes: config.maxAttachmentBytes,
      maxTotalBytes: config.maxTotalAttachmentBytes,
    });

    acceptedAttachments = selection.accepted;
    if (selection.rejected.length > 0) {
      logger.info(
        {
          jid,
          skipped: selection.rejected.map(({ attachment, reason, limitBytes }) => ({
            name: attachment.name,
            size: attachment.size,
            reason,
            limitBytes,
          })),
        },
        'Skipped oversized Discord attachments before enqueue',
      );
    }

    if (acceptedAttachments.length > 0) {
      attachmentsJson = JSON.stringify(acceptedAttachments);
    }
  }

  // Reply context
  if (message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      const refAuthor = ref.member?.displayName || ref.author.displayName || ref.author.username;
      content = `[Reply to ${refAuthor}] ${content}`;
    } catch {
      // deleted message
    }
  }

  // ── Channel registration check ──
  let channel = getChannel(jid);

  // Auto-register DMs
  if (!channel && isDM && config.autoRegisterDMs) {
    const reg = createDmChannel(jid, sender, senderName);
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, senderName }, 'Auto-registered DM channel');
  }

  // Auto-register guild channels based on policy
  if (!channel && !isDM && config.channelPolicy !== 'allowlist') {
    if (config.excludedChannels.has(channelId)) {
      return;
    }

    const guildName = message.guild?.name || 'Unknown';
    const channelName = (message.channel as TextChannel).name || 'unknown';
    const name = `${guildName} #${channelName}`;
    const reg: RegisteredChannel = {
      jid,
      name,
      folder: `ch_${channelId}`,
      requiresTrigger: config.channelPolicy === 'open-trigger',
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
      thinkingToolStatusEnabled: true,
    };
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, name, policy: config.channelPolicy }, 'Auto-registered guild channel');
  }

  if (!channel) {
    logger.debug({ jid }, 'Message from unregistered channel, ignoring');
    return;
  }

  // ── Trigger check ──
  // `alwaysRequireTrigger` forces the prefix for guild channels and threads,
  // but DMs (1-on-1 personal context) are exempt unless channel-specific policy requires it.
  const mustTrigger =
    channel.requiresTrigger || (config.alwaysRequireTrigger && !isDM);
  if (mustTrigger && !triggerPattern.test(content)) {
    logger.debug({ jid }, 'Message does not match trigger, ignoring');
    return;
  }

  // Strip trigger prefix from content sent to agent
  content = content.replace(triggerPattern, '').trim();
  if (!content && acceptedAttachments.length > 0) {
    content = buildAttachmentOnlyPrompt(acceptedAttachments.length);
  }
  if (!content) return;

  // ── Direct extension slash command interception (e.g. /kv status) ──
  if (content.startsWith('/kv')) {
    const parts = content.slice(1).trim().split(/\s+/);
    const cmd = parts.slice(0, 2).join(' ');
    const rest = parts.slice(2).join(' ');
    const args: Record<string, string> = {};
    if (rest) args.name = rest;

    try {
      if ('sendTyping' in message.channel) {
        await message.channel.sendTyping();
      }
      const result = await executePiExtensionCommand(channel, cmd, args);
      const text = result.text || (result.ok ? '✅ Done.' : '⚠️ Command failed.');
      const formatted = text.length > 1950 ? text.slice(0, 1950) + '\n...(truncated)' : text;
      await message.reply(formatted);
    } catch (err: any) {
      await message.reply(`⚠️ ${err.message}`);
    }
    return;
  }

  // ── Auto-thread ──
  // When enabled, a triggering message in a top-level guild text channel spins
  // up a thread off that message; the conversation is then routed into the
  // thread (registered without a trigger requirement so follow-ups flow freely).
  // Already-in-thread messages and DMs fall through unchanged.
  let targetJid = jid;
  if (config.autoThread && !isDM && !message.channel.isThread()) {
    targetJid =
      (await openAutoThread(message, channel, buildThreadName(senderName, content))) ?? jid;
  }

  // ── Steer (RPC mode) ──
  // With a persistent RPC session, a message that arrives mid-turn is steered
  // INTO the running turn (redirect the agent in-flight) rather than killing it.
  // Persist the steered message before injection. If the RPC process dies,
  // its row is returned to pending and the normal queue will replay it.
  // Attachments remain on the normal queue because RPC steer currently carries text only.
  const targetFolder = getChannel(targetJid)?.folder;
  if (
    config.rpcSteer &&
    targetFolder &&
    acceptedAttachments.length === 0 &&
    rpcSessionIsStreaming(targetFolder)
  ) {
    const steerText = `[Discord user: ${senderName}]\n${content}`;
    const steered = persistAndSteerMessage(targetFolder, steerText, {
      channelJid: targetJid,
      sender,
      senderName,
      content,
      timestamp,
      attachments: attachmentsJson,
    });
    if (steered) {
      logger.info({ jid: targetJid }, 'Persisted and steered new message into in-flight turn');
      try {
        await message.react('⏩');
      } catch {
        // reaction is best-effort; ignore permission errors
      }
    } else {
      logger.info({ jid: targetJid }, 'RPC turn settled during steering; message left pending');
    }
    return;
  }

  // ── Interrupt (print mode) ──
  // If pi is still working on an earlier message in this channel, a fresh user
  // message pre-empts it: stop the in-flight run ("pi stop") and let the new
  // message be processed next. Acknowledge with `interrupt` only when an actual
  // run was interrupted (the new message is enqueued below either way).
  if (config.interruptOnNewMessage && isChannelProcessing(targetJid)) {
    if (interruptChannelTask(targetJid)) {
      logger.info({ jid: targetJid }, 'Interrupted in-flight run for new message');
      try {
        await message.reply('interrupt');
      } catch (err: any) {
        logger.warn({ jid: targetJid, err: err.message }, 'Failed to send interrupt acknowledgement');
      }
    }
  }

  // ── Enqueue ──
  enqueueMessage({
    channelJid: targetJid,
    sender,
    senderName,
    content,
    timestamp,
    attachments: attachmentsJson,
  });
  logger.info(
    { jid: targetJid, sender: senderName, len: content.length },
    'Message enqueued',
  );
}

// ── Outbound ──

const DISCORD_MAX_LENGTH = 2000;

/**
 * Live (streaming) reply.
 *
 * Discord has no server-push, so "streaming" means editing one message as the
 * text grows. Edits are rate limited per channel, so they are throttled rather
 * than sent per token — pi emits hundreds of deltas per reply and an unthrottled
 * edit loop would be throttled into arriving *later* than a single send.
 *
 * The streamed message becomes the real reply: sendResponse finalises it with
 * an edit instead of posting a second copy.
 */
const LIVE_EDIT_MS = 1500;

interface LiveMessage {
  /** The message being written into. Undefined once sealed (see below). */
  message?: Message;
  /** Every message this reply created, so a bad preview can be withdrawn. */
  messages: Message[];
  channel: TextChannel | DMChannel;
  /** Text already committed to `message`. */
  shown: string;
  /** The whole reply as of the last update, so a seal can flush it. */
  latest: string;
  /** Characters of the reply that earlier, finished messages consumed. */
  consumed: number;
  lastEditAt: number;
  timer?: NodeJS.Timeout;
}

const liveMessages = new Map<string, LiveMessage>();

/**
 * Opening a message is async, but callers fire-and-forget one update per delta
 * and finishLiveResponse reads the map synchronously. Without a handle on the
 * in-flight open, rapid deltas each saw an empty map and a short reply
 * finalised before any send landed, so the reply was posted twice.
 */
const liveOpening = new Map<string, Promise<void>>();

/**
 * Turns whose reply has already been settled. The streamer feeds updates
 * through its own queue while the queue module finalises off it, so an update
 * can still be in flight when the reply is delivered — it would open a fresh
 * message that nothing ever finalises, leaving a stray half-reply in the
 * channel next to the real one.
 */
const liveClosed = new Set<string>();

/** Start a turn: allow streaming into this channel again. */
export function beginLiveResponse(jid: string): void {
  liveClosed.delete(jid);
}

/**
 * How many characters of the source a committed message accounts for.
 *
 * splitMessage swallows the newline it splits on, so the head is one character
 * shorter than what it consumed. Counting only `head.length` left that newline
 * at the front of the next slice: every continuation message opened with a
 * blank line, and the offset drifted further with each one.
 */
export function liveConsumedBy(slice: string, head: string): number {
  return head.length + (slice[head.length] === '\n' ? 1 : 0);
}

/** Text that belongs in the current message, given what earlier ones took. */
function liveSlice(live: LiveMessage, full: string): string {
  return full.slice(live.consumed);
}

async function pushLive(jid: string, full: string): Promise<void> {
  const live = liveMessages.get(jid);
  if (!live?.message) return;

  let slice = liveSlice(live, full);

  // The current message is full: commit it at a line boundary and continue in a
  // new one, so a long reply streams across several messages like a normal
  // split reply rather than stopping at 2000 characters. Only ever a message
  // this module opened is edited — never anything else in the channel.
  //
  // A loop, not an `if`: edits are throttled, so between two pushes the reply
  // can grow by more than one message's worth and a single continuation would
  // leave the overflow unsent until the next tick.
  while (slice.length > DISCORD_MAX_LENGTH) {
    const head = splitMessage(slice, DISCORD_MAX_LENGTH)[0];
    try {
      await live.message.edit(head);
    } catch (err: any) {
      logger.warn({ jid, err: err.message }, 'live: final edit of full message failed');
    }
    live.consumed += liveConsumedBy(slice, head);
    slice = liveSlice(live, full);
    const next = splitMessage(slice, DISCORD_MAX_LENGTH)[0] || '…';
    live.message = await live.channel.send(next);
    live.messages.push(live.message);
    live.shown = next;
    live.lastEditAt = Date.now();
  }

  if (slice === live.shown || !slice) return;
  await live.message.edit(slice);
  live.shown = slice;
  live.lastEditAt = Date.now();
}

/** Open the message the reply is written into, resuming after a seal. */
async function openLive(jid: string, full: string): Promise<void> {
  const existing = liveMessages.get(jid);
  const channelId = jid.replace(/^dc:/, '');
  try {
    let channel = existing?.channel;
    if (!channel) {
      const fetched = await client!.channels.fetch(channelId);
      if (!fetched || !('send' in fetched)) return;
      channel = fetched as TextChannel | DMChannel;
    }
    const consumed = existing?.consumed ?? 0;
    const body = full.slice(consumed, consumed + DISCORD_MAX_LENGTH);
    if (!body.trim()) return;
    const message = await channel.send(body);
    logger.info({ jid, resumed: Boolean(existing) }, 'Streaming reply opened');
    liveMessages.set(jid, {
      message,
      messages: [...(existing?.messages ?? []), message],
      channel,
      shown: body,
      latest: full,
      consumed,
      lastEditAt: Date.now(),
    });
  } catch (err: any) {
    logger.warn({ jid, err: err.message }, 'live: could not open streaming message');
  }
}

/** Resolve once any in-flight message send has settled. */
async function awaitLiveOpen(jid: string): Promise<void> {
  await liveOpening.get(jid)?.catch(() => undefined);
}

/** Feed the growing reply. Safe to call per delta; edits are throttled. */
export async function updateLiveResponse(jid: string, full: string): Promise<void> {
  if (!client || !full.trim() || liveClosed.has(jid)) return;

  const known = liveMessages.get(jid);
  if (known) known.latest = full;

  if (!known?.message) {
    let opening = liveOpening.get(jid);
    if (!opening) {
      opening = openLive(jid, full);
      liveOpening.set(jid, opening);
      // The opening message already carries `full` as of this delta; later
      // deltas fall through below and edit it with their newer text.
      await opening.finally(() => {
        if (liveOpening.get(jid) === opening) liveOpening.delete(jid);
      });
      return;
    }
    await awaitLiveOpen(jid);
  }

  const live = liveMessages.get(jid);
  if (!live?.message) return;

  const wait = LIVE_EDIT_MS - (Date.now() - live.lastEditAt);
  if (wait > 0) {
    // Coalesce: keep only the newest text, one pending edit per channel.
    if (live.timer) clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      const current = liveMessages.get(jid);
      if (!current) return;
      current.timer = undefined;
      void pushLive(jid, full).catch((err) =>
        logger.warn({ jid, err: err?.message }, 'live: throttled edit failed'),
      );
    }, wait);
    live.timer.unref?.();
    return;
  }

  await pushLive(jid, full).catch((err) =>
    logger.warn({ jid, err: err?.message }, 'live: edit failed'),
  );
}

/**
 * Stop writing into the current message, without ending the reply.
 *
 * A Discord message's position is fixed when it is created, but a streamed
 * reply keeps growing. In a multi-step turn the reply therefore opened before
 * the tool calls and thinking that came later in the SAME turn, and the
 * finished answer ended up sitting above the thinking that produced it.
 *
 * Sealing before each of those messages keeps the channel chronological: what
 * was written so far stays put, and the next tokens open a fresh message below
 * the thinking. `consumed` carries across, so nothing is delivered twice.
 */
export async function sealLiveResponse(jid: string): Promise<void> {
  await awaitLiveOpen(jid);
  const live = liveMessages.get(jid);
  if (!live?.message) return;

  if (live.timer) {
    clearTimeout(live.timer);
    live.timer = undefined;
  }
  // Flush whatever the throttle was still holding back, or it would be lost.
  await pushLive(jid, live.latest).catch((err) =>
    logger.warn({ jid, err: err?.message }, 'live: flush before seal failed'),
  );

  const sealed = liveMessages.get(jid);
  if (!sealed?.message) return;
  sealed.consumed += sealed.shown.length;
  sealed.shown = '';
  sealed.message = undefined;
}

/**
 * Settle the streamed message on the final text.
 *
 * Returns true when it delivered the reply, so the caller must not send it
 * again. Any text beyond what the streamed messages hold is sent as follow-ups.
 */
/**
 * Send whatever of `text` has not been committed to a message yet.
 *
 * Used by both finish paths. It must not go through pushLive: that refuses to
 * write while the reply is sealed, so a reply sealed by a trailing tool message
 * silently lost everything after the seal — the answer just stopped mid-word.
 */
async function deliverRemainder(live: LiveMessage, text: string): Promise<void> {
  const rest = text.slice(live.consumed);
  // Invariant: what earlier messages took, plus what is left, is the whole
  // reply. Both truncation bugs in this file showed up here first — an offset
  // advanced against a different string leaves a hole no test would notice,
  // because the reply still *looks* finished.
  if (live.consumed + rest.length !== text.length) {
    logger.warn(
      { consumed: live.consumed, rest: rest.length, total: text.length },
      'live: reply accounting does not cover the text; some of it will be missing',
    );
  }
  if (!rest) return;
  const chunks = rest.length > DISCORD_MAX_LENGTH ? splitMessage(rest, DISCORD_MAX_LENGTH) : [rest];
  // Never fall back to a placeholder here: editing a message to "…" would
  // replace the text it is already showing.
  if (live.message) {
    if (chunks[0]) await live.message.edit(chunks[0]);
  } else if (chunks[0]) {
    // Sealed: the tail after the last thinking or tool message needs its own.
    await live.channel.send(chunks[0]);
  }
  for (const chunk of chunks.slice(1)) {
    await live.channel.send(chunk);
  }
}

export async function finishLiveResponse(jid: string, finalText: string): Promise<boolean> {
  await awaitLiveOpen(jid);
  const live = liveMessages.get(jid);
  if (!live) return false;
  // Claim it synchronously. A turn can call sendResponse more than once (one
  // per run), and while the delete waited in a `finally` the second call saw
  // the first reply's entry: it inherited a `consumed` past the end of its own
  // text, so the remainder computed empty and the answer was silently dropped.
  // Safe to delete now — delivery below works off `live`, not the map.
  liveMessages.delete(jid);
  liveClosed.add(jid);
  if (live.timer) clearTimeout(live.timer);

  const body = finalText?.trim() ?? '';
  try {
    if (!body) {
      // The turn produced nothing deliverable; drop the preview rather than
      // leaving a half-written sentence as the reply. Every message, not just
      // the open one — a sealed reply has already spilled into several.
      for (const message of live.messages) await message.delete().catch(() => undefined);
      return false;
    }

    // `consumed` indexes the STREAMED text, but `finalText` is produced
    // separately by the queue. In a multi-run turn (text, tools, more text)
    // those are not the same string, and slicing one by the other's offset
    // re-sent a whole block of the answer beneath the copy already there.
    const streamed = live.latest;
    if (
      live.consumed > body.length ||
      body.slice(0, live.consumed) !== streamed.slice(0, live.consumed)
    ) {
      // The usual reason: the queue hands back only the last run's text while
      // the stream carried every run, so the reply is already complete on
      // screen and the "final" text is its tail. Measured: streamed 505 chars,
      // final 368, finalIsTail true. Flush and settle; re-sending would
      // duplicate the answer.
      // `consumed` and `latest` are two views of the same stream and they can
      // drift: measured on a three-run turn, consumed reached 5390 — the true
      // total streamed — while latest held only the last 4492. Trusting the
      // offset there computed an empty remainder and silently swallowed the
      // end of the answer. Only take this path when the offset actually
      // indexes the text; otherwise fall through and repost in full.
      if (streamed.trim().endsWith(body) && live.consumed <= streamed.length) {
        await deliverRemainder(live, streamed);
        logger.info({ jid, length: streamed.length }, 'Response finalised (streamed in full)');
        return true;
      }
      logger.warn(
        { jid, consumed: live.consumed, streamed: streamed.length, final: body.length },
        'live: streamed text is unrelated to the final reply, withdrawing the preview',
      );
      for (const message of live.messages) await message.delete().catch(() => undefined);
      return false; // the caller posts the whole reply normally
    }

    await deliverRemainder(live, body);
    logger.info({ jid, length: body.length }, 'Response finalised (streamed)');
    return true;
  } catch (err: any) {
    logger.warn({ jid, err: err.message }, 'live: finalise failed, falling back to a new message');
    return false;
  }
}

/** Drop a streamed message without finalising it (abort, error, empty turn). */
export async function discardLiveResponse(jid: string): Promise<void> {
  await awaitLiveOpen(jid);
  const live = liveMessages.get(jid);
  if (!live) return;
  liveClosed.add(jid);
  liveMessages.delete(jid);
  if (live.timer) clearTimeout(live.timer);
  for (const message of live.messages) await message.delete().catch(() => undefined);
}

/**
 * The thinking block's message, reserved before its content exists.
 *
 * pi emits `thinking_start` as soon as the model begins reasoning but only
 * emits `thinking_end` — the event carrying the text — when the whole assistant
 * message completes, at the same millisecond as `text_end`. Measured on
 * qwen3.6-35b: thinking_start at 18:22:08.401, text_start at 18:22:11.475,
 * thinking_end at 18:22:12.957.
 *
 * A Discord message's position is fixed when it is created, so posting the
 * thinking only once its text arrived put it below a reply that had started
 * streaming three seconds earlier. Posting a placeholder at `thinking_start`
 * claims the position while the reply is still unwritten, and the content is
 * edited in later.
 */
interface ThinkingMessage {
  message: Message;
  shown: string;
  lastEditAt: number;
  timer?: NodeJS.Timeout;
}

const thinkingMessages = new Map<string, ThinkingMessage>();

/** Claim the thinking block's position in the channel. */
export async function openThinkingMessage(jid: string): Promise<void> {
  if (!client || thinkingMessages.has(jid)) return;
  try {
    const channel = await client.channels.fetch(jid.replace(/^dc:/, ''));
    if (!channel || !('send' in channel)) return;
    const shown = '💭 *Thinking…*';
    const message = await (channel as TextChannel | DMChannel).send(shown);
    thinkingMessages.set(jid, { message, shown, lastEditAt: Date.now() });
  } catch (err: any) {
    logger.warn({ jid, err: err.message }, 'live: could not reserve the thinking message');
  }
}

async function pushThinking(jid: string, rendered: string): Promise<void> {
  const live = thinkingMessages.get(jid);
  if (!live || rendered === live.shown) return;
  await live.message.edit(rendered.slice(0, DISCORD_MAX_LENGTH));
  live.shown = rendered;
  live.lastEditAt = Date.now();
}

/**
 * Fill the reserved message as the reasoning is written.
 *
 * Without this the placeholder sat unchanged until `thinking_end`, which pi
 * only emits when the whole assistant message completes — so the thinking
 * appeared to update after the answer it produced had already been written.
 * The deltas arrive throughout, so the block can fill in as it is thought.
 */
export async function updateThinkingMessage(jid: string, rendered: string): Promise<void> {
  const live = thinkingMessages.get(jid);
  if (!live || !rendered.trim() || rendered === live.shown) return;

  const wait = LIVE_EDIT_MS - (Date.now() - live.lastEditAt);
  if (wait > 0) {
    if (live.timer) clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      const current = thinkingMessages.get(jid);
      if (!current) return;
      current.timer = undefined;
      void pushThinking(jid, rendered).catch((err) =>
        logger.warn({ jid, err: err?.message }, 'live: throttled thinking edit failed'),
      );
    }, wait);
    live.timer.unref?.();
    return;
  }

  await pushThinking(jid, rendered).catch((err) =>
    logger.warn({ jid, err: err?.message }, 'live: thinking edit failed'),
  );
}

/**
 * Fill in the reserved thinking message. Returns false when there is none, so
 * the caller can fall back to sending it as a normal message.
 */
export async function finishThinkingMessage(jid: string, text: string): Promise<boolean> {
  const live = thinkingMessages.get(jid);
  if (!live) return false;
  thinkingMessages.delete(jid);
  if (live.timer) clearTimeout(live.timer);
  try {
    await live.message.edit(text.slice(0, DISCORD_MAX_LENGTH));
    return true;
  } catch (err: any) {
    logger.warn({ jid, err: err.message }, 'live: could not fill the thinking message');
    return false;
  }
}

/** Remove a reserved thinking message whose content never arrived. */
export async function discardThinkingMessage(jid: string): Promise<void> {
  const live = thinkingMessages.get(jid);
  if (!live) return;
  thinkingMessages.delete(jid);
  if (live.timer) clearTimeout(live.timer);
  await live.message.delete().catch(() => undefined);
}

export async function sendResponse(
  jid: string,
  text: string,
  options: { settleLive?: boolean } = {},
): Promise<boolean> {
  if (!client) return false;

  // A streamed reply is already on screen; settle it in place.
  //
  // Only the caller delivering the turn's ANSWER may do this. The event
  // streamer also posts through here (thinking blocks, tool status), and
  // settling on those rewrote the half-written reply with a thinking block —
  // the reply appeared to mutate into some other message mid-stream.
  if (options.settleLive !== false && (await finishLiveResponse(jid, text))) return true;

  const channelId = jid.replace(/^dc:/, '');

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Channel not found or not text-based');
      return false;
    }

    const textChannel = channel as TextChannel | DMChannel;

    if (text.length <= DISCORD_MAX_LENGTH) {
      await textChannel.send(text);
    } else {
      // Split at line boundaries when possible
      const chunks = splitMessage(text, DISCORD_MAX_LENGTH);
      for (const chunk of chunks) {
        await textChannel.send(chunk);
      }
    }
    logger.info({ jid, length: text.length }, 'Response sent');
    return true;
  } catch (err: any) {
    logger.error({ jid, err: err.message }, 'Failed to send message');
    return false;
  }
}

/**
 * Send a reply with file attachments (Method C outbox delivery). Reuses the
 * gateway's already-connected client (unlike sendFilesToDiscord, which logs in a
 * fresh client for the standalone CLI). Oversized/missing files are skipped.
 */
export async function sendFilesResponse(
  jid: string,
  text: string,
  files: string[],
): Promise<boolean> {
  if (!client) return false;

  // The text may already be on screen as a streamed message. Settle it there
  // and send only the attachments, instead of posting the whole reply twice.
  const streamed = await finishLiveResponse(jid, text);
  const bodyText = streamed ? '' : text;

  const channelId = jid.replace(/^dc:/, '');

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Channel not found or not text-based');
      return false;
    }
    const textChannel = channel as TextChannel | DMChannel;

    const valid: Array<{ path: string; size: number }> = [];
    const notices: string[] = [];
    for (const f of files) {
      try {
        const size = statSync(f).size;
        if (config.maxAttachmentBytes > 0 && size > config.maxAttachmentBytes) {
          logger.warn({ jid, file: f, size }, 'Skipping attachment over size limit');
          notices.push(
            formatAttachmentTooLargeNotice(basename(f), size, config.maxAttachmentBytes),
          );
        } else {
          valid.push({ path: f, size });
        }
      } catch {
        logger.warn({ jid, file: f }, 'Attachment not readable, skipping');
      }
    }

    const responseText = [bodyText, ...notices].filter(Boolean).join('\n\n');
    const attachments = await Promise.all(
      valid.map(
        async ({ path }) => new AttachmentBuilder(await readFile(path), { name: basename(path) }),
      ),
    );

    // Fall back to a plain text reply if nothing attachable survived. When the
    // text already went out as a streamed message there is nothing left to say,
    // so do not post "(empty response)" on top of a correct answer.
    if (attachments.length === 0) {
      if (streamed && !responseText) return true;
      return sendResponse(jid, responseText || '(empty response)');
    }

    const body: string | undefined = responseText.length > 0 ? responseText : undefined;
    let finalBody = body;
    if (body && body.length > DISCORD_MAX_LENGTH) {
      // Send the long text in chunks; attach files to the final chunk.
      const chunks = splitMessage(body, DISCORD_MAX_LENGTH);
      for (let i = 0; i < chunks.length - 1; i++) {
        await textChannel.send(chunks[i]);
      }
      finalBody = chunks[chunks.length - 1];
    }

    try {
      await textChannel.send({ content: finalBody, files: attachments });
    } catch (err) {
      if (!isAttachmentTooLargeError(err)) throw err;

      const rejectedNotices = valid.map(({ path, size }) =>
        formatAttachmentTooLargeNotice(basename(path), size),
      );
      const fallback = [finalBody, ...rejectedNotices].filter(Boolean).join('\n\n');
      for (const chunk of splitMessage(fallback, DISCORD_MAX_LENGTH)) {
        await textChannel.send(chunk);
      }
      logger.warn(
        { jid, files: valid.map(({ path }) => path) },
        'Discord rejected oversized attachments; sent a text notice instead',
      );
      return true;
    }

    logger.info(
      { jid, files: attachments.length, length: text?.length ?? 0 },
      'Response sent (with files)',
    );
    return true;
  } catch (err: any) {
    logger.error({ jid, err: err.message }, 'Failed to send files');
    return false;
  }
}

export async function setTyping(jid: string): Promise<void> {
  if (!client) return;
  try {
    const channelId = jid.replace(/^dc:/, '');
    const channel = await client.channels.fetch(channelId);
    if (channel && 'sendTyping' in channel) {
      await (channel as TextChannel).sendTyping();
    }
  } catch {
    // best-effort
  }
}

export function stopDiscord(): void {
  stopGpuPresenceMonitor();
  if (client) {
    client.destroy();
    client = null;
    logger.info('Discord bot stopped');
  }
}

export function getBotTag(): string | undefined {
  return client?.user?.tag;
}

// ── Helpers ──

export function splitMessage(text: string, max: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt <= 0) splitAt = max; // hard split if no newline
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a Discord-safe thread title (max 100 chars) from sender + message. */
export function createAutoThreadRegistration(
  parent: RegisteredChannel,
  threadId: string,
  threadName: string,
): RegisteredChannel {
  return {
    jid: `dc:${threadId}`,
    name: `${parent.name} ▸ ${threadName}`,
    folder: `ch_${threadId}`,
    requiresTrigger: false,
    isMain: false,
    modelOverride: parent.modelOverride,
    thinkingOverride: 'medium',
    cwdOverride: parent.cwdOverride,
    thinkingToolStatusEnabled: parent.thinkingToolStatusEnabled,
  };
}

/**
 * Route a triggering message into its own thread, returning the jid to queue
 * against, or null to stay in the parent channel.
 *
 * The thread jid is returned ONLY once its channel row exists. Routing to an
 * unregistered jid loses the message outright: the queue finds no channel,
 * logs "Channel disappeared during processing" and never answers, so the user
 * sees the bot ignore a tag it plainly received. Any failure here — missing
 * thread permissions, a rejected channels insert — falls back to the parent
 * channel, which is always registered by the time we get here.
 */
export async function openAutoThread(
  message: Message,
  channel: RegisteredChannel,
  threadName: string,
): Promise<string | null> {
  try {
    const thread = await message.startThread({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });
    const threadJid = `dc:${thread.id}`;
    if (!getChannel(threadJid)) {
      const threadReg = createAutoThreadRegistration(channel, thread.id, thread.name);
      dbRegisterChannel(threadReg);
      logger.info({ jid: threadJid, name: threadReg.name }, 'Opened and registered thread');
    }
    return threadJid;
  } catch (err: any) {
    logger.warn(
      { jid: channel.jid, err: err.message },
      'Failed to open thread, replying in channel',
    );
    return null;
  }
}

function buildThreadName(senderName: string, content: string): string {
  const snippet = content.replace(/\s+/g, ' ').trim();
  const raw = snippet ? `${senderName}: ${snippet}` : senderName;
  return raw.length > 100 ? `${raw.slice(0, 97)}...` : raw;
}
