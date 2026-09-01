/**
 * OpenRouter ASR transport for Bareeq voice validation.
 *
 * Why this exists: the Gemini direct ASR path (gemini-3.5-transcribe /
 * gemini-3.6-flash via the Files API + interactions endpoint) exhausted its
 * free-tier quota (exit 75). This module performs the *same* verbatim
 * transcription work through the OpenRouter gateway instead, so the
 * independent dual-ASR gate can close without waiting for Gemini quota.
 *
 * Guarantees kept identical to the Gemini path:
 *   - transcription is independent of the expected text (no priming, no
 *     expected transcript is ever sent to the model)
 *   - exact lexical comparison only (audio-exact-match.mjs); no fuzzy
 *     matching, no stemming, no synonyms
 *   - full evidence: gateway, model, request id, audio SHA-256, usage/cost,
 *     transcript
 *
 * This module never uploads to the Gemini Files API, so it must never emit
 * Files-API evidence fields.
 */

import { readFile } from 'node:fs/promises';
import { EXIT_CONFIG, EXIT_HARD, EXIT_QUOTA, EXIT_USAGE, sha256 } from './audio-constants.mjs';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_TRANSCRIPTIONS = `${OPENROUTER_BASE}/audio/transcriptions`;
export const OPENROUTER_CHAT = `${OPENROUTER_BASE}/chat/completions`;
export const OPENROUTER_MODELS = `${OPENROUTER_BASE}/models`;

/**
 * Verbatim instruction used only for the multimodal fallback transport.
 * It deliberately contains no article content and no expected wording.
 */
export const VERBATIM_PROMPT =
  'Transcribe this Arabic audio verbatim. Return only the spoken words as Modern Standard Arabic text. '
  + 'Do not translate, summarise, correct, or normalise the wording. '
  + 'Do not add commentary, timestamps, speaker labels, diacritics, or any formatting beyond the words themselves.';

function attributionHeaders() {
  return {
    'HTTP-Referer': 'https://bareeqworld.com',
    'X-Title': 'Bareeq Voice ASR Validation',
  };
}

export function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    ...attributionHeaders(),
  };
}

function requireKey(apiKey) {
  if (!apiKey?.trim()) {
    throw Object.assign(
      new Error('OPENROUTER_API_KEY is absent. No OpenRouter ASR request was sent.'),
      { exitCode: EXIT_CONFIG },
    );
  }
  return apiKey.trim();
}

/** Map an OpenRouter HTTP status onto the project's exit-code contract. */
export function exitCodeForStatus(status) {
  if (status === 429) return EXIT_QUOTA;
  // OpenRouter returns 402 when the account is out of credits. That is a
  // funding decision for the owner, not a quality failure, so it is surfaced
  // with the same "quota" exit code the pipeline already understands.
  if (status === 402) return EXIT_QUOTA;
  return EXIT_HARD;
}

export function isTransientStatus(status) {
  return status === 408 || status === 409 || status === 500 || status === 502 || status === 503 || status === 504;
}

function pickRequestId(response, payload) {
  return (
    payload?.id
    || response?.headers?.get?.('x-request-id')
    || response?.headers?.get?.('x-openrouter-request-id')
    || null
  );
}

function normaliseUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    seconds: usage.seconds ?? null,
    inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? null,
    outputTokens: usage.output_tokens ?? usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    cost: usage.cost ?? null,
  };
}

/**
 * Transcribe raw audio bytes through OpenRouter's dedicated STT endpoint.
 * Returns evidence, never throws for a plain lexical mismatch.
 */
export async function transcribeViaSttEndpoint({
  apiKey,
  model,
  bytes,
  format = 'mp3',
  language = 'ar',
  fetchImpl = globalThis.fetch,
  signalTimeoutMs = 180000,
}) {
  const key = requireKey(apiKey);
  const startedAt = new Date().toISOString();
  const body = {
    model,
    input_audio: { data: Buffer.from(bytes).toString('base64'), format },
    // temperature 0 keeps the decode as deterministic as the provider allows.
    temperature: 0,
  };
  if (language) body.language = language;

  const response = await fetchImpl(OPENROUTER_TRANSCRIPTIONS, {
    method: 'POST',
    headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(signalTimeoutMs),
  });
  const raw = await response.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* handled below */ }

  const evidence = {
    gateway: 'openrouter',
    transport: 'openrouter-stt',
    endpoint: OPENROUTER_TRANSCRIPTIONS,
    requestedModel: model,
    responseModel: payload?.model ?? null,
    requestId: pickRequestId(response, payload),
    httpStatus: response.status,
    usage: normaliseUsage(payload?.usage),
    audioSha256: sha256(bytes),
    audioBytes: bytes.length,
    startedAt,
    endedAt: new Date().toISOString(),
  };

  if (!response.ok) {
    return {
      ...evidence,
      ok: false,
      transcript: '',
      error: (payload?.error?.message || raw || '').slice(0, 800),
      exitCode: exitCodeForStatus(response.status),
      transient: isTransientStatus(response.status),
    };
  }
  const transcript = typeof payload?.text === 'string' ? payload.text.trim() : '';
  return { ...evidence, ok: Boolean(transcript), transcript, error: transcript ? null : 'empty transcript' };
}

