import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { abortRpcSessionMock } = vi.hoisted(() => ({
  abortRpcSessionMock: vi.fn(),
}));

vi.mock('../src/agent/rpc-session.js', () => ({
  abortRpcSession: abortRpcSessionMock,
  closeAllRpcSessions: vi.fn(),
  getRpcSession: vi.fn(),
}));

const originalDbPath = process.env.DB_PATH;
let closeDb: (() => void) | undefined;
let db: typeof import('../src/db.js');
let queue: typeof import('../src/agent/queue.js');

beforeAll(async () => {
  process.env.DB_PATH = ':memory:';
  vi.resetModules();
  db = await import('../src/db.js');
  db.initDb();
  closeDb = db.closeDb;
  queue = await import('../src/agent/queue.js');
});

afterAll(() => {
  closeDb?.();
  vi.resetModules();
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
});

describe('stopChannelTask with a persistent RPC session', () => {
  it('uses RPC abort and keeps the Pi process alive', () => {
    db.registerChannel({
      jid: 'dc:stop',
      name: 'stop test',
      folder: 'ch_stop',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'dc:stop',
      sender: 'u1',
      senderName: 'Alice',
      content: 'queued follow-up',
      timestamp: new Date().toISOString(),
    });
    abortRpcSessionMock.mockReturnValue(true);

    const result = queue.stopChannelTask('dc:stop');

    expect(abortRpcSessionMock).toHaveBeenCalledWith('ch_stop');
    expect(result).toEqual({ aborted: true, cleared: 0, preservedSession: true });
    expect(db.channelsWithPending()).toContain('dc:stop');
  });
});
