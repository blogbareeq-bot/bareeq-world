import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyMicroCut, verifyMicroCutTranscript } from './audio-micro-repair-preflight.mjs';
import { locateSentenceRepair, planMicroSpliceCandidates } from './audio-segment-repair.mjs';
import { buildPositiveCorrectionHint, createBudgetedSynthesizer } from './audio-progressive-repair.mjs';

const expected = 'هل تعتمد التوقعات على بياناتي الشخصية؟';
assert.equal(verifyMicroCutTranscript(expected, 'هل تعتمد التوقعات على بيانات الشخصية', [4]), true);
assert.equal(verifyMicroCutTranscript(expected, 'خطأ هل تعتمد التوقعات على بيانات الشخصية', [4]), false);
assert.equal(verifyMicroCutTranscript(expected, 'هل تعتمد التوقعات على بيانات', [4]), false);
assert.equal(verifyMicroCutTranscript(expected, 'هل تظهر التوقعات على بيانات الشخصية', [4]), false);
const hint = buildPositiveCorrectionHint({ substantiveDifferences: [{ expectedIndex: 4, expected: 'بياناتي', actual: 'بيانات' }] }, [4]);
assert.ok(hint.includes('«بياناتي»'));
assert.ok(!hint.includes('«بيانات»'), 'incorrect pronunciation is not repeated in the prompt');
const sentences = { parts: [{ partIndex: 0, items: [{ runtimeId: 'b1', text: 'تمهيد طويل. هذه أقسى تجربة. نهاية هادئة.' }],
  sync: [{ id: 'b1', start: 0.1, end: 0.9 }] }] };
const repair = locateSentenceRepair(sentences, [3]);
assert.equal(repair.text, 'هذه أقسى تجربة.');
assert.equal(repair.tokenStart, 2);
assert.equal(locateSentenceRepair(sentences, [0, 3]), null);
const pcm = Buffer.alloc(5000 * 2);
for (let i = 0; i < 5000; i++) pcm.writeInt16LE((i >= 1000 && i < 1600) || (i >= 3200 && i < 3800) ? 0 : 6000, i * 2);
const plans = planMicroSpliceCandidates(pcm, { sync: { start: 0.26, end: 0.7 } }, { sampleRate: 1000, maxDistanceSeconds: 0.4 });
assert.equal(plans.length, 1);
assert.equal(plans[0].start.seconds, 1.3);
assert.equal(plans[0].end.seconds, 3.5);
assert.equal(planMicroSpliceCandidates(pcm, { sync: { start: 0.01, end: 0.02 } }, { sampleRate: 1000, maxDistanceSeconds: 0.1 }).length, 0);

const root = await mkdtemp(path.join(tmpdir(), 'bareeq-preflight-test-'));
try {
  const audioPath = path.join(root, 'cut.mp3');
  await writeFile(audioPath, Buffer.alloc(120));
  const microRepair = { text: expected, tokenStart: 20, failedIndices: [24] };
  for (const [transcripts, passed, asrCalls] of [
    [['هل تعتمد التوقعات على بيانات الشخصية', expected], true, 2],
    [['خطأ هل تعتمد التوقعات على بيانات الشخصية'], false, 1],
    [[expected, 'هل تعتمد التوقعات على بيانات'], false, 2],
  ]) {
    let seen = 0;
    let uploads = 0;
    let deletions = 0;
    const fetchImpl = async (url, options) => {
      if (options.method === 'DELETE') { deletions++; return new Response(null, { status: 200 }); }
      if (String(url).endsWith('/interactions')) {
        const model = JSON.parse(options.body).model;
        return Response.json({ model, id: `mock-${seen}`, output_text: transcripts[seen++] });
      }
      if (options.headers['X-Goog-Upload-Command'] === 'start') {
        uploads++;
        return new Response(null, { status: 200, headers: { 'X-Goog-Upload-URL': 'https://example.test/upload' } });
      }
      if (String(url) === 'https://example.test/upload') return Response.json({ file: { name: 'files/mock', uri: 'https://example.test/file', mimeType: 'audio/mpeg' } });
      throw new Error(`Unexpected request ${url}`);
    };
    const result = await verifyMicroCut({ audioPath, repair: microRepair, apiKey: 'mock', fetchImpl });
    assert.equal(result.passed, passed);
    assert.equal(seen, asrCalls);
    assert.equal(uploads, 1);
    assert.equal(deletions, 1, 'uploaded preflight cut is deleted after success or mismatch');
  }
  await assert.rejects(() => verifyMicroCut({ audioPath, repair: microRepair, models: ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite'], apiKey: 'mock', fetchImpl: () => { throw new Error('network forbidden'); } }), /Independent ASR/);
  const previousEvent = process.env.GITHUB_EVENT_NAME;
  process.env.GITHUB_EVENT_NAME = 'push';
  try {
    const synth = createBudgetedSynthesizer({ apiKey: 'unused' });
    await assert.rejects(() => synth({}), /disabled for push/);
    assert.equal(synth.stats().sent, 0);
  } finally {
    if (previousEvent === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = previousEvent;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('Verified micro-cut tests passed: exact sentence, two independent transcripts, no neighboring words, cleanup, and zero TTS on push.');
