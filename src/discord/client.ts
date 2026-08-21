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

  // ── Auto-thread ──
  // When enabled, a triggering message in a top-level guild text channel spins
  // up a thread off that message; the conversation is then routed into the
  // thread (registered without a trigger requirement so follow-ups flow freely).
  // Already-in-thread messages and DMs fall through unchanged.
  let targetJid = jid;
  if (config.autoThread && !isDM && !message.channel.isThread()) {
    try {
      const thread = await message.startThread({
        name: buildThreadName(senderName, content),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
      targetJid = `dc:${thread.id}`;
      if (!getChannel(targetJid)) {
        const threadReg = createAutoThreadRegistration(channel, thread.id, thread.name);
        dbRegisterChannel(threadReg);
        logger.info({ jid: targetJid, name: threadReg.name }, 'Opened and registered thread');
      }
    } catch (err: any) {
      // Missing thread permissions, etc. — fall back to replying in-channel.
      logger.warn({ jid, err: err.message }, 'Failed to open thread, replying in channel');
    }
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
  if (!client || !full.trim()) return;

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
export async function finishLiveResponse(jid: string, finalText: string): Promise<boolean> {
  await awaitLiveOpen(jid);
  const live = liveMessages.get(jid);
  if (!live) return false;
  liveMessages.delete(jid);
  if (live.timer) clearTimeout(live.timer);

  const body = finalText?.trim() ?? '';
  try {
    if (!body) {
      // The turn produced nothing deliverable; drop the preview rather than
      // leaving a half-written sentence as the reply.
      await live.message?.delete().catch(() => undefined);
      return false;
    }

    const rest = body.slice(live.consumed);
    const chunks = rest.length > DISCORD_MAX_LENGTH ? splitMessage(rest, DISCORD_MAX_LENGTH) : [rest];
    if (live.message) {
      await live.message.edit(chunks[0] || '…');
    } else if (chunks[0]) {
      // Sealed: the tail after the last thinking block still needs a message.
      await live.channel.send(chunks[0]);
    }
    for (const chunk of chunks.slice(1)) {
      await live.channel.send(chunk);
    }
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
  liveMessages.delete(jid);
  if (live.timer) clearTimeout(live.timer);
  await live.message?.delete().catch(() => undefined);
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
  };
}

function buildThreadName(senderName: string, content: string): string {
  const snippet = content.replace(/\s+/g, ' ').trim();
  const raw = snippet ? `${senderName}: ${snippet}` : senderName;
  return raw.length > 100 ? `${raw.slice(0, 97)}...` : raw;
}
