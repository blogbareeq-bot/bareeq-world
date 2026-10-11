import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertTtsUnfrozen, gate5OverrideAuthorized, newContentTestClipOverrideAuthorized, newContentFullSynthesisOverrideAuthorized, readTtsFreeze, ttsIsFrozen } from './audio-tts-freeze-guard.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'bareeq-tts-freeze-'));
const file = path.join(dir, 'freeze.json');
await writeFile(file, JSON.stringify({ schema:'bareeq.audio-tts-freeze.v1', active:true, reason:'test' }));
assert.equal(await ttsIsFrozen(file), true);
assert.equal((await readTtsFreeze(file)).reason, 'test');
await assert.rejects(() => assertTtsUnfrozen({ file, operation:'unit-test' }), (error) => error?.code === 'BAREEQ_TTS_FROZEN');
await writeFile(file, JSON.stringify({ schema:'bareeq.audio-tts-freeze.v1', active:false }));
assert.equal(await ttsIsFrozen(file), false);
await assertTtsUnfrozen({ file, operation:'unit-test' });
console.log('TTS freeze guard tests passed: active freeze blocks synthesis and inactive state permits it.');


const authFile = path.join(dir, 'auth.json');
await writeFile(authFile, JSON.stringify({
  schema:'bareeq.audio-gate5-authorization.v1',
  decisionId:'GATE5-PASSPORTS-v1',
  targetArticleId:'why-some-passports-are-stronger',
  targetCaseId:'T03',
  targetPartNumber:4,
  targetSegmentId:'b0030',
  expectedToken:'لا',
  successfulTtsRequestsRequired:1,
  successfulTtsRequestsAuthorized:1,
  authorizationStatus:'AUTHORIZED',
}));
const env={
  BAREEQ_GATE5_AUTHORIZED:'1',
  BAREEQ_GATE5_TARGET_ARTICLE:'why-some-passports-are-stronger',
  BAREEQ_GATE5_DECISION_ID:'GATE5-PASSPORTS-v1',
};
assert.ok(await gate5OverrideAuthorized({authorizationFile:authFile,operation:'gemini-interactions-tts',env}));
assert.equal(await gate5OverrideAuthorized({authorizationFile:authFile,operation:'openrouter-speech',env}),null);


const newContentAuthFile = path.join(dir, 'new-content-test-clip-auth.json');
await writeFile(newContentAuthFile, JSON.stringify({
  schema:'bareeq.audio-new-content-test-clip-authorization.v1',
  decisionId:'NEW-CONTENT-SCREEN-FOCUS-TEST-CLIP-20261011-v1',
  authorizationStatus:'AUTHORIZED',
  targetArticleId:'screen-focus',
  speechScriptHash:'a'.repeat(64),
  testClipPlanHash:'b'.repeat(64),
  provider:'gemini-interactions',
  model:'gemini-3.1-flash-tts-preview',
  voice:'Sadaltager',
  successfulTtsRequestsAuthorized:1,
  successfulTtsRequestsConsumed:0,
  providerAttemptsAuthorized:1,
  providerAttemptsConsumed:1,
  automaticRetry:false,
  publicationAuthorized:false,
  fullArticleSynthesisAuthorized:false,
  legacyRenewalAuthorized:false,
  freezeRemainsActive:true,
}));
const newContentEnv = {
  BAREEQ_NEW_CONTENT_TEST_CLIP_AUTHORIZED:'1',
  BAREEQ_NEW_CONTENT_TEST_CLIP_DECISION_ID:'NEW-CONTENT-SCREEN-FOCUS-TEST-CLIP-20261011-v1',
  BAREEQ_NEW_CONTENT_TEST_CLIP_ARTICLE:'screen-focus',
  BAREEQ_NEW_CONTENT_TEST_CLIP_SCRIPT_HASH:'a'.repeat(64),
  BAREEQ_NEW_CONTENT_TEST_CLIP_PLAN_HASH:'b'.repeat(64),
  GITHUB_ACTIONS:'true',
  GITHUB_REF:'refs/heads/main',
  GITHUB_RUN_ATTEMPT:'1',
};
assert.ok(await newContentTestClipOverrideAuthorized({authorizationFile:newContentAuthFile,operation:'gemini-interactions-tts',env:newContentEnv}));
assert.equal(await newContentTestClipOverrideAuthorized({authorizationFile:newContentAuthFile,operation:'gemini-generate-content-tts',env:newContentEnv}),null);
assert.equal(await newContentTestClipOverrideAuthorized({authorizationFile:newContentAuthFile,operation:'gemini-interactions-tts',env:{...newContentEnv,GITHUB_RUN_ATTEMPT:'2'}}),null);
console.log('New-content test-clip override tests passed: exact one-shot main Actions scope only.');


