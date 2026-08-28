import { INDEPENDENT_ASR_MODELS as ASR_MODELS, FORBIDDEN_ASR_MODELS } from './audio-constants.mjs';

/**
 * Bareeq V4.22.1 audio lifecycle gates.
 *
 * Stages are independent and never circular:
 *   text_ready → generation_authorized → generated → asr_passed
 *   → human_approved → technical_passed → publishable → published
 *
 * Generation authorization requires a reviewed spoken-text script.
 * It must not require ASR, listening evidence, or any artifact that can
 * only exist after TTS has already run.
 */

export const AUDIO_LIFECYCLE_STAGES = [
  'text_ready',
  'generation_authorized',
  'generated',
  'asr_passed',
  'human_approved',
  'technical_passed',
  'publishable',
  'published',
];

export const PRODUCTION_NARRATOR = {
  role: 'primary',
  provider: 'Google Gemini API',
  providerId: 'gemini',
  model: 'gemini-3.1-flash-tts-preview',
  voiceId: 'sadaltager',
  providerVoice: 'Sadaltager',
  language: 'ar',
  outputFormat: 'audio-48khz-96kbitrate-mono-mp3',
  sourceAudioFormat: 'pcm-s16le-24000hz-mono',
  encodingTool: 'ffmpeg-libmp3lame',
  generatorVersion: 8,
};

export const FALLBACK_NARRATOR = {
  role: 'fallback-only',
  provider: 'Microsoft Azure AI Speech',
  providerId: 'azure',
  model: 'Neural TTS',
  voiceId: 'hamed',
  providerVoice: 'ar-SA-HamedNeural',
  alternateVoiceId: 'fahed',
  alternateProviderVoice: 'ar-KW-FahedNeural',
  language: 'ar-SA',
  note: 'Hamed/Fahed remain rollback voices. They are not competing production narrators.',
};

export const INDEPENDENT_ASR_MODELS = ASR_MODELS;
export { FORBIDDEN_ASR_MODELS };

const STAGE_INDEX = Object.fromEntries(AUDIO_LIFECYCLE_STAGES.map((stage, index) => [stage, index]));

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function evaluateTextReadiness(post) {
  const validation = post?.speechApproval?.validation;
  const reasons = [];
  if (!validation?.valid) reasons.push('Speech Script is missing, stale, or structurally invalid');
  if (!validation?.approved) reasons.push('Speech Script is not fully linguistically/pronunciation reviewed');
  return {
    stage: 'text_ready',
    passed: reasons.length === 0,
    reasons,
  };
}

export function evaluateGenerationAuthorization(post) {
  const text = evaluateTextReadiness(post);
  const plan = post?.speechApproval?.testClipPlan;
  const reasons = [...text.reasons];
  if (!plan) reasons.push('test clip plan is missing');
  if (plan && plan.speechScriptHash !== post?.speechApproval?.script?.scriptHash) {
    reasons.push('test clip plan targets a stale Speech Script hash');
  }
  return {
    stage: 'generation_authorized',
    passed: reasons.length === 0,
    reasons,
    textReady: text.passed,
  };
}

export function evaluateGenerated(record = {}) {
  const reasons = [];
  if (!record.generated) reasons.push('no complete generated candidate exists');
  if (record.provider && record.provider !== PRODUCTION_NARRATOR.provider) {
    reasons.push(`generated provider is ${record.provider}, expected ${PRODUCTION_NARRATOR.provider}`);
  }
  if (record.model && record.model !== PRODUCTION_NARRATOR.model) {
    reasons.push(`generated model is ${record.model}, expected ${PRODUCTION_NARRATOR.model}`);
  }
  if (record.voiceId && record.voiceId !== PRODUCTION_NARRATOR.voiceId) {
    reasons.push(`generated voice is ${record.voiceId}, expected ${PRODUCTION_NARRATOR.voiceId}`);
  }
  return { stage: 'generated', passed: reasons.length === 0, reasons };
}

