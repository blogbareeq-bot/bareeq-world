import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertEngineConfiguration,
  publicEngineIdentity,
  selectedEngineProfile,
} from './audio-engine-config.mjs';
import { prepareArabicSynthesisText, readPronunciationLexicon } from './audio-arabic-normalizer.mjs';
import { resolveAudioSynthesizer } from './audio-engine-router.mjs';
import { buildSegmentPlan, loadCachedSegment, saveCachedSegment, segmentCachePaths } from './audio-segment-cache.mjs';
import { runLocalAsrPreflight } from './audio-local-asr-preflight.mjs';
import { candidateFingerprint } from './audio-split.mjs';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import {
  GENERATOR_VERSION,
  PERFORMANCE_INSTRUCTIONS,
  PRODUCTION_TTS_MODEL,
  PRODUCTION_VOICE,
  sha256,
} from './audio-constants.mjs';

function oldCandidateFingerprint(article, splitPlan) {
  const split = {
    version: splitPlan.settings.version,
    algorithmVersion: splitPlan.settings.algorithmVersion || splitPlan.settings.version,
    name: splitPlan.settings.name,
    maxTranscriptBytes: splitPlan.settings.maxTranscriptBytes,
    targetSeconds: splitPlan.settings.targetSeconds,
    maxSeconds: splitPlan.settings.maxSeconds,
    minSeconds: splitPlan.settings.minSeconds,
    geminiInputTokenLimit: splitPlan.settings.geminiInputTokenLimit,
    geminiTokenEstimateDivisorBytes: splitPlan.settings.geminiTokenEstimateDivisorBytes,
    rebalanceFloorSeconds: splitPlan.settings.rebalanceFloorSeconds,
    defaultCharsPerSecond: splitPlan.settings.defaultCharsPerSecond,
    charsPerSecond: splitPlan.charsPerSecond,
    liveDurationSeconds: splitPlan.liveDurationSeconds ?? null,
    generatorVersion: splitPlan.settings.generatorVersion || GENERATOR_VERSION,
  };
  return sha256(JSON.stringify({
    articleId: article.articleId,
    spokenText: article.spokenText,
    speechScriptHash: article.speechScriptHash,
    model: PRODUCTION_TTS_MODEL,
    voice: PRODUCTION_VOICE,
    generatorVersion: GENERATOR_VERSION,
    performanceInstructions: PERFORMANCE_INSTRUCTIONS,
    split,
    partTexts: splitPlan.parts.map((part) => part.text),
    partIndexes: splitPlan.parts.map((part) => part.partIndex),
  }));
}

