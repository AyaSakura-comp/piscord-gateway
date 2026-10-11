/**
 * Render one Markdown block (table, display math, mermaid) to a PNG.
 *
 * A single headless Chrome tab stays open on the live-page server's /snap
 * page, which carries piweb's renderer, so an image looks exactly like the web
 * page and a render costs a fraction of a second instead of a browser launch.
 * Renders are serialized; a stuck or crashed browser is thrown away and the
 * next render starts a fresh one.
 */
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { config } from '../config.js';
import { logger } from '../logger.js';

const RENDER_TIMEOUT_MS = 20_000;
/** React roots accumulate in the tab; recycle it now and then. */
const RENDERS_PER_PAGE = 60;

let browser: Browser | undefined;
let page: Page | undefined;
let rendersOnPage = 0;
let chain: Promise<unknown> = Promise.resolve();

function snapUrl(): string {
  const host = config.livePageHost.split(',')[0]?.trim() || '127.0.0.1';
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.livePagePort}/snap`;
}

async function ensurePage(): Promise<Page> {
  if (page && !page.isClosed() && browser?.connected && rendersOnPage < RENDERS_PER_PAGE)
    return page;
  if (page && !page.isClosed()) await page.close().catch(() => undefined);
  if (!browser?.connected) {
    browser = await puppeteer.launch({
      executablePath: config.liveSnapshotChrome,
      headless: true,
      args: ['--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none', '--mute-audio'],
    });
    browser.on('disconnected', () => {
      browser = undefined;
      page = undefined;
    });
  }
  page = await browser.newPage();
  rendersOnPage = 0;
  await page.setViewport({
    width: 1400,
    height: 900,
    deviceScaleFactor: config.liveSnapshotScale,
  });
  await page.goto(snapUrl(), { waitUntil: 'load' });
  await page.waitForFunction('window.__snapReady === true', { timeout: 10_000 });
  return page;
}

async function renderOnce(source: string): Promise<Buffer | null> {
  const tab = await ensurePage();
  rendersOnPage++;
  const ok = await tab.evaluate(
    (src) => (window as any).__snapRender(src) as Promise<boolean>,
    source,
  );
  if (!ok) return null;
  const element = await tab.$('#snap');
  if (!element) return null;
  const png = await element.screenshot({ type: 'png' });
  return Buffer.from(png);
}

async function reset(): Promise<void> {
  const old = browser;
  browser = undefined;
  page = undefined;
  await old?.close().catch(() => undefined);
}

/** PNG of the block, or null when it cannot be rendered (callers fall back to text). */
export function renderBlockImage(source: string): Promise<Buffer | null> {
  const run = chain.then(async () => {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const image = await Promise.race([
        renderOnce(source),
        new Promise<never>((_, fail) => {
          timer = setTimeout(() => fail(new Error('render timed out')), RENDER_TIMEOUT_MS);
        }),
      ]);
      logger.info(
        { ms: Date.now() - started, bytes: image?.length ?? 0 },
        image ? 'live-page: block rendered' : 'live-page: block did not render',
      );
      return image;
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'live-page: block render failed');
      await reset();
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

export async function stopSnapshots(): Promise<void> {
  await reset();
}

/** The page the renderer tab sits on: piweb's renderer, Discord's dark palette. */
export function renderSnapHtml(): string {
  return `<!doctype html>
<html lang="zh-Hant" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<link rel="stylesheet" href="/app.css">
<style>
  html, body { height: auto; overflow: visible; margin: 0; background: #313338; }
  #snap { display: inline-block; max-width: 1360px; padding: 18px 22px; background: #313338; }
  #snap .msg-text { font-size: 17px; line-height: 1.55; white-space: normal; }
  #snap .table-wrap { margin: 0; overflow: visible; }
  #snap table { font-size: 16px; }
  #snap th, #snap td { white-space: normal; max-width: 360px; padding: 8px 12px; vertical-align: top; }
  #snap .katex-display, #snap .math-display { margin: 2px 0; overflow: visible; font-size: 1.45em; }
  #snap .mermaid-wrap { margin: 0; border: 0; background: transparent; }
  #snap .mermaid-header { display: none; }
  #snap .mermaid-scroll { overflow: visible; max-height: none; }
  #snap .mermaid-chart { padding: 4px; }
</style>
</head>
<body>
<div id="snap"></div>
<script src="/vendor/katex/katex.min.js"></script>
<script src="/vendor/highlight/highlight.min.js"></script>
<script type="module">
  import { renderLobehubStatic } from '/lobehub-rich.js';
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__snapRender = async (src) => {
    const snap = document.createElement('div');
    snap.id = 'snap';
    const body = document.createElement('div');
    body.className = 'msg-text';
    snap.append(body);
    document.getElementById('snap').replaceWith(snap);
    renderLobehubStatic(body, src);
    const mermaid = /^\\s*(\`{3,}|~{3,})\\s*mermaid/i.test(src);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
      if (mermaid) {
        const wrap = body.querySelector('.mermaid-wrap');
        if (wrap && !wrap.dataset.renderPending) {
          await document.fonts.ready;
          await frame();
          return !!wrap.querySelector('.mermaid-chart svg');
        }
      } else if (body.firstElementChild) {
        await document.fonts.ready;
        await frame();
        return true;
      }
    }
    return false;
  };
  window.__snapReady = true;
</script>
</body>
</html>
`;
}
