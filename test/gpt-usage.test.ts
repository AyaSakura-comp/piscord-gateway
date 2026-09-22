import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatGptUsage, getGptUsage } from '../src/gpt-usage.js';

const tempDirs: string[] = [];

function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

async function authFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'piscord-gpt-usage-'));
  tempDirs.push(dir);
  const path = join(dir, 'auth.json');
  await writeFile(
    path,
    JSON.stringify({
      'openai-codex': {
        type: 'oauth',
        access: jwt('account-123'),
        refresh: 'refresh-token',
        expires: Date.now() + 3_600_000,
      },
    }),
  );
  return path;
}

function usageHeaders(): HeadersInit {
  return {
    'x-codex-plan-type': 'pro',
    'x-codex-active-limit': 'premium',
    'x-codex-primary-used-percent': '37',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-at': '1786429200',
    'x-codex-primary-reset-after-seconds': '3600',
    'x-codex-secondary-used-percent': '52',
    'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-reset-at': '1787000000',
    'x-codex-secondary-reset-after-seconds': '570800',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('getGptUsage', () => {
  it('queries Codex usage directly from pi OAuth credentials', async () => {
    const authPath = await authFile();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(init?.headers).toMatchObject({
        Authorization: expect.stringMatching(/^Bearer /),
        'chatgpt-account-id': 'account-123',
        originator: 'pi',
      });
      signal = init?.signal ?? undefined;
      return new Response(null, { status: 429, headers: usageHeaders() });
    });

    const usage = await getGptUsage({ authPath, fetchImpl: fetchImpl as typeof fetch });

    expect(signal?.aborted).toBe(true);
    expect(usage).toMatchObject({
      plan: 'pro',
      activeLimit: 'premium',
      httpStatus: 429,
      primary: { usedPercent: 37, windowMinutes: 300 },
      secondary: { usedPercent: 52, windowMinutes: 10080 },
    });
  });
});

describe('formatGptUsage', () => {
  it('renders both quota windows and the 429 warning', () => {
    const output = formatGptUsage({
      plan: 'pro',
      activeLimit: 'premium',
      credits: { balance: null, hasCredits: null, unlimited: null },
      primary: {
        usedPercent: 37,
        windowMinutes: 300,
        resetAt: 1786429200,
        resetAfterSeconds: 3600,
      },
      secondary: {
        usedPercent: 52,
        windowMinutes: 10080,
        resetAt: 1787000000,
        resetAfterSeconds: 570800,
      },
      httpStatus: 429,
    });

    expect(output).toContain('短窗 (5 小時 滾動)');
    expect(output).toContain('已用 37%  剩 63%');
    expect(output).toContain('長窗 (7 天)');
    expect(output).toContain('目前短窗已達上限 (429)');
  });
});
