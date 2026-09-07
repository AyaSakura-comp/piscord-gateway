/**
 * Persistent pi RPC sessions (one long-lived `pi --mode rpc` child per channel).
 *
 * The one-shot print path (invoke.ts) spawns a fresh `pi -p` per message and
 * can only "interrupt" by killing the process. RPC mode instead keeps the agent
 * alive and speaks a JSONL protocol on stdin/stdout, which lets a message that
 * arrives mid-turn be **steered** into the running turn (redirect the agent
 * in-flight) instead of stopping it.
 *
 * Protocol (verified against @earendil-works/pi-coding-agent):
 *   stdin  : {type:"prompt"|"steer"|"abort", message?, id?}\n
 *   stdout : AgentSessionEvent objects (same shape as `--mode json`), plus
 *            {type:"response",command,success}, {type:"extension_ui_request",…}
 *   turn lifecycle: agent_start → turn_start → message_* → turn_end → agent_end
 *
 * Events are the *same* objects the print path emits, so the existing
 * createEventStreamer and final-text extraction are reused verbatim.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { resolveChannelSessionDir } from '../session/path.js';
import {
  formatStreamError,
  recoverTextFromParserError,
  resolvePiSpawn,
} from './invoke.js';
import type { AgentResult } from '../types.js';

export interface RpcSessionOpts {
  model?: string;
  thinking?: string;
  cwd?: string;
}

export interface RpcSteerHooks {
  onSettled: () => void;
  onFailed: (error: Error) => void;
}

interface PendingTurn {
  onEvent?: (event: any) => void | Promise<void>;
  inAssistant: boolean;
  currentAssistantText: string;
  lastAssistantText: string;
  lastError: string;
  userPromptPersisted: boolean;
  abortRequested: boolean;
  abortSent: boolean;
  aborted: boolean;
  steerHooks: RpcSteerHooks[];
  resolve: (result: AgentResult) => void;
}

class RpcSession {
  private proc?: ChildProcess;
  private stdoutBuf = '';
  private streaming = false;
  private pending?: PendingTurn;
  private idleTimer?: NodeJS.Timeout;
  private starting = false;

  constructor(
    private readonly folder: string,
    private readonly opts: RpcSessionOpts,
  ) {}

  getOpts(): RpcSessionOpts {
    return { ...this.opts };
  }

  matchesOpts(opts: RpcSessionOpts): boolean {
    const currentCwd = this.opts.cwd || config.piCwd;
    const nextCwd = opts.cwd || config.piCwd;
    return (
      (this.opts.model ?? '') === (opts.model ?? '') &&
      (this.opts.thinking ?? '') === (opts.thinking ?? '') &&
      currentCwd === nextCwd
    );
  }

  get isStreaming(): boolean {
    // A prompt is steer-able as soon as it has been written to the RPC process.
    // Waiting for agent_start leaves a startup race where a rapid follow-up
    // falls back to killing the process before the first prompt is persisted.
    return this.streaming || Boolean(this.pending);
  }

  get isAlive(): boolean {
    return Boolean(this.proc) && !this.proc!.killed;
  }

  private ensureProc(): void {
    if (this.isAlive) return;
    const dir = resolveChannelSessionDir(this.folder);
    mkdirSync(dir, { recursive: true });
    const args = ['--mode', 'rpc', '--session-dir', dir, '--continue'];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.thinking) args.push('--thinking', this.opts.thinking);
    if (config.piExtraFlags) args.push(...config.piExtraFlags.split(/\s+/).filter(Boolean));
    const { bin, args: spawnArgs } = resolvePiSpawn(config.piBin, args);
    const proc = spawn(bin, spawnArgs, {
      cwd: this.opts.cwd || config.piCwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.stdoutBuf = '';
    this.streaming = false;
    proc.stdout!.on('data', (d: Buffer) => this.onData(d));
    proc.stderr!.on('data', (d: Buffer) =>
      logger.debug({ folder: this.folder, stderr: d.toString().slice(0, 200) }, 'rpc stderr'),
    );
    proc.on('exit', (code) => this.onExit(code));
    proc.on('error', (err) => {
      logger.error({ folder: this.folder, err: err.message }, 'rpc session spawn error');
      this.onExit(null);
    });
    logger.info({ folder: this.folder }, 'Started persistent RPC session');
  }

  private onData(d: Buffer): void {
    this.stdoutBuf += d.toString();
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    // Command acks and extension UI prompts are protocol noise (the latter are
    // non-blocking — turns complete without a client response).
    if (event.type === 'response' || event.type === 'extension_ui_request') return;

    const turn = this.pending;
    if (turn) {
      // Capture in-stream provider errors (e.g. Codex 429) so an empty turn
      // surfaces the error instead of "(empty response)".
      const errMsg = event?.message?.errorMessage ?? event?.errorMessage;
      if (typeof errMsg === 'string' && errMsg) turn.lastError = errMsg;

      // Final assistant text — same accumulation as the print path.
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        turn.inAssistant = true;
        turn.currentAssistantText = '';
      } else if (event.type === 'message_end' && event.message?.role === 'user') {
        turn.userPromptPersisted = true;
        if (turn.abortRequested) this.sendAbort(turn);
      } else if (event.type === 'message_end' && turn.inAssistant) {
        const fromMessage = (event.message?.content ?? [])
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text)
          .join('');
        turn.lastAssistantText = fromMessage || turn.currentAssistantText;
        turn.aborted = event.message?.stopReason === 'aborted';
        turn.inAssistant = false;
      } else if (event.type === 'message_update' && turn.inAssistant) {
        const ev = event.assistantMessageEvent;
        if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
          turn.currentAssistantText += ev.delta;
        }
      }

      if (turn.onEvent) Promise.resolve(turn.onEvent(event)).catch(() => {});
    }

    if (event.type === 'agent_start' || event.type === 'turn_start') this.streaming = true;
    // agent_end only closes one low-level run. Retry, compaction, or a queued
    // steering continuation may start another run immediately afterward.
    // agent_settled is the authoritative end of the whole session-level turn.
    if (event.type === 'agent_settled') {
      this.streaming = false;
      this.finishTurn();
    }
  }

  private finishTurn(): void {
    const turn = this.pending;
    if (!turn) return;
    this.pending = undefined;
    for (const hooks of turn.steerHooks) {
      try {
        hooks.onSettled();
      } catch (error) {
        logger.warn({ folder: this.folder, err: String(error) }, 'RPC steer settle hook failed');
      }
    }
    if (turn.aborted) {
      turn.resolve({ ok: false, text: '', error: 'Agent invocation aborted', aborted: true });
    } else if (!turn.lastAssistantText && turn.lastError) {
      const recoveredText = recoverTextFromParserError(turn.lastError);
      if (recoveredText) {
        logger.warn(
          { folder: this.folder, error: turn.lastError.slice(0, 120) },
          'Recovered assistant text from llama.cpp parser error',
        );
        turn.resolve({ ok: true, text: recoveredText });
      } else {
        turn.resolve({ ok: false, text: '', error: formatStreamError(turn.lastError) });
      }
    } else {
      turn.resolve({ ok: true, text: turn.lastAssistantText || '(empty response)' });
    }
    this.armIdleTimer();
  }

  private onExit(code: number | null): void {
    logger.info({ folder: this.folder, code }, 'RPC session exited');
    this.proc = undefined;
    this.streaming = false;
    this.clearIdleTimer();
    // A turn in flight when the process died resolves as an error so the caller
    // isn't left hanging; the next prompt respawns the session.
    if (this.pending) {
      const turn = this.pending;
      const error = new Error(`pi rpc session exited (code ${code})`);
      this.pending = undefined;
      for (const hooks of turn.steerHooks) {
        try {
          hooks.onFailed(error);
        } catch (hookError) {
          logger.warn({ folder: this.folder, err: String(hookError) }, 'RPC steer failure hook failed');
        }
      }
      turn.resolve({ ok: false, text: '', error: error.message });
    }
  }

  private send(cmd: object): void {
    this.proc?.stdin?.write(JSON.stringify(cmd) + '\n');
  }

  private sendAbort(turn: PendingTurn): void {
    if (turn.abortSent) return;
    turn.abortSent = true;
    this.send({ type: 'abort' });
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.isAlive && !this.streaming && !this.pending) {
        logger.info({ folder: this.folder }, 'RPC session idle timeout — shutting down');
        this.close();
      }
    }, config.rpcIdleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Run a new turn. Must only be called when not already streaming. */
  prompt(
    message: string,
    onEvent?: (event: any) => void | Promise<void>,
  ): Promise<AgentResult> {
    this.ensureProc();
    this.clearIdleTimer();
    return new Promise<AgentResult>((resolve) => {
      this.pending = {
        onEvent,
        inAssistant: false,
        currentAssistantText: '',
        lastAssistantText: '',
        lastError: '',
        userPromptPersisted: false,
        abortRequested: false,
        abortSent: false,
        aborted: false,
        steerHooks: [],
        resolve,
      };
      this.send({ type: 'prompt', message });
    });
  }

  /** Inject a message into the running turn (redirect the agent in-flight). */
  steer(message: string, hooks?: RpcSteerHooks): boolean {
    if (!this.isAlive || !this.pending) return false;
    if (hooks) this.pending.steerHooks.push(hooks);
    this.send({ type: 'steer', message });
    return true;
  }

  /** Abort after Pi has persisted the active user prompt in the session. */
  requestAbort(): boolean {
    const turn = this.pending;
    if (!this.isAlive || !turn) return false;
    turn.abortRequested = true;
    if (turn.userPromptPersisted) this.sendAbort(turn);
    return true;
  }

  close(): void {
    this.clearIdleTimer();
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    try {
      proc.stdin?.end();
    } catch {
      // ignore
    }
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 3000).unref?.();
  }
}

