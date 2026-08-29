import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  INDEPENDENT_ASR_MODELS,
  FORBIDDEN_ASR_MODELS,
  EXIT_QUOTA,
  EXIT_HARD,
  EXIT_USAGE,
  EXIT_OK,
  EXIT_CONFIG,
  liveAudioDir,
  sha256,
  QUOTA_SPLIT,
  GEMINI_TTS_CONTRACT,
  CLOUD_TTS_CONTRACT,
} from './audio-constants.mjs';
import { assertIndependentAsrModels } from './audio-exact-match.mjs';
import { evaluateAsr, evaluatePublishability } from './audio-lifecycle.mjs';
import { loadSpokenArticle, splitSpokenArticle } from './audio-split.mjs';
import { generateCandidate, QuotaError } from './audio-generate-candidate.mjs';
import { mergeCandidateParts } from './audio-merge.mjs';
import { runTechnicalQa, inspectLiveSnapshot } from './audio-technical-qa.mjs';
import { publishApprovedCandidate, listeningMatchesFingerprint, atomicReplaceDir } from './audio-publish.mjs';
import {
  assertAsrModel,
  transcribeFullAudio,
  GEMINI_FILES_UPLOAD,
  GEMINI_INTERACTIONS,
} from './audio-asr-transcribe.mjs';
import { buildDryRun, runProductionMode, MODES } from './audio-production.mjs';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { readCheckpoint } from './audio-checkpoint.mjs';
import { isValidProductionManifest } from './audio-manifest.mjs';
import { expectedSyncIds } from './audio-sync.mjs';
import { uploadResumableFile } from './audio-files-api.mjs';
import { writeApprovedFixture } from './test-audio-fixture.mjs';

const ROOT = process.cwd();
const { ffmpeg } = await assertFfmpeg();

