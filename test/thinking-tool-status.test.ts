import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sendResponse = vi.fn(async () => true);

vi.mock('../src/discord/client.js', () => ({
  sendResponse,
  updateLiveResponse: vi.fn(),
  discardLiveResponse: vi.fn(),
  beginLiveResponse: vi.fn(),
  updateLiveResponse: vi.fn(),
  sealLiveResponse: vi.fn(),
  finishLiveResponse: vi.fn(),
  openThinkingMessage: vi.fn(),
  finishThinkingMessage: vi.fn(),
  discardThinkingMessage: vi.fn(),
  openThinkingMessage: vi.fn(),
  finishThinkingMessage: vi.fn(),
  sealLiveResponse: vi.fn(),
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

async function openTempDb() {
  const tempDir = mkdtempSync(join(tmpdir(), 'piscord-thinking-tool-status-'));
  tempDirs.push(tempDir);
  process.env.DB_PATH = resolve(tempDir, 'gateway.db');
  process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
  return { db, dbPath: process.env.DB_PATH };
}

afterEach(() => {
  sendResponse.mockClear();
  vi.resetModules();
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('per-session thinking and tool status', () => {
  it('migrates legacy channels enabled and persists disable/reset state', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-thinking-tool-status-legacy-'));
    tempDirs.push(tempDir);
    const dbPath = resolve(tempDir, 'gateway.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      create table channels (
        jid text primary key,
        name text not null,
        folder text not null unique,
        requires_trigger integer not null default 1,
        is_main integer not null default 0,
        model_override text not null default '',
        thinking_override text not null default '',
        cwd_override text not null default '',
        created_at text not null default (datetime('now'))
      );
      insert into channels (jid, name, folder) values ('dc:123', 'legacy', 'ch_123');
    `);
    legacyDb.close();
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();
    try {
      expect(db.getChannel('dc:123')?.thinkingToolStatusEnabled).toBe(true);
      expect(db.disableChannelThinkingToolStatus('dc:123')).toBe(true);
      expect(db.getChannel('dc:123')?.thinkingToolStatusEnabled).toBe(false);
      expect(db.resetChannelThinkingToolStatus('dc:123')).toBe(true);
      expect(db.getChannel('dc:123')?.thinkingToolStatusEnabled).toBe(true);
    } finally {
      db.closeDb();
    }
  });

  it('defaults newly registered channels to enabled', async () => {
    const { db } = await openTempDb();
    try {
      db.registerChannel({
        jid: 'dc:456',
        name: 'new channel',
        folder: 'ch_456',
        requiresTrigger: true,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
        thinkingToolStatusEnabled: true,
      });
      expect(db.getChannel('dc:456')?.thinkingToolStatusEnabled).toBe(true);
    } finally {
      db.closeDb();
    }
  });

  it('slash command disables output until a new session resets it', async () => {
    const { db } = await openTempDb();
    const reply = vi.fn(async () => undefined);
    try {
      db.registerChannel({
        jid: 'dc:777',
        name: 'command channel',
        folder: 'ch_777',
        requiresTrigger: true,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
        thinkingToolStatusEnabled: true,
      });
      const { handleChatCommand } = await import('../src/discord/slash-commands.js');
      const interaction = (subcommand: string) =>
        ({
          commandName: 'pi',
          channelId: '777',
          guild: {},
          user: { id: 'user-1', username: 'tester', displayName: 'Tester' },
          options: { getSubcommand: () => subcommand },
          inGuild: () => true,
          reply,
          replied: false,
          deferred: false,
        }) as any;

      await handleChatCommand(interaction('disable-thinking-tool-status'));
      expect(db.getChannel('dc:777')?.thinkingToolStatusEnabled).toBe(false);

      await handleChatCommand(interaction('new'));
      expect(db.getChannel('dc:777')?.thinkingToolStatusEnabled).toBe(true);
    } finally {
      db.closeDb();
    }
  });

  it('does not send thinking or tool events when disabled for the session', async () => {
    const { createEventStreamer } = await import('../src/discord/stream-events.js');
    const stream = createEventStreamer('dc:789', { enabled: false });

    await stream({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', content: 'secret reasoning' },
    });
    await stream({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { name: 'read', arguments: { path: '/tmp/private' } },
      },
    });
    await stream({
      type: 'message_end',
      message: { role: 'tool', content: [{ content: 'private tool output' }] },
    });

    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe('/pi command registration', () => {
  it('registers disable-thinking-tool-status', async () => {
    const set = vi.fn(async () => undefined);
    const { registerGlobalCommands } = await import('../src/discord/slash-commands.js');

    await registerGlobalCommands({ application: { commands: { set } } } as any);

    const commands = set.mock.calls[0][0] as Array<{
      name: string;
      options?: Array<{ name: string }>;
    }>;
    const pi = commands.find((command) => command.name === 'pi');
    expect(pi?.options?.map((option) => option.name)).toContain('disable-thinking-tool-status');
    expect(pi?.options?.map((option) => option.name)).toContain('clear');
  });
});
