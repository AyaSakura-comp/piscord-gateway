import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = mkdtempSync(resolve(tmpdir(), 'piscord-live-page-'));
const assets = resolve(root, 'public');
mkdirSync(resolve(assets, 'vendor'), { recursive: true });
writeFileSync(resolve(assets, 'app.css'), 'body{}');
writeFileSync(resolve(root, 'secret.txt'), 'nope');
const PORT = 18_792 + Math.floor(Math.random() * 500);
process.env.LIVE_PAGE_PUBLIC_URL = `http://127.0.0.1:${PORT}/`;
process.env.LIVE_PAGE_PORT = String(PORT);
process.env.LIVE_PAGE_DIR = resolve(root, 'pages');
process.env.LIVE_PAGE_ASSETS_DIR = assets;
process.env.LIVE_PAGE_MODE = 'auto';

const live = await import('../src/live-page/server.js');
const base = `http://127.0.0.1:${PORT}`;
const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |\n';
let stop = () => {};

beforeAll(async () => {
  stop = await live.startLivePageServer();
});
afterAll(() => stop());

const idOf = (url: string) => url.split('/r/')[1];

describe('needsLivePage', () => {
  it('links what Discord renders badly and nothing else', () => {
    expect(live.needsLivePage('hello **world**')).toBe(false);
    expect(live.needsLivePage(`intro\n\n${TABLE}`)).toBe(true);
    expect(live.needsLivePage('a | b but no separator')).toBe(false);
    expect(live.needsLivePage('$$\nx^2\n$$')).toBe(true);
    expect(live.needsLivePage('```mermaid\ngraph TD\n```')).toBe(true);
    expect(live.needsLivePage('x'.repeat(2001))).toBe(true);
  });
});

describe('live page lifecycle', () => {
  it('links once, as soon as a table arrives, and keeps streaming', async () => {
    live.beginLivePage('dc:1');
    expect(live.updateLivePage('dc:1', 'Here is a table:\n\n')).toBeNull();
    const url = live.updateLivePage('dc:1', `Here is a table:\n\n${TABLE}`);
    expect(url).toMatch(new RegExp(`^${base}/r/[A-Za-z0-9_-]{22}$`));
    expect(live.updateLivePage('dc:1', `Here is a table:\n\n${TABLE}\nmore`)).toBeNull();

    const html = await (await fetch(url!)).text();
    expect(html).toContain('og:title');
    expect(html).toContain("from '/lobehub-rich.js'");
    expect(html).toContain('生成中');

    // SSE: the first frame is the current text, the last one marks completion.
    const res = await fetch(`${url}/events`);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('more');
    expect(live.completeLivePage('dc:1', `Here is a table:\n\n${TABLE}\nmore!`)).toBeNull();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('"complete":true');
    expect(rest).toContain('more!');

    const md = await (await fetch(`${url}.md`)).text();
    expect(md).toBe(`Here is a table:\n\n${TABLE}\nmore!`);
  });

  it('keeps the fuller streamed text when the final text is only its tail', () => {
    live.beginLivePage('dc:2');
    const url = live.updateLivePage('dc:2', `run one\n\n${TABLE}\nrun two`)!;
    live.completeLivePage('dc:2', 'run two');
    return fetch(`${url}.md`)
      .then((r) => r.text())
      .then((md) => expect(md).toBe(`run one\n\n${TABLE}\nrun two`));
  });

  it('does not link or keep plain replies', () => {
    live.beginLivePage('dc:3');
    expect(live.updateLivePage('dc:3', 'just words')).toBeNull();
    expect(live.completeLivePage('dc:3', 'just words')).toBeNull();
  });

  it('links an unstreamed reply once, even if it is settled twice', () => {
    const text = `whole\n\n${TABLE}`;
    const url = live.completeLivePage('dc:4', text);
    expect(url).toMatch(/\/r\//);
    expect(live.completeLivePage('dc:4', text)).toBeNull();
  });

  it('serves a finished page from disk after a restart', async () => {
    const id = 'A'.repeat(22);
    writeFileSync(
      resolve(root, 'pages', `${id}.json`),
      JSON.stringify({ text: 'saved', complete: false, createdAt: 1, updatedAt: 1 }),
    );
    const html = await (await fetch(`${base}/r/${id}`)).text();
    expect(html).toContain('已完成');
    expect(html).toContain('"text":"saved"');
  });
});

describe('http surface', () => {
  it('serves only the renderer assets', async () => {
    expect((await fetch(`${base}/app.css`)).status).toBe(200);
    expect((await fetch(`${base}/secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/vendor/../../secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/vendor/%2e%2e/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/r/${'B'.repeat(22)}`)).status).toBe(404);
  });

  it('cannot be broken out of by the reply text', () => {
    const html = live.renderPageHtml({
      id: idOf(`${base}/r/${'C'.repeat(22)}`),
      text: '</script><script>alert(1)</script> "quoted"',
      complete: false,
    });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toMatch(/og:description" content="[^"]*&quot;quoted&quot;/);
  });

  it('serves the local pictures a reply names, and nothing else', async () => {
    const png = resolve(root, 'pic.png');
    writeFileSync(png, 'PNGDATA');
    writeFileSync(resolve(root, 'other.png'), 'OTHER');
    live.beginLivePage('dc:img');
    const url = live.updateLivePage('dc:img', `圖：\n[[image: ${png}]]\n\n${TABLE}`)!;
    const html = await (await fetch(url.replace(/^.*\/r\//, `${base}/r/`))).text();
    const img = /\/r\/[\w-]{22}\/img\/[0-9a-f]{20}/.exec(html)?.[0];
    expect(img).toBeTruthy();
    expect(html).not.toContain('[[image:');
    const res = await fetch(`${base}${img}`);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('PNGDATA');
    expect((await fetch(`${base}${img!.replace(/img\/.*/, `img/${'0'.repeat(20)}`)}`)).status).toBe(
      404,
    );
  });
});
