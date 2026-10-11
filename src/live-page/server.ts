/**
 * Live web page for a streamed reply.
 *
 * Discord renders neither tables nor math, and splits anything past 2000
 * characters. Each turn's reply is therefore mirrored onto a page that renders
 * it with piweb's own Markdown island (LobeHub Streamdown, per-character fade),
 * and Discord gets a link. The page subscribes over Server-Sent Events and
 * re-renders the whole source on every update, so it keeps up while the model
 * is still writing — "一直改一直改" — and becomes a static page once complete.
 *
 * The renderer is not vendored: the assets are served straight out of piweb's
 * public/ directory (LIVE_PAGE_ASSETS_DIR), so the two front ends stay in step.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { renderSnapHtml, stopSnapshots } from './snapshot.js';
import { localImagePath } from './images.js';

interface LivePage {
  id: string;
  text: string;
  complete: boolean;
  createdAt: number;
  updatedAt: number;
  /** Whether Discord has been sent the link yet. */
  linked: boolean;
  clients: Set<ServerResponse>;
  flushTimer?: NodeJS.Timeout;
}

/** SSE fan-out is coalesced: pi emits a delta per token. */
const BROADCAST_MS = 80;
const HEARTBEAT_MS = 15_000;
const DISCORD_MAX_LENGTH = 2000;
/** Recent pages kept in memory; older ones are read back from disk. */
const MEMORY_PAGES = 200;

const pages = new Map<string, LivePage>();
/** The page the channel's current turn is writing into. */
const current = new Map<string, LivePage>();
/**
 * The last text each channel settled. One reply can be settled twice (the
 * attachment path falls back to the text path), and must not get two pages.
 */
const lastSettled = new Map<string, string>();
let server: Server | undefined;
let cleanupTimer: NodeJS.Timeout | undefined;

export function livePageActive(): boolean {
  return config.livePageEnabled && Boolean(config.livePagePublicUrl) && Boolean(server);
}

/** Whether blocks Discord cannot render should be posted as images. */
export function richImagesActive(): boolean {
  return livePageActive() && config.liveRichImages;
}

export function livePageUrl(id: string): string {
  return `${config.livePagePublicUrl}/r/${id}`;
}

/**
 * Whether Discord shows this reply badly enough to be worth a link: a GFM
 * table, display math, a diagram, or more than one message's worth of text.
 */