export function evaluateAsr(record = {}) {
  const reasons = [];
  const reports = Array.isArray(record.asrReports) ? record.asrReports : [];
  const models = unique(reports.map((item) => item.model));
  if (models.length < 2) reasons.push('independent dual-ASR is incomplete; two distinct model IDs are required');
  for (const expected of INDEPENDENT_ASR_MODELS) {
    if (!models.includes(expected)) reasons.push(`missing ASR model ${expected}`);
  }
  for (const model of models) {
    if (FORBIDDEN_ASR_MODELS.includes(model)) reasons.push(`forbidden ASR model ${model}`);
  }
  if (models.length === 2 && models[0] === models[1]) {
    reasons.push('the same ASR model was used twice; that is not an independent check');
  }
  for (const report of reports) {
    const substitutions = Number(report.substitutions ?? -1);
    const deletions = Number(report.deletions ?? -1);
    const insertions = Number(report.insertions ?? -1);
    if (!(substitutions === 0 && deletions === 0 && insertions === 0)) {
      reasons.push(`${report.model || 'unknown-asr'}: substitutions=${substitutions} deletions=${deletions} insertions=${insertions}`);
    }
  }
  if (record.asrStatus === 'pending-independent-asr') {
    reasons.push('only one independent ASR model is available; final certification is withheld');
  }
  return { stage: 'asr_passed', passed: reasons.length === 0, reasons, models };
}

export function evaluateHumanListening(record = {}) {
  const review = record.humanListening || {};
  const reasons = [];
  if (review.status !== 'passed') reasons.push('human listening review is not passed');
  if (!review.reviewedBy) reasons.push('human listening reviewer is missing');
  if (!review.reviewedAt) reasons.push('human listening review date is missing');
  if (!review.evidence) reasons.push('human listening evidence is missing');
  return { stage: 'human_approved', passed: reasons.length === 0, reasons };
}

export function evaluateTechnical(record = {}) {
  const reasons = [];
  if (record.technicalStatus !== 'passed') reasons.push('technical audio QA is not passed');
  if (record.syncStatus !== 'passed') reasons.push('sync map QA is not passed');
  return { stage: 'technical_passed', passed: reasons.length === 0, reasons };
}

export function evaluatePublishability(post, record = {}) {
  const generation = evaluateGenerationAuthorization(post);
  const generated = evaluateGenerated(record);
  const asr = evaluateAsr(record);
  const human = evaluateHumanListening(record);
  const technical = evaluateTechnical(record);
  const reasons = unique([
    ...generation.reasons.map((reason) => `generation: ${reason}`),
    ...generated.reasons.map((reason) => `generated: ${reason}`),
    ...asr.reasons.map((reason) => `asr: ${reason}`),
    ...human.reasons.map((reason) => `listening: ${reason}`),
    ...technical.reasons.map((reason) => `technical: ${reason}`),
  ]);
  return {
    stage: 'publishable',
    passed: reasons.length === 0,
    reasons,
    parts: { generation, generated, asr, human, technical },
  };
}

export function currentStage({ textReady, generationAuthorized, generated, asrPassed, humanApproved, technicalPassed, publishable, published }) {
  if (published) return 'published';
  if (publishable) return 'publishable';
  if (technicalPassed) return 'technical_passed';
  if (humanApproved) return 'human_approved';
  if (asrPassed) return 'asr_passed';
  if (generated) return 'generated';
  if (generationAuthorized) return 'generation_authorized';
  if (textReady) return 'text_ready';
  return 'blocked';
}

export function stageReached(actual, required) {
  return (STAGE_INDEX[actual] ?? -1) >= (STAGE_INDEX[required] ?? 99);
}

export function classifyLiveAudio(manifest) {
  if (!manifest) {
    return { exists: false, class: 'missing', voiceId: null, provider: null, model: null };
  }
  const voiceId = manifest.defaultVoice || null;
  const provider = manifest.provider || null;
  const model = manifest.model || null;
  const isSadaltager = provider === PRODUCTION_NARRATOR.provider
    && model === PRODUCTION_NARRATOR.model
    && voiceId === PRODUCTION_NARRATOR.voiceId;
  const isFallback = voiceId === FALLBACK_NARRATOR.voiceId || voiceId === FALLBACK_NARRATOR.alternateVoiceId;
  return {
    exists: true,
    class: isSadaltager ? 'live-sadaltager' : isFallback ? 'live-fallback' : 'live-other',
    voiceId,
    provider,
    model,
    reusablePrimary: isSadaltager,
  };
}
