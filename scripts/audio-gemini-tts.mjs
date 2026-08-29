import { spawn } from 'node:child_process';
import { buildGeminiPrompt } from './speech-prompt.mjs';
import {
  EXIT_CONFIG,
  EXIT_HARD,
  EXIT_QUOTA,
  GEMINI_TTS_CONTRACT,
  PRODUCTION_TTS_MODEL,
  PRODUCTION_VOICE,
} from './audio-constants.mjs';
import { assertFfmpeg } from './audio-ffmpeg.mjs';

export function geminiTtsEndpoint() {
  const override = process.env.GEMINI_TTS_ENDPOINT?.trim();
  if (override) {
    if (process.env.BAREEQ_TTS_CONTRACT_TEST !== '1') {
      throw Object.assign(new Error('GEMINI_TTS_ENDPOINT is restricted to BAREEQ_TTS_CONTRACT_TEST=1'), { exitCode: EXIT_HARD });
    }
    return override.replace(/\/$/, '');
  }
  return GEMINI_TTS_CONTRACT.endpoint;
}

export function geminiGenerateContentEndpoint(model = PRODUCTION_TTS_MODEL) {
  const override = process.env.GEMINI_GENERATE_CONTENT_ENDPOINT?.trim();
  if (override) {
    if (process.env.BAREEQ_TTS_CONTRACT_TEST !== '1') {
      throw Object.assign(new Error('GEMINI_GENERATE_CONTENT_ENDPOINT is restricted to BAREEQ_TTS_CONTRACT_TEST=1'), { exitCode: EXIT_HARD });
    }
    return override.replace(/\/$/, '');
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

export const GEMINI_TTS_ENDPOINT = GEMINI_TTS_CONTRACT.endpoint;

export function extractGeminiAudio(payload) {
  const stepContent = Array.isArray(payload?.steps)
    ? payload.steps.flatMap((step) => (Array.isArray(step?.content) ? step.content : []))
    : [];
  const legacyContent = Array.isArray(payload?.outputs)
    ? payload.outputs.flatMap((output) => (Array.isArray(output?.content) ? output.content : [output]))
    : [];
  return [...stepContent, ...legacyContent].find((block) => block?.type === 'audio' && typeof block?.data === 'string')
    || payload?.output_audio
    || payload?.outputAudio
    || null;
}

export function extractGenerateContentAudio(payload) {
  const parts = Array.isArray(payload?.candidates)
    ? payload.candidates.flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
    : [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    if (typeof inline?.data === 'string' && inline.data.trim()) {
      return {
        data: inline.data,
        mimeType: inline.mimeType || inline.mime_type || '',
      };
    }
  }
  return null;
}

export function encodeGeminiPcmToMp3(pcm, ffmpegPath) {
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
    child.once('error', (error) => fail(new Error(`ffmpeg could not encode Gemini PCM: ${error.message}`)));
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') fail(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`ffmpeg failed to encode Gemini PCM (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 700)}`));
        return;
      }
      const mp3 = Buffer.concat(stdout);
      if (mp3.length < 100) {
        fail(new Error(`ffmpeg returned an unexpectedly small Gemini MP3 (${mp3.length} bytes).`));
        return;
      }
      settled = true;
      resolve(mp3);
    });
    child.stdin.end(pcm);
  });
}

async function decodeAndEncodePcmAudio(outputAudio, ffmpegPath, label) {
  const encoded = typeof outputAudio?.data === 'string' ? outputAudio.data.replace(/\s+/g, '') : '';
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw Object.assign(new Error(`${label} response has no valid audio content`), { exitCode: EXIT_HARD });
  }
  const mimeType = String(outputAudio?.mime_type || outputAudio?.mimeType || '').toLowerCase();
  if (mimeType && !mimeType.includes('l16') && !mimeType.includes('pcm') && !mimeType.includes('audio/raw')) {
    throw Object.assign(new Error(`${label} returned unsupported audio MIME type ${mimeType}`), { exitCode: EXIT_HARD });
  }
  const sampleRateMatch = mimeType.match(/(?:rate=|rate%3d)(\d+)/i);
  const sampleRate = Number(outputAudio?.sample_rate || outputAudio?.sampleRate || sampleRateMatch?.[1] || 24000);
  const channels = Number(outputAudio?.channels || 1);
  if (sampleRate !== 24000 || channels !== 1) {
    throw Object.assign(new Error(`${label} returned unsupported PCM layout (${sampleRate} Hz, ${channels} channel(s))`), { exitCode: EXIT_HARD });
  }
  const pcm = Buffer.from(encoded, 'base64');
  if (pcm.length < 100 || pcm.length % 2 !== 0) {
    throw Object.assign(new Error(`${label} returned invalid 16-bit PCM (${pcm.length} bytes)`), { exitCode: EXIT_HARD });
  }
  const { ffmpeg } = ffmpegPath ? { ffmpeg: ffmpegPath } : await assertFfmpeg();
  return encodeGeminiPcmToMp3(pcm, ffmpeg);
}

