import { spawn } from 'node:child_process';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { spliceWindowMetrics } from './audio-merge.mjs';

const EXIT_HARD = 1;
const EXIT_CONFIG = 78;
const MAX_WORKER_BYTES = 64 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 900000;

function hard(message, extra = {}) {
  return Object.assign(new Error(message), { exitCode: EXIT_HARD, ...extra });
}

function config(message) {
  return Object.assign(new Error(message), { exitCode: EXIT_CONFIG });
}

function decodeJsonAudio(payload) {
  const encoded = payload?.audioBase64 || payload?.audio_base64 || payload?.audio?.base64 || null;
  if (typeof encoded !== 'string' || !encoded.trim()) throw hard('Local TTS worker JSON has no audioBase64 payload.');
  const clean = encoded.replace(/\s+/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) {
    throw hard('Local TTS worker returned invalid base64 audio.');
  }
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.length > MAX_WORKER_BYTES) throw hard('Local TTS audio exceeds the size limit.');
  if (bytes.length < 100) throw hard('Local TTS worker returned only ' + bytes.length + ' audio bytes.');
  return {
    bytes,
    mimeType: String(payload?.mimeType || payload?.mime_type || payload?.format || 'audio/wav').toLowerCase(),
    metadata: payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
  };
}

export async function normalizeWorkerAudioToMp3(bytes, mimeType = 'audio/mpeg') {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_WORKER_BYTES) throw hard('Local TTS audio exceeds the size limit.');
  const type = String(mimeType || '').toLowerCase().split(';')[0];
  if (!['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'application/octet-stream'].includes(type)) {
    throw hard('Unsupported local TTS audio type.');
  }
  const isMp3 = bytes.subarray(0, 3).toString('ascii') === 'ID3'
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const isWav = bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
  if ((['audio/mpeg', 'audio/mp3'].includes(type) && !isMp3)
    || (['audio/wav', 'audio/x-wav'].includes(type) && !isWav)) {
    throw hard('Local TTS audio bytes do not match the declared type.');
  }
  const { ffmpeg } = await assertFfmpeg();
  const encoded = await runCommand(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
    '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
  ], { input: bytes, timeoutMs: 180000 });
  if (encoded.code !== 0) throw hard('Local TTS audio is invalid or could not be normalized.');
  if (encoded.stdout.length < 100) throw hard('ffmpeg returned an unexpectedly small local TTS MP3 (' + encoded.stdout.length + ' bytes).');
  return encoded.stdout;
}

function assertWorkerIdentity(identity, request) {
  if (!request || (identity?.engine === request.engine && identity?.model === request.model
    && identity?.voiceId === request.voice?.id
    && identity?.modelRevision === request.audit?.modelRevision
    && identity?.workerRevision === request.audit?.workerRevision)) return;
  throw hard('Local TTS worker identity does not match the pinned request.');
}

async function boundedResponse(response) {
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > MAX_WORKER_BYTES) throw hard('Local TTS response exceeds the size limit.');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_WORKER_BYTES) throw hard('Local TTS response exceeds the size limit.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_WORKER_BYTES) throw hard('Local TTS response exceeds the size limit.');
  return bytes;
}

export async function invokeHttpWorker({ runtime, request, fetchImpl = globalThis.fetch }) {
  if (!runtime?.endpoint) throw config('Local TTS HTTP endpoint is missing.');
  let url;
  try { url = new URL(runtime.endpoint); } catch { throw config('Local TTS HTTP endpoint is invalid.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || (!loopback && runtime.approvedOrigin !== url.origin) || url.username || url.password
    || [...url.searchParams.keys()].some((key) => /^(token|key|api_key|access_token)$/i.test(key))) {
    throw config('Local TTS HTTP endpoint is not approved.');
  }
  let response;
  const controller = new AbortController();
  const timeoutMs = Math.min(WORKER_TIMEOUT_MS, Math.max(1, Number(runtime.timeoutMs || WORKER_TIMEOUT_MS)));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetchImpl(runtime.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, audio/mpeg, audio/wav, application/octet-stream',
        ...(runtime.token ? { Authorization: 'Bearer ' + runtime.token } : {}),
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw hard(controller.signal.aborted ? 'Local TTS HTTP worker timed out.' : 'Local TTS HTTP transport failed.');
  }
  try {
  if (!response.ok) {
    throw hard('Local TTS worker failed (HTTP ' + response.status + ').', { httpStatus: response.status });
  }
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const payload = response.body?.getReader || response.arrayBuffer
      ? JSON.parse((await boundedResponse(response)).toString('utf8'))
      : await response.json();
    assertWorkerIdentity(payload, request);
    const decoded = decodeJsonAudio(payload);
    return {
      audio: await normalizeWorkerAudioToMp3(decoded.bytes, decoded.mimeType),
      sourceAudio: decoded.bytes,
      metadata: { engine: payload.engine, model: payload.model, voiceId: payload.voiceId,
        modelRevision: payload.modelRevision, workerRevision: payload.workerRevision },
      mimeType: decoded.mimeType,
      transport: 'http',
    };
  }
  assertWorkerIdentity({
    engine: response.headers?.get?.('x-bareeq-tts-engine'),
    model: response.headers?.get?.('x-bareeq-tts-model'),
    voiceId: response.headers?.get?.('x-bareeq-tts-voice'),
    modelRevision: response.headers?.get?.('x-bareeq-tts-model-revision') || '',
    workerRevision: response.headers?.get?.('x-bareeq-tts-worker-revision') || '',
  }, request);
  const bytes = await boundedResponse(response);
  if (bytes.length < 100) throw hard('Local TTS HTTP worker returned only ' + bytes.length + ' bytes.');
  return {
    audio: await normalizeWorkerAudioToMp3(bytes, contentType || 'application/octet-stream'),
    sourceAudio: bytes,
    metadata: {},
    mimeType: contentType || 'application/octet-stream',
    transport: 'http',
  };
  } finally { clearTimeout(timer); }
}

