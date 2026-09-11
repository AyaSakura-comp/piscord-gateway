import { afterEach, describe, expect, it, vi } from 'vitest';

const { getChannelMock, registerChannelMock } = vi.hoisted(() => ({
  getChannelMock: vi.fn(),
  registerChannelMock: vi.fn(),
}));

vi.mock('../src/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db.js')>()),
  getChannel: getChannelMock,
  registerChannel: registerChannelMock,
}));

const parent = {
  jid: 'dc:parent',
  name: 'Guild #channel',
  folder: 'ch_parent',
  requiresTrigger: true,
  isMain: false,
  modelOverride: '',
  thinkingOverride: '',
  cwdOverride: '',
  thinkingToolStatusEnabled: true,
};

afterEach(() => {
  vi.clearAllMocks();
});

async function openAutoThread() {
  return (await import('../src/discord/client.js')).openAutoThread;
}

describe('auto-thread fallback', () => {
  it('routes into the thread once its channel row is registered', async () => {
    getChannelMock.mockReturnValue(undefined);
    const message = {
      startThread: vi.fn().mockResolvedValue({ id: 'thread-1', name: 'request' }),
    } as any;

    const target = await (await openAutoThread())(message, parent as any, 'request');

    expect(registerChannelMock).toHaveBeenCalledOnce();
    expect(target).toBe('dc:thread-1');
  });

  it('stays in the parent channel when the thread row cannot be registered', async () => {
    // A rejected channels insert (e.g. a stray UNIQUE index left by another
    // gateway's migration) used to leave the caller routing into the brand new
    // thread jid anyway. The queue then found no channel row, logged "Channel
    // disappeared during processing" and answered nothing at all.
    getChannelMock.mockReturnValue(undefined);
    registerChannelMock.mockImplementation(() => {
      throw new Error('UNIQUE constraint failed: channels.storage_token');
    });
    const message = {
      startThread: vi.fn().mockResolvedValue({ id: 'thread-2', name: 'request' }),
    } as any;

    const target = await (await openAutoThread())(message, parent as any, 'request');

    expect(target).toBeNull();
  });

  it('stays in the parent channel when Discord refuses to open the thread', async () => {
    const message = {
      startThread: vi.fn().mockRejectedValue(new Error('Missing Permissions')),
    } as any;

    const target = await (await openAutoThread())(message, parent as any, 'request');

    expect(target).toBeNull();
  });
});