export function needsLivePage(text: string): boolean {
  if (text.length > DISCORD_MAX_LENGTH) return true;
  if (
    /^[ \t]*\|.*\|[ \t]*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/m.test(
      text,
    )
  )
    return true;
  if (/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/.test(text)) return true;
  return /^ {0,3}```mermaid\b/m.test(text);
}

/** A new turn starts with no page; one is created on its first text. */
export function beginLivePage(jid: string): void {
  current.delete(jid);
}

/**
 * Feed the growing reply. Returns the page URL exactly once — the first time
 * the reply qualifies for a link — so the caller can post it; otherwise null.
 */
export function updateLivePage(jid: string, full: string): string | null {
  if (!livePageActive() || !full.trim()) return null;
  let page = current.get(jid);
  if (!page || page.complete) {
    page = createPage();
    current.set(jid, page);
  }
  if (page.text !== full) {
    page.text = full;
    page.updatedAt = Date.now();
    scheduleBroadcast(page);
  }
  if (page.linked) return null;
  if (config.livePageMode !== 'always' && !needsLivePage(full)) return null;
  page.linked = true;
  void persist(page);
  return livePageUrl(page.id);
}

/**
 * Settle the turn's page on its final text. Returns the page URL when the
 * final text qualifies but no link was posted yet (a short streamed reply
 * whose table arrived only in the final text), so the caller can post it.
 */
export function completeLivePage(jid: string, finalText?: string): string | null {
  const page = current.get(jid);
  current.delete(jid);
  const settled = lastSettled.get(jid);
  if (finalText !== undefined) lastSettled.set(jid, finalText);
  if (!page) {
    // Nothing streamed (streaming off, or the reply arrived whole).
    const body = finalText?.trim();
    if (!livePageActive() || !body || settled === finalText) return null;
    if (config.livePageMode !== 'always' && !needsLivePage(body)) return null;
    const fresh = createPage();
    fresh.text = body;
    fresh.complete = true;
    fresh.linked = true;
    void persist(fresh);
    return livePageUrl(fresh.id);
  }
  const body = finalText?.trim() ?? '';
  // In a multi-run turn the final text is only the last run's tail while the
  // stream carried every run; keep the fuller streamed copy then.
  if (body && !page.text.trim().endsWith(body)) page.text = body;
  page.complete = true;
  page.updatedAt = Date.now();
  if (page.flushTimer) clearTimeout(page.flushTimer);
  page.flushTimer = undefined;
  broadcast(page);
  for (const res of page.clients) res.end();
  page.clients.clear();
  let link: string | null = null;
  if (!page.linked && (config.livePageMode === 'always' || needsLivePage(page.text))) {
    page.linked = true;
    link = livePageUrl(page.id);
  }
  // Pages nobody was ever linked to are dropped instead of written to disk.
  if (page.linked) void persist(page);
  else pages.delete(page.id);
  return link;
}

function createPage(): LivePage {
  const now = Date.now();
  const page: LivePage = {
    id: randomBytes(16).toString('base64url'),
    text: '',
    complete: false,
    createdAt: now,
    updatedAt: now,
    linked: false,
    clients: new Set(),
  };
  pages.set(page.id, page);
  while (pages.size > MEMORY_PAGES) {
    const oldest = pages.keys().next().value as string;
    if (pages.get(oldest)?.clients.size) break;
    pages.delete(oldest);
  }
  return page;
}

function scheduleBroadcast(page: LivePage): void {
  if (page.flushTimer || !page.clients.size) return;
  page.flushTimer = setTimeout(() => {
    page.flushTimer = undefined;
    broadcast(page);
  }, BROADCAST_MS);
  page.flushTimer.unref?.();
}

// ── local images ───────────────────────────────────────────────────────

const LOCAL_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
const PAGE_IMAGE =
  /\[\[image\s*:\s*([^\]\n]+?)\s*\]\]|!\[([^\]\n]*)\]\(\s*<?((?:\/|~\/|file:\/\/)[^\s()<>]+)>?\s*\)/gi;

const imageKey = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 20);

function pageImagePath(source: string): string | null {
  const path = localImagePath(source.trim().replace(/^['"<]+|['">]+$/g, ''));
  return path && LOCAL_IMAGE_EXT.has(extname(path).toLowerCase()) ? path : null;
}

/**
 * The reply as the browser gets it. Pictures pi saved on this machine
 * (`[[image: /path]]`, `![](/path)`) are served from the page itself, and
 * only the ones its reply names, so the page shows them in place too.
 */
function pageText(page: { id: string; text: string }): string {
  return page.text.replace(PAGE_IMAGE, (match, marker?: string, alt?: string, src?: string) => {
    const path = pageImagePath(marker ?? src ?? '');
    if (!path) return match;
    const label = (alt ?? path.split('/').pop() ?? '').replace(/[[\]]/g, '');
    return `![${label}](/r/${page.id}/img/${imageKey(path)})`;
  });
}

async function servePageImage(res: ServerResponse, page: LivePage, key: string): Promise<void> {
  for (const m of page.text.matchAll(PAGE_IMAGE)) {
    const path = pageImagePath(m[1] ?? m[3] ?? '');
    if (!path || imageKey(path) !== key) continue;
    try {
      const body = await readFile(path);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      // An SVG could carry script; the CSP keeps it inert when opened directly.
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      return send(res, 200, MIME[extname(path).toLowerCase()] ?? 'application/octet-stream', body);
    } catch {
      break;
    }
  }
  send(res, 404, 'text/plain', 'not found');
}

function broadcast(page: LivePage): void {
  const frame = `data: ${JSON.stringify({ text: pageText(page), complete: page.complete })}\n\n`;
  for (const res of page.clients) res.write(frame);
}

// ── storage ────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

function pagePath(id: string): string {
  return resolve(config.livePageDir, `${id}.json`);
}

async function persist(page: LivePage): Promise<void> {
  try {
    const path = pagePath(page.id);
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify({
        text: page.text,
        complete: page.complete,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      }),
    );
    await rename(tmp, path);
  } catch (err: any) {
    logger.warn({ id: page.id, err: err?.message }, 'live-page: persist failed');
  }
}

async function loadPage(id: string): Promise<LivePage | null> {
  if (!ID_RE.test(id)) return null;
  const cached = pages.get(id);
  if (cached) return cached;
  try {
    const saved = JSON.parse(await readFile(pagePath(id), 'utf8'));
    // A page left unfinished by a restart will never receive more text.
    return {
      id,
      text: String(saved.text ?? ''),
      complete: true,
      createdAt: Number(saved.createdAt) || 0,
      updatedAt: Number(saved.updatedAt) || 0,
      linked: true,
      clients: new Set(),
    };
  } catch {
    return null;
  }
}

async function cleanupOldPages(): Promise<void> {
  if (config.livePageRetentionDays <= 0) return;
  const cutoff = Date.now() - config.livePageRetentionDays * 86_400_000;
  try {
    for (const name of await readdir(config.livePageDir)) {
      if (!name.endsWith('.json')) continue;
      const path = resolve(config.livePageDir, name);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await unlink(path).catch(() => undefined);
        pages.delete(name.slice(0, -5));
      }
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'live-page: cleanup failed');
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

/** Only the renderer's files are served out of piweb's public/ directory. */
const ASSET_FILES = new Set(['lobehub-rich.js', 'markdown.js', 'app.css', 'favicon.svg']);

const CSP = [
  "default-src 'self'",
  // The page's own boot script is inline; the renderer is same-origin.
  "script-src 'self' 'unsafe-inline'",
  // Streamdown injects its fade keyframes; KaTeX and highlight set inline styles.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function baseHeaders(res: ServerResponse): void {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(body);
}

async function serveAsset(res: ServerResponse, rel: string): Promise<void> {
  if (!ASSET_FILES.has(rel) && !rel.startsWith('vendor/'))
    return send(res, 404, 'text/plain', 'not found');
  const root = resolve(config.livePageAssetsDir);
  const path = resolve(root, rel);
  if (!path.startsWith(root + sep)) return send(res, 404, 'text/plain', 'not found');
  try {
    const body = await readFile(path);
    res.setHeader('Cache-Control', 'public, max-age=300');
    send(res, 200, MIME[extname(path)] ?? 'application/octet-stream', body);
  } catch {
    send(res, 404, 'text/plain', 'not found');
  }
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** A plain-text summary for the link preview — Discord shows it, not the page. */
export function previewDescription(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}.*$/gm, ' ')
    .replace(/[|#>*_`~]|\[\[[^\]]*\]\]|!?\[([^\]]*)\]\([^)]*\)/g, (m, label) => label ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 180 ? `${plain.slice(0, 179)}…` : plain;
}

