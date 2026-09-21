import { resolveProductionSynthesizer } from './audio-gemini-tts.mjs';
import {
  assertEngineConfiguration,
  publicEngineIdentity,
  selectedEngineProfile,
} from './audio-engine-config.mjs';
import { prepareArabicSynthesisText, readPronunciationLexicon } from './audio-arabic-normalizer.mjs';
import { invokeLocalTtsWorker } from './audio-local-transport.mjs';

export function buildLocalWorkerRequest({ profile, article, part, splitPlan, synthesis, correctionHint = '', env = process.env }) {
  return {
    schema: 'bareeq.tts-worker.v1',
    engine: profile.id,
    model: profile.model,
    language: 'ar',
    articleId: article.articleId,
    articleTitle: article.title,
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
} = {}) {
  const profile = selectedEngineProfile(env);
  if (profile.id === 'gemini') return resolveProductionSynthesizer({ apiKey: env.GEMINI_API_KEY, fetchImpl });

  const runtime = assertEngineConfiguration(profile, env);
  const lexicon = await readPronunciationLexicon(root, env.BAREEQ_PRONUNCIATION_LEXICON);
  return async ({ article, part, splitPlan, correctionHint = '' }) => {
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
      normalization: {
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
