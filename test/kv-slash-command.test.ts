import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent/extension-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../src/agent/extension-runner.js')>(
    '../src/agent/extension-runner.js',
  );
  return {
    ...actual,
    executePiExtensionCommand: vi.fn(async (_channel, command, args) => {
      if (command === 'kv status') {
        return {
          ok: true,
          text: '### ⚡ KV Cache Snapshot Status\n- Active Session Tokens: 1,234',
        };
      }
      if (command === 'kv save') {
        return {
          ok: true,
          text: `Saved KV cache snapshot: ${args.name || 'default'}`,
        };
      }
      return { ok: true, text: `Command ${command} executed` };
    }),
  };
});

describe('KV cache slash commands and extension runner in piscord', () => {
  it('registers /kv and /pi kv slash commands globally', async () => {
    const set = vi.fn(async () => undefined);
    const { registerGlobalCommands } = await import('../src/discord/slash-commands.js');

    await registerGlobalCommands({ application: { commands: { set } } } as any);

    const commands = set.mock.calls[0][0] as Array<{
      name: string;
      options?: Array<{ name: string; description: string; options?: any[] }>;
    }>;

    const kv = commands.find((command) => command.name === 'kv');
    expect(kv).toBeDefined();
    expect(kv?.description).toContain('llama.cpp KV cache');

    const subcommands = (kv?.options || []).map((opt) => opt.name);
    expect(subcommands).toContain('status');
    expect(subcommands).toContain('save');
    expect(subcommands).toContain('restore');
    expect(subcommands).toContain('prune');
    expect(subcommands).toContain('base-update');
    expect(subcommands).toContain('help');

    const pi = commands.find((command) => command.name === 'pi');
    const piKv = pi?.options?.find((opt) => opt.name === 'kv');
    expect(piKv).toBeDefined();
  });

  it('handles /kv status slash command through handleChatCommand', async () => {
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { executePiExtensionCommand } = await import('../src/agent/extension-runner.js');

    const mockInteraction: any = {
      commandName: 'kv',
      channelId: 'mock-chan-1',
      user: { id: 'u1', username: 'alice' },
      guild: null,
      inGuild: () => false,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      options: {
        getSubcommand: () => 'status',
        getString: (_key: string) => null,
      },
    };

    // Auto-register DM channel
    const db = await import('../src/db.js');
    db.initDb(':memory:');
    db.registerChannel({
      jid: 'dc:mock-chan-1',
      name: 'mock',
      folder: 'mock_folder',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
      thinkingToolStatusEnabled: true,
    });

    await handleChatCommand(mockInteraction);

    expect(mockInteraction.deferReply).toHaveBeenCalled();
    expect(executePiExtensionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'dc:mock-chan-1' }),
      'kv status',
      {},
    );
    expect(mockInteraction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('KV Cache Snapshot Status'),
    });
  });

  it('handles /pi kv save slash command with name argument', async () => {
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { executePiExtensionCommand } = await import('../src/agent/extension-runner.js');

    const mockInteraction: any = {
      commandName: 'pi',
      channelId: 'mock-chan-1',
      user: { id: 'u1', username: 'alice' },
      guild: null,
      inGuild: () => false,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      options: {
        getSubcommand: () => 'kv',
        getString: (key: string) => {
          if (key === 'action') return 'save';
          if (key === 'name') return 'my_snapshot';
          return null;
        },
      },
    };

    await handleChatCommand(mockInteraction);

    expect(executePiExtensionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'dc:mock-chan-1' }),
      'kv save',
      { name: 'my_snapshot' },
    );
    expect(mockInteraction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('Saved KV cache snapshot: my_snapshot'),
    });
  });

  it('fallback discovery returns expanded kv subcommands', async () => {
    const { getFallbackExtensionCommands } = await import('../src/agent/extension-runner.js');
    const fallback = getFallbackExtensionCommands();
    const names = fallback.map((c) => c.name);
    expect(names).toContain('kv status');
    expect(names).toContain('kv save');
    expect(names).toContain('kv');
  });
});
