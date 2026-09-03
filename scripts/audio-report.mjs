import { GENERATOR_VERSION, PRODUCTION_TTS_MODEL, PRODUCTION_VOICE } from './audio-constants.mjs';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';

export const TOOL_VERSION = 9;

export const REQUIRED_BOUND_FIELDS = Object.freeze([
  'articleId',
  'candidateFingerprint',
  'fullSha256',
  'speechScriptHash',
  'provider',
  'model',
  'voice',
  'generatorVersion',
  'schema',
  'status',
  'generatedAt',
]);

export function boundIdentity({
  article,
  fingerprint,
  fullSha256,
  status,
  schema,
  model = PRODUCTION_NARRATOR.model,
  extra = {},
}) {
  const generatedAt = extra.generatedAt || new Date().toISOString();
  return {
    schema,
    articleId: article?.articleId || extra.articleId,
    candidateFingerprint: fingerprint,
    fingerprint,
    fullSha256,
    speechScriptHash: extra.speechScriptHash ?? article?.speechScriptHash ?? null,
    provider: extra.provider || PRODUCTION_NARRATOR.provider,
    model,
    voice: extra.voice || PRODUCTION_NARRATOR.providerVoice,
    generatorVersion: extra.generatorVersion || GENERATOR_VERSION,
    toolVersion: extra.toolVersion || TOOL_VERSION,
    status,
    generatedAt,
    ttsModel: PRODUCTION_TTS_MODEL,
    ttsVoice: PRODUCTION_VOICE,
    ...extra,
    schema,
    articleId: article?.articleId || extra.articleId,
    candidateFingerprint: fingerprint,
    fingerprint,
    fullSha256,
    speechScriptHash: extra.speechScriptHash ?? article?.speechScriptHash ?? null,
    status,
    generatedAt,
  };
}

export function missingBoundFields(payload) {
  const failures = [];
  if (!payload || typeof payload !== 'object') return ['report is missing'];
  for (const field of REQUIRED_BOUND_FIELDS) {
    if (payload[field] == null || payload[field] === '') {
      failures.push(`missing ${field}`);
    }
  }
  if (payload.toolVersion == null) failures.push('missing toolVersion');
  return failures;
}

export function assertBoundReport(payload, expected, label) {
  const failures = missingBoundFields(payload).map((item) => `${label}: ${item}`);
  if (!payload) {
    return failures;
  }
  if (expected.articleId && payload.articleId !== expected.articleId) {
    failures.push(`${label}: articleId mismatch`);
  }
  if (expected.fingerprint && payload.candidateFingerprint !== expected.fingerprint) {
    failures.push(`${label}: candidateFingerprint mismatch`);
  }
  if (expected.fullSha256 && payload.fullSha256 !== expected.fullSha256) {
    failures.push(`${label}: fullSha256 mismatch`);
  }
  if (expected.speechScriptHash != null && payload.speechScriptHash !== expected.speechScriptHash) {
    failures.push(`${label}: speechScriptHash mismatch`);
  }
  return failures;
}

export function assertSafeArticleId(articleId) {
  if (!articleId || typeof articleId !== 'string') return false;
  if (articleId.includes('/') || articleId.includes('\\') || articleId.includes('..')) return false;
  return /^[A-Za-z0-9\u0600-\u06FF_-]+$/.test(articleId);
}

export function assertSha256Fingerprint(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
