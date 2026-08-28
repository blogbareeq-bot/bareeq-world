import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

let cached = null;

export async function resolveFfmpeg() {
  if (cached) return cached;
  let installer = null;
  try { installer = (await import('@ffmpeg-installer/ffmpeg')).default; } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  const ffmpeg = process.env.FFMPEG_PATH?.trim() || installer?.path || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH?.trim() || (installer?.path ? installer.path.replace(/ffmpeg(\.exe)?$/i, (_, ext) => `ffprobe${ext || ''}`) : 'ffprobe');
  cached = { ffmpeg, ffprobe };
  return cached;
}

export function runCommand(bin, args, { input = null, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(bin)} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function assertFfmpeg() {
  const tools = await resolveFfmpeg();
  try { await access(tools.ffmpeg); } catch {
    throw new Error(`ffmpeg is required at ${tools.ffmpeg}`);
  }
  return tools;
}
