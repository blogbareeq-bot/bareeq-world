import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';
import {
  audioKeyFor,
  PRODUCTION_VOICE_ID,
  GENERATOR_VERSION,
  PERFORMANCE_INSTRUCTIONS,
} from './audio-constants.mjs';
import { publicEngineIdentity, synthesisContractSha256 } from './audio-engine-config.mjs';

export function isValidProductionManifest(data) {
  if (!data || !Array.isArray(data.parts) || !data.parts.length || !data.parts.every((part) => Array.isArray(part?.sync))) return false;
  if (Array.isArray(data.voices) && data.voices.length) {
    const ids = data.voices.map((voice) => voice?.id).filter(Boolean);
    return ids.length === data.voices.length && data.parts.every((part) => ids.every((id) => typeof part?.audio?.[id]?.src === 'string' && part.audio[id].src.endsWith('.mp3') && Number(part.audio[id].durationSeconds) > 0));
  }
  return data.parts.every((part) => typeof part?.src === 'string' && part.src.endsWith('.mp3'));
}

export function buildProductionManifest({
  article,
  splitPlan,
  partAssets,
  fingerprint,
  fullSha256 = null,
}) {
  const engine = publicEngineIdentity();
  const voiceId = engine.engineId === 'gemini' ? PRODUCTION_VOICE_ID : engine.voiceId;
  const parts = splitPlan.parts.map((part, index) => {
    const asset = partAssets[index];
    if (!asset?.src || !asset.src.endsWith('.mp3') || !(Number(asset.durationSeconds) > 0)) {
      throw new Error(`part ${index} is missing player-compatible audio asset`);
    }
    return {
      characters: part.chars,
      sync: part.sync || [],
      syncIds: part.syncIds || (part.sync || []).map((entry) => entry.id),
      audio: {
        [voiceId]: {
          src: asset.src,
          bytes: asset.bytes,
          durationSeconds: Number(asset.durationSeconds),
          sha256: asset.sha256,
        },
      },
    };
  });
  const totalDurationSeconds = Number(parts.reduce((sum, part) => sum + Number(part.audio[voiceId].durationSeconds || 0), 0).toFixed(3));
  return {
    version: 3,
    generatorVersion: GENERATOR_VERSION,
    syncVersion: 1,
    speechScriptHash: article.speechScriptHash,
    speechInput: 'reviewed-contextual-speech-script',
    engineId: engine.engineId,
    engine,
    ...(engine.local ? { synthesisContractSha256: synthesisContractSha256() } : {}),
    provider: engine.provider,
    model: engine.model,
    language: PRODUCTION_NARRATOR.language,
    outputFormat: engine.engineId === 'gemini' ? PRODUCTION_NARRATOR.outputFormat : 'MP3 48kHz mono 96kbps',
    articleId: article.articleId,
    title: article.title,
    audioKey: audioKeyFor(article.articleId),
    fingerprint,
    fullSha256,
    defaultVoice: voiceId,
    voices: [{
      id: voiceId,
      label: engine.engineId === 'gemini' ? 'سادالتاجر (Sadaltager)' : engine.provider,
      description: engine.engineId === 'gemini' ? 'معرفي طبيعي مناسب لمقالات بريق' : 'مرشح صوت بريق التجريبي — غير معتمد للنشر حتى مراجعة وضع العمل',
      providerVoice: engine.voice,
      totalDurationSeconds,
    }],
    syncMethod: 'paragraph-weighted',
    performanceInstructions: PERFORMANCE_INSTRUCTIONS,
    sourceAudioFormat: engine.engineId === 'gemini' ? PRODUCTION_NARRATOR.sourceAudioFormat : 'worker audio normalized before validation',
    encodingTool: engine.engineId === 'gemini' ? PRODUCTION_NARRATOR.encodingTool : 'ffmpeg',
    disclosure: 'الصوت مولّد بالذكاء الاصطناعي وليس صوتًا بشريًا.',
    parts,
  };
}

export function buildCandidateManifest(args) {
  return buildProductionManifest(args);
}

export function publicPartSrc(articleId, filename) {
  return `/audio/articles/${audioKeyFor(articleId)}/${filename}`;
}
