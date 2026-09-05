/**
 * Discovery and execution runner for Pi extension slash commands in Discord.
 */

import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { isChannelProcessing } from './queue.js';
import { computeEffectiveChannelSettings } from './channel-settings.js';
import { resolvePiSpawn } from './invoke.js';
import { resolveChannelSessionDir, resolveLatestChannelSessionFile } from '../session/path.js';
import type { RegisteredChannel } from '../types.js';

export interface CommandSpec {
  name: string;
  description: string;
  arg?: {
    name: string;
    kind: string;
    required: boolean;
  };
}

export interface CommandResult {
  ok: boolean;
  text: string;
}

interface PiRpcCommandEntry {
  name: string;
  description?: string;
  source?: string;
}

interface PiRpcResponse {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  message?: string;
  error?: string;
  data?: {
    commands?: PiRpcCommandEntry[];
  };
}

const EXPANDED_EXTENSION_SUBCOMMANDS: Record<string, CommandSpec[]> = {
  kv: [
    { name: 'kv status', description: 'Show KV cache status, active tokens, and snapshot table' },
    {
      name: 'kv save',
      description: 'Save current session KV snapshot (optional custom name)',
      arg: { name: 'name', kind: 'text', required: false },
    },
    {
      name: 'kv restore',
      description: 'Restore session or named snapshot',
      arg: { name: 'name', kind: 'text', required: false },
    },
    { name: 'kv prune', description: 'Enforce LRU session count and storage quotas' },
    { name: 'kv base-update', description: 'Re-evaluate and cache Golden Base System Prompt' },
    { name: 'kv help', description: 'Show KV cache manager help' },
  ],
};

export async function discoverPiExtensionCommands(timeoutMs = 5000): Promise<CommandSpec[]> {
  return new Promise<CommandSpec[]>((resolve) => {
    const rpcArgs = ['--mode', 'rpc'];
    const { bin: rpcBin, args: resolvedArgs } = resolvePiSpawn(config.piBin, rpcArgs);

    let finished = false;
    let proc: ReturnType<typeof spawn> | undefined;

    const cleanup = () => {
      if (proc) {
        try {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGTERM');
          }
        } catch {
          // Ignore
        }
      }
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      logger.warn('Timed out probing Pi extension commands');
      resolve(getFallbackExtensionCommands());
    }, timeoutMs);

    try {
      proc = spawn(rpcBin, resolvedArgs, {
        cwd: config.piCwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stderr?.on('data', () => {
        // Drain stderr to prevent blocking the subprocess
      });

      let stdoutBuf = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        let newlineIndex: number;
        while ((newlineIndex = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, newlineIndex).trim();
          stdoutBuf = stdoutBuf.slice(newlineIndex + 1);
          if (!line) continue;

          try {
            const msg: PiRpcResponse = JSON.parse(line);
            if (msg.type === 'response' && msg.id === 'probe_ext_commands') {
              finished = true;
              clearTimeout(timer);
              cleanup();

              const rawCommands = msg.data?.commands || [];
              const specs: CommandSpec[] = [];
              const seen = new Set<string>();

              for (const cmd of rawCommands) {
                if (cmd.source !== 'extension') continue;
                const baseName = cmd.name.trim();
                if (!baseName || seen.has(baseName)) continue;

                const subSpecs = EXPANDED_EXTENSION_SUBCOMMANDS[baseName];
                if (subSpecs) {
                  for (const sub of subSpecs) {
                    if (!seen.has(sub.name)) {
                      specs.push(sub);
                      seen.add(sub.name);
                    }
                  }
                }

                specs.push({
                  name: baseName,
                  description: cmd.description || `Execute /${baseName} extension command`,
                  arg: { name: 'args', kind: 'text', required: false },
                });
                seen.add(baseName);
              }

              resolve(specs);
              return;
            }
          } catch {
            // Ignore parse errors
          }
        }
      });

      proc.on('error', (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cleanup();
        logger.warn({ err: err.message }, 'Failed to spawn Pi for extension command probe');
        resolve(getFallbackExtensionCommands());
      });

      proc.on('exit', () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve(getFallbackExtensionCommands());
        }
      });

      proc.stdin?.write(
        JSON.stringify({ type: 'get_commands', id: 'probe_ext_commands' }) + '\n',
      );
    } catch (err: any) {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        cleanup();
        logger.warn({ err: err.message }, 'Error during extension command discovery');
        resolve(getFallbackExtensionCommands());
      }
    }
  });
}