export function renderPageHtml(page: { id: string; text: string; complete: boolean }): string {
  const title = page.complete ? 'pi 回覆' : 'pi 回覆 · 生成中';
  const description = previewDescription(page.text) || '即時渲染的回覆';
  // The initial state rides along so a finished page renders without waiting
  // for the event stream, and `<` cannot close the script element early.
  const initial = JSON.stringify({
    id: page.id,
    text: pageText(page),
    complete: page.complete,
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-Hant" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="article">
<meta property="og:site_name" content="piscord">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#5865f2">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>
  try {
    if (matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.dataset.theme = 'light';
    }
  } catch {}
</script>
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<link rel="stylesheet" href="/app.css">
<style>
  html, body { height: 100%; overflow: hidden; }
  #messages { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .live-page { max-width: 820px; margin: 0 auto; padding: 20px 16px calc(48px + env(safe-area-inset-bottom)); }
  .live-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px;
    color: var(--text-dim); font-size: 13px; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tool); flex: none; }
  .live-head[data-state='live'] .live-dot { animation: live-pulse 1.2s ease-in-out infinite; }
  .live-head[data-state='done'] .live-dot { background: var(--text-dim); }
  .live-head[data-state='lost'] .live-dot { background: var(--danger); }
  .live-head a { margin-left: auto; color: var(--text-dim); }
  @keyframes live-pulse { 50% { opacity: 0.3; } }
  @media (prefers-reduced-motion: reduce) { .live-head .live-dot { animation: none !important; } }
  .live-page .msg-text { font-size: 15.5px; line-height: 1.6; overflow-wrap: anywhere; }
  .live-page .msg-text th, .live-page .msg-text td { white-space: normal; min-width: 4em; }
</style>
</head>
<body>
<div id="messages">
  <main class="live-page">
    <div class="live-head" data-state="${page.complete ? 'done' : 'live'}" role="status">
      <span class="live-dot"></span><span class="live-label">${page.complete ? '已完成' : '生成中…'}</span>
      <a href="/r/${page.id}.md">原始 Markdown</a>
    </div>
    <div class="msg-text" id="reply"></div>
  </main>
</div>
<script id="initial" type="application/json">${initial}</script>
<script src="/vendor/katex/katex.min.js"></script>
<script src="/vendor/highlight/highlight.min.js"></script>
<script type="module">
  import { updateLobehubRich, renderLobehubStatic } from '/lobehub-rich.js';
  const initial = JSON.parse(document.getElementById('initial').textContent);
  const target = document.getElementById('reply');
  const scroller = document.getElementById('messages');
  const head = document.querySelector('.live-head');
  const label = head.querySelector('.live-label');
  const setState = (state, text) => { head.dataset.state = state; label.textContent = text; };
  // Follow the bottom only while the reader is already there.
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  const hooks = {
    beforeAppend: atBottom,
    afterAppend: (follow) => { if (follow) scroller.scrollTop = scroller.scrollHeight; },
  };
  let shown = '';
  let done = initial.complete;
  if (done) {
    renderLobehubStatic(target, initial.text);
  } else {
    if (initial.text) { shown = initial.text; updateLobehubRich(target, shown, hooks); }
    const events = new EventSource('/r/' + initial.id + '/events');
    events.onmessage = (event) => {
      const { text, complete } = JSON.parse(event.data);
      if (text !== shown || complete) {
        shown = text;
        updateLobehubRich(target, text, { ...hooks, complete });
      }
      if (complete) {
        done = true;
        events.close();
        setState('done', '已完成');
        document.title = 'pi 回覆';
      } else setState('live', '生成中…');
    };
    events.onerror = () => { if (!done) setState('lost', '連線中斷，重新連線中…'); };
  }
</script>
</body>
</html>
`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  baseHeaders(res);
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return send(res, 405, 'text/plain', 'method not allowed');
  const url = new URL(req.url ?? '/', 'http://local');
  const path = decodeURIComponent(url.pathname);

  if (path === '/healthz') return send(res, 200, 'text/plain', 'ok');
  if (path === '/snap') {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cache-Control', 'no-store');
    return send(res, 200, 'text/html; charset=utf-8', renderSnapHtml());
  }

  const route = /^\/r\/([A-Za-z0-9_-]{22})(\/events|\.md|\/img\/([0-9a-f]{20}))?$/.exec(path);
  if (route) {
    const page = await loadPage(route[1]);
    if (!page) return send(res, 404, 'text/plain; charset=utf-8', '找不到這個頁面（可能已過期）');
    if (route[3]) return servePageImage(res, page, route[3]);
    if (route[2] === '.md') {
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, 'text/markdown; charset=utf-8', page.text);
    }
    if (route[2] === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(
        `retry: 2000\ndata: ${JSON.stringify({ text: pageText(page), complete: page.complete })}\n\n`,
      );
      if (page.complete) return void res.end();
      page.clients.add(res);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      heartbeat.unref?.();
      req.on('close', () => {
        clearInterval(heartbeat);
        page.clients.delete(res);
      });
      return;
    }
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cache-Control', 'no-store');
    return send(res, 200, 'text/html; charset=utf-8', renderPageHtml(page));
  }

  const asset = path.replace(/^\/+/, '');
  if (asset && !asset.includes('..')) return serveAsset(res, asset);
  return send(res, 404, 'text/plain', 'not found');
}

/**
 * Start the page server on every LIVE_PAGE_HOST address (comma-separated, e.g.
 * loopback plus the docker bridge a Funnel sidecar proxies from). Resolves
 * once listening; returns a stop function.
 */
export async function startLivePageServer(): Promise<() => void> {
  if (!config.livePageEnabled || !config.livePagePublicUrl) return () => undefined;
  mkdirSync(config.livePageDir, { recursive: true });
  const listening: Server[] = [];
  for (const host of config.livePageHost
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)) {
    const instance = createServer((req, res) => {
      handle(req, res).catch((err) => {
        logger.warn({ err: err?.message, url: req.url }, 'live-page: request failed');
        if (!res.headersSent) send(res, 500, 'text/plain', 'error');
        else res.end();
      });
    });
    try {
      await new Promise<void>((ok, fail) => {
        instance.once('error', fail);
        instance.listen(config.livePagePort, host, () => ok());
      });
      listening.push(instance);
    } catch (err: any) {
      // The bot works without it; replies just go unlinked.
      logger.warn(
        { err: err?.message, host, port: config.livePagePort },
        'live-page: could not listen',
      );
    }
  }
  if (!listening.length) return () => undefined;
  server = listening[0];
  void cleanupOldPages();
  cleanupTimer = setInterval(() => void cleanupOldPages(), 6 * 3_600_000);
  cleanupTimer.unref?.();
  logger.info(
    { host: config.livePageHost, port: config.livePagePort, publicUrl: config.livePagePublicUrl },
    'Live page server listening',
  );
  return () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const page of pages.values()) for (const res of page.clients) res.end();
    for (const instance of listening) instance.close();
    void stopSnapshots();
    server = undefined;
  };
}
