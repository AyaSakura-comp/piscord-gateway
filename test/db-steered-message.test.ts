import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  for (const key of ['DB_PATH', 'HOME', 'PIDG_CONFIG']) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable steered messages', () => {
  it('recovers an unsettled steered row to the normal pending queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piscord-db-steer-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();

    try {
      const rowid = db.enqueueMessage(
        {
          channelJid: 'dc:steer',
          sender: 'u1',
          senderName: 'Alice',
          content: 'durable correction',
          timestamp: new Date().toISOString(),
        },
        { status: 'steered' },
      );

      expect(typeof rowid).toBe('number');
      expect(readStatus(dbPath, rowid)).toBe('steered');
      expect(db.channelsWithPending()).not.toContain('dc:steer');
      expect(db.recoverStuckMessages()).toBe(1);
      expect(readStatus(dbPath, rowid)).toBe('pending');
      expect(db.channelsWithPending()).toContain('dc:steer');
    } finally {
      db.closeDb();
    }
  });
});

function readStatus(path: string, rowid: number): string {
  const inspect = new Database(path, { readonly: true });
  const row = inspect.prepare('select status from message_queue where rowid = ?').get(rowid) as {
    status: string;
  };
  inspect.close();
  return row.status;
}
