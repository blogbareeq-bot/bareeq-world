import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, atomicWriteJson } from './audio-io.mjs';
import { sha256 } from './audio-constants.mjs';
import { engineFingerprintExtension, publicEngineIdentity } from './audio-engine-config.mjs';
import { prepareArabicSynthesisText } from './audio-arabic-normalizer.mjs';

export const SEGMENT_CACHE_SCHEMA = 'bareeq.audio-segment-cache.v1';

function safeId(value) {
  return String(value || 'segment').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'segment';
}

export function segmentFingerprint({ article, item, synthesis, env = process.env }) {
  const profile = publicEngineIdentity(env);
  return sha256(JSON.stringify({
    schema: SEGMENT_CACHE_SCHEMA,
    articleId: article.articleId,
    segmentId: item.segmentId,
    canonicalText: synthesis.canonicalText,
    synthesisText: synthesis.synthesisText,
    synthesisFingerprint: synthesis.fingerprint,
    speechScriptHash: article.speechScriptHash,
    model: profile.model,
    voice: profile.voice,
    engine: engineFingerprintExtension(env),
  }));
}

export function segmentCachePaths({ root, articleId, candidateFingerprint, segmentId, fingerprint }) {
  const dir = path.join(root, 'audio-candidates', articleId, candidateFingerprint, 'segments');
  const stem = safeId(segmentId) + '-' + fingerprint.slice(0, 12);
  return {
    dir,
    audioFile: path.join(dir, stem + '.mp3'),
    metadataFile: path.join(dir, stem + '.json'),
  };
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

export function buildSegmentPlan(article, lexicon, env = process.env) {
  return article.items.map((item, index) => {
    const synthesis = prepareArabicSynthesisText(item.text, lexicon);
    const fingerprint = segmentFingerprint({ article, item, synthesis, env });
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