const sessions = new Map<string, RpcSession>();

function keyFor(folder: string): string {
  return folder;
}

/** Get (or lazily create) the persistent RPC session for a channel folder. */
export function getRpcSession(folder: string, opts: RpcSessionOpts): RpcSession {
  const key = keyFor(folder);
  let session = sessions.get(key);
  if (session && !session.matchesOpts(opts)) {
    logger.info(
      { folder, oldOpts: session.getOpts(), newOpts: opts },
      'Closing RPC session due to options change',
    );
    session.close();
    sessions.delete(key);
    session = undefined;
  }
  if (!session) {
    session = new RpcSession(folder, opts);
    sessions.set(key, session);
  }
  return session;
}

/** True if a live RPC session for this folder is mid-turn (steer-able). */
export function rpcSessionIsStreaming(folder: string): boolean {
  const session = sessions.get(keyFor(folder));
  return Boolean(session && session.isAlive && session.isStreaming);
}

/** Steer a message into the running turn. Returns false if not steer-able. */
export function steerRpcSession(
  folder: string,
  message: string,
  hooks?: RpcSteerHooks,
): boolean {
  const session = sessions.get(keyFor(folder));
  if (!session || !session.isAlive || !session.isStreaming) return false;
  return session.steer(message, hooks);
}

/** Abort an active RPC turn without terminating its persistent Pi process. */
export function abortRpcSession(folder: string): boolean {
  const session = sessions.get(keyFor(folder));
  return session?.requestAbort() ?? false;
}

/**
 * Terminate the persistent Pi process for one channel and forget it.
 *
 * Required whenever the channel's session directory changes underneath it.
 * A warm RPC session was started with `--session-dir <dir>` and has already
 * resolved a session file inside it; /new renames that directory to
 * `<folder>__archived_<ts>`, so the next prompt into the surviving process
 * opens a path that no longer exists and the turn dies with
 * "ENOENT: no such file or directory, open '.../<uuid>.jsonl'".
 */
export function closeRpcSession(folder: string): boolean {
  const key = keyFor(folder);
  const session = sessions.get(key);
  if (!session) return false;
  session.close();
  sessions.delete(key);
  return true;
}

/** Shut down every RPC session (graceful gateway stop). */
export function closeAllRpcSessions(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}
