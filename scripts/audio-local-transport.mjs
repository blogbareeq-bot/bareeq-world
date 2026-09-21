import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';

const EXIT_HARD = 1;
const EXIT_CONFIG = 78;

function hard(message, extra = {}) {
  return Object.assign(new Error(message), { exitCode: EXIT_HARD, ...extra });
}

function config(message) {
  return Object.assign(new Error(message), { exitCode: EXIT_CONFIG });
}

function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer ***')
    .replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, '$1***');
}

function decodeJsonAudio(payload) {
  const encoded = payload?.audioBase64 || payload?.audio_base64 || payload?.audio?.base64 || null;
  if (typeof encoded !== 'string' || !encoded.trim()) throw hard('Local TTS worker JSON has no audioBase64 payload.');
  const bytes = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
  if (bytes.length < 100) throw hard('Local TTS worker returned only ' + bytes.length + ' audio bytes.');
  return {
    bytes,
    mimeType: String(payload?.mimeType || payload?.mime_type || payload?.format || 'audio/wav').toLowerCase(),
    metadata: payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
  };
}

export async function normalizeWorkerAudioToMp3(bytes, mimeType = 'audio/mpeg') {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('mpeg') || type.includes('mp3')) return bytes;
  const { ffmpeg } = await assertFfmpeg();
  const encoded = await runCommand(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
    '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
  ], { input: bytes, timeoutMs: 180000 });
  if (encoded.code !== 0) throw hard('ffmpeg could not normalize local TTS audio: ' + encoded.stderr.slice(0, 700));
  if (encoded.stdout.length < 100) throw hard('ffmpeg returned an unexpectedly small local TTS MP3 (' + encoded.stdout.length + ' bytes).');
  return encoded.stdout;
}

export async function invokeHttpWorker({ runtime, request, fetchImpl = globalThis.fetch }) {
  if (!runtime?.endpoint) throw config('Local TTS HTTP endpoint is missing.');
  let response;
  try {
    response = await fetchImpl(runtime.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, audio/mpeg, audio/wav, application/octet-stream',
        ...(runtime.token ? { Authorization: 'Bearer ' + runtime.token } : {}),
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw hard('Local TTS HTTP transport failed (' + redact(runtime.endpoint) + '): ' + (error.cause?.code || error.message));
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw hard('Local TTS worker failed (' + response.status + '): ' + redact(body).slice(0, 700), { httpStatus: response.status });
  }
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const payload = await response.json();
    const decoded = decodeJsonAudio(payload);
    return {
      audio: await normalizeWorkerAudioToMp3(decoded.bytes, decoded.mimeType),
      metadata: decoded.metadata,
      mimeType: decoded.mimeType,
      transport: 'http',
    };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100) throw hard('Local TTS HTTP worker returned only ' + bytes.length + ' bytes.');
  return {
    audio: await normalizeWorkerAudioToMp3(bytes, contentType || 'application/octet-stream'),
    metadata: {},
    mimeType: contentType || 'application/octet-stream',
    transport: 'http',
  };
}

function runJsonCommand(bin, args, request, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, hard(bin + ' local TTS worker timed out after ' + timeoutMs + 'ms.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => finish(reject, config('Could not launch local TTS worker ' + bin + ': ' + error.message)));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(reject, hard('Local TTS worker ' + bin + ' exited ' + code + ': ' + redact(Buffer.concat(stderr).toString('utf8')).slice(0, 700)));
        return;
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(stdout).toString('utf8')); }
      catch (error) {
        finish(reject, hard('Local TTS worker ' + bin + ' returned invalid JSON: ' + error.message));
        return;
      }
      finish(resolve, payload);
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

export async function invokeCommandWorker({ runtime, request }) {
  if (!runtime?.bin) throw config('Local TTS worker executable is missing.');
  const payload = await runJsonCommand(runtime.bin, runtime.args || [], request);
  const decoded = decodeJsonAudio(payload);
  return {
    audio: await normalizeWorkerAudioToMp3(decoded.bytes, decoded.mimeType),
    metadata: decoded.metadata,
    mimeType: decoded.mimeType,
    transport: 'command',
  };
}

export async function concatWorkerMp3Buffers(buffers) {
  if (!Array.isArray(buffers) || !buffers.length) throw hard('Cannot merge an empty local TTS segment list.');
  if (buffers.length === 1) return buffers[0];
  const temp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-tts-segments-'));
  try {
    const files = [];
    for (let index = 0; index < buffers.length; index += 1) {
      const file = path.join(temp, 'segment-' + String(index + 1).padStart(3, '0') + '.mp3');
      await writeFile(file, buffers[index]);
      files.push(file);
    }
    const list = path.join(temp, 'concat.txt');
    await writeFile(list, files.map((file) => "file '" + file.replace(/'/g, "'\\''") + "'").join('\n') + '\n');
    const output = path.join(temp, 'part.mp3');
    const { ffmpeg } = await assertFfmpeg();
    const result = await runCommand(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
      '-c:a', 'libmp3lame', '-b:a', '96k', '-y', output,
    ], { timeoutMs: 180000 });
    if (result.code !== 0) throw hard('ffmpeg could not merge local TTS segments: ' + result.stderr.slice(0, 700));
    const merged = await readFile(output);
    if (merged.length < 100) throw hard('Merged local TTS part is unexpectedly small (' + merged.length + ' bytes).');
    return merged;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function invokeLocalTtsWorker({ runtime, request, fetchImpl = globalThis.fetch }) {
  if (runtime?.kind === 'http') return invokeHttpWorker({ runtime, request, fetchImpl });
  if (runtime?.kind === 'command') return invokeCommandWorker({ runtime, request });
  throw config('Local TTS runtime is not configured.');
}
