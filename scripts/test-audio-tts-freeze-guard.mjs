import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertTtsUnfrozen, gate5OverrideAuthorized, newContentTestClipOverrideAuthorized, readTtsFreeze, ttsIsFrozen } from './audio-tts-freeze-guard.mjs';

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
