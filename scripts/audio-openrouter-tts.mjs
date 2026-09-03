import { spawn } from 'node:child_process';
import {
  EXIT_CONFIG,
  EXIT_HARD,
  EXIT_QUOTA,
  PRODUCTION_TTS_MODEL,
  PRODUCTION_VOICE,
} from './audio-constants.mjs';
import { assertFfmpeg } from './audio-ffmpeg.mjs';

export const OPENROUTER_TTS_ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';
export const OPENROUTER_TTS_MODEL = `google/${PRODUCTION_TTS_MODEL}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeBody(body) {
  return String(body || '').replace(/[\r\n]+/g, ' ').slice(0, 700);
}

function encodePcmToMp3(pcm, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
      '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once('error', (error) => fail(new Error(`ffmpeg could not encode OpenRouter PCM: ${error.message}`)));
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') fail(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`ffmpeg failed to encode OpenRouter PCM (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 700)}`));
        return;
      }
      const mp3 = Buffer.concat(stdout);
      if (mp3.length < 100) {
        fail(new Error(`ffmpeg returned an unexpectedly small OpenRouter MP3 (${mp3.length} bytes).`));
        return;
      }
      settled = true;
      resolve(mp3);
    });
    child.stdin.end(pcm);
  });
}

export async function synthesizeOpenRouterPart({
  apiKey = process.env.OPENROUTER_API_KEY,
  part,
  voice = PRODUCTION_VOICE,
  model = OPENROUTER_TTS_MODEL,
  fetchImpl = globalThis.fetch,
  ffmpegPath,
}) {
  if (!apiKey?.trim()) {
    throw Object.assign(new Error('OPENROUTER_API_KEY is absent. No OpenRouter TTS request was sent.'), { exitCode: EXIT_CONFIG });
  }
  if (!part?.text?.trim()) {
    throw Object.assign(new Error('OpenRouter TTS refused an empty speech part.'), { exitCode: EXIT_HARD });
  }

  let response;
  let bodyText = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetchImpl(OPENROUTER_TTS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'audio/pcm',
          'HTTP-Referer': 'https://bareeqworld.com',
          'X-Title': 'Bareeq',
        },
        body: JSON.stringify({
          model,
          input: part.text,
          voice,
          response_format: 'pcm',
        }),
      });
    } catch (error) {
      if (attempt < 3) {
        await sleep(1000 * attempt);
        continue;
      }
      throw Object.assign(new Error(`OpenRouter TTS transport failed: ${error.cause?.code || error.cause?.message || error.message}`), { exitCode: EXIT_HARD });
    }

    if (response.ok) break;
    bodyText = await response.text().catch(() => '');
    if ([500, 502, 503, 524, 529].includes(response.status) && attempt < 3) {
      await sleep(1500 * attempt);
      continue;
    }
    break;
  }

  if (!response) {
    throw Object.assign(new Error('OpenRouter TTS produced no HTTP response.'), { exitCode: EXIT_HARD });
  }
  if (response.status === 402 || response.status === 429) {
    if (!bodyText) bodyText = await response.text().catch(() => '');
    throw Object.assign(new Error(`OpenRouter TTS quota/billing stop (${response.status}): ${safeBody(bodyText)}`), {
      httpStatus: response.status === 429 ? 429 : 402,
      exitCode: EXIT_QUOTA,
      code: 'BAREEQ_QUOTA',
    });
  }
  if (!response.ok) {
    if (!bodyText) bodyText = await response.text().catch(() => '');
    throw Object.assign(new Error(`OpenRouter TTS failed (${response.status}): ${safeBody(bodyText)}`), {
      httpStatus: response.status,
      exitCode: response.status === 401 || response.status === 403 ? EXIT_CONFIG : EXIT_HARD,
    });
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('audio/pcm') && !contentType.includes('application/octet-stream')) {
    throw Object.assign(new Error(`OpenRouter TTS returned unexpected content type ${contentType}`), { exitCode: EXIT_HARD });
  }
  const pcm = Buffer.from(await response.arrayBuffer());
  if (pcm.length < 100 || pcm.length % 2 !== 0) {
    throw Object.assign(new Error(`OpenRouter TTS returned invalid 24 kHz 16-bit PCM (${pcm.length} bytes).`), { exitCode: EXIT_HARD });
  }
  const { ffmpeg } = ffmpegPath ? { ffmpeg: ffmpegPath } : await assertFfmpeg();
  const audio = await encodePcmToMp3(pcm, ffmpeg);
  return {
    audio,
    transport: 'openrouter-speech',
    endpoint: OPENROUTER_TTS_ENDPOINT,
    projectId: null,
    model: PRODUCTION_TTS_MODEL,
    voice,
  };
}