const fullAuthFile = path.join(dir, 'new-content-full-auth.json');
const fullPreflightFile = path.join(dir, 'new-content-full-preflight.json');
await writeFile(fullAuthFile, JSON.stringify({
  schema:'bareeq.audio-new-content-full-synthesis-authorization.v1',
  decisionId:'FULL-TEST-v1',
  authorizationStatus:'EXECUTING',
  targetArticleId:'screen-focus',
  speechScriptHash:'c'.repeat(64),
  testClipPlanHash:'d'.repeat(64),
  candidateFingerprint:'e'.repeat(64),
  provider:'gemini-interactions',
  model:'gemini-3.1-flash-tts-preview',
  voice:'Sadaltager',
  successfulTtsRequestsAuthorized:8,
  successfulTtsRequestsConsumed:0,
  providerAttemptsAuthorized:8,
  providerAttemptsConsumed:0,
  allowedPartIndexes:[0,1,2,3,4,5,6,7],
  automaticRetry:false,
  validationAfterGeneration:true,
  publicationAuthorized:false,
  legacyRenewalAuthorized:false,
  freezeRemainsActive:true,
}));
await writeFile(fullPreflightFile, JSON.stringify({
  schema:'bareeq.audio-new-content-full-synthesis-preflight.v1',
  status:'READY_FOR_BOUNDED_FULL_SYNTHESIS_AUTHORIZATION',
  articleId:'screen-focus',
  speechScriptHash:'c'.repeat(64),
  testClipPlanHash:'d'.repeat(64),
  candidateFingerprint:'e'.repeat(64),
  successfulTtsRequestsRequired:8,
  providerAttemptsMaximum:8,
  automaticRetry:false,
  publish:false,
}));
const fullEnv={
  BAREEQ_NEW_CONTENT_FULL_AUTHORIZED:'1',
  BAREEQ_NEW_CONTENT_FULL_DECISION_ID:'FULL-TEST-v1',
  BAREEQ_NEW_CONTENT_FULL_ARTICLE:'screen-focus',
  BAREEQ_NEW_CONTENT_FULL_SCRIPT_HASH:'c'.repeat(64),
  BAREEQ_NEW_CONTENT_FULL_PLAN_HASH:'d'.repeat(64),
  BAREEQ_NEW_CONTENT_FULL_FINGERPRINT:'e'.repeat(64),
  GITHUB_ACTIONS:'true',
  GITHUB_REF:'refs/heads/main',
  GITHUB_RUN_ATTEMPT:'1',
  GITHUB_RUN_ID:'999',
};
for(let partIndex=0;partIndex<8;partIndex+=1){
  const authorized=await newContentFullSynthesisOverrideAuthorized({
    authorizationFile:fullAuthFile,
    preflightFile:fullPreflightFile,
    operation:'gemini-interactions-tts',
    context:{articleId:'screen-focus',speechScriptHash:'c'.repeat(64),partIndex,partCount:8},
    env:fullEnv,
  });
  assert.equal(authorized.partIndex,partIndex);
  assert.equal(authorized.attemptNumber,partIndex+1);
}
await assert.rejects(()=>newContentFullSynthesisOverrideAuthorized({
  authorizationFile:fullAuthFile,
  preflightFile:fullPreflightFile,
  operation:'gemini-interactions-tts',
  context:{articleId:'screen-focus',speechScriptHash:'c'.repeat(64),partIndex:7,partCount:8},
  env:fullEnv,
}),/budget exhausted/);
assert.equal(await newContentFullSynthesisOverrideAuthorized({
  authorizationFile:fullAuthFile,
  preflightFile:fullPreflightFile,
  operation:'gemini-generate-content-tts',
  context:{articleId:'screen-focus',speechScriptHash:'c'.repeat(64),partIndex:0,partCount:8},
  env:{...fullEnv,GITHUB_RUN_ID:'1000'},
}),null);
console.log('New-content full-synthesis override tests passed: exactly 8 ordered main-branch Interactions attempts, no replay expansion.');
