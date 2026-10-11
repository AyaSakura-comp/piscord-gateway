/**
 * Load an image a reply refers to, so it can be posted where it stands.
 *
 * Sources are pi's own files (`[[image: /path]]`, or `![alt](/path)`) and web
 * images it found while browsing (`![alt](https://…)`). Web images are
 * downloaded and attached rather than linked: Discord's link preview cannot
 * be placed mid-reply, and hotlink-protected sites refuse its proxy anyway.
 */
import { lookup } from 'node:dns/promises';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/** Formats Discord shows inline. */
const TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
};
const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);

export interface LoadedImage {
  data: Buffer;
  name: string;
}

function limit(): number {
  return config.maxAttachmentBytes > 0 ? config.maxAttachmentBytes : 25 * 1024 * 1024;
}

/** A local path pi wrote: absolute, `~/…`, `file://…`, or relative to home like outbox markers. */
export function localImagePath(source: string): string | null {
  if (/^file:\/\//i.test(source)) {
    try {
      return fileURLToPath(source);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return null;
  if (source.startsWith('~/')) return resolve(homedir(), source.slice(2));
  return isAbsolute(source) ? source : resolve(homedir(), source);
}

async function loadFile(path: string): Promise<LoadedImage | null> {
  if (!EXTENSIONS.has(extname(path).toLowerCase())) return null;
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > limit()) return null;
  return { data: await readFile(path), name: basename(path) };
}

/** Loopback, private, link-local, CGNAT (tailnet) and the like are off limits. */
export function isPrivateAddress(address: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * A reply's URL may come from a page pi read, so it must not be able to point
 * the gateway at this machine or the tailnet and post what comes back.
 */
async function publicHost(url: URL): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  return addresses.length > 0 && !addresses.some(isPrivateAddress);
}

async function loadUrl(source: string): Promise<LoadedImage | null> {
  let url = new URL(source);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https?:$/.test(url.protocol) || !(await publicHost(url))) return null;
    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': UA,
        accept: 'image/avif,image/webp,image/png,image/*;q=0.8',
        referer: url.origin + '/',
      },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !TYPES[type] || !res.body) {
      await res.body?.cancel();
      return null;
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > limit()) {
      await res.body.cancel();
      return null;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > limit()) return null;
      chunks.push(Buffer.from(chunk));
    }
    const stem =
      basename(url.pathname)
        .replace(/\.[^.]*$/, '')
        .replace(/[^\w.-]+/g, '_') || 'image';
    return { data: Buffer.concat(chunks), name: `${stem.slice(0, 60)}${TYPES[type]}` };
  }
  return null;
}

/** The image's bytes, or null when it cannot be had (callers fall back to text). */
export async function loadImage(source: string): Promise<LoadedImage | null> {
  const started = Date.now();
  try {
    const path = localImagePath(source);
    const image = path ? await loadFile(path) : await loadUrl(source);
    logger.info(
      { source: source.slice(0, 200), ms: Date.now() - started, bytes: image?.data.length ?? 0 },
      image ? 'live-page: image loaded' : 'live-page: image unavailable',
    );
    return image;
  } catch (err: any) {
    logger.warn(
      { source: source.slice(0, 200), err: err?.message },
      'live-page: image load failed',
    );
    return null;
  }
}

/** What stands in for an image that could not be loaded. */
export function imageFallbackText(source: string, alt?: string): string {
  // A bare URL lets Discord try its own preview.
  if (/^https?:\/\//i.test(source)) return alt ? `🖼️ ${alt}\n${source}` : source;
  return `🖼️ ${alt || basename(source)}（圖片無法載入）`;
}
