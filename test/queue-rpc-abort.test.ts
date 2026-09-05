import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { promptMock, sendResponseMock, setTypingMock } = vi.hoisted(() => ({
  promptMock: vi.fn(),
  sendResponseMock: vi.fn(),
  setTypingMock: vi.fn(),
}));

vi.mock('../src/agent/rpc-session.js', () => ({
  closeAllRpcSessions: vi.fn(),
  getRpcSession: vi.fn(() => ({ prompt: promptMock })),
}));

vi.mock('../src/discord/client.js', () => ({
  sendFilesResponse: vi.fn(),
  sendResponse: sendResponseMock,
  discardLiveResponse: vi.fn(),
  discardThinkingMessage: vi.fn(),
  setTyping: setTypingMock,
}));

vi.mock('../src/discord/stream-events.js', () => ({
  createEventStreamer: vi.fn(() => vi.fn()),
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'MAX_CONCURRENCY',
  'PI_CWD',
  'POLL_INTERVAL_MS',
  'RPC_STEER',
  'SESSIONS_DIR',
];

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('queue RPC abort handling', () => {
  it('records an RPC-aborted prompt without sending an agent error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piscord-queue-abort-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = join(dir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.PI_CWD = dir;
    process.env.RPC_STEER = 'true';
    promptMock.mockResolvedValue({
      ok: false,
      text: '',
      error: 'Agent invocation aborted',
      aborted: true,
    });
    setTypingMock.mockResolvedValue(undefined);

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    db.initDb();

    try {
      db.registerChannel({
        jid: 'dc:abort',
        name: 'abort test',
        folder: 'ch_abort',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
        thinkingToolStatusEnabled: true,
      });
      db.enqueueMessage({
        channelJid: 'dc:abort',
        sender: 'u1',
        senderName: 'Alice',
        content: 'keep this prompt',
        timestamp: new Date().toISOString(),
      });

      queue.startProcessingLoop();
      await vi.waitFor(
        () => {
          const inspect = new Database(dbPath, { readonly: true });
          const row = inspect.prepare('select status from message_queue limit 1').get() as {
            status: string;
          };
          inspect.close();
          expect(row.status).toBe('aborted');
        },
        { timeout: 2000, interval: 10 },
      );
      expect(sendResponseMock).not.toHaveBeenCalled();
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });
});
