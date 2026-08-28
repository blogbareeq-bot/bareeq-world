import assert from 'node:assert/strict';
import {
  evaluateGenerationAuthorization,
  evaluatePublishability,
  evaluateAsr,
  classifyLiveAudio,
  PRODUCTION_NARRATOR,
  INDEPENDENT_ASR_MODELS,
} from './audio-lifecycle.mjs';
import { evaluateSynthesisReadiness, evaluatePublicationReadiness } from './speech-synthesis-gate.mjs';
import { compareExactSpokenText, assertIndependentAsrModels } from './audio-exact-match.mjs';

const approvedPost = {
  id: 'sample',
  speechApproval: {
    validation: { valid: true, approved: true },
    script: { scriptHash: 'abc' },
    testClipPlan: { speechScriptHash: 'abc', testClipPassed: false, fullSynthesisAllowed: false, audioReview: { status: 'not-performed' } },
    testClipEvidenceVerified: false,
  },
};

const generation = evaluateSynthesisReadiness(approvedPost);
assert.equal(generation.allowed, true);
assert.equal(generation.generationAuthorized, true);
assert.equal(generation.publishable, false);
assert.equal(generation.audioEvidencePassed, false);

const unreviewed = structuredClone(approvedPost);
unreviewed.speechApproval.validation.approved = false;
assert.equal(evaluateGenerationAuthorization(unreviewed).passed, false);

const circular = structuredClone(approvedPost);
circular.speechApproval.testClipPlan.testClipPassed = true;
circular.speechApproval.testClipPlan.fullSynthesisAllowed = true;
const circularReadiness = evaluateSynthesisReadiness(circular);
assert.equal(circularReadiness.allowed, true, 'listening evidence must not be required before the first TTS request');
assert.equal(evaluatePublicationReadiness(circular, {}).allowed, false);

const exact = compareExactSpokenText('كَيْفَ تَعْرِفُ الشَّاشَةُ', 'كيف تعرف الشاشة');
assert.equal(exact.passed, true);
assert.equal(exact.substitutions, 0);

const mismatch = compareExactSpokenText('مختلفتين', 'مختلفين');
assert.equal(mismatch.passed, false);
assert.equal(mismatch.substitutions, 1);
assert.equal(mismatch.deletions, 0);
assert.equal(mismatch.insertions, 0);

assert.throws(() => assertIndependentAsrModels(['gemini-3.5-transcribe', 'gemini-3.5-transcribe']));
assert.deepEqual(assertIndependentAsrModels(INDEPENDENT_ASR_MODELS), INDEPENDENT_ASR_MODELS);

const sameModelTwice = evaluateAsr({
  asrReports: [
    { model: 'gemini-3.5-transcribe', substitutions: 0, deletions: 0, insertions: 0 },
    { model: 'gemini-3.5-transcribe', substitutions: 0, deletions: 0, insertions: 0 },
  ],
});
assert.equal(sameModelTwice.passed, false);

const dual = evaluateAsr({
  asrReports: [
    { model: 'gemini-3.5-transcribe', substitutions: 0, deletions: 0, insertions: 0 },
    { model: 'gemini-3.6-transcribe', substitutions: 0, deletions: 0, insertions: 0 },
  ],
});
assert.equal(dual.passed, true);

const live = classifyLiveAudio({
  provider: PRODUCTION_NARRATOR.provider,
  model: PRODUCTION_NARRATOR.model,
  defaultVoice: PRODUCTION_NARRATOR.voiceId,
});
assert.equal(live.reusablePrimary, true);

const hamed = classifyLiveAudio({
  provider: 'Microsoft Azure AI Speech',
  model: 'Neural TTS',
  defaultVoice: 'hamed',
});
assert.equal(hamed.class, 'live-fallback');
assert.equal(hamed.reusablePrimary, false);

assert.equal(evaluatePublishability(approvedPost, {}).passed, false);
console.log('Audio lifecycle tests passed: split gates, no circular generation lock, exact 0/0/0 match, and independent dual-ASR requirement.');
