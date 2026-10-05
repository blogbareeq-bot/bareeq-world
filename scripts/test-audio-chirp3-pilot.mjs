import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildChirpRequest, pilotFingerprint, PILOT_ENGINE, runPilot } from './audio-chirp3-pilot.mjs';
import { decidePilot } from './audio-chirp3-pilot-evaluate.mjs';

const sample = {
  sampleId: 'unit',
  articleId: 'example',
  sourceSegmentId: 'segment',
  text: 'اختبار عربي قصير',
};
const first = pilotFingerprint(sample);
const second = pilotFingerprint(sample);
assert.equal(first, second);
assert.match(first, /^[a-f0-9]{64}$/);

const built = buildChirpRequest({
  accessToken: 'token',
  projectId: 'bareeq-test-12345',
  text: sample.text,
});
assert.equal(built.url, 'https://texttospeech.googleapis.com/v1/text:synthesize');
const body = JSON.parse(built.options.body);
assert.equal(body.voice.languageCode, 'ar-XA');
assert.equal(body.voice.name, 'ar-XA-Chirp3-HD-Sadaltager');
assert.equal(body.audioConfig.audioEncoding, 'MP3');
assert.deepEqual(PILOT_ENGINE, {
  provider: 'google-cloud-text-to-speech',
  model: 'Chirp3-HD',
  languageCode: 'ar-XA',
  voice: 'ar-XA-Chirp3-HD-Sadaltager',
  audioEncoding: 'MP3',
});

const dry = await runPilot();
assert.equal(dry.mode, 'dry-run');
assert.equal(dry.samples.length, 3);
assert.equal(dry.providerRequests, 0);
assert.equal(dry.productionAudioTouched, false);
assert.equal(dry.publicationAllowed, false);

await assert.rejects(
  () => runPilot({ live: true, env: {}, fetchImpl: async () => { throw new Error('unexpected provider call'); } }),
  /Live Chirp pilot is locked/,
);

const temp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-chirp-pilot-'));
let calls = 0;
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(256, 1)]).toString('base64');
const fakeFetch = async () => {
  calls += 1;
  return {
    ok: true,
    status: 200,
    async json() { return { audioContent: mp3 }; },
  };
};
try {
  const live = await runPilot({
    live: true,
    outputRoot: temp,
    env: {
      BAREEQ_CHIRP_PILOT_ACTIVATE: '1',
      GOOGLE_CLOUD_PROJECT: 'bareeq-test-12345',
      GOOGLE_CLOUD_ACCESS_TOKEN: 'test-access-token',
    },
    fetchImpl: fakeFetch,
  });
  assert.equal(calls, 3);
  assert.equal(live.reports.length, 3);
  assert.equal(live.productionAudioTouched, false);
  assert.equal(live.publicationAllowed, false);
  for (const report of live.reports) {
    assert.equal(report.status, 'generated-not-validated-not-publishable');
    assert.equal(report.engine.voice, 'ar-XA-Chirp3-HD-Sadaltager');
    assert.equal(report.productionAudioTouched, false);
    assert.equal(report.publicationAllowed, false);
    assert.match(report.audioSha256, /^[a-f0-9]{64}$/);
    assert.ok((await readFile(path.join(process.cwd(), report.outputFile))).length >= 100 || report.outputFile.startsWith('..'));
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

const qa = { passed: true };
assert.equal(decidePilot([
  { delta: 1, technicalQa: qa },
  { delta: 2, technicalQa: qa },
  { delta: 0, technicalQa: qa },
]).passed, true);
assert.equal(decidePilot([
  { delta: 2, technicalQa: qa },
  { delta: 1, technicalQa: qa },
  { delta: -1, technicalQa: qa },
]).passed, true);
assert.equal(decidePilot([
  { delta: 2, technicalQa: qa },
  { delta: -1, technicalQa: qa },
  { delta: -1, technicalQa: qa },
]).passed, false);
assert.equal(decidePilot([
  { delta: 4, technicalQa: qa },
  { delta: 1, technicalQa: qa },
  { delta: -3, technicalQa: qa },
]).passed, false);
assert.equal(decidePilot([
  { delta: 2, technicalQa: qa },
  { delta: 1, technicalQa: { passed: false } },
  { delta: 0, technicalQa: qa },
]).passed, false);

console.log('Chirp 3 Sadaltager pilot tests passed: locked dry-run, engine identity, isolation, and bounded decision thresholds.');
