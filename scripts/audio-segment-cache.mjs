import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, atomicWriteJson } from './audio-io.mjs';
import { sha256 } from './audio-constants.mjs';
import { engineFingerprintExtension, publicEngineIdentity } from './audio-engine-config.mjs';
import { prepareArabicSynthesisText } from './audio-arabic-normalizer.mjs';
import { assertSafeArticleId } from './audio-report.mjs';

export const SEGMENT_CACHE_SCHEMA = 'bareeq.audio-segment-cache.v2';

function safeId(value) {
  return String(value || 'segment').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'segment';
}

export function segmentFingerprint({ article, item, synthesis, correctionHint = '', env = process.env }) {
  const profile = publicEngineIdentity(env);
  return sha256(JSON.stringify({
    schema: SEGMENT_CACHE_SCHEMA,
    articleId: article.articleId,
    segmentId: item.segmentId,
    canonicalText: synthesis.canonicalText,
    synthesisText: synthesis.synthesisText,
    synthesisFingerprint: synthesis.fingerprint,
    correctionHint: String(correctionHint || ''),
    model: profile.model,
    voice: profile.voice,
    engine: engineFingerprintExtension(env),
  }));
}

export function segmentCachePaths({ root, articleId, segmentId, fingerprint, env = process.env }) {
  if (!assertSafeArticleId(articleId) || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('Invalid segment cache article ID or fingerprint.');
  }
  const engine = publicEngineIdentity(env);
  const dir = path.join(root, 'audio-candidates', '_segment-cache', articleId, engine.engineId);
  const stem = safeId(segmentId) + '-' + fingerprint;
  return {
    dir,
    audioFile: path.join(dir, stem + '.wav'),
    metadataFile: path.join(dir, stem + '.json'),
  };
}

export async function withSegmentCacheLock(paths, operation, { timeoutMs = 960000 } = {}) {
  await mkdir(paths.dir, { recursive: true });
  const lock = `${paths.metadataFile}.lock`;
  const started = Date.now();
  let handle;
  while (!handle) {
    try { handle = await open(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = await stat(lock).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
      if (age > 1200000) { await rm(lock, { force: true }); continue; }
      if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for segment cache lock.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await operation(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}

export async function loadCachedSegment(paths, expectedFingerprint) {
  try {
    const metadata = JSON.parse(await readFile(paths.metadataFile, 'utf8'));
    if (metadata?.schema !== SEGMENT_CACHE_SCHEMA || metadata?.fingerprint !== expectedFingerprint) return null;
    const audio = await readFile(paths.audioFile);
    if (audio.length < 100 || sha256(audio) !== metadata.sha256) return null;
    return { audio, metadata };
  } catch {
    return null;
  }
}

export async function saveCachedSegment(paths, { fingerprint, articleId, segmentId, synthesis, audio, env = process.env, metadata = {} }) {
  if (!Buffer.isBuffer(audio) || audio.length < 100) throw new Error('Segment cache refuses empty/small audio.');
  if (audio.subarray(0, 4).toString('ascii') !== 'RIFF' || audio.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Segment cache accepts only uncompressed WAV segments.');
  }
  await mkdir(paths.dir, { recursive: true });
  await atomicWriteFile(paths.audioFile, audio);
  const record = {
    schema: SEGMENT_CACHE_SCHEMA,
    fingerprint,
    articleId,
    segmentId,
    sha256: sha256(audio),
    bytes: audio.length,
    engine: publicEngineIdentity(env),
    synthesis: {
      canonicalTextHash: sha256(synthesis.canonicalText),
      synthesisTextHash: sha256(synthesis.synthesisText),
      synthesisFingerprint: synthesis.fingerprint,
      changed: synthesis.changed,
      transformations: synthesis.transformations,
      normalizerVersion: synthesis.normalizerVersion,
      lexiconVersion: synthesis.lexiconVersion,
    },
    metadata,
    savedAt: new Date().toISOString(),
  };
  await atomicWriteJson(paths.metadataFile, record);
  return record;
}

export function buildSegmentPlan(article, lexicon, env = process.env, correctionHint = '') {
  return article.items.map((item, index) => {
    const synthesis = prepareArabicSynthesisText(item.text, lexicon);
    const fingerprint = segmentFingerprint({ article, item, synthesis, correctionHint, env });
    return {
      index,
      segmentId: item.segmentId,
      runtimeId: item.runtimeId,
      type: item.type,
      canonicalText: synthesis.canonicalText,
      synthesisText: synthesis.synthesisText,
      synthesisFingerprint: synthesis.fingerprint,
      fingerprint,
      changed: synthesis.changed,
      transformations: synthesis.transformations,
    };
  });
}
