import { exec } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type InteractionReplyOptions,
} from 'discord.js';
import {
  getChannelSessionStatus,
  UNTIL_DONE_MARKER,
  type ChannelSessionStatus,
  type SessionContextUsage,
  type SessionTokenUsage,
} from '../agent/invoke.js';
import { config } from '../config.js';
import {
  clearChannelCwdOverride,
  clearChannelModelOverride,
  clearPendingMessages,
  createDmChannel,
  disableChannelThinkingToolStatus,
  enqueueMessage,
  getChannel,
  registerChannel,
  resetChannelThinkingToolStatus,
  setChannelCwdOverride,
  setChannelModelOverride,
  setChannelThinkingOverride,
} from '../db.js';
import { logger } from '../logger.js';
import {
  autocompleteModels,
  isThinkingLevel,
  listAvailableModels,
  resolveModelReference,
  resolveThinkingForModel,
  toModelChoiceName,
} from '../agent/model-catalog.js';
import {
  buildThinkingAdjustmentMessage,
  computeEffectiveChannelSettings,
  getDesiredThinkingLevel,
  type EffectiveChannelSettings,
} from '../agent/channel-settings.js';
import { isChannelProcessing, stopChannelTask } from '../agent/queue.js';
import { closeRpcSession } from '../agent/rpc-session.js';
import { executePiExtensionCommand } from '../agent/extension-runner.js';
import { getAgyUsageReport } from '../agy-usage.js';
import { rotateChannelSessionDir } from '../session/path.js';
import type { RegisteredChannel } from '../types.js';