export async function synthesizeGeminiPart({
  apiKey,
  part,
  context,
  voice = PRODUCTION_VOICE,
  model = PRODUCTION_TTS_MODEL,
  fetchImpl = globalThis.fetch,
  ffmpegPath,
}) {
  if (!apiKey?.trim()) {
    throw Object.assign(new Error('GEMINI_API_KEY is absent. No TTS request was sent.'), { exitCode: EXIT_CONFIG });
  }
  const endpoint = geminiTtsEndpoint();
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Api-Revision': GEMINI_TTS_CONTRACT.apiRevision,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        input: buildGeminiPrompt(part, context),
        response_format: { type: 'audio' },
        generation_config: {
          speech_config: [{ voice }],
        },
      }),
    });
  } catch (error) {
    throw Object.assign(new Error(`Gemini TTS transport failed (${endpoint}): ${error.cause?.code || error.cause?.message || error.message}`), { exitCode: EXIT_HARD });
  }
  if (response.status === 429) {
    throw Object.assign(new Error('Gemini TTS HTTP 429'), { httpStatus: 429, exitCode: EXIT_QUOTA, code: 'BAREEQ_QUOTA' });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw Object.assign(new Error(`Gemini TTS failed (${response.status}): ${body.slice(0, 700)}`), {
      httpStatus: response.status,
      exitCode: EXIT_HARD,
    });
  }
  let payload;
  try { payload = await response.json(); }
  catch (error) { throw Object.assign(new Error(`Gemini TTS returned invalid JSON: ${error.message}`), { exitCode: EXIT_HARD }); }
  const outputAudio = extractGeminiAudio(payload);
  return decodeAndEncodePcmAudio(outputAudio, ffmpegPath, 'Gemini Interactions TTS');
}

export async function synthesizeGeminiGenerateContentPart({
  apiKey,
  part,
  context,
  voice = PRODUCTION_VOICE,
  model = PRODUCTION_TTS_MODEL,
  fetchImpl = globalThis.fetch,
  ffmpegPath,
}) {
  if (!apiKey?.trim()) {
    throw Object.assign(new Error('GEMINI_API_KEY is absent. No generateContent TTS request was sent.'), { exitCode: EXIT_CONFIG });
  }
  const endpoint = geminiGenerateContentEndpoint(model);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: buildGeminiPrompt(part, context) }],
        }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      }),
    });
  } catch (error) {
    throw Object.assign(new Error(`Gemini generateContent TTS transport failed (${endpoint}): ${error.cause?.code || error.cause?.message || error.message}`), { exitCode: EXIT_HARD });
  }
  if (response.status === 429) {
    throw Object.assign(new Error('Gemini generateContent TTS HTTP 429'), { httpStatus: 429, exitCode: EXIT_QUOTA, code: 'BAREEQ_QUOTA' });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw Object.assign(new Error(`Gemini generateContent TTS failed (${response.status}): ${body.slice(0, 700)}`), {
      httpStatus: response.status,
      exitCode: EXIT_HARD,
    });
  }
  let payload;
  try { payload = await response.json(); }
  catch (error) { throw Object.assign(new Error(`Gemini generateContent TTS returned invalid JSON: ${error.message}`), { exitCode: EXIT_HARD }); }
  const outputAudio = extractGenerateContentAudio(payload);
  const audio = await decodeAndEncodePcmAudio(outputAudio, ffmpegPath, 'Gemini generateContent TTS');
  return {
    audio,
    transport: 'developer-generate-content',
    endpoint,
    projectId: null,
    model,
    voice,
  };
}

export async function resolveProductionSynthesizer({
  apiKey = process.env.GEMINI_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof process.env.BAREEQ_AUDIO_SYNTHESIZE_HOOK === 'function') {
    return process.env.BAREEQ_AUDIO_SYNTHESIZE_HOOK;
  }
  if (process.env.BAREEQ_GEMINI_GENERATE_CONTENT === '1') {
    return async ({ article, part, splitPlan, correctionHint }) => synthesizeGeminiGenerateContentPart({
      apiKey,
      part,
      context: {
        articleTitle: article.title,
        partIndex: part.partIndex,
        partCount: splitPlan.parts.length,
        correctionHint,
      },
      fetchImpl,
    });
  }
  return async ({ article, part, splitPlan, correctionHint }) => synthesizeGeminiPart({
    apiKey,
    part,
    context: {
      articleTitle: article.title,
      partIndex: part.partIndex,
      partCount: splitPlan.parts.length,
      correctionHint,
    },
    fetchImpl,
  });
}
