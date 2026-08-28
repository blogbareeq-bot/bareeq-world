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

export const INDEPENDENT_ASR_MODELS = Object.freeze([
  'gemini-3.5-transcribe',
  'gemini-3.6-flash',
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
  'gemini-3.6-flash': {
    api: 'interactions',
    fileUpload: true,
    input: 'text-plus-audio-uri',
    verbatim: true,
  },
});

export const LEGACY_SPLIT = Object.freeze({
  version: 1,
  name: 'byte-cap-2400',
  maxTranscriptBytes: 2400,
  targetSeconds: null,
  maxSeconds: null,
});

export const QUOTA_SPLIT = Object.freeze({
  version: 2,
  name: 'sentence-duration-quota',
  targetSeconds: 165,
  minSeconds: 90,
  maxSeconds: 180,
  maxTranscriptBytes: 6500,
  officialTextLimitBytes: 4000,
  officialPromptLimitBytes: 4000,
  officialCombinedLimitBytes: 8000,
  officialOutputSeconds: 655,
  driftCapSeconds: 180,
  defaultCharsPerSecond: 10,
});

export const PERFORMANCE_INSTRUCTIONS = GEMINI_STYLE;

export const CANDIDATE_SCHEMA = 'bareeq.audio-candidate.v2';
export const CHECKPOINT_SCHEMA = 'bareeq.audio-checkpoint.v2';

export const encoder = new TextEncoder();
export const utf8Bytes = (value) => encoder.encode(String(value ?? '')).byteLength;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const audioKeyFor = (articleId) => sha256(articleId).slice(0, 16);

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
