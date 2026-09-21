import { resolveProductionSynthesizer } from './audio-gemini-tts.mjs';
import {
  assertEngineConfiguration,
  publicEngineIdentity,
  selectedEngineProfile,
} from './audio-engine-config.mjs';
import { prepareArabicSynthesisText, readPronunciationLexicon } from './audio-arabic-normalizer.mjs';
import { concatWorkerMp3Buffers, invokeLocalTtsWorker } from './audio-local-transport.mjs';
import { loadCachedSegment, saveCachedSegment, segmentCachePaths, segmentFingerprint } from './audio-segment-cache.mjs';

export function buildLocalWorkerRequest({ profile, article, part, splitPlan, synthesis, correctionHint = '', env = process.env }) {
  return {
    schema: 'bareeq.tts-worker.v1',
    engine: profile.id,
    model: profile.model,
    language: 'ar',
    articleId: article.articleId,
    articleTitle: article.title,
    segmentId: part.segmentId || null,
    partIndex: part.partIndex,
    partCount: splitPlan.parts.length,
    canonicalText: synthesis.canonicalText,
    text: synthesis.synthesisText,
    correctionHint: String(correctionHint || ''),
    voice: {
      id: profile.voiceId,
      designPrompt: profile.supportsVoiceDesign ? String(env.BAREEQ_VOICE_DESIGN_PROMPT || '').trim() : '',
      referenceAudio: String(env.BAREEQ_TTS_REFERENCE_AUDIO || '').trim() || null,
    },
    output: {
      format: 'mp3',
      sampleRateHz: profile.outputSampleRateHz || 48000,
      channels: 1,
      bitrateKbps: 96,
    },
    audit: {
      normalizerVersion: synthesis.normalizerVersion,
      pronunciationLexiconVersion: synthesis.lexiconVersion,
      synthesisFingerprint: synthesis.fingerprint,
    },
  };
}

export async function resolveAudioSynthesizer({
  env = process.env,
  fetchImpl = globalThis.fetch,
  root = process.cwd(),
  cacheRoot = root,
} = {}) {
  const profile = selectedEngineProfile(env);
  if (profile.id === 'gemini') return resolveProductionSynthesizer({ apiKey: env.GEMINI_API_KEY, fetchImpl });

  const runtime = assertEngineConfiguration(profile, env);
  const lexicon = await readPronunciationLexicon(root, env.BAREEQ_PRONUNCIATION_LEXICON);
  return async ({ article, part, splitPlan, correctionHint = '' }) => {
    const useSegmentCache = env.BAREEQ_SEGMENT_CACHE_ENABLE === '1' && Array.isArray(part.items) && part.items.length > 0;
    if (useSegmentCache) {
      const buffers = [];
      const segmentRecords = [];
      let providerCalls = 0;
      for (const item of part.items) {
        const synthesis = prepareArabicSynthesisText(item.text, lexicon);
        const fingerprint = segmentFingerprint({ article, item, synthesis, correctionHint, env });
        const paths = segmentCachePaths({
          root: cacheRoot,
          articleId: article.articleId,
          segmentId: item.segmentId,
          fingerprint,
          env,
        });
        const cached = await loadCachedSegment(paths, fingerprint);
        if (cached) {
          buffers.push(cached.audio);
          segmentRecords.push({ segmentId: item.segmentId, fingerprint, cache: 'hit', sha256: cached.metadata.sha256 });
          continue;
        }
        const segmentPart = { ...part, text: item.text, items: [item], segmentId: item.segmentId };
        const request = buildLocalWorkerRequest({ profile, article, part: segmentPart, splitPlan, synthesis, correctionHint, env });
        let result;
        try {
          result = await invokeLocalTtsWorker({ runtime, request, fetchImpl });
          providerCalls += 1;
        } catch (error) {
          error.providerCalls = providerCalls + 1;
          throw error;
        }
        const record = await saveCachedSegment(paths, {
          fingerprint,
          articleId: article.articleId,
          segmentId: item.segmentId,
          synthesis,
          audio: result.audio,
          env,
          metadata: {
            workerTransport: result.transport,
            workerMetadata: result.metadata,
          },
        });
        buffers.push(result.audio);
        segmentRecords.push({ segmentId: item.segmentId, fingerprint, cache: 'miss', sha256: record.sha256 });
      }
      return {
        audio: await concatWorkerMp3Buffers(buffers),
        transport: 'local-' + profile.id + '-segment-cache',
        endpoint: runtime.kind === 'http' ? runtime.endpoint : null,
        projectId: null,
        model: profile.model,
        voice: profile.voice,
        engineId: profile.id,
        providerCalls,
        normalization: {
          mode: 'segment',
          normalizerVersion: segmentRecords.length ? undefined : null,
          lexiconVersion: lexicon.version,
        },
        workerMetadata: {
          segmentCache: {
            enabled: true,
            segments: segmentRecords,
            hits: segmentRecords.filter((item) => item.cache === 'hit').length,
            misses: segmentRecords.filter((item) => item.cache === 'miss').length,
          },
        },
      };
    }

    const synthesis = prepareArabicSynthesisText(part.text, lexicon);
    const request = buildLocalWorkerRequest({ profile, article, part, splitPlan, synthesis, correctionHint, env });
    const result = await invokeLocalTtsWorker({ runtime, request, fetchImpl });
    return {
      audio: result.audio,
      transport: 'local-' + profile.id + '-' + result.transport,
      endpoint: runtime.kind === 'http' ? runtime.endpoint : null,
      projectId: null,
      model: profile.model,
      voice: profile.voice,
      engineId: profile.id,
      providerCalls: 1,
      normalization: {
        mode: 'part',
        changed: synthesis.changed,
        transformations: synthesis.transformations,
        normalizerVersion: synthesis.normalizerVersion,
        lexiconVersion: synthesis.lexiconVersion,
        synthesisFingerprint: synthesis.fingerprint,
      },
      workerMetadata: result.metadata,
    };
  };
}

export function currentAudioEngineIdentity(env = process.env) {
  return publicEngineIdentity(env);
}
