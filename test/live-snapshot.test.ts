import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// A real headless Chrome on a stand-in renderer: lobehub-rich.js just draws the
// source into a table, which is all the snapshot code waits for.
const CHROME = process.env.LIVE_SNAPSHOT_CHROME || '/usr/bin/google-chrome';
const root = mkdtempSync(resolve(tmpdir(), 'piscord-live-snapshot-'));
const assets = resolve(root, 'public');
mkdirSync(resolve(assets, 'vendor/katex'), { recursive: true });
mkdirSync(resolve(assets, 'vendor/highlight'), { recursive: true });
writeFileSync(resolve(assets, 'app.css'), 'body{color:#fff}');
writeFileSync(resolve(assets, 'vendor/katex/katex.min.css'), '');
writeFileSync(resolve(assets, 'vendor/katex/katex.min.js'), '');
writeFileSync(resolve(assets, 'vendor/highlight/highlight.min.js'), '');
writeFileSync(
  resolve(assets, 'lobehub-rich.js'),
  "export function renderLobehubStatic(el, src) { const t = document.createElement('table'); t.textContent = src; el.append(t); }",
);
const PORT = 19_400 + Math.floor(Math.random() * 500);
process.env.LIVE_PAGE_PUBLIC_URL = `http://127.0.0.1:${PORT}/`;
process.env.LIVE_PAGE_PORT = String(PORT);
process.env.LIVE_PAGE_HOST = '127.0.0.1';
process.env.LIVE_PAGE_DIR = resolve(root, 'pages');
process.env.LIVE_PAGE_ASSETS_DIR = assets;
process.env.LIVE_SNAPSHOT_SCALE = '1';

const live = await import('../src/live-page/server.js');
const { renderBlockImage } = await import('../src/live-page/snapshot.js');
const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |\n';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
let stop = () => {};

beforeAll(async () => {
  stop = await live.startLivePageServer();
});
afterAll(() => stop());

/** Chrome renderer processes started by this test process, and only those. */
function ourRenderers(): number[] {
  const parent = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      parent.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch {
      /* exited */
    }
  }
  const descends = (pid: number): boolean => {
    for (let p = parent.get(pid); p && p > 1; p = parent.get(p)) if (p === process.pid) return true;
    return false;
  };
  return [...parent.keys()].filter((pid) => {
    try {
      return (
        descends(pid) && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')
      );
    } catch {
      return false;
    }
  });
}

describe.skipIf(!existsSync(CHROME))('renderBlockImage', () => {
  it('renders after the warm tab was killed, without waiting out the timeout', async () => {
    const first = await renderBlockImage(TABLE);
    expect(first?.subarray(0, 4)).toEqual(PNG);

    // earlyoom kills Chrome renderers first when memory runs low.
    const renderers = ourRenderers();
    expect(renderers.length).toBeGreaterThan(0);
    for (const pid of renderers) process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 500));

    const started = Date.now();
    const second = await renderBlockImage(TABLE);
    expect(second?.subarray(0, 4)).toEqual(PNG);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);
});
