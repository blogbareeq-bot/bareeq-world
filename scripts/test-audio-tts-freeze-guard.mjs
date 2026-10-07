import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertTtsUnfrozen, gate5OverrideAuthorized, readTtsFreeze, ttsIsFrozen } from './audio-tts-freeze-guard.mjs';

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
