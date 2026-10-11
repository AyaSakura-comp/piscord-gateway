import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  imageFallbackText,
  isPrivateAddress,
  loadImage,
  localImagePath,
} from '../src/live-page/images.js';
import { parseOutboxMarkers } from '../src/agent/outbox.js';

describe('image sources', () => {
  it('tells local paths from URLs', () => {
    expect(localImagePath('/tmp/a.png')).toBe('/tmp/a.png');
    expect(localImagePath('~/x/a.png')).toBe(join(homedir(), 'x/a.png'));
    expect(localImagePath('file:///tmp/a.png')).toBe('/tmp/a.png');
    expect(localImagePath('https://e.com/a.png')).toBeNull();
    expect(localImagePath('data:image/png;base64,AA')).toBeNull();
  });

  it('refuses addresses on this machine or the tailnet', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.24.0.1',
      '192.168.1.1',
      '100.100.1.1',
      '169.254.1.1',
      '::1',
      'fd7a::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPrivateAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111'])
      expect(isPrivateAddress(a)).toBe(false);
  });

  it('loads a local picture, and not other files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-img-'));
    writeFileSync(join(dir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    expect((await loadImage(join(dir, 'a.png')))?.name).toBe('a.png');
    expect(await loadImage(join(dir, 'secret.txt'))).toBeNull();
    expect(await loadImage(join(dir, 'missing.png'))).toBeNull();
    expect(await loadImage('http://127.0.0.1:1/a.png')).toBeNull();
  });

  it('falls back to a bare link Discord can still preview', () => {
    expect(imageFallbackText('https://e.com/a.png')).toBe('https://e.com/a.png');
    expect(imageFallbackText('/x/a.png', '貓')).toBe('🖼️ 貓（圖片無法載入）');
  });
});

describe('outbox markers with in-place images', () => {
  it('keeps picture markers in the text and still collects other files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
    const png = join(dir, 'a.png');
    const pdf = join(dir, 'r.pdf');
    writeFileSync(png, 'x');
    writeFileSync(pdf, 'x');
    const raw = `圖：\n[[image: ${png}]]\n報告 [[file: ${pdf}]]`;
    const kept = parseOutboxMarkers(raw, dir, { keepImages: true });
    expect(kept.files).toEqual([pdf]);
    expect(kept.text).toBe(`圖：\n[[image: ${png}]]\n報告`);
    expect(parseOutboxMarkers(raw, dir).files).toEqual([png, pdf]);
  });
});
