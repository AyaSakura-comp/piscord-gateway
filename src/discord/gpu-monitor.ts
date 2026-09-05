import { ActivityType, type Client } from 'discord.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { logger } from '../logger.js';

let intervalTimer: NodeJS.Timeout | null = null;

function readAmdDrmSysfsStatus(): string | null {
  const drmDir = '/sys/class/drm';
  if (!existsSync(drmDir)) return null;

  try {
    const entries = readdirSync(drmDir);
    const cardDevices = entries
      .filter((f) => f.startsWith('card') && !f.includes('-'))
      .map((f) => join(drmDir, f, 'device'))
      .filter((p) => existsSync(p));

    for (const card of cardDevices) {
      const busyFile = join(card, 'gpu_busy_percent');
      if (existsSync(busyFile)) {
        const busy = readFileSync(busyFile, 'utf8').trim();

        const gttUsedFile = join(card, 'mem_info_gtt_used');
        const gttTotalFile = join(card, 'mem_info_gtt_total');
        const vramUsedFile = join(card, 'mem_info_vram_used');
        const vramTotalFile = join(card, 'mem_info_vram_total');

        let memUsedGb = '0.0';
        let memTotalGb = '0.0';
        if (existsSync(gttUsedFile) && existsSync(gttTotalFile)) {
          memUsedGb = (parseInt(readFileSync(gttUsedFile, 'utf8').trim(), 10) / 1024 ** 3).toFixed(1);
          memTotalGb = (parseInt(readFileSync(gttTotalFile, 'utf8').trim(), 10) / 1024 ** 3).toFixed(1);
        } else if (existsSync(vramUsedFile) && existsSync(vramTotalFile)) {
          memUsedGb = (parseInt(readFileSync(vramUsedFile, 'utf8').trim(), 10) / 1024 ** 3).toFixed(1);
          memTotalGb = (parseInt(readFileSync(vramTotalFile, 'utf8').trim(), 10) / 1024 ** 3).toFixed(1);
        }

        let tempStr = '';
        const hwmonDir = join(card, 'hwmon');
        if (existsSync(hwmonDir)) {
          const subdirs = readdirSync(hwmonDir);
          for (const s of subdirs) {
            const tempFile = join(hwmonDir, s, 'temp1_input');
            if (existsSync(tempFile)) {
              const tempC = Math.floor(parseInt(readFileSync(tempFile, 'utf8').trim(), 10) / 1000);
              tempStr = ` | ${tempC}°C`;
              break;
            }
          }
        }

        let powerStr = '';
        if (existsSync(hwmonDir)) {
          const subdirs = readdirSync(hwmonDir);
          for (const s of subdirs) {
            const powerFile = join(hwmonDir, s, 'power1_average') || join(hwmonDir, s, 'power1_input');
            if (existsSync(powerFile)) {
              const powerW = (parseInt(readFileSync(powerFile, 'utf8').trim(), 10) / 1_000_000).toFixed(1);
              powerStr = ` | ${powerW}W`;
              break;
            }
          }
        }

        return `GPU: ${busy}% | VRAM: ${memUsedGb}/${memTotalGb}G${tempStr}${powerStr}`;
      }
    }
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'Failed to read AMD DRM sysfs');
  }

  return null;
}

function readNvidiaStatus(): string | null {
  try {
    const output = execSync(
      'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 2000 },
    ).trim();
    const lines = output.split('\n').filter((l) => l.trim());
    if (lines.length > 0) {
      const [util, memUsed, memTotal, temp] = lines[0].split(',').map((x) => x.trim());
      const usedGb = (parseInt(memUsed, 10) / 1024).toFixed(1);
      const totalGb = (parseInt(memTotal, 10) / 1024).toFixed(1);
      return `GPU: ${util}% | VRAM: ${usedGb}/${totalGb}G | ${temp}°C`;
    }
  } catch {
    // Ignore nvidia-smi errors
  }
  return null;
}

export function getGpuStatusText(): string {
  const amd = readAmdDrmSysfsStatus();
  if (amd) return amd;

  const nvidia = readNvidiaStatus();
  if (nvidia) return nvidia;

  return 'GPU: Idle';
}

export function startGpuPresenceMonitor(client: Client<true>, intervalSec = 5): void {
  stopGpuPresenceMonitor();

  const update = () => {
    try {
      const statusText = getGpuStatusText();
      client.user.setPresence({
        activities: [
          {
            name: 'custom',
            type: ActivityType.Custom,
            state: `🔥 ${statusText}`,
          },
        ],
        status: 'online',
      });
    } catch (err: any) {
      logger.debug({ err: err?.message }, 'Failed to update GPU presence');
    }
  };

  update();
  intervalTimer = setInterval(update, Math.max(1, intervalSec) * 1000);
  intervalTimer.unref?.();
  logger.info({ intervalSec }, 'GPU presence monitor started in piscord');
}

export function stopGpuPresenceMonitor(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
