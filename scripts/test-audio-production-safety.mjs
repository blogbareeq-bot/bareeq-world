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
  liveAudioDir,
  sha256,
  QUOTA_SPLIT,
  LEGACY_SPLIT,
} from './audio-constants.mjs';
import { assertIndependentAsrModels } from './audio-exact-match.mjs';
import { evaluateAsr, evaluatePublishability } from './audio-lifecycle.mjs';
import { loadSpokenArticle, splitSpokenArticle } from './audio-split.mjs';
import { generateCandidate, QuotaError } from './audio-generate-candidate.mjs';
import { mergeCandidateParts } from './audio-merge.mjs';
import { runTechnicalQa, inspectLiveSnapshot } from './audio-technical-qa.mjs';
import { publishApprovedCandidate, listeningMatchesFingerprint } from './audio-publish.mjs';
import {
  assertAsrModel,
  transcribeFullAudio,
  buildInteractionBody,
  GEMINI_FILES_UPLOAD,
  GEMINI_INTERACTIONS,
  extractTranscript,
} from './audio-asr-transcribe.mjs';
import { buildDryRun } from './audio-production.mjs';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { readCheckpoint } from './audio-checkpoint.mjs';
import { partFileName } from './audio-checkpoint.mjs';
import { candidateFingerprint, partFingerprint } from './audio-split.mjs';

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
  const posts = path.join(dir, 'src', 'content', 'posts');
  return mkdir(posts, { recursive: true }).then(() => writeFile(path.join(posts, 'resume-fixture.md'), `---
title: "اختبار الاستئناف"
draft: false
---
هذه فقرة أولى مخصصة لتقسيم الأجزاء أثناء الاختبار.

هذه فقرة ثانية مخصصة لتقسيم الأجزاء أثناء الاختبار.

هذه فقرة ثالثة مخصصة لتقسيم الأجزاء أثناء الاختبار.

هذه فقرة رابعة مخصصة لتقسيم الأجزاء أثناء الاختبار.
`));
}

const tinySplit = {
  ...QUOTA_SPLIT,
  name: 'test-tiny',
  maxTranscriptBytes: 120,
  maxSeconds: 600,
  targetSeconds: 1,
  minSeconds: 0,
};

assert.throws(() => assertAsrModel('gemini-3.6-transcribe'));
assert.throws(() => assertIndependentAsrModels(['gemini-3.5-transcribe', 'gemini-3.6-transcribe']));
assert.deepEqual(assertIndependentAsrModels(INDEPENDENT_ASR_MODELS), [...INDEPENDENT_ASR_MODELS]);
assert.equal(FORBIDDEN_ASR_MODELS.includes('gemini-3.6-transcribe'), true);

const pending = evaluateAsr({
  asrStatus: 'pending-independent-asr',
  asrReports: [{ model: 'gemini-3.5-transcribe', substitutions: 0, deletions: 0, insertions: 0 }],
});
assert.equal(pending.passed, false);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-audio-safety-'));
const liveTmp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-live-'));
try {
  await writeFixtureArticle(tmp);
  const article = await loadSpokenArticle('resume-fixture', tmp);
  const splitPlan = splitSpokenArticle(article, { settings: tinySplit, liveDurationSeconds: 40 });
  assert.ok(splitPlan.ttsRequests >= 4, `expected ≥4 tiny parts, got ${splitPlan.ttsRequests}`);

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
  assert.equal(first.pausedAtPart, 2);
  const checkpoint = await readCheckpoint({ checkpointFile: path.join(first.candidateDir, 'checkpoint.json') });
  assert.equal(Object.keys(checkpoint.completedParts).length, 2);
  assert.equal(checkpoint.status, 'paused-quota');
  assert.equal(checkpoint.exitCode, EXIT_QUOTA);

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
  const asrCalls = [];
  const fetchImpl = async (url, options = {}) => {
    asrCalls.push({ url: String(url), body: options.body && !(options.body instanceof Buffer) ? String(options.body).slice(0, 500) : `[${options.body?.length || 0} bytes]` });
    if (String(url).startsWith(GEMINI_FILES_UPLOAD)) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mime_type: 'audio/mpeg' } }),
      };
    }
    if (String(url) === GEMINI_INTERACTIONS) {
      const payload = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ model: payload.model, output_text: expectedSpoken }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
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
  assert.ok(asrCalls.some((item) => item.url.startsWith(GEMINI_FILES_UPLOAD)));
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
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        text: async () => String(url).includes('upload')
          ? JSON.stringify({ file: { uri: 'files/x', mime_type: 'audio/mpeg' } })
          : JSON.stringify({ model: 'gemini-3.5-transcribe', output_text: '' }),
      }),
    });
  } catch (error) {
    emptyFailed = true;
    assert.equal(error.emptyTranscript, true);
  }
  assert.equal(emptyFailed, true);

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
  ]) {
    assert.ok(workflow.includes(token), `workflow missing ${token}`);
  }
  assert.ok(!workflow.includes('gemini-3.6-transcribe'));
  assert.ok(!workflow.includes('execute-one'));

  const dry = await buildDryRun(ROOT);
  assert.equal(dry.expected.ttsRequestsBefore, 63);
  assert.ok(dry.expected.ttsRequestsAfter < dry.expected.ttsRequestsBefore, 'quota split must reduce TTS requests');
  assert.deepEqual(dry.asr.models, INDEPENDENT_ASR_MODELS);
  for (const plan of dry.plans.filter((item) => item.action === 'generate-sadaltager-candidate')) {
    assert.ok(plan.maxPartBytes <= QUOTA_SPLIT.maxTranscriptBytes, `${plan.articleId} exceeds transcript byte cap`);
    assert.ok(plan.parts.every((part) => part.promptBytes <= QUOTA_SPLIT.officialCombinedLimitBytes), `${plan.articleId} exceeds combined input limit`);
    assert.ok(plan.maxPartEstimatedSeconds <= QUOTA_SPLIT.driftCapSeconds + 1e-6, `${plan.articleId} exceeds drift cap`);
    assert.ok(plan.maxPartEstimatedSeconds <= QUOTA_SPLIT.officialOutputSeconds);
    if (plan.ttsRequestsAfter > 6) assert.ok(plan.justification);
  }

  const qaCli = spawnSync(process.execPath, ['scripts/audio-technical-qa.mjs', '--article=does-not-exist'], { encoding: 'utf8' });
  assert.notEqual(qaCli.status, 0);

  console.log(`Audio production safety tests passed. TTS plan ${dry.expected.ttsRequestsBefore} → ${dry.expected.ttsRequestsAfter}. Resume kept 2 parts after simulated 429. Zero real provider calls.`);
} finally {
  await rm(tmp, { recursive: true, force: true });
  await rm(liveTmp, { recursive: true, force: true });
}
