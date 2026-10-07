import assert from 'node:assert/strict';
import {
  ASR_FALLBACK_MODELS,
  asrModelCandidates,
  isFallbackEligibleAsrFailure,
} from './audio-validate-consensus.mjs';
import {
  ASR_MODEL_TRANSPORT,
  FORBIDDEN_ASR_MODELS,
  INDEPENDENT_ASR_MODELS,
} from './audio-constants.mjs';

assert.deepEqual(INDEPENDENT_ASR_MODELS, [
  'gemini-3.5-flash-lite',
  'gemini-3.5-transcribe',
]);
assert.deepEqual(ASR_FALLBACK_MODELS, [
  'gemini-3.5-flash',
  'gemini-3.6-flash',
]);

for (const model of [...INDEPENDENT_ASR_MODELS, ...ASR_FALLBACK_MODELS]) {
  assert.ok(ASR_MODEL_TRANSPORT[model], `${model} must have a supported ASR transport`);
  assert.equal(FORBIDDEN_ASR_MODELS.includes(model), false, `${model} must not be forbidden`);
}

assert.deepEqual(
  asrModelCandidates('gemini-3.5-transcribe'),
  ['gemini-3.5-transcribe', 'gemini-3.5-flash', 'gemini-3.6-flash'],
  'quota fallback must prefer the primary model, then the bounded alternatives',
);
assert.deepEqual(
  asrModelCandidates('gemini-3.5-transcribe', ['gemini-3.5-flash']),
  ['gemini-3.5-transcribe', 'gemini-3.6-flash'],
  'the second ASR slot must never reuse the model already selected for the first slot',
);
assert.deepEqual(
  asrModelCandidates('gemini-3.5-flash-lite', ['gemini-3.5-flash']),
  ['gemini-3.5-flash-lite', 'gemini-3.6-flash'],
  'fallback exclusion must preserve two distinct model identifiers',
);

assert.equal(isFallbackEligibleAsrFailure({ httpStatus: 429 }), true);
assert.equal(isFallbackEligibleAsrFailure({ httpStatus: 503 }), true);
assert.equal(isFallbackEligibleAsrFailure({ httpStatus: 404 }), true);
assert.equal(isFallbackEligibleAsrFailure({ httpStatus: 400 }), false);
const backendFailure={httpStatus:400,result:{requestedModel:'gemini-3.5-transcribe',rawTranscript:JSON.stringify({error:{message:'Thinking is not enabled for this model'}})}};
assert.equal(isFallbackEligibleAsrFailure(backendFailure),true);
for(const edit of [x=>x.httpStatus=401,x=>x.result.requestedModel='gemini-3.5-flash',x=>x.result.rawTranscript=JSON.stringify({error:{message:'Invalid request parameter'}}),x=>x.result.rawTranscript='not JSON']){const bad=structuredClone(backendFailure);edit(bad);assert.equal(isFallbackEligibleAsrFailure(bad),false);}
assert.equal(isFallbackEligibleAsrFailure({ exitCode: 75 }), true);

console.log('ASR quota fallback tests passed: primary models remain preferred, only supported independent models are eligible, and the exact dual-model gate stays distinct.');
