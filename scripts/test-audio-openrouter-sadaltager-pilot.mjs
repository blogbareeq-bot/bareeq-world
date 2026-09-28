import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildOpenRouterRequest, pilotFingerprint, PILOT_ENGINE, probeOpenRouterKey, runPilot } from './audio-openrouter-sadaltager-pilot.mjs';
import { decidePilot } from './audio-openrouter-sadaltager-pilot-evaluate.mjs';

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

const built = buildOpenRouterRequest({ apiKey: 'sk-or-test', text: sample.text });
assert.equal(built.url, 'https://openrouter.ai/api/v1/audio/speech');
const body = JSON.parse(built.options.body);
assert.equal(body.model, 'google/gemini-3.1-flash-tts-preview');
assert.equal(body.voice, 'Sadaltager');
assert.equal(body.response_format, 'mp3');
assert.deepEqual(PILOT_ENGINE, {
  provider: 'openrouter',
  model: 'google/gemini-3.1-flash-tts-preview',
  voice: 'Sadaltager',
  responseFormat: 'mp3',
});

const missing = await probeOpenRouterKey({ apiKey: '' });
assert.equal(missing.authorized, false);
assert.equal(missing.status, 'missing');

const probe = await probeOpenRouterKey({
  apiKey: 'sk-or-test',
  fetchImpl: async (url) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key');
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: { is_free_tier: false, limit: 10, limit_remaining: 4.5, usage: 5.5 } };
      },
    };
  },
});
assert.equal(probe.authorized, true);
assert.equal(probe.keyLimitRemaining, 4.5);

const dry = await runPilot();
assert.equal(dry.mode, 'dry-run');
assert.equal(dry.samples.length, 3);
assert.equal(dry.providerRequests, 0);
assert.equal(dry.productionAudioTouched, false);
assert.equal(dry.publicationAllowed, false);

await assert.rejects(
  () => runPilot({ live: true, env: {} }),
  /Live OpenRouter pilot is locked/,
);

const temp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-openrouter-pilot-'));
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(256, 1)]);
let keyCalls = 0;
let speechCalls = 0;
const fakeFetch = async (url) => {
  if (url === 'https://openrouter.ai/api/v1/key') {
    keyCalls += 1;
    return {
      ok: true,
      status: 200,
      async json() { return { data: { is_free_tier: false, limit: 20, limit_remaining: 10 } }; },
    };
  }
  if (url === 'https://openrouter.ai/api/v1/audio/speech') {
    speechCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get(name) { return name.toLowerCase() === 'content-type' ? 'audio/mpeg' : null; } },
      async arrayBuffer() { return mp3; },
    };
  }
  throw new Error(`unexpected URL ${url}`);
};
try {
  const live = await runPilot({
    live: true,
    outputRoot: temp,
    env: {
      BAREEQ_OPENROUTER_TTS_PILOT_ACTIVATE: '1',
      OPENROUTER_API_KEY: 'sk-or-test',
    },
    fetchImpl: fakeFetch,
  });
  assert.equal(keyCalls, 1);
  assert.equal(speechCalls, 3);
  assert.equal(live.reports.length, 3);
  assert.equal(live.productionAudioTouched, false);
  assert.equal(live.publicationAllowed, false);
  for (const report of live.reports) {
    assert.equal(report.status, 'generated-not-validated-not-publishable');
    assert.equal(report.engine.model, 'google/gemini-3.1-flash-tts-preview');
    assert.equal(report.engine.voice, 'Sadaltager');
    assert.match(report.audioSha256, /^[a-f0-9]{64}$/);
    const audio = await readFile(path.join(temp, `${report.sampleId}.mp3`));
    assert.ok(audio.length >= 100);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

const passDecision = decidePilot([
  { delta: 1, technicalQa: { passed: true } },
  { delta: 2, technicalQa: { passed: true } },
  { delta: 0, technicalQa: { passed: true } },
]);
assert.equal(passDecision.passed, true);
const failDecision = decidePilot([
  { delta: -2, technicalQa: { passed: true } },
  { delta: 2, technicalQa: { passed: true } },
  { delta: 2, technicalQa: { passed: true } },
]);
assert.equal(failDecision.passed, false);

console.log('OpenRouter Sadaltager pilot tests passed: same model/voice identity, locked dry-run, key probe, three isolated mock requests, bounded decision rule, and zero publication authority.');
