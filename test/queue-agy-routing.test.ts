import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const QUEUE = readFileSync(resolve(__dirname, '../src/agent/queue.ts'), 'utf8');
const CATALOG = readFileSync(resolve(__dirname, '../src/agent/model-catalog.ts'), 'utf8');

/**
 * agy has no RPC/steer mode, so the routing test must sit before the RPC
 * branch; otherwise an agy model would be handed to a pi RPC session and the
 * bridge silently bypassed.
 */
describe('agy routing in the queue', () => {
  it('decides on the model ref before the RPC branch is taken', () => {
    const useAgy = QUEUE.indexOf('const useAgy = isAgyModelRef(');
    const call = QUEUE.indexOf('await invokeAgy(');
    const rpc = QUEUE.indexOf('await getRpcSession(');
    expect(useAgy).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(rpc);
  });

  it('passes the ref through, not a stripped id', () => {
    const block = QUEUE.slice(QUEUE.indexOf('await invokeAgy('), QUEUE.indexOf('await getRpcSession('));
    expect(block).toContain('model: effective.rawModelRef');
    // Attachments and abort must reach agy too, or uploads and /pi stop break.
    expect(block).toContain('attachments');
    expect(block).toContain('signal');
  });

  it('merges the agy catalog into the model list', () => {
    expect(CATALOG).toContain('cachedAgyModels()');
    expect(CATALOG).toContain('listAgyModels(');
  });
});