async function makeToneMp3(file, seconds = 0.5, frequency = 440) {
  await mkdir(path.dirname(file), { recursive: true });
  const result = await runCommand(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`,
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k',
    '-y', file,
  ]);
  if (result.code !== 0) throw new Error(result.stderr);
  return readFile(file);
}

function writeFixtureArticle(dir) {
  return writeApprovedFixture(dir, { copyRulesFrom: ROOT });
}

const tinySplit = {
  ...QUOTA_SPLIT,
  name: 'test-tiny',
  maxTranscriptBytes: 400,
  maxSeconds: 600,
  targetSeconds: 1,
  minSeconds: 0,
  rebalanceFloorSeconds: 0,
};

function mockGeminiTransport(expectedSpoken) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const headers = options.headers || {};
    const header = (name) => headers[name] || headers[name.toLowerCase()] || '';
    calls.push({
      url: String(url),
      command: header('X-Goog-Upload-Command'),
      offset: header('X-Goog-Upload-Offset'),
      protocol: header('X-Goog-Upload-Protocol'),
      body: options.body && !(options.body instanceof Buffer) && typeof options.body !== 'object'
        ? String(options.body).slice(0, 500)
        : `[${options.body?.length || 0} bytes]`,
    });
    if (String(url).startsWith(GEMINI_FILES_UPLOAD)) {
      assert.equal(header('X-Goog-Upload-Protocol'), 'resumable');
      assert.equal(header('X-Goog-Upload-Command'), 'start');
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => (String(name).toLowerCase() === 'x-goog-upload-url'
            ? 'https://generativelanguage.googleapis.com/upload/session/test'
            : ''),
        },
      };
    }
    if (String(url).includes('/upload/session/')) {
      assert.equal(header('X-Goog-Upload-Offset'), '0');
      assert.equal(header('X-Goog-Upload-Command'), 'upload, finalize');
      return {
        ok: true,
        status: 200,
        json: async () => ({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'audio/mpeg' } }),
        text: async () => JSON.stringify({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'audio/mpeg' } }),
      };
    }
    if (String(url) === GEMINI_INTERACTIONS || String(url).includes('/v1beta/interactions')) {
      const payload = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ model: payload.model, output_text: expectedSpoken }),
      };
    }
    if (options.method === 'DELETE' || String(url).includes('/v1beta/files/')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { calls, fetchImpl };
}

assert.throws(() => assertAsrModel('gemini-3.6-transcribe'));
assert.throws(() => assertIndependentAsrModels(['gemini-3.5-transcribe', 'gemini-3.6-transcribe']));
assert.deepEqual(assertIndependentAsrModels(INDEPENDENT_ASR_MODELS), [...INDEPENDENT_ASR_MODELS]);
assert.equal(FORBIDDEN_ASR_MODELS.includes('gemini-3.6-transcribe'), true);
assert.equal(GEMINI_TTS_CONTRACT.inputTokenLimit, 8192);
assert.equal(GEMINI_TTS_CONTRACT.qualityCapSeconds, 180);
assert.equal(CLOUD_TTS_CONTRACT.status.includes('inactive'), true);
assert.equal(QUOTA_SPLIT.geminiInputTokenLimit, 8192);
assert.equal('officialTextLimitBytes' in QUOTA_SPLIT, false);

const pending = evaluateAsr({
  asrStatus: 'pending-independent-asr',
  asrReports: [{ model: 'gemini-3.5-transcribe', substitutions: 0, deletions: 0, insertions: 0 }],
});
assert.equal(pending.passed, false);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-audio-safety-'));
const liveTmp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-live-'));
const resumeB = await mkdtemp(path.join(os.tmpdir(), 'bareeq-resume-b-'));
const resumePause = await mkdtemp(path.join(os.tmpdir(), 'bareeq-resume-pause-'));
try {
  await writeFixtureArticle(tmp);
  const article = await loadSpokenArticle('resume-fixture', tmp);
  const splitPlan = splitSpokenArticle(article, { settings: tinySplit, liveDurationSeconds: 40 });
  assert.ok(splitPlan.ttsRequests >= 4, `expected ≥4 tiny parts, got ${splitPlan.ttsRequests}`);
  assert.ok(splitPlan.parts.every((part) => Array.isArray(part.syncIds)), 'parts must store syncIds');

  const toneCache = new Map();
  async function toneFor(part) {
    const file = path.join(tmp, `tone-${part.partIndex}.mp3`);
    if (!toneCache.has(part.partIndex)) toneCache.set(part.partIndex, await makeToneMp3(file, 0.45, 420 + part.partIndex * 20));
    return toneCache.get(part.partIndex);
  }

  let sent = 0;
  const first = await generateCandidate({
    articleId: 'resume-fixture',
    root: tmp,
    storeRoot: tmp,
    settings: tinySplit,
    liveDurationSeconds: 40,
    synthesize: async ({ part }) => {
      sent += 1;
      if (sent === 3) throw new QuotaError('simulated HTTP 429');
      return toneFor(part);
    },
  }).then(() => {
    throw new Error('first run should not succeed');
  }).catch((error) => {
    assert.equal(error instanceof QuotaError, true);
    assert.equal(error.exitCode, EXIT_QUOTA);
    return error.result;
  });
  assert.equal(first.status, 'paused-quota');
  assert.equal(first.ttsRequestsSent, 2);
  assert.equal(first.providerAttempts, 3);
  assert.equal(first.quotaRejectedRequests, 1);
  assert.equal(first.pausedAtPart, 2);
  const checkpoint = await readCheckpoint({ checkpointFile: path.join(first.candidateDir, 'checkpoint.json') });
  assert.equal(Object.keys(checkpoint.completedParts).length, 2);
  assert.equal(checkpoint.status, 'paused-quota');
  assert.equal(checkpoint.exitCode, EXIT_QUOTA);

  await writeFixtureArticle(resumePause);
  await cp(path.join(tmp, 'audio-candidates'), path.join(resumePause, 'audio-candidates'), { recursive: true });
  for (let index = 0; index < splitPlan.ttsRequests; index += 1) {
    const tone = path.join(tmp, `tone-${index}.mp3`);
    try { await cp(tone, path.join(resumePause, `tone-${index}.mp3`)); } catch { /* later parts may not exist yet */ }
  }
  for (let index = 0; index < splitPlan.ttsRequests; index += 1) {
    if (!toneCache.has(index)) toneCache.set(index, await makeToneMp3(path.join(tmp, `tone-${index}.mp3`), 0.45, 420 + index * 20));
    await cp(path.join(tmp, `tone-${index}.mp3`), path.join(resumePause, `tone-${index}.mp3`));
  }
  const pauseChild = spawnSync(process.execPath, ['scripts/audio-resume-child.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BAREEQ_RESUME_ROOT: resumePause,
      BAREEQ_RESUME_STORE: resumePause,
      BAREEQ_RESUME_ARTICLE: 'resume-fixture',
      BAREEQ_RESUME_FAIL_AT: '-1',
    },
    cwd: ROOT,
  });
  assert.equal(pauseChild.status, 0, `two-checkout 429 resume failed: ${pauseChild.stderr}\n${pauseChild.stdout}`);
  const pauseResult = JSON.parse(pauseChild.stdout.trim().split('\n').at(-1));
  assert.equal(pauseResult.status, 'generated');
  assert.ok(pauseResult.ttsRequestsResumed >= 2, 'second checkout after 429 must skip completed parts');
  assert.equal(pauseResult.childSent, splitPlan.ttsRequests - pauseResult.ttsRequestsResumed);

  let resentFirstTwo = 0;
  const second = await generateCandidate({
    articleId: 'resume-fixture',
    root: tmp,
    storeRoot: tmp,
    settings: tinySplit,
    liveDurationSeconds: 40,
    synthesize: async ({ part }) => {
      if (part.partIndex < 2) resentFirstTwo += 1;
      sent += 1;
      return toneFor(part);
    },
  });
  assert.equal(resentFirstTwo, 0, 'resumed parts must not call the provider again');
  assert.equal(second.status, 'generated');
  assert.equal(second.ttsRequestsResumed, 2);
  assert.ok(second.ttsRequestsSent >= 2);
  assert.equal(second.liveUntouched, true);
  assert.ok(second.candidateDir.includes('audio-candidates'));
  assert.ok(second.liveDir.includes(path.join('public', 'audio', 'articles')));

  await writeFixtureArticle(resumeB);
  await cp(path.join(tmp, 'audio-candidates'), path.join(resumeB, 'audio-candidates'), { recursive: true });
  for (let index = 0; index < splitPlan.ttsRequests; index += 1) {
    await cp(path.join(tmp, `tone-${index}.mp3`), path.join(resumeB, `tone-${index}.mp3`));
  }
  const childEnv = {
    ...process.env,
    BAREEQ_RESUME_ROOT: resumeB,
    BAREEQ_RESUME_STORE: resumeB,
    BAREEQ_RESUME_ARTICLE: 'resume-fixture',
    BAREEQ_RESUME_FAIL_AT: '-1',
  };
  const child = spawnSync(process.execPath, ['scripts/audio-resume-child.mjs'], { encoding: 'utf8', env: childEnv, cwd: ROOT });
  assert.equal(child.status, 0, `two-checkout resume failed: ${child.stderr}\n${child.stdout}`);
  const childResult = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(childResult.status, 'generated');
  assert.ok(childResult.ttsRequestsResumed >= 2, 'second checkout must restore completed parts');
  assert.equal(childResult.childSent, splitPlan.ttsRequests - childResult.ttsRequestsResumed);

  const liveId = 'altadakhom-explained-simply';
  const liveDir = liveAudioDir(liveId, liveTmp);
  await mkdir(liveDir, { recursive: true });
  await writeFile(path.join(liveDir, 'manifest.json'), `${JSON.stringify({
    articleId: liveId,
    provider: 'Microsoft Azure AI Speech',
    defaultVoice: 'hamed',
    parts: [{ audio: { hamed: { src: `/audio/articles/${path.basename(liveDir)}/hamed.mp3`, bytes: 4 } } }],
  }, null, 2)}\n`);
  await writeFile(path.join(liveDir, 'hamed.mp3'), Buffer.from('LIVE'));
  const beforeLive = await inspectLiveSnapshot(liveId, liveTmp);
  const afterLive = await inspectLiveSnapshot(liveId, liveTmp);
  assert.equal(beforeLive.fingerprint, afterLive.fingerprint);
  assert.equal(beforeLive.voiceId, 'hamed');
  assert.equal(await readFile(path.join(liveDir, 'hamed.mp3'), 'utf8'), 'LIVE');

  const partFiles = [];
  for (let index = 0; index < 3; index += 1) {
    const file = path.join(tmp, 'merge', `p${index}.mp3`);
    await makeToneMp3(file, 0.4, 500 + index);
    partFiles.push(file);
  }
  const merged = await mergeCandidateParts({
    articleId: 'resume-fixture',
    fingerprint: 'merge-test',
    root: tmp,
    partFiles,
  });
  assert.equal(merged.partCount, 3);
  assert.ok(merged.sha256);
  assert.ok(Math.abs(merged.durationSeconds - merged.expectedDurationSeconds) < 0.35);

  let qaMissing = false;
  try {
    await runTechnicalQa({ articleId: 'missing-article', fingerprint: 'nope', root: tmp });
  } catch (error) {
    qaMissing = true;
    assert.equal(error.exitCode, EXIT_HARD);
  }
  assert.equal(qaMissing, true);

  const expectedSpoken = 'كيف تعرف الشاشة';
  const { calls: asrCalls, fetchImpl } = mockGeminiTransport(expectedSpoken);
  const audioFile = path.join(tmp, 'asr.mp3');
  await makeToneMp3(audioFile, 0.4);
  const asr35 = await transcribeFullAudio({
    model: 'gemini-3.5-transcribe',
    audioPath: audioFile,
    expectedText: expectedSpoken,
    apiKey: 'test-key',
    fetchImpl,
    outputPath: path.join(tmp, 'asr-35.json'),
  });
  assert.equal(asr35.status, 'passed');
  assert.equal(asr35.httpStatus, 200);
  assert.equal(asr35.filesApiUploads, 1);
  assert.equal(asr35.requestedModel, 'gemini-3.5-transcribe');
  assert.equal(asr35.actualResponseModel, 'gemini-3.5-transcribe');
  assert.equal(asr35.actualResponseModelSource, 'response.model');
  assert.ok(asrCalls.some((item) => item.url.startsWith(GEMINI_FILES_UPLOAD) && item.command === 'start'));
  assert.ok(asrCalls.some((item) => item.url.includes('/upload/session/') && item.command === 'upload, finalize' && item.offset === '0'));
  const body35 = JSON.parse(asrCalls.find((item) => item.url === GEMINI_INTERACTIONS).body);
  assert.equal(body35.model, 'gemini-3.5-transcribe');
  assert.equal(body35.input[0].type, 'audio');
  assert.equal(body35.generation_config.transcription_config.mode.type, 'verbatim');

  asrCalls.length = 0;
  const asr36 = await transcribeFullAudio({
    model: 'gemini-3.6-flash',
    audioPath: audioFile,
    expectedText: expectedSpoken,
    apiKey: 'test-key',
    fetchImpl,
    outputPath: path.join(tmp, 'asr-36.json'),
  });
  assert.equal(asr36.status, 'passed');
  const body36 = JSON.parse(asrCalls.find((item) => item.url === GEMINI_INTERACTIONS).body);
  assert.equal(body36.model, 'gemini-3.6-flash');
  assert.equal(body36.input[0].type, 'text');
  assert.equal(body36.input[1].type, 'audio');

  let emptyFailed = false;
  try {
    await transcribeFullAudio({
      model: 'gemini-3.5-transcribe',
      audioPath: audioFile,
      expectedText: expectedSpoken,
      apiKey: 'test-key',
      fetchImpl: async (url, options = {}) => {
        const headers = options.headers || {};
        if (String(url).startsWith(GEMINI_FILES_UPLOAD)) {
          return {
            ok: true,
            status: 200,
            headers: { get: (name) => String(name).toLowerCase() === 'x-goog-upload-url' ? 'https://generativelanguage.googleapis.com/upload/session/empty' : '' },
          };
        }
        if (String(url).includes('/upload/session/')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ file: { uri: 'files/x', mimeType: 'audio/mpeg' } }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ model: 'gemini-3.5-transcribe', output_text: '' }),
        };
      },
    });
  } catch (error) {
    emptyFailed = true;
    assert.equal(error.emptyTranscript, true);
  }
  assert.equal(emptyFailed, true);

  const filesProbe = [];
  await uploadResumableFile({
    apiKey: 'test-key',
    bytes: Buffer.from('hello-audio-bytes-hello-audio-bytes'),
    fetchImpl: async (url, options = {}) => {
      filesProbe.push({ url: String(url), headers: options.headers });
      if (String(url).startsWith(GEMINI_FILES_UPLOAD)) {
        return { ok: true, status: 200, headers: { get: () => 'https://example.test/upload' } };
      }
      return { ok: true, status: 200, json: async () => ({ file: { uri: 'files/z', mimeType: 'audio/mpeg' } }) };
    },
  });
  assert.equal(filesProbe[0].headers['X-Goog-Upload-Command'], 'start');
  assert.equal(filesProbe[1].headers['X-Goog-Upload-Command'], 'upload, finalize');
  assert.equal(filesProbe[1].headers['X-Goog-Upload-Offset'], '0');

  const fullSha = merged.sha256;
  assert.equal(listeningMatchesFingerprint({ status: 'passed', reviewedBy: 'x', reviewedAt: '2026-08-29', evidence: { sha256: 'nope' } }, fullSha, 'fp'), false);
  let publishBlocked = false;
  try {
    await publishApprovedCandidate({
      articleId: 'resume-fixture',
      fingerprint: 'missing',
      root: tmp,
      post: { speechApproval: { validation: { valid: true, approved: true }, script: { scriptHash: 'a' }, testClipPlan: { speechScriptHash: 'a' } } },
      record: {},
    });
  } catch (error) {
    publishBlocked = true;
    assert.equal(error.exitCode, EXIT_HARD);
  }
  assert.equal(publishBlocked, true);

  const validate = await runProductionMode({
    mode: 'validate-candidate',
    articleId: 'resume-fixture',
    fingerprint: second.fingerprint,
    root: tmp,
    storeRoot: tmp,
    settings: tinySplit,
    liveDurationSeconds: 40,
    fetchImpl: mockGeminiTransport(article.spokenText).fetchImpl,
  });
  assert.equal(validate.status, 'validated');
  assert.equal(validate.filesApiUploads, 1);
  assert.equal(validate.asrInteractions, 2);
  assert.ok(validate.totalHttpRequests >= 5 || validate.asrProviderCalls >= 5);
  assert.equal(validate.fullSha256, sha256(await readFile(path.join(second.candidateDir, 'full.mp3'))));
  const playerManifest = JSON.parse(await readFile(path.join(second.candidateDir, 'manifest.json'), 'utf8'));
  assert.equal(isValidProductionManifest(playerManifest), true);
  assert.ok(playerManifest.parts.every((part) => Array.isArray(part.sync) && Array.isArray(part.syncIds)));

  const qa = await runTechnicalQa({
    articleId: 'resume-fixture',
    fingerprint: second.fingerprint,
    root: tmp,
    expectedSyncIds: expectedSyncIds(article),
    fullSha256: validate.fullSha256,
  });
  assert.equal(qa.passed, true);
  assert.equal(qa.fullSha256, validate.fullSha256);

  const publishRecord = {
    generated: true,
    provider: 'Google Gemini API',
    model: 'gemini-3.1-flash-tts-preview',
    voiceId: 'sadaltager',
    asrReports: validate.asrReports.map((item) => ({
      model: item.model,
      substitutions: 0,
      deletions: 0,
      insertions: 0,
    })),
    humanListening: {
      status: 'passed',
      reviewedBy: 'safety-test',
      reviewedAt: '2026-08-29T00:00:00.000Z',
      evidence: { sha256: validate.fullSha256, candidateFingerprint: second.fingerprint },
    },
    technicalStatus: 'passed',
    syncStatus: 'passed',
  };
  const post = {
    speechApproval: {
      validation: { valid: true, approved: true },
      script: { scriptHash: article.speechScriptHash || 'fixture' },
      testClipPlan: { speechScriptHash: article.speechScriptHash || 'fixture' },
    },
  };
  assert.equal(evaluatePublishability(post, publishRecord).passed, true);

  const validatePath = path.join(second.candidateDir, 'reports', 'validate.json');
  const originalValidate = await readFile(validatePath, 'utf8');
  await writeFile(validatePath, originalValidate.replaceAll(second.fingerprint, 'ab'.repeat(32)));
  let flipped = false;
  try {
    await runProductionMode({
      mode: 'publish-approved',
      articleId: 'resume-fixture',
      fingerprint: second.fingerprint,
      root: tmp,
      storeRoot: tmp,
      post,
      record: publishRecord,
    });
  } catch (error) {
    flipped = true;
    assert.equal(error.exitCode, EXIT_HARD);
  }
  assert.equal(flipped, true, 'publish must fail when a bound report fingerprint is altered');
  await writeFile(validatePath, originalValidate);

  const publishedLive = liveAudioDir('resume-fixture', tmp);
  await mkdir(publishedLive, { recursive: true });
  await writeFile(path.join(publishedLive, 'hamed.mp3'), Buffer.from('LIVE-HAMED'));
  await writeFile(path.join(publishedLive, 'manifest.json'), `${JSON.stringify({
    articleId: 'resume-fixture',
    defaultVoice: 'hamed',
    parts: [{ audio: { hamed: { src: '/audio/articles/x/hamed.mp3', durationSeconds: 1 } }, sync: [] }],
    voices: [{ id: 'hamed' }],
  }, null, 2)}\n`);

  let persistCalls = 0;
  const published = await runProductionMode({
    mode: 'publish-approved',
    articleId: 'resume-fixture',
    fingerprint: second.fingerprint,
    root: tmp,
    storeRoot: tmp,
    post,
    record: publishRecord,
    persistGit: async () => {
      persistCalls += 1;
      return { committed: true };
    },
  });
  assert.equal(published.exitCode, EXIT_OK);
  assert.equal(persistCalls, 1);
  assert.equal(await pathExistsSafe(path.join(published.liveDir, 'manifest.json')), true);
  const liveManifest = JSON.parse(await readFile(path.join(published.liveDir, 'manifest.json'), 'utf8'));
  assert.equal(isValidProductionManifest(liveManifest), true);
  assert.equal(liveManifest.defaultVoice, 'sadaltager');
  assert.ok(published.rollbackDir);
  assert.equal(await readFile(path.join(publishedLive, 'hamed.mp3'), 'utf8'), 'LIVE-HAMED');

  const verifiedLive = await runProductionMode({
    mode: 'verify-live',
    articleId: 'resume-fixture',
    root: tmp,
    storeRoot: tmp,
  });
  assert.equal(verifiedLive.status, 'live-snapshot-unverified');
  assert.equal(verifiedLive.certified, false);
  assert.match(verifiedLive.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(verifiedLive.liveUntouched, true);
  assert.equal(await readFile(path.join(publishedLive, 'hamed.mp3'), 'utf8'), 'LIVE-HAMED');
  const liveAfterVerify = JSON.parse(await readFile(path.join(published.liveDir, 'manifest.json'), 'utf8'));
  assert.equal(liveAfterVerify.defaultVoice, 'sadaltager');

  const staging = path.join(tmp, 'staging-swap');
  const liveSwap = path.join(tmp, 'live-swap');
  await mkdir(staging, { recursive: true });
  await mkdir(liveSwap, { recursive: true });
  await writeFile(path.join(liveSwap, 'keep.txt'), 'ORIGINAL');
  await writeFile(path.join(staging, 'keep.txt'), 'NEW');
  let rolled = false;
  try {
    await atomicReplaceDir(liveSwap, staging, {
      afterLiveMoved: async () => {
        throw new Error('injected swap failure');
      },
    });
  } catch (error) {
    rolled = true;
    assert.match(error.message, /injected swap failure/);
  }
  assert.equal(rolled, true);
  assert.equal(await readFile(path.join(liveSwap, 'keep.txt'), 'utf8'), 'ORIGINAL');

  const executedModes = [];
  for (const mode of MODES) {
    if (mode === 'dry-run') {
      const dryMode = await runProductionMode({ mode, root: ROOT });
      assert.equal(dryMode.mode, 'dry-run');
      executedModes.push(mode);
      continue;
    }
    if (mode === 'generate-candidate') {
      const generated = await runProductionMode({
        mode,
        articleId: 'resume-fixture',
        root: tmp,
        storeRoot: tmp,
        settings: tinySplit,
        liveDurationSeconds: 40,
        synthesize: async ({ part }) => toneFor(part),
      });
      assert.equal(generated.status, 'generated');
      executedModes.push(mode);
      continue;
    }
    if (mode === 'validate-candidate') {
      assert.equal(validate.status, 'validated');
      executedModes.push(mode);
      continue;
    }
    if (mode === 'publish-approved') {
      assert.equal(published.exitCode, EXIT_OK);
      executedModes.push(mode);
      continue;
    }
    if (mode === 'verify-live') {
      executedModes.push(mode);
    }
  }
  assert.deepEqual(executedModes, MODES);

  const workflow = await readFile(path.join(ROOT, 'docs', 'audio', 'github-audio-production.yml'), 'utf8');
  for (const token of [
    'dry-run',
    'generate-candidate',
    'validate-candidate',
    'publish-approved',
    'exit 75',
    'if: always()',
    'actions/upload-artifact@v4',
    'actions/cache/restore@v4',
    'gemini-3.5-transcribe',
    'gemini-3.6-flash',
    'Does not publish',
    'human listening evidence bound to the candidate file SHA-256',
    '--fingerprint=',
    'Refusing to pick latest',
    'BAREEQ_AUDIO_MODE',
    'BAREEQ_AUDIO_PUBLISH_PUSH',
    '--snapshot-only',
  ]) {
    assert.ok(workflow.includes(token), `workflow missing ${token}`);
  }
  assert.ok(!workflow.includes('gemini-3.6-transcribe'));
  assert.ok(!workflow.includes('execute-one'));

  const dry = await buildDryRun(ROOT);
  assert.equal(dry.expected.ttsRequestsBefore, 63);
  assert.ok(dry.expected.ttsRequestsAfter < dry.expected.ttsRequestsBefore, 'quota split must reduce TTS requests');
  assert.equal(dry.expected.filesApiUploads, dry.plans.length);
  assert.equal(dry.expected.asrRequests, dry.plans.length * 2);
  assert.equal(dry.expected.filesApiStartRequests, dry.plans.length);
  assert.equal(dry.expected.filesApiFinalizeRequests, dry.plans.length);
  assert.equal(dry.expected.filesApiDeleteRequests, dry.plans.length);
  assert.equal(dry.expected.totalHttpRequests, dry.plans.length * 5);
  assert.equal(dry.expected.asrProviderCalls, dry.expected.totalHttpRequests);
  assert.deepEqual(dry.asr.models, INDEPENDENT_ASR_MODELS);
  assert.equal(dry.geminiTtsContract.inputTokenLimit, 8192);
  for (const plan of dry.plans.filter((item) => item.action === 'generate-sadaltager-candidate')) {
    assert.ok(plan.maxPartBytes <= QUOTA_SPLIT.maxTranscriptBytes, `${plan.articleId} exceeds transcript byte cap`);
    assert.ok(plan.maxPartEstimatedTokens <= GEMINI_TTS_CONTRACT.inputTokenLimit, `${plan.articleId} exceeds Gemini 8192-token contract`);
    assert.ok(plan.maxPartEstimatedSeconds <= GEMINI_TTS_CONTRACT.qualityCapSeconds + 1e-6, `${plan.articleId} exceeds Gemini 180s quality cap`);
    assert.ok(plan.parts.every((part) => Array.isArray(part.syncIds)), `${plan.articleId} missing syncIds`);
    assert.ok(plan.parts.some((part) => part.syncIds.length), `${plan.articleId} has no synchronized blocks`);
    if (plan.ttsRequestsAfter > 6) assert.ok(plan.justification);
    for (const part of plan.parts) {
      if (part.estimatedSeconds < 150 && plan.ttsRequestsAfter > 1) {
        assert.ok(part.unavoidableReason, `${plan.articleId} part ${part.partIndex} is ${part.estimatedSeconds}s without unavoidableReason`);
      }
    }
  }

  const dryCli = spawnSync(process.execPath, ['scripts/audio-production.mjs', '--mode=dry-run'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(dryCli.status, EXIT_OK, dryCli.stderr);
  const generateCli = spawnSync(process.execPath, ['scripts/audio-production.mjs', '--mode=generate-candidate'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(generateCli.status, EXIT_USAGE);
  const validateCli = spawnSync(process.execPath, ['scripts/audio-production.mjs', '--mode=validate-candidate'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(validateCli.status, EXIT_USAGE);
  const publishCli = spawnSync(process.execPath, ['scripts/audio-production.mjs', '--mode=publish-approved'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(publishCli.status, EXIT_USAGE);

  const qaCli = spawnSync(process.execPath, ['scripts/audio-technical-qa.mjs', '--article=does-not-exist'], { encoding: 'utf8' });
  assert.notEqual(qaCli.status, 0);

  console.log(`Audio production safety tests passed. TTS plan ${dry.expected.ttsRequestsBefore} → ${dry.expected.ttsRequestsAfter}. ASR provider calls ${dry.expected.asrProviderCalls}. Two-checkout resume restored parts. Four modes executed. Zero real provider calls.`);
} finally {
  await rm(tmp, { recursive: true, force: true });
  await rm(liveTmp, { recursive: true, force: true });
  await rm(resumeB, { recursive: true, force: true });
}

async function pathExistsSafe(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}
