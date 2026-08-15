import { describe, expect, it } from 'vitest';
import type { RegisteredChannel } from '../src/types.js';
import { createAutoThreadRegistration } from '../src/discord/client.js';

describe('auto-thread settings', () => {
  it('starts every new thread at medium thinking instead of inheriting the parent level', () => {
    const parent: RegisteredChannel = {
      jid: 'dc:parent',
      name: 'Guild #channel',
      folder: 'ch_parent',
      requiresTrigger: true,
      isMain: false,
      modelOverride: 'local-llama/qwen3.6-35b-q4',
      thinkingOverride: 'xhigh',
      cwdOverride: '/workspace',
    };

    const thread = createAutoThreadRegistration(parent, 'thread-123', 'request');

    expect(thread).toMatchObject({
      jid: 'dc:thread-123',
      modelOverride: parent.modelOverride,
      thinkingOverride: 'medium',
      cwdOverride: parent.cwdOverride,
    });
    expect(parent.thinkingOverride).toBe('xhigh');
  });
});