/**
 * Fallback transport: OpenRouter multimodal chat completions with
 * `input_audio`. Used only when a dedicated STT model is unfit for Arabic.
 * The prompt carries no expected text, so the check stays independent.
 */
export async function transcribeViaChatAudio({
  apiKey,
  model,
  bytes,
  format = 'mp3',
  fetchImpl = globalThis.fetch,
  signalTimeoutMs = 300000,
}) {
  const key = requireKey(apiKey);
  const startedAt = new Date().toISOString();
  const body = {
    model,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: VERBATIM_PROMPT },
        { type: 'input_audio', input_audio: { data: Buffer.from(bytes).toString('base64'), format } },
      ],
    }],
  };

  const response = await fetchImpl(OPENROUTER_CHAT, {
    method: 'POST',
    headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(signalTimeoutMs),
  });
  const raw = await response.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* handled below */ }

  const evidence = {
    gateway: 'openrouter',
    transport: 'openrouter-chat-audio',
    endpoint: OPENROUTER_CHAT,
    requestedModel: model,
    responseModel: payload?.model ?? null,
    requestId: pickRequestId(response, payload),
    httpStatus: response.status,
    usage: normaliseUsage(payload?.usage),
    audioSha256: sha256(bytes),
    audioBytes: bytes.length,
    startedAt,
    endedAt: new Date().toISOString(),
  };

  if (!response.ok) {
    return {
      ...evidence,
      ok: false,
      transcript: '',
      error: (payload?.error?.message || raw || '').slice(0, 800),
      exitCode: exitCodeForStatus(response.status),
      transient: isTransientStatus(response.status),
    };
  }
  const transcript = String(payload?.choices?.[0]?.message?.content ?? '').trim();
  return { ...evidence, ok: Boolean(transcript), transcript, error: transcript ? null : 'empty transcript' };
}

export async function transcribeFile({ transport = 'stt', audioPath, ...rest }) {
  if (!audioPath) {
    throw Object.assign(new Error('audioPath is required'), { exitCode: EXIT_USAGE });
  }
  const bytes = await readFile(audioPath);
  const run = transport === 'chat' ? transcribeViaChatAudio : transcribeViaSttEndpoint;
  const result = await run({ bytes, ...rest });
  return { ...result, audioPath };
}

/** Discover which OpenRouter models can emit transcriptions. */
export async function listTranscriptionModels({ apiKey, fetchImpl = globalThis.fetch }) {
  const key = requireKey(apiKey);
  const response = await fetchImpl(`${OPENROUTER_MODELS}?output_modalities=transcription`, {
    headers: authHeaders(key),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`model discovery failed (${response.status}): ${raw.slice(0, 400)}`), {
      exitCode: exitCodeForStatus(response.status),
    });
  }
  const payload = JSON.parse(raw);
  return (payload?.data || []).map((model) => ({
    id: model.id,
    name: model.name ?? null,
    inputModalities: model?.architecture?.input_modalities ?? null,
    outputModalities: model?.architecture?.output_modalities ?? null,
    pricing: model?.pricing ?? null,
  }));
}

/** Discover which OpenRouter chat models accept audio input. */
export async function listAudioInputModels({ apiKey, fetchImpl = globalThis.fetch }) {
  const key = requireKey(apiKey);
  const response = await fetchImpl(OPENROUTER_MODELS, { headers: authHeaders(key) });
  const raw = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`model listing failed (${response.status}): ${raw.slice(0, 400)}`), {
      exitCode: exitCodeForStatus(response.status),
    });
  }
  const payload = JSON.parse(raw);
  return (payload?.data || [])
    .filter((model) => (model?.architecture?.input_modalities || []).includes('audio'))
    .map((model) => ({
      id: model.id,
      name: model.name ?? null,
      inputModalities: model?.architecture?.input_modalities ?? null,
      pricing: model?.pricing ?? null,
    }));
}
