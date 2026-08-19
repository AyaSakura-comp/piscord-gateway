import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SLASH = readFileSync(resolve(__dirname, '../src/discord/slash-commands.ts'), 'utf8');
const RPC = readFileSync(resolve(__dirname, '../src/agent/rpc-session.ts'), 'utf8');

/**
 * /new renames the channel's session directory to <folder>__archived_<ts>. A
 * warm RPC pi process was started with --session-dir and has already resolved a
 * session file inside it, so rotating underneath it makes the next prompt die
 * with "ENOENT: no such file or directory, open '.../<uuid>.jsonl'" — observed
 * live on this gateway.
 */
describe('/new with a warm RPC session', () => {
  it('exposes a way to close one channel’s RPC session', () => {
    expect(RPC).toContain('export function closeRpcSession(');
    // Must drop it from the map, not just kill the process, or the next call
    // hands back a dead session.
    const body = RPC.slice(RPC.indexOf('export function closeRpcSession('));
    expect(body.slice(0, 400)).toContain('sessions.delete(');
  });

  it('closes it BEFORE rotating the directory', () => {
    const close = SLASH.indexOf('closeRpcSession(channel.folder)');
    const rotate = SLASH.indexOf('rotateChannelSessionDir(channel.folder)');
    expect(close).toBeGreaterThan(-1);
    expect(rotate).toBeGreaterThan(-1);
    expect(close).toBeLessThan(rotate);
  });

  it('does not touch the RPC session on the refusal path', () => {
    // The in-flight guard returns before any of this; a reset denied mid-run
    // must not kill a healthy session.
    const handler = SLASH.slice(SLASH.indexOf('async function handleNew('));
    const guard = handler.indexOf('currently processing a message');
    const close = handler.indexOf('closeRpcSession(channel.folder)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(close);
  });
});
