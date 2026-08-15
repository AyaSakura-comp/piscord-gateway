import { describe, expect, it, vi } from 'vitest';

describe('/pi interruption command registration', () => {
  it('registers session-preserving stop separately from queue clearing', async () => {
    const set = vi.fn(async () => undefined);
    const { registerGlobalCommands } = await import('../src/discord/slash-commands.js');

    await registerGlobalCommands({ application: { commands: { set } } } as any);

    const commands = set.mock.calls[0][0] as Array<{
      name: string;
      options?: Array<{ name: string; description: string }>;
    }>;
    const pi = commands.find((command) => command.name === 'pi');
    const stop = pi?.options?.find((option) => option.name === 'stop');
    const clear = pi?.options?.find((option) => option.name === 'clear');

    expect(stop?.description).toContain('preserving the session and queue');
    expect(clear?.description).toContain('Delete queued messages');
  });
});
