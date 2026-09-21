import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertCandidatePublishEngine, publishApprovedCandidate } from './audio-publish.mjs';
import { candidateDir, sha256 } from './audio-constants.mjs';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { atomicWriteFile } from './audio-io.mjs';
import { invokeHttpWorker, invokeCommandWorker, concatWorkerMp3Buffers } from './audio-local-transport.mjs';
import { readPronunciationLexicon, prepareArabicSynthesisText } from './audio-arabic-normalizer.mjs';
import { segmentCachePaths, segmentFingerprint } from './audio-segment-cache.mjs';
import { resolveAudioSynthesizer } from './audio-engine-router.mjs';
import { runLocalAsrPreflight } from './audio-local-asr-preflight.mjs';
import { candidateFingerprint, partFingerprint } from './audio-split.mjs';
import { validateCandidate } from './audio-validate.mjs';
import { mergeCandidateParts } from './audio-merge.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-v2-hardening-'));
const original = { ...process.env };
try {
  process.env.BAREEQ_TTS_ENGINE = 'voxcpm2';
  process.env.BAREEQ_LOCAL_TTS_ENABLE = '1';
  process.env.BAREEQ_SEGMENT_CACHE_ENABLE = '1';
  process.env.BAREEQ_VOXCPM2_ENDPOINT = 'http://127.0.0.1:9876/tts';
  process.env.BAREEQ_TTS_MODEL_REVISION = 'model-test-1';
  process.env.BAREEQ_TTS_WORKER_REVISION = 'worker-test-1';
  delete process.env.BAREEQ_AUDIO_ENGINE_V2_PUBLISH;

  const candidate = { engineId: 'voxcpm2', provider: 'OpenBMB VoxCPM2', model: 'openbmb/VoxCPM2',
    voice: 'bareeq-designed', synthesisContractSha256: 'b'.repeat(64) };
  const player = { ...candidate, defaultVoice: candidate.voice,
    voices: [{ id: candidate.voice, providerVoice: candidate.voice }] };
  assert.throws(() => assertCandidatePublishEngine(candidate, player, { BAREEQ_TTS_ENGINE: 'gemini' }), /review-locked/);
  assert.equal(assertCandidatePublishEngine(candidate, player, { BAREEQ_AUDIO_ENGINE_V2_PUBLISH: '1' }).engineId, 'voxcpm2');
  assert.throws(() => assertCandidatePublishEngine(candidate, { ...player, model: 'wrong' }, { BAREEQ_AUDIO_ENGINE_V2_PUBLISH: '1' }), /differ/);

  const articleId = 'review-lock-test';
  const fingerprint = 'a'.repeat(64);
  const dir = candidateDir(articleId, fingerprint, temp);
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'full.mp3'), Buffer.alloc(200, 1));
  await writeFile(path.join(dir, 'manifest.candidate.json'), JSON.stringify(candidate));
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(player));
  await assert.rejects(publishApprovedCandidate({ articleId, fingerprint, root: temp }), /review-locked/);
  await assert.rejects(publishApprovedCandidate({ articleId, fingerprint: '../../escape', root: temp }), /SHA-256/);
  await assert.rejects(validateCandidate({ articleId, fingerprint: '../../escape', root: temp }), /SHA-256/);

  const lexicon = await readPronunciationLexicon(process.cwd());
  for (const [source, expected] of [
    ['ببساطة', 'بِبَساطَة'], ['وببساطة', 'وبِبَساطَة'], ['فببساطة', 'فبِبَساطَة'],
    ['ببساطةً', 'بِبَساطَةً'], ['3.14 و1,000 و2026:العام', '3.14 و1,000 و2026: العام'],
    ['2026؟2027 و12:30', '2026؟ 2027 و12:30'],
    ['12\u200F34', '12 34'],
  ]) {
    const result = prepareArabicSynthesisText(source, lexicon);
    assert.equal(result.canonicalText, source);
    assert.equal(result.synthesisText, expected);
  }
  const contextual = { version: 1, entries: [
    { source: 'علم', synthesis: 'عَلَم', kind: 'polyphonic', priority: 1, context: { before: ['رفع'] } },
    { source: 'علم', synthesis: 'عِلْم', kind: 'polyphonic', priority: 1, context: { before: ['طلب'] } },
  ] };
  assert.equal(prepareArabicSynthesisText('رفع علم', contextual).synthesisText, 'رفع عَلَم');
  assert.equal(prepareArabicSynthesisText('طلب علم', contextual).synthesisText, 'طلب عِلْم');

  const { ffmpeg } = await assertFfmpeg();
  const tone = await runCommand(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4:sample_rate=48000',
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
  ]);
  assert.equal(tone.code, 0);
  const wavTone = await runCommand(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4:sample_rate=48000',
    '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
  ]);
  assert.equal(wavTone.code, 0);
  const request = { schema: 'bareeq.tts-worker.v1', engine: candidate.engineId, model: candidate.model,
    voice: { id: candidate.voice }, audit: { modelRevision: 'model-test-1', workerRevision: 'worker-test-1' } };
  const identity = { engine: request.engine, model: request.model, voiceId: request.voice.id,
    modelRevision: request.audit.modelRevision, workerRevision: request.audit.workerRevision };
  const success = (payload) => ({ ok: true, status: 200,
    headers: { get: (key) => key === 'content-type' ? 'application/json' : null }, json: async () => payload });
  const runtime = { kind: 'http', endpoint: 'http://127.0.0.1/tts' };
  let forbiddenCalls = 0;
  await assert.rejects(invokeHttpWorker({ runtime: { endpoint: 'http://169.254.169.254/metadata' }, request,
    fetchImpl: async () => { forbiddenCalls += 1; } }), /not approved/);
  assert.equal(forbiddenCalls, 0);
  const payload = { ...identity, audioBase64: tone.stdout.toString('base64'), mimeType: 'audio/mpeg' };
  assert.ok((await invokeHttpWorker({ runtime, request, fetchImpl: async () => success(payload) })).audio.length > 100);
  await assert.rejects(invokeHttpWorker({ runtime, request, fetchImpl: async () => success({ ...payload, model: 'wrong' }) }), /identity/);
  await assert.rejects(invokeHttpWorker({ runtime, request, fetchImpl: async () => success({ ...payload, audioBase64: payload.audioBase64 + '%%' }) }), /base64/);
  await assert.rejects(invokeHttpWorker({ runtime, request, fetchImpl: async () => success({ ...payload, audioBase64: Buffer.alloc(200, 1).toString('base64') }) }), /type/);
  const token = 'REVIEW_SECRET_TEST_ONLY';
  await assert.rejects(invokeHttpWorker({ runtime: { ...runtime, token }, request,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'token=' + token }) }),
    (error) => !error.message.includes(token));
  await assert.rejects(invokeHttpWorker({ runtime: { ...runtime, timeoutMs: 10 }, request,
    fetchImpl: async (_endpoint, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) }), /timed out/);
  const commandScript = path.join(temp, 'worker.mjs');
  await writeFile(commandScript, `import { readFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({ engine: request.engine, model: request.model,
 voiceId: request.voice.id, modelRevision: request.audit.modelRevision,
 workerRevision: request.audit.workerRevision, mimeType: 'audio/wav',
 audioBase64: readFileSync(${JSON.stringify(path.join(temp, 'tone.wav'))}).toString('base64') }));\n`);
  await writeFile(path.join(temp, 'tone.wav'), wavTone.stdout);
  assert.ok((await invokeCommandWorker({ runtime: { kind: 'command', bin: process.execPath,
    args: [commandScript] }, request })).audio.length > 100);

  const file = path.join(temp, 'racing.mp3');
  const writes = await Promise.allSettled(Array.from({ length: 30 }, (_, index) => atomicWriteFile(file, Buffer.alloc(10000, index + 1))));
  assert.ok(writes.every((item) => item.status === 'fulfilled'));
  const last = await readFile(file);
  assert.ok(last.every((value) => value === last[0]));
  assert.throws(() => segmentCachePaths({ root: temp, articleId: '../../outside', segmentId: 'one', fingerprint }), /Invalid/);

  const referenceA = path.join(temp, 'voice-a.wav');
  const referenceB = path.join(temp, 'voice-b.wav');
  await writeFile(referenceA, Buffer.alloc(200, 1));
  await writeFile(referenceB, Buffer.alloc(200, 2));
  const item = { segmentId: 'segment-1', text: 'ببساطة' };
  const article = { articleId: 'sample', title: 'عنوان', spokenText: item.text, speechScriptHash: 'hash', items: [item] };
  const synthesis = prepareArabicSynthesisText(item.text, lexicon);
  const baseEnv = { ...process.env, BAREEQ_TTS_REFERENCE_AUDIO: referenceA };
  const first = segmentFingerprint({ article, item, synthesis, env: baseEnv });
  assert.notEqual(first, segmentFingerprint({ article, item, synthesis, env: { ...baseEnv, BAREEQ_TTS_REFERENCE_AUDIO: referenceB } }));
  assert.notEqual(first, segmentFingerprint({ article, item, synthesis, env: { ...baseEnv, BAREEQ_VOXCPM2_ENDPOINT: 'https://worker-2.invalid/tts' } }));
  assert.notEqual(first, segmentFingerprint({ article, item, synthesis, env: baseEnv, correctionHint: 'أعد النطق' }));
  const plan = { settings: { version: 1, name: 'test' }, charsPerSecond: 10, parts: [{ text: item.text, partIndex: 0 }] };
  process.env.BAREEQ_TTS_REFERENCE_AUDIO = referenceA;
  const oldCandidate = candidateFingerprint(article, plan);
  const oldPart = partFingerprint(article, plan, plan.parts[0]);
  process.env.BAREEQ_TTS_REFERENCE_AUDIO = referenceB;
  assert.notEqual(candidateFingerprint(article, plan), oldCandidate);
  assert.notEqual(partFingerprint(article, plan, plan.parts[0]), oldPart);
  delete process.env.BAREEQ_TTS_REFERENCE_AUDIO;

  let calls = 0;
  const synth = await resolveAudioSynthesizer({ root: process.cwd(), cacheRoot: temp, env: process.env,
    fetchImpl: async (_endpoint, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(body.output.format, 'wav');
      return success({ audioBase64: wavTone.stdout.toString('base64'), mimeType: 'audio/wav',
        engine: body.engine, model: body.model, voiceId: body.voice.id,
        modelRevision: body.audit.modelRevision, workerRevision: body.audit.workerRevision });
    } });
  const part = { text: item.text, items: [item], partIndex: 0 };
  await Promise.all(Array.from({ length: 8 }, () => synth({ article, part, splitPlan: { parts: [part] } })));
  assert.equal(calls, 1, 'parallel synthesis must make one worker request per segment key');
  await synth({ article, part, splitPlan: { parts: [part] } });
  assert.equal(calls, 1, 'second invocation must reuse the SHA-256 checked segment');
  const merged = await concatWorkerMp3Buffers([wavTone.stdout, wavTone.stdout]);
  const decoded = await runCommand(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1'], { input: merged });
  assert.equal(decoded.code, 0);
  assert.ok(decoded.stdout.length / 96000 >= 0.78 && decoded.stdout.length / 96000 < 0.85);

  const silence = await runCommand(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
    '-t', '0.4', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1']);
  assert.equal(silence.code, 0);
  const silentFiles = [path.join(temp, 'silent-1.mp3'), path.join(temp, 'silent-2.mp3')];
  await Promise.all(silentFiles.map((file) => writeFile(file, silence.stdout)));
  const failedMergeDir = candidateDir('splice-failure', 'f'.repeat(64), temp);
  await assert.rejects(mergeCandidateParts({ articleId: 'splice-failure', fingerprint: 'f'.repeat(64), root: temp,
    partFiles: silentFiles }), /gap\/silence/);
  await assert.rejects(access(path.join(failedMergeDir, 'full.mp3')), /ENOENT/);
  await assert.rejects(access(path.join(failedMergeDir, 'concat.txt')), /ENOENT/);

  const asrPath = path.join(temp, 'local-asr-error.json');
  await assert.rejects(runLocalAsrPreflight({ audioPath: path.join(dir, 'full.mp3'), expectedText: 'نص',
    outputPath: asrPath, env: { BAREEQ_LOCAL_ASR_PREFLIGHT: '1' } }), /not configured/);
  const asrReport = JSON.parse(await readFile(asrPath, 'utf8'));
  assert.equal(asrReport.status, 'error');
  assert.equal(asrReport.audioSha256, sha256(await readFile(path.join(dir, 'full.mp3'))));
  console.log('Audio Engine 2.0 hardening tests passed: publish lock, Arabic, worker, cache concurrency, fingerprints and splice.');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  for (const [key, value] of Object.entries(original)) process.env[key] = value;
  await rm(temp, { recursive: true, force: true });
}
