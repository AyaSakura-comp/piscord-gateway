import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueMessage, markMessageDone, markMessagePending, steerRpcSession } = vi.hoisted(() => ({
  enqueueMessage: vi.fn(() => 42),
  markMessageDone: vi.fn(),
  markMessagePending: vi.fn(),
  steerRpcSession: vi.fn(),
}));

vi.mock('../src/db.js', () => ({ enqueueMessage, markMessageDone, markMessagePending }));
vi.mock('../src/agent/rpc-session.js', () => ({ steerRpcSession }));

beforeEach(() => vi.clearAllMocks());

describe('durable steering dispatch', () => {
  it('stores the Discord message before steering and marks it done only after settlement', async () => {
    let hooks: { onSettled: () => void; onFailed: (error: Error) => void } | undefined;
    steerRpcSession.mockImplementation((_folder, _message, suppliedHooks) => {
      hooks = suppliedHooks;
      return true;
    });
    const { persistAndSteerMessage } = await import('../src/agent/durable-steer.js');
    const queuedMessage = {
      channelJid: 'dc:1',
      sender: 'u1',
      senderName: 'Alice',
      content: 'correction',
      timestamp: new Date().toISOString(),
      attachments: null,
    };

    expect(persistAndSteerMessage('ch_1', '[Discord user: Alice]\ncorrection', queuedMessage)).toBe(
      true,
    );
    expect(enqueueMessage).toHaveBeenCalledWith(queuedMessage, { status: 'steered' });
    expect(markMessageDone).not.toHaveBeenCalled();

    hooks?.onSettled();
    expect(markMessageDone).toHaveBeenCalledWith(42);
    expect(markMessagePending).not.toHaveBeenCalled();
  });

  it('returns the durable row to pending when steering fails or the RPC process exits', async () => {
    const { persistAndSteerMessage } = await import('../src/agent/durable-steer.js');
    const queuedMessage = {
      channelJid: 'dc:1',
      sender: 'u1',
      senderName: 'Alice',
      content: 'correction',
      timestamp: new Date().toISOString(),
    };

    steerRpcSession.mockReturnValueOnce(false);
    expect(persistAndSteerMessage('ch_1', 'correction', queuedMessage)).toBe(false);
    expect(markMessagePending).toHaveBeenCalledWith(42);

    markMessagePending.mockClear();
    let onFailed: ((error: Error) => void) | undefined;
    steerRpcSession.mockImplementationOnce((_folder, _message, hooks) => {
      onFailed = hooks.onFailed;
      return true;
    });
    expect(persistAndSteerMessage('ch_1', 'correction', queuedMessage)).toBe(true);
    onFailed?.(new Error('rpc crashed'));
    expect(markMessagePending).toHaveBeenCalledWith(42);
  });
});