const original = { ...process.env };
try {
  delete process.env.BAREEQ_TTS_ENGINE;
  delete process.env.BAREEQ_LOCAL_TTS_ENABLE;
  delete process.env.BAREEQ_LOCAL_ASR_PREFLIGHT;
  assert.equal(selectedEngineProfile().id, 'gemini');
  assert.equal(publicEngineIdentity().voice, 'Sadaltager');

  const article = { articleId: 'test-article', spokenText: 'نص تجريبي', speechScriptHash: 'abc', items: [] };
  const splitPlan = {
    settings: {
      version: 4,
      algorithmVersion: 4,
      name: 'test',
      maxTranscriptBytes: 6500,
      targetSeconds: 165,
      maxSeconds: 180,
      minSeconds: 90,
      geminiInputTokenLimit: 8192,
      geminiTokenEstimateDivisorBytes: 3,
      rebalanceFloorSeconds: 90,
      defaultCharsPerSecond: 10,
      generatorVersion: GENERATOR_VERSION,
    },
    charsPerSecond: 10,
    liveDurationSeconds: null,
    parts: [{ text: 'نص تجريبي', partIndex: 0 }],
  };
  assert.equal(candidateFingerprint(article, splitPlan), oldCandidateFingerprint(article, splitPlan));

  process.env.BAREEQ_TTS_ENGINE = 'voxcpm2';
  assert.throws(() => assertEngineConfiguration(selectedEngineProfile()), /disabled/);
  process.env.BAREEQ_LOCAL_TTS_ENABLE = '1';
  process.env.BAREEQ_VOXCPM2_ENDPOINT = 'http://127.0.0.1:9876/tts';
  process.env.BAREEQ_TTS_MODEL_REVISION = 'test-model-v1';
  process.env.BAREEQ_TTS_WORKER_REVISION = 'test-worker-v1';
  assert.equal(assertEngineConfiguration(selectedEngineProfile()).kind, 'http');
  assert.notEqual(candidateFingerprint(article, splitPlan), oldCandidateFingerprint(article, splitPlan));

  const lexicon = await readPronunciationLexicon(process.cwd());
  const normalized = prepareArabicSynthesisText('هذا شرح ببساطة.', lexicon);
  assert.equal(normalized.canonicalText, 'هذا شرح ببساطة.');
  assert.match(normalized.synthesisText, /بِبَساطَة/u);

  let request = null;
  const { ffmpeg } = await assertFfmpeg();
  const generated = await runCommand(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4:sample_rate=48000',
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
  ]);
  assert.equal(generated.code, 0);
  const fakeMp3 = generated.stdout;
  const wavGenerated = await runCommand(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4:sample_rate=48000',
    '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
  ]);
  assert.equal(wavGenerated.code, 0);
  const fakeWav = wavGenerated.stdout;
  const attest = (body) => ({ engine: body.engine, model: body.model, voiceId: body.voice.id,
    modelRevision: body.audit.modelRevision, workerRevision: body.audit.workerRevision });
  const synth = await resolveAudioSynthesizer({
    root: process.cwd(),
    env: process.env,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ ...attest(request), audioBase64: fakeMp3.toString('base64'), mimeType: 'audio/mpeg' }),
      };
    },
  });
  const synthResult = await synth({
    article: { articleId: 'a', title: 'عنوان' },
    part: { text: 'ببساطة', partIndex: 0 },
    splitPlan: { parts: [{}] },
  });
  assert.equal(synthResult.transport, 'local-voxcpm2-http');
  assert.equal(request.canonicalText, 'ببساطة');
  assert.match(request.text, /بِبَساطَة/u);

  const temp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-segment-cache-'));
  try {
    const segmentArticle = {
      articleId: 'segment-test',
      speechScriptHash: 'hash',
      items: [{ segmentId: 's1', runtimeId: 'r1', type: 'paragraph', text: 'ببساطة' }],
    };
    const plan = buildSegmentPlan(segmentArticle, lexicon, process.env);
    const paths = segmentCachePaths({
      root: temp,
      articleId: segmentArticle.articleId,
      candidateFingerprint: 'c'.repeat(64),
      segmentId: plan[0].segmentId,
      fingerprint: plan[0].fingerprint,
    });
    const synthesis = prepareArabicSynthesisText(segmentArticle.items[0].text, lexicon);
    await saveCachedSegment(paths, {
      fingerprint: plan[0].fingerprint,
      articleId: segmentArticle.articleId,
      segmentId: plan[0].segmentId,
      synthesis,
      audio: fakeWav,
      env: process.env,
    });
    const cached = await loadCachedSegment(paths, plan[0].fingerprint);
    assert.ok(cached);
    assert.equal(cached.metadata.sha256, sha256(fakeWav));
    await rm(temp, { recursive: true, force: true });

    process.env.BAREEQ_SEGMENT_CACHE_ENABLE = '1';
    let workerCalls = 0;
    const cachedSynth = await resolveAudioSynthesizer({
      root: process.cwd(),
      cacheRoot: temp,
      env: process.env,
      fetchImpl: async (_url, options) => {
        workerCalls += 1;
        const body = JSON.parse(options.body);
        assert.equal(body.segmentId, 's1');
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ ...attest(body), audioBase64: fakeWav.toString('base64'), mimeType: 'audio/wav' }),
        };
      },
    });
    const cachedPart = {
      text: 'ببساطة',
      partIndex: 0,
      items: segmentArticle.items,
    };
    const firstCachedRun = await cachedSynth({
      article: segmentArticle,
      part: cachedPart,
      splitPlan: { parts: [cachedPart] },
    });
    const secondCachedRun = await cachedSynth({
      article: segmentArticle,
      part: cachedPart,
      splitPlan: { parts: [cachedPart] },
    });
    assert.equal(firstCachedRun.providerCalls, 1);
    assert.equal(firstCachedRun.workerMetadata.segmentCache.misses, 1);
    assert.equal(secondCachedRun.providerCalls, 0);
    assert.equal(secondCachedRun.workerMetadata.segmentCache.hits, 1);
    assert.equal(workerCalls, 1);
    delete process.env.BAREEQ_SEGMENT_CACHE_ENABLE;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  process.env.BAREEQ_LOCAL_ASR_PREFLIGHT = '1';
  const pass = await runLocalAsrPreflight({
    audioPath: '/tmp/not-read.mp3',
    expectedText: 'مرحبا بالعالم',
    env: process.env,
    transcribeImpl: async () => 'مرحبا بالعالم',
  });
  assert.equal(pass.status, 'passed');
  const fail = await runLocalAsrPreflight({
    audioPath: '/tmp/not-read.mp3',
    expectedText: 'مرحبا بالعالم',
    env: process.env,
    transcribeImpl: async () => 'مرحبا',
  });
  assert.equal(fail.status, 'failed');
  assert.equal(fail.remoteProviderCallsAvoidedOnFailure, 2);

  process.env.BAREEQ_TTS_ENGINE = 'not-an-engine';
  assert.throws(() => selectedEngineProfile(), /Unknown BAREEQ_TTS_ENGINE/);

  console.log('Bareeq Audio Engine 2.0 offline tests passed.');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  for (const [key, value] of Object.entries(original)) process.env[key] = value;
}
