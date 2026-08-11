import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { AttachmentBuilder, Client, GatewayIntentBits } from 'discord.js';
import { config } from '../config.js';

export interface SendRequest {
  channelJid: string;
  text?: string;
  files: string[];
}

export function normalizeChannelJid(input: string): string {
  const value = input.trim();
  return value.startsWith('dc:') ? value : `dc:${value}`;
}

function formatMebibytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

export function formatAttachmentTooLargeNotice(
  fileName: string,
  sizeBytes: number,
  limitBytes?: number,
): string {
  const size = formatMebibytes(sizeBytes);
  if (limitBytes !== undefined) {
    return `⚠️ 無法上傳「${fileName}」（${size} MiB）：超過 Discord 附件上限 ${formatMebibytes(limitBytes)} MiB，請壓縮後再試。`;
  }
  return `⚠️ 無法上傳「${fileName}」（${size} MiB）：超過 Discord 此頻道的附件大小限制，請壓縮後再試。`;
}

export function isAttachmentTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: number | string; message?: string };
  return (
    Number(candidate.code) === 40005 ||
    /request entity too large|entity too large/i.test(candidate.message ?? '')
  );
}

export function validateSendRequest(
  request: SendRequest,
  options: { maxAttachmentBytes: number; fileStat: (path: string) => { size: number } },
): void {
  const hasText = Boolean(request.text?.trim());

  if (!hasText && request.files.length === 0) {
    throw new Error('Either text or at least one file is required.');
  }

  if (request.files.length > 10) {
    throw new Error('At most 10 files can be sent in a single message.');
  }

  for (const filePath of request.files) {
    let file;

    try {
      file = options.fileStat(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    if (options.maxAttachmentBytes > 0 && file.size > options.maxAttachmentBytes) {
      throw new Error(
        `File exceeds max attachment size (${options.maxAttachmentBytes} bytes): ${filePath}`,
      );
    }
  }
}

export async function sendFilesToDiscord(request: SendRequest): Promise<{ sentFiles: number }> {
  validateSendRequest(request, {
    maxAttachmentBytes: config.maxAttachmentBytes,
    fileStat: (filePath) => statSync(filePath),
  });

  const channelJid = normalizeChannelJid(request.channelJid);
  const channelId = channelJid.slice(3);
  const attachments = await Promise.all(
    request.files.map(
      async (filePath) =>
        new AttachmentBuilder(await readFile(filePath), { name: basename(filePath) }),
    ),
  );

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  try {
    await client.login(config.discordToken);
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Channel not found or not text-based: ${channelJid}`);
    }

    await channel.send({
      content: request.text || undefined,
      ...(attachments.length > 0 ? { files: attachments } : {}),
    });
    return { sentFiles: attachments.length };
  } finally {
    client.destroy();
  }
}