function runJsonCommand(bin, args, request, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, hard('Local TTS command worker timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_WORKER_BYTES) {
        child.kill('SIGKILL'); finish(reject, hard('Local TTS command response exceeds the size limit.'));
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8) stderr.push(chunk); });
    child.once('error', () => finish(reject, config('Could not launch local TTS worker.')));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(reject, hard('Local TTS command worker exited ' + code + '.'));
        return;
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(stdout).toString('utf8')); }
      catch (error) {
        finish(reject, hard('Local TTS command worker returned invalid JSON.'));
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
  assertWorkerIdentity(payload, request);
  const decoded = decodeJsonAudio(payload);
  return {
    audio: await normalizeWorkerAudioToMp3(decoded.bytes, decoded.mimeType),
    sourceAudio: decoded.bytes,
    metadata: { engine: payload.engine, model: payload.model, voiceId: payload.voiceId,
      modelRevision: payload.modelRevision, workerRevision: payload.workerRevision },
    mimeType: decoded.mimeType,
    transport: 'command',
  };
}

export async function concatWorkerMp3Buffers(buffers) {
  if (!Array.isArray(buffers) || !buffers.length) throw hard('Cannot merge an empty local TTS segment list.');
  const { ffmpeg } = await assertFfmpeg();
  const pcmParts = [];
  for (const bytes of buffers) {
    const decoded = await runCommand(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '48000', 'pipe:1',
    ], { input: bytes, timeoutMs: 180000 });
    if (decoded.code !== 0 || decoded.stdout.length < 4800) throw hard('Local TTS segment could not be decoded.');
    pcmParts.push(trimSegmentPadding(decoded.stdout));
  }
  for (let index = 1; index < pcmParts.length; index += 1) {
    const metrics = spliceWindowMetrics(pcmParts[index - 1], pcmParts[index]);
    if (metrics.gap || metrics.click || metrics.overlap || metrics.step > 0.85) {
      throw hard('Local TTS segment splice failed acoustic continuity checks at index ' + index + '.');
    }
  }
  const encoded = await runCommand(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
    '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
  ], { input: Buffer.concat(pcmParts), timeoutMs: 180000 });
  if (encoded.code !== 0 || encoded.stdout.length < 100) throw hard('Local TTS segment merge failed.');
  return encoded.stdout;
}

function trimSegmentPadding(pcm) {
  const frameSamples = 240; // 5 ms at 48 kHz.
  const frames = Math.floor(pcm.length / (frameSamples * 2));
  const active = (frame) => {
    let energy = 0;
    for (let offset = frame * frameSamples * 2; offset < (frame + 1) * frameSamples * 2; offset += 2) {
      const sample = pcm.readInt16LE(offset) / 32768;
      energy += sample * sample;
    }
    return Math.sqrt(energy / frameSamples) >= 0.006;
  };
  let first = 0;
  while (first < frames && !active(first)) first += 1;
  let last = frames - 1;
  while (last >= first && !active(last)) last -= 1;
  if (last < first) throw hard('Local TTS segment contains no audible speech.');
  const start = Math.max(0, first - 2) * frameSamples * 2;
  const end = Math.min(frames, last + 3) * frameSamples * 2;
  return pcm.subarray(start, end);
}

export async function invokeLocalTtsWorker({ runtime, request, fetchImpl = globalThis.fetch }) {
  if (runtime?.kind === 'http') return invokeHttpWorker({ runtime, request, fetchImpl });
  if (runtime?.kind === 'command') return invokeCommandWorker({ runtime, request });
  throw config('Local TTS runtime is not configured.');
}