const PI_COMMAND = new SlashCommandBuilder()
  .setName('pi')
  .setDescription('Inspect or change pi model settings for this channel')
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Show the current model and thinking configuration for this channel'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('model')
      .setDescription('Set the default model for this channel')
      .addStringOption((option) =>
        option
          .setName('model')
          .setDescription("Choose one of pi's currently available models")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('reset-model').setDescription("Reset this channel to the gateway's default model"),
  )
  .addSubcommand((sub) =>
    sub
      .setName('thinking')
      .setDescription('Set the default thinking level for this channel')
      .addStringOption((option) =>
        option
          .setName('level')
          .setDescription('Thinking level')
          .setRequired(true)
          .addChoices(
            { name: 'off', value: 'off' },
            { name: 'minimal', value: 'minimal' },
            { name: 'low', value: 'low' },
            { name: 'medium', value: 'medium' },
            { name: 'high', value: 'high' },
            { name: 'xhigh', value: 'xhigh' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('disable-thinking-tool-status')
      .setDescription('Hide thinking, tool calls, and tool results for the current session'),
  )
  .addSubcommand((sub) =>
    sub.setName('new').setDescription('Start a fresh pi session for this channel'),
  )
  .addSubcommand((sub) =>
    sub.setName('stop').setDescription('Abort the current task while preserving the session and queue'),
  )
  .addSubcommand((sub) =>
    sub.setName('clear').setDescription('Delete queued messages without aborting the current task'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('cwd')
      .setDescription('Set the working directory override for this channel')
      .addStringOption((option) =>
        option
          .setName('path')
          .setDescription('Absolute path to the workspace directory')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('reset-cwd').setDescription("Reset this channel to the gateway's default working directory"),
  )
  .addSubcommand((sub) =>
    sub.setName('gpt-usage').setDescription('Show ChatGPT/Codex subscription rate-limit usage'),
  )
  .addSubcommand((sub) =>
    sub.setName('agy-usage').setDescription('Show Antigravity (Gemini) quota usage'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('kv')
      .setDescription('Inspect or manage llama.cpp KV cache snapshots')
      .addStringOption((option) =>
        option
          .setName('action')
          .setDescription('Action: status (default), save, restore, prune, base-update, help')
          .setRequired(false)
          .addChoices(
            { name: 'status', value: 'status' },
            { name: 'save', value: 'save' },
            { name: 'restore', value: 'restore' },
            { name: 'prune', value: 'prune' },
            { name: 'base-update', value: 'base-update' },
            { name: 'help', value: 'help' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Optional snapshot name')
          .setRequired(false),
      ),
  );

const UNTIL_COMMAND = new SlashCommandBuilder()
  .setName('until')
  .setDescription('Run an autonomous "work until done" task (pi-until-done) in this channel')
  .addSubcommand((sub) =>
    sub
      .setName('goal')
      .setDescription('Start an autonomous goal — pi works until it is done and verified')
      .addStringOption((option) =>
        option
          .setName('text')
          .setDescription('What you want accomplished (the goal)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Ask pi to report progress on the current goal'),
  )
  .addSubcommand((sub) =>
    sub.setName('stop').setDescription('Abort the current task while preserving the session and queue'),
  );

const GPT_USAGE_COMMAND = new SlashCommandBuilder()
  .setName('gpt-usage')
  .setDescription('Show ChatGPT/Codex subscription rate-limit usage (Taiwan time)');

const KV_COMMAND = new SlashCommandBuilder()
  .setName('kv')
  .setDescription('Inspect or manage llama.cpp KV cache snapshots')
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Show current KV cache snapshot status, active tokens, and snapshot table'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('save')
      .setDescription('Save current session KV snapshot (optional custom name)')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Optional custom snapshot name')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('restore')
      .setDescription('Restore session or named snapshot')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Optional snapshot name to restore')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('prune')
      .setDescription('Enforce LRU session count and storage quotas'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('base-update')
      .setDescription('Re-evaluate and cache Golden Base System Prompt'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('help')
      .setDescription('Show KV cache manager help and usage'),
  );

export async function registerGlobalCommands(client: Client<true>): Promise<void> {
  // Discord only surfaces a global command inside a DM with the bot when the
  // command declares the DM contexts explicitly. Left unset, `contexts` comes
  // back null from the API and the commands are effectively guild-only — which
  // is why /pi new, /pi stop and friends were missing in the pi-agent DM while
  // they worked fine in the server.
  const commands = [PI_COMMAND, UNTIL_COMMAND, GPT_USAGE_COMMAND, KV_COMMAND].map((command) =>
    command
      .setContexts(
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      )
      .setIntegrationTypes(
        ApplicationIntegrationType.GuildInstall,
        ApplicationIntegrationType.UserInstall,
      )
      .toJSON(),
  );
  await client.application.commands.set(commands);
  logger.info({ contexts: [0, 1, 2] }, 'Registered global slash commands');
}

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== 'pi') return;
  if (interaction.options.getSubcommand() !== 'model') return;
  if (interaction.options.getFocused(true).name !== 'model') return;

  const focused = interaction.options.getFocused();
  const matches = autocompleteModels(focused, 25).map((model) => ({
    name: toModelChoiceName(model),
    value: model.ref,
  }));

  await interaction.respond(matches);
}

export async function handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (
    interaction.commandName !== 'pi' &&
    interaction.commandName !== 'until' &&
    interaction.commandName !== 'gpt-usage' &&
    interaction.commandName !== 'kv'
  )
    return;

  const subcommand =
    interaction.commandName === 'gpt-usage' ? null : interaction.options.getSubcommand();

  try {
    if (interaction.commandName === 'gpt-usage') {
      await handleGptUsage(interaction);
      return;
    }

    if (interaction.commandName === 'kv') {
      await handleKvCommand(interaction, subcommand);
      return;
    }

    if (interaction.commandName === 'until') {
      switch (subcommand) {
        case 'goal':
          await handleUntilGoal(interaction);
          return;
        case 'status':
          await handleUntilStatus(interaction);
          return;
        case 'stop':
          await handleStop(interaction);
          return;
        default:
          await interaction.reply(reply(`Unknown subcommand: ${subcommand}`, interaction));
          return;
      }
    }

    switch (subcommand) {
      case 'status':
        await handleStatus(interaction);
        return;
      case 'model':
        await handleModelSet(interaction);
        return;
      case 'reset-model':
        await handleModelReset(interaction);
        return;
      case 'thinking':
        await handleThinkingSet(interaction);
        return;
      case 'disable-thinking-tool-status':
        await handleDisableThinkingToolStatus(interaction);
        return;
      case 'new':
        await handleNew(interaction);
        return;
      case 'stop':
        await handleStop(interaction);
        return;
      case 'clear':
        await handleClear(interaction);
        return;
      case 'cwd':
        await handleCwdSet(interaction);
        return;
      case 'reset-cwd':
        await handleCwdReset(interaction);
        return;
      case 'gpt-usage':
        await handleGptUsage(interaction);
        return;
      case 'agy-usage':
        await handleAgyUsage(interaction);
        return;
      case 'kv':
        await handlePiKvCommand(interaction);
        return;
      default:
        await interaction.reply(reply(`Unknown subcommand: ${subcommand}`, interaction));
    }
  } catch (err: any) {
    logger.error(
      { err: err.message, command: interaction.commandName, subcommand },
      'Slash command failed',
    );
    const payload = reply(`⚠️ ${err.message}`, interaction);
    if (interaction.replied) {
      await interaction.followUp(payload);
    } else if (interaction.deferred) {
      await interaction.editReply({ content: payload.content });
    } else {
      await interaction.reply(payload);
    }
  }
}

async function handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  if (isChannelProcessing(channel.jid)) {
    await interaction.reply(
      reply(
        'This channel is currently processing a message. Wait for it to finish, then run /new again.',
        interaction,
      ),
    );
    return;
  }

  const cleared = clearPendingMessages(channel.jid);

  // Retire the warm RPC process BEFORE moving the directory out from under it.
  // It holds `--session-dir` plus an already-resolved session file; leaving it
  // alive across the rename makes the next prompt fail with ENOENT on a .jsonl
  // that now lives in the archive. The next message simply spawns a fresh one.
  const closedRpc = closeRpcSession(channel.folder);
  const archivedSession = rotateChannelSessionDir(channel.folder);
  resetChannelThinkingToolStatus(channel.jid);

  logger.info(
    { jid: channel.jid, cleared, archived: Boolean(archivedSession), closedRpc },
    'Channel session reset',
  );

  const notes = ['Started a fresh session for this channel.'];
  if (cleared > 0) {
    notes.push(`Cleared ${cleared} queued ${cleared === 1 ? 'message' : 'messages'}.`);
  }
  if (archivedSession) {
    notes.push('Archived the previous session on disk.');
  }

  await interaction.reply(reply(notes.join('\n'), interaction));
}

async function handleDisableThinkingToolStatus(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  disableChannelThinkingToolStatus(channel.jid);
  await interaction.reply(
    reply(
      'Thinking, tool calls, and tool results are hidden for this session. `/pi new` turns them back on.',
      interaction,
    ),
  );
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const jid = `dc:${interaction.channelId}`;
  const result = stopChannelTask(jid);

  if (!result.aborted && result.cleared === 0) {
    await interaction.reply(
      reply('No active task or queued messages in this channel.', interaction),
    );
    return;
  }

  const notes: string[] = [];
  if (result.aborted) {
    notes.push('Aborted the current task.');
  }
  if (result.cleared > 0) {
    notes.push(
      `Cleared ${result.cleared} queued ${result.cleared === 1 ? 'message' : 'messages'}.`,
    );
  }

  await interaction.reply(reply(notes.join(' '), interaction));
}

async function handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  const cleared = clearPendingMessages(channel.jid);
  const message =
    cleared === 0
      ? 'No queued messages in this channel.'
      : `Cleared ${cleared} queued ${cleared === 1 ? 'message' : 'messages'}.`;
  await interaction.reply(reply(message, interaction));
}

async function handleUntilGoal(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  const goal = interaction.options.getString('text', true).trim();
  if (!goal) {
    await interaction.reply(reply('Please provide a goal.', interaction));
    return;
  }

  const senderName = interaction.user.displayName || interaction.user.username;
  enqueueMessage({
    channelJid: channel.jid,
    sender: interaction.user.id,
    senderName,
    content: `${UNTIL_DONE_MARKER}${goal}`,
    timestamp: new Date().toISOString(),
  });

  await interaction.reply(
    reply(
      `🎯 Started an until-done goal:\n> ${goal}\n\npi will work autonomously and report back when it's done and verified. Use \`/until stop\` to abort.`,
      interaction,
    ),
  );
}

async function handleUntilStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  const senderName = interaction.user.displayName || interaction.user.username;
  enqueueMessage({
    channelJid: channel.jid,
    sender: interaction.user.id,
    senderName,
    content:
      'Report the current pi-until-done goal status: the goal, which tasks are done vs. remaining, ' +
      'and the latest verifyCommand result. If there is no active goal, say so briefly.',
    timestamp: new Date().toISOString(),
  });

  await interaction.reply(reply('📊 Asked pi to report the current until-done status.', interaction));
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  await interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );

  const effective = computeEffectiveChannelSettings(channel);
  const sessionStatus = await getChannelSessionStatus(channel.folder, effective.effectiveCwd);
  await interaction.editReply({ content: buildStatusMessage(effective, sessionStatus) });
}

async function handleModelSet(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  const selectedRef = interaction.options.getString('model', true);
  const models = listAvailableModels({ forceRefresh: true });
  const selectedModel = resolveModelReference(selectedRef, models);
  if (!selectedModel) {
    await interaction.reply(reply(`Model is no longer available: ${selectedRef}`, interaction));
    return;
  }

  setChannelModelOverride(channel.jid, selectedModel.ref);

  // Re-read channel to use the persisted override in status/effective computation.
  const updated = getChannel(channel.jid)!;
  const desiredThinking = getDesiredThinkingLevel(updated);
  const thinkingResolution = resolveThinkingForModel(selectedModel, desiredThinking);

  // Only persist the clamped value if the channel already had an explicit thinking override.
  if (updated.thinkingOverride) {
    setChannelThinkingOverride(updated.jid, thinkingResolution.effective);
  }

  const notes = [`Model set to ${selectedModel.ref} for this channel.`];
  if (thinkingResolution.adjusted) {
    notes.push(
      buildThinkingAdjustmentMessage(
        thinkingResolution.requested,
        thinkingResolution.effective,
        selectedModel,
      ),
    );
  }

  await interaction.reply(reply(notes.join('\n'), interaction));
}

async function handleModelReset(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  clearChannelModelOverride(channel.jid);

  const updated = getChannel(channel.jid)!;
  const effective = computeEffectiveChannelSettings(updated, { forceRefresh: true });
  const notes = ['Model reset for this channel.'];

  if (updated.thinkingOverride && effective.thinkingAdjusted) {
    setChannelThinkingOverride(updated.jid, effective.effectiveThinking);
  }

  if (effective.thinkingAdjusted) {
    const currentThinking = effective.hasManagedThinking
      ? effective.effectiveThinking
      : '(pi runtime default)';
    notes.push(
      `Current effective thinking is ${currentThinking}. ${effective.thinkingAdjustmentMessage}`,
    );
  }

  await interaction.reply(reply(notes.join('\n'), interaction));
}

async function handleThinkingSet(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  const rawLevel = interaction.options.getString('level', true);
  if (!isThinkingLevel(rawLevel)) {
    await interaction.reply(reply(`Invalid thinking level: ${rawLevel}`, interaction));
    return;
  }

  const effective = computeEffectiveChannelSettings(channel, { forceRefresh: true });
  const resolution = resolveThinkingForModel(effective.modelInfo, rawLevel);

  setChannelThinkingOverride(channel.jid, resolution.effective);

  const notes = [`Thinking level set to ${resolution.effective} for this channel.`];
  if (resolution.adjusted) {
    notes.push(
      buildThinkingAdjustmentMessage(
        resolution.requested,
        resolution.effective,
        effective.modelInfo,
      ),
    );
  }

  await interaction.reply(reply(notes.join('\n'), interaction));
}

function ensureManagedChannel(
  interaction: ChatInputCommandInteraction,
): RegisteredChannel | undefined {
  const jid = `dc:${interaction.channelId}`;
  const channel = getChannel(jid);
  if (channel) return channel;

  // Allow slash commands to bootstrap DM channels, same as normal DM messages.
  if (!interaction.guild && config.autoRegisterDMs) {
    const reg = createDmChannel(jid, interaction.user.id, interaction.user.username);
    registerChannel(reg);
    return getChannel(jid) ?? reg;
  }

  return undefined;
}

function notRegisteredMessage(): string {
  return 'This channel is not registered yet. Send a regular message in this channel first — the gateway will auto-register it (if channel policy is `open` or `open-trigger`).';
}

function buildStatusMessage(
  effective: EffectiveChannelSettings,
  sessionStatus: ChannelSessionStatus,
): string {
  const rows: Array<[string, string]> = [
    ['Model', formatModelValue(effective)],
    ['Thinking', formatThinkingValue(effective)],
    ['Working dir', formatWorkingDirValue(effective)],
  ];

  if (effective.thinkingAdjusted) {
    rows.push(['Fallback', formatThinkingFallback(effective)]);
  }

  rows.push(
    ['Reasoning', effective.modelInfo ? (effective.modelInfo.reasoning ? 'yes' : 'no') : 'unknown'],
    [
      'Session',
      sessionStatus.createdAt ? formatSessionCreatedAt(sessionStatus.createdAt) : 'not started',
    ],
    ['Tokens', formatTokenUsage(sessionStatus.tokens, sessionStatus.statsSource)],
    ['Context', formatContextUsage(sessionStatus.contextUsage)],
  );

  return `\`\`\`text\n${formatTwoColumnRows(rows)}\n\`\`\``;
}

function formatModelValue(effective: EffectiveChannelSettings): string {
  if (effective.modelSource === 'pi runtime default') {
    return 'pi runtime default';
  }

  return `${effective.displayModel} (${formatSettingSource(effective.modelSource)})`;
}

function formatThinkingValue(effective: EffectiveChannelSettings): string {
  if (!effective.hasManagedThinking || effective.thinkingSource === 'pi runtime default') {
    return 'pi runtime default';
  }

  return `${effective.effectiveThinking} (${formatSettingSource(effective.thinkingSource)})`;
}

function formatThinkingFallback(effective: EffectiveChannelSettings): string {
  if (
    effective.modelInfo &&
    !effective.modelInfo.reasoning &&
    effective.requestedThinking !== 'off'
  ) {
    return `${effective.requestedThinking} -> off (no reasoning)`;
  }

  if (effective.requestedThinking === 'xhigh' && effective.effectiveThinking === 'high') {
    return 'xhigh -> high (unsupported)';
  }

  return `${effective.requestedThinking} -> ${effective.effectiveThinking}`;
}

function formatWorkingDirValue(effective: EffectiveChannelSettings): string {
  return `${effective.effectiveCwd} (${effective.cwdSource === 'override' ? 'channel' : 'gateway'})`;
}

function formatSettingSource(source: EffectiveChannelSettings['modelSource']): string {
  switch (source) {
    case 'override':
      return 'channel';
    case 'default':
      return 'gateway';
    case 'pi runtime default':
      return 'pi';
  }
}

function formatSessionCreatedAt(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function formatTokenUsage(
  tokens: SessionTokenUsage | undefined,
  statsSource: ChannelSessionStatus['statsSource'],
): string {
  if (!tokens) {
    return statsSource === 'none' ? '0 total' : '?';
  }

  const cache = tokens.cacheRead + tokens.cacheWrite;
  const details = [`${formatNumber(tokens.input)} in`, `${formatNumber(tokens.output)} out`];
  if (cache > 0) {
    details.push(`${formatNumber(cache)} cache`);
  }

  const showDetails = tokens.input > 0 || tokens.output > 0 || cache > 0;
  return `${formatNumber(tokens.total)} total${showDetails ? ` (${details.join(' / ')})` : ''}`;
}

function formatContextUsage(contextUsage: SessionContextUsage | undefined): string {
  if (!contextUsage) {
    return '?';
  }

  const tokens = contextUsage.tokens == null ? '?' : formatNumber(contextUsage.tokens);
  const window =
    contextUsage.contextWindow == null ? '?' : formatNumber(contextUsage.contextWindow);
  const percent = contextUsage.percent == null ? '?' : `${formatPercent(contextUsage.percent)}%`;
  return `${tokens} / ${window} (${percent})`;
}

function formatTwoColumnRows(rows: Array<[string, string]>): string {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}

function reply(content: string, interaction: ChatInputCommandInteraction): InteractionReplyOptions {
  if (interaction.inGuild()) {
    return { content, flags: MessageFlags.Ephemeral };
  }
  return { content };
}

const execAsync = promisify(exec);

async function handleAgyUsage(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );

  // getAgyUsageReport never throws; it renders its own failure text so a missing
  // or expired agy login reads as an explanation rather than a stack trace.
  const output = await getAgyUsageReport();
  await interaction.editReply({ content: `\`\`\`text\n${output.trim()}\n\`\`\`` });
}

async function handleGptUsage(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );

  try {
    const scriptPath = pathResolve(homedir(), '.gemini/antigravity/skills/gpt-usage/bin/gpt-usage.mjs');
    const { stdout } = await execAsync(`node "${scriptPath}"`);
    await interaction.editReply({ content: `\`\`\`text\n${stdout.trim()}\n\`\`\`` });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to check gpt-usage');
    await interaction.editReply({
      content: `⚠️ Failed to get GPT usage status: ${err.stderr || err.message}`,
    });
  }
}

async function handleCwdSet(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  const selectedPath = interaction.options.getString('path', true).trim();
  
  let resolvedPath: string;
  if (selectedPath.startsWith('~/')) {
    resolvedPath = pathResolve(homedir(), selectedPath.slice(2));
  } else if (selectedPath === '~') {
    resolvedPath = homedir();
  } else {
    resolvedPath = pathResolve(selectedPath);
  }

  let pathExists = false;
  try {
    pathExists = existsSync(resolvedPath) && statSync(resolvedPath).isDirectory();
  } catch {
    // ignore
  }

  setChannelCwdOverride(channel.jid, resolvedPath);

  const notes = [`Working directory override set to ${resolvedPath} for this channel.`];
  if (!pathExists) {
    notes.push(`⚠️ Note: The path does not exist or is not a directory on the host machine currently.`);
  }

  await interaction.reply(reply(notes.join('\n'), interaction));
}

async function handleCwdReset(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  clearChannelCwdOverride(channel.jid);

  await interaction.reply(reply('Working directory override reset to default for this channel.', interaction));
}

async function handleKvCommand(
  interaction: ChatInputCommandInteraction,
  subcommand: string | null,
): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  await interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );

  const sub = subcommand || 'status';
  const name = interaction.options.getString('name') || '';
  const args: Record<string, string> = {};
  if (name) args.name = name;

  const result = await executePiExtensionCommand(channel, `kv ${sub}`, args);
  const text = result.text || (result.ok ? '✅ Done.' : '⚠️ Command failed.');
  const formatted = text.length > 1950 ? text.slice(0, 1950) + '\n...(truncated)' : text;

  await interaction.editReply({ content: formatted });
}

async function handlePiKvCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  await interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );

  const action = interaction.options.getString('action') || 'status';
  const name = interaction.options.getString('name') || '';
  const args: Record<string, string> = {};
  if (name) args.name = name;

  const result = await executePiExtensionCommand(channel, `kv ${action}`, args);
  const text = result.text || (result.ok ? '✅ Done.' : '⚠️ Command failed.');
  const formatted = text.length > 1950 ? text.slice(0, 1950) + '\n...(truncated)' : text;

  await interaction.editReply({ content: formatted });
}


