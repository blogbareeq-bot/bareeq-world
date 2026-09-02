import { createHash } from 'node:crypto';
import path from 'node:path';
import { GEMINI_STYLE } from './speech-prompt.mjs';

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_HARD = 1;
export const EXIT_QUOTA = 75;
export const EXIT_CONFIG = 78;

export const PRODUCTION_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
export const PRODUCTION_VOICE = 'Sadaltager';
export const PRODUCTION_VOICE_ID = 'sadaltager';
export const GENERATOR_VERSION = 10;

// gemini-3.6-flash exhausted its daily provider quota and gemini-3.5-flash
// remained unavailable after bounded transient retries. Use the specialized
// transcription model with flash-lite for the remaining final pass; they are
// distinct model identifiers and keep the two-model exact-consensus gate.
export const INDEPENDENT_ASR_MODELS = Object.freeze([
  'gemini-3.5-flash-lite',
  'gemini-3.5-transcribe',
]);

export const FORBIDDEN_ASR_MODELS = Object.freeze([
  'gemini-3.6-transcribe',
]);

export const ASR_MODEL_TRANSPORT = Object.freeze({
  'gemini-3.5-transcribe': {
    api: 'interactions',
    fileUpload: true,
    input: 'audio-uri',
    verbatim: true,
  },
  // Kept as a supported non-production transport for diagnostics/resume data.
  'gemini-3.5-flash': {
    api: 'interactions',
    fileUpload: true,
    input: 'text-plus-audio-uri',
    verbatim: true,
  },
  'gemini-3.5-flash-lite': {
    api: 'interactions',
    fileUpload: true,
    input: 'text-plus-audio-uri',
    verbatim: true,
  },
  'gemini-3.6-flash': {
    api: 'interactions',
    fileUpload: true,
    input: 'text-plus-audio-uri',
    verbatim: true,
  },
});

export const GEMINI_TTS_CONTRACT = Object.freeze({
  provider: 'gemini-interactions',
  model: PRODUCTION_TTS_MODEL,
  inputTokenLimit: 8192,
  outputTokenLimit: 16384,
  qualityCapSeconds: 180,
  sampleRateHz: 24000,
  channels: 1,
  pcmEncoding: 's16le',
  tokenEstimateDivisorBytes: 3,
  endpoint: 'https://generativelanguage.googleapis.com/v1beta/interactions',
  apiRevision: '2026-05-20',
});

export const CLOUD_TTS_CONTRACT = Object.freeze({
  provider: 'cloud-tts',
  status: 'inactive-until-BAREEQ_CLOUD_TTS_ACTIVATE',
  officialMaxTranscriptBytes: 4000,
  officialMaxPromptBytes: 4000,
  officialCombinedBytes: 8000,
  officialOutputSeconds: 655,
  note: 'Cloud TTS byte/duration caps are not the official Gemini Interactions TTS contract.',
});

export const LEGACY_SPLIT = Object.freeze({
  version: 1,
  name: 'byte-cap-2400',
  maxTranscriptBytes: 2400,
  targetSeconds: null,
  maxSeconds: null,
});

export const QUOTA_SPLIT = Object.freeze({
  version: 4,
  algorithmVersion: 4,
  name: 'gemini-8192-token-duration',
  targetSeconds: 165,
  minSeconds: 90,
  maxSeconds: GEMINI_TTS_CONTRACT.qualityCapSeconds,
  targetBandMinSeconds: 150,
  targetBandMaxSeconds: GEMINI_TTS_CONTRACT.qualityCapSeconds,
  maxTranscriptBytes: 6500,
  geminiInputTokenLimit: GEMINI_TTS_CONTRACT.inputTokenLimit,
  geminiTokenEstimateDivisorBytes: GEMINI_TTS_CONTRACT.tokenEstimateDivisorBytes,
  defaultCharsPerSecond: 10,
  rebalanceFloorSeconds: 90,
  generatorVersion: GENERATOR_VERSION,
});

export const PERFORMANCE_INSTRUCTIONS = GEMINI_STYLE;

export const CANDIDATE_SCHEMA = 'bareeq.audio-candidate.v3';
export const CHECKPOINT_SCHEMA = 'bareeq.audio-checkpoint.v3';

export const encoder = new TextEncoder();
export const utf8Bytes = (value) => encoder.encode(String(value ?? '')).byteLength;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const audioKeyFor = (articleId) => sha256(articleId).slice(0, 16);

export function estimateGeminiTokens(text) {
  return Math.ceil(utf8Bytes(text) / GEMINI_TTS_CONTRACT.tokenEstimateDivisorBytes);
}

export function candidateRoot(root = process.cwd()) {
  return path.join(root, 'audio-candidates');
}

export function liveAudioDir(articleId, root = process.cwd()) {
  return path.join(root, 'public', 'audio', 'articles', audioKeyFor(articleId));
}

export function candidateDir(articleId, fingerprint, root = process.cwd()) {
  return path.join(candidateRoot(root), articleId, fingerprint);
}

export function joinSpeechPieces(items) {
  let text = '';
  for (const item of items) {
    const piece = String(item.text || '').trim();
    if (!piece) continue;
    if (!text) text = piece;
    else text += /[.!؟؛:]$/.test(text) ? ` ${piece}` : `. ${piece}`;
  }
  return text.trim();
}