export function getFallbackExtensionCommands(): CommandSpec[] {
  return [
    ...(EXPANDED_EXTENSION_SUBCOMMANDS.kv || []),
    {
      name: 'kv',
      description: 'Manage llama.cpp slot KV cache snapshots and lifecycle',
      arg: { name: 'args', kind: 'text', required: false },
    },
  ];
}

export async function executePiExtensionCommand(
  channel: RegisteredChannel,
  command: string,
  args: Record<string, string> = {},
): Promise<CommandResult> {
  if (isChannelProcessing(channel.jid)) {
    return {
      ok: false,
      text: 'This channel is currently processing a message. Wait for it to finish, then try again.',
    };
  }

  const effective = computeEffectiveChannelSettings(channel);
  const sessionFile = resolveLatestChannelSessionFile(channel.folder);
  const sessionDir = resolveChannelSessionDir(channel.folder);

  const rpcArgs = ['--mode', 'rpc'];
  if (sessionFile) {
    rpcArgs.push('--session', sessionFile);
  } else {
    rpcArgs.push('--session-dir', sessionDir);
  }

  const { bin: rpcBin, args: resolvedArgs } = resolvePiSpawn(config.piBin, rpcArgs);

  const argParts = Object.values(args)
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  const promptMessage = `/${command}${argParts.length > 0 ? ' ' + argParts.join(' ') : ''}`;

  return new Promise<CommandResult>((resolve) => {
    let finished = false;
    let promptSent = false;
    const collectedNotifies: string[] = [];
    let assistantText = '';
    let proc: ReturnType<typeof spawn> | undefined;
    let sendTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (proc) {
        try {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGTERM');
            setTimeout(() => {
              try {
                if (proc?.exitCode === null && proc?.signalCode === null) {
                  proc.kill('SIGKILL');
                }
              } catch {
                // Ignore
              }
            }, 1000).unref?.();
          }
        } catch {
          // Ignore
        }
      }
    };

    const finish = (result: CommandResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      cleanup();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, text: `⚠️ Command /${command} timed out.` });
    }, 20_000);

    try {
      proc = spawn(rpcBin, resolvedArgs, {
        cwd: effective.effectiveCwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stderr?.on('data', () => {
        // Drain stderr to prevent blocking
      });

      let stdoutBuf = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        let newlineIndex: number;
        while ((newlineIndex = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, newlineIndex).trim();
          stdoutBuf = stdoutBuf.slice(newlineIndex + 1);
          if (!line) continue;

          try {
            const event = JSON.parse(line);

            if (
              promptSent &&
              event.type === 'extension_ui_request' &&
              event.method === 'notify' &&
              typeof event.message === 'string'
            ) {
              collectedNotifies.push(event.message);
            }

            if (
              promptSent &&
              event.type === 'message_update' &&
              event.assistantMessageEvent?.type === 'text_delta' &&
              typeof event.assistantMessageEvent.delta === 'string'
            ) {
              assistantText += event.assistantMessageEvent.delta;
            }

            if (promptSent && event.type === 'message_end' && event.message?.role === 'assistant') {
              const fromParts = (event.message.content || [])
                .filter((c: any) => c?.type === 'text')
                .map((c: any) => c.text)
                .join('');
              if (fromParts) assistantText = fromParts;
            }

            if (event.type === 'response' && event.id === 'ext_cmd_run') {
              const text =
                collectedNotifies.join('\n\n').trim() ||
                assistantText.trim() ||
                event.message ||
                (event.success ? 'Command executed successfully.' : 'Command failed.');

              finish({
                ok: Boolean(event.success),
                text,
              });
              return;
            }
          } catch {
            // Ignore parse errors
          }
        }
      });

      proc.on('error', (err) => {
        finish({ ok: false, text: `⚠️ Failed to execute extension command: ${err.message}` });
      });

      proc.on('exit', (code) => {
        if (!finished) {
          const text =
            collectedNotifies.join('\n\n').trim() ||
            assistantText.trim() ||
            `Process exited (code ${code})`;
          finish({
            ok: code === 0,
            text,
          });
        }
      });

      sendTimer = setTimeout(() => {
        if (finished || !proc?.stdin) return;
        promptSent = true;
        proc.stdin.write(
          JSON.stringify({
            type: 'prompt',
            message: promptMessage,
            id: 'ext_cmd_run',
          }) + '\n',
        );
      }, 350);
    } catch (err: any) {
      finish({ ok: false, text: `⚠️ Failed to start extension command process: ${err.message}` });
    }
  });
}
