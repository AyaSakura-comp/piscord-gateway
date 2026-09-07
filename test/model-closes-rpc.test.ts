import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRpcSession, closeRpcSession, closeAllRpcSessions } from '../src/agent/rpc-session.js';
import * as db from '../src/db.js';
import * as queue from '../src/agent/queue.js';
import { handleChatCommand } from '../src/discord/slash-commands.js';

describe('Warm RPC session lifecycle on model, thinking, and cwd changes', () => {
  const channelJid = 'dc:test_model_rpc';
  const folder = 'ch_test_model_rpc';

  beforeAll(() => {
    process.env.DB_PATH = ':memory:';
    db.initDb();
    db.registerChannel({
      jid: channelJid,
      name: 'test channel',
      folder,
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
      thinkingToolStatusEnabled: true,
    });
  });

  afterAll(() => {
    closeAllRpcSessions();
    db.closeDb();
  });

  beforeEach(() => {
    closeAllRpcSessions();
    db.clearChannelModelOverride(channelJid);
    db.clearChannelCwdOverride(channelJid);
    vi.restoreAllMocks();
  });

  describe('getRpcSession options tracking', () => {
    it('reuses session when options match', () => {
      const s1 = getRpcSession(folder, { model: 'model-a', thinking: 'off', cwd: '/tmp' });
      const s2 = getRpcSession(folder, { model: 'model-a', thinking: 'off', cwd: '/tmp' });
      expect(s1).toBe(s2);
    });

    it('replaces session when model changes', () => {
      const s1 = getRpcSession(folder, { model: 'model-a', thinking: 'off' });
      const closeSpy = vi.spyOn(s1, 'close');
      const s2 = getRpcSession(folder, { model: 'model-b', thinking: 'off' });
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(s1).not.toBe(s2);
      expect(s2.getOpts().model).toBe('model-b');
    });

    it('replaces session when thinking changes', () => {
      const s1 = getRpcSession(folder, { model: 'model-a', thinking: 'off' });
      const closeSpy = vi.spyOn(s1, 'close');
      const s2 = getRpcSession(folder, { model: 'model-a', thinking: 'high' });
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(s1).not.toBe(s2);
      expect(s2.getOpts().thinking).toBe('high');
    });

    it('replaces session when cwd changes', () => {
      const s1 = getRpcSession(folder, { cwd: '/workspace/a' });
      const closeSpy = vi.spyOn(s1, 'close');
      const s2 = getRpcSession(folder, { cwd: '/workspace/b' });
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(s1).not.toBe(s2);
      expect(s2.getOpts().cwd).toBe('/workspace/b');
    });
  });

  describe('Slash commands close warm RPC session on idle channel', () => {
    const makeInteraction = (
      subcommand: string,
      options: Record<string, string> = {},
    ) => {
      let repliedText = '';
      return {
        commandName: 'pi',
        channelId: 'test_model_rpc',
        user: { id: 'u1', username: 'alice' },
        guild: null,
        inGuild: () => false,
        reply: vi.fn(async (opts: any) => {
          repliedText = typeof opts === 'string' ? opts : opts.content || '';
        }),
        get repliedText() {
          return repliedText;
        },
        options: {
          getSubcommand: () => subcommand,
          getString: (name: string, required?: boolean) => {
            const val = options[name];
            if (val === undefined && required) throw new Error(`Missing option ${name}`);
            return val ?? null;
          },
        },
      } as any;
    };

    it('/pi model closes warm RPC session when idle', async () => {
      const session = getRpcSession(folder, { model: 'local-llama/qwen3.6-35b-q4' });
      const closeSpy = vi.spyOn(session, 'close');

      const interaction = makeInteraction('model', { model: 'openai-codex/gpt-5.6-sol' });
      await handleChatCommand(interaction);

      expect(closeSpy).toHaveBeenCalledOnce();
      expect(db.getChannel(channelJid)?.modelOverride).toBe('openai-codex/gpt-5.6-sol');
    });

    it('/pi reset-model closes warm RPC session when idle', async () => {
      db.setChannelModelOverride(channelJid, 'openai-codex/gpt-5.6-sol');
      const session = getRpcSession(folder, { model: 'openai-codex/gpt-5.6-sol' });
      const closeSpy = vi.spyOn(session, 'close');

      const interaction = makeInteraction('reset-model');
      await handleChatCommand(interaction);

      expect(closeSpy).toHaveBeenCalledOnce();
      expect(db.getChannel(channelJid)?.modelOverride).toBe('');
    });

    it('/pi thinking closes warm RPC session when idle', async () => {
      const session = getRpcSession(folder, { thinking: 'off' });
      const closeSpy = vi.spyOn(session, 'close');

      const interaction = makeInteraction('thinking', { level: 'low' });
      await handleChatCommand(interaction);

      expect(closeSpy).toHaveBeenCalledOnce();
      expect(db.getChannel(channelJid)?.thinkingOverride).toBe('low');
    });

    it('/pi cwd closes warm RPC session when idle', async () => {
      const session = getRpcSession(folder, { cwd: '/tmp' });
      const closeSpy = vi.spyOn(session, 'close');

      const interaction = makeInteraction('cwd', { path: '/tmp' });
      await handleChatCommand(interaction);

      expect(closeSpy).toHaveBeenCalledOnce();
      expect(db.getChannel(channelJid)?.cwdOverride).toBe('/tmp');
    });

    it('/pi reset-cwd closes warm RPC session when idle', async () => {
      db.setChannelCwdOverride(channelJid, '/tmp');
      const session = getRpcSession(folder, { cwd: '/tmp' });
      const closeSpy = vi.spyOn(session, 'close');

      const interaction = makeInteraction('reset-cwd');
      await handleChatCommand(interaction);

      expect(closeSpy).toHaveBeenCalledOnce();
      expect(db.getChannel(channelJid)?.cwdOverride).toBe('');
    });

    it('does not close RPC session mid-flight if channel is processing', async () => {
      vi.spyOn(queue, 'isChannelProcessing').mockReturnValue(true);

      const session = getRpcSession(folder, { model: 'local-llama/qwen3.6-35b-q4' });
      const closeSpy = vi.spyOn(session, 'close');

      const interaction = makeInteraction('model', { model: 'openai-codex/gpt-5.6-sol' });
      await handleChatCommand(interaction);

      expect(closeSpy).not.toHaveBeenCalled();
      expect(db.getChannel(channelJid)?.modelOverride).toBe('openai-codex/gpt-5.6-sol');
    });
  });
});
