import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT_HARD, EXIT_OK, QUOTA_SPLIT, sha256, liveAudioDir, GEMINI_TTS_CONTRACT } from './audio-constants.mjs';
import { persistPublishedAudio, publishApprovedCandidate } from './audio-publish.mjs';
import { confirmRemoteSha, resolvePublishRef, verifyPublishedManifest } from './audio-publish-verify.mjs';
import { bindObservedCandidate } from './audio-inventory.mjs';
import { assertSafeEvidencePath } from './audio-paths.mjs';
import { uploadResumableFile } from './audio-files-api.mjs';
import { transcribeDualAsr, GEMINI_FILES_UPLOAD, GEMINI_INTERACTIONS } from './audio-asr-transcribe.mjs';
import { parseEbur128, longestInternalSilenceSeconds, PRODUCTION_LOUDNESS } from './audio-technical-qa.mjs';
import { spliceWindowMetrics } from './audio-merge.mjs';
import { loadSpokenArticle, splitSpokenArticle } from './audio-split.mjs';
import { runProductionMode } from './audio-production.mjs';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { writeApprovedFixture } from './test-audio-fixture.mjs';

const ROOT = process.cwd();

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function pcmSine(seconds, { freq = 440, amplitude = 8000, sampleRate = 48000 } = {}) {
  const samples = Math.floor(seconds * sampleRate);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.floor(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude), i * 2);
  }
  return buf;
}

function pcmSilence(seconds, sampleRate = 48000) {
  return Buffer.alloc(Math.floor(seconds * sampleRate) * 2);
}

const parsed = parseEbur128(`Summary:

  Integrated loudness:
    I:         -18.6 LUFS
  Loudness range:
    LRA:         3.2 LU
  True peak:
    Peak:       -1.2 dBTP
`);
assert.equal(parsed.integratedLufs, -18.6);
assert.equal(parsed.truePeakDbTP, -1.2);

const silentPcm = Buffer.concat([pcmSine(0.4), pcmSilence(4.2), pcmSine(0.4)]);
assert.ok(longestInternalSilenceSeconds(silentPcm) > 3, 'internal 4s silence must fail the 3s cap');

const left = pcmSine(0.05);
const rightSilent = pcmSilence(0.05);
assert.equal(spliceWindowMetrics(left, rightSilent).gap, false);
const bothSilent = spliceWindowMetrics(pcmSilence(0.12), pcmSilence(0.12));
assert.equal(bothSilent.gap, true);

const clickLeft = Buffer.alloc(480 * 2);
const clickRight = Buffer.alloc(480 * 2);
clickLeft.writeInt16LE(30000, clickLeft.length - 2);
clickRight.writeInt16LE(-30000, 0);
assert.ok(spliceWindowMetrics(clickLeft, clickRight).step > 0.95);

assert.equal(PRODUCTION_LOUDNESS.maxTruePeakDbTP, 0);
assert.equal(GEMINI_TTS_CONTRACT.qualityCapSeconds, 180);
assert.equal(GEMINI_TTS_CONTRACT.inputTokenLimit, 8192);

const noPick = bindObservedCandidate({
  candidates: [
    { fingerprint: 'aa'.repeat(32), publishRecord: null },
    { fingerprint: 'ff'.repeat(32), publishRecord: null },
  ],
  liveFingerprint: null,
  liveFilesMatch: false,
});
assert.equal(noPick.published, false);
assert.equal(noPick.boundFingerprint, null);
assert.equal(noPick.latestBySha, null);

const matched = bindObservedCandidate({
  candidates: [
    { fingerprint: 'aa'.repeat(32), publishRecord: { status: 'published', fingerprint: 'aa'.repeat(32) } },
    { fingerprint: 'ff'.repeat(32), publishRecord: null },
  ],
  liveFingerprint: 'aa'.repeat(32),
  liveFilesMatch: true,
});
assert.equal(matched.published, true);
assert.equal(matched.boundFingerprint, 'aa'.repeat(32));

const mismatchLive = bindObservedCandidate({
  candidates: [
    { fingerprint: 'ff'.repeat(32), publishRecord: { status: 'published', fingerprint: 'ff'.repeat(32) } },
  ],
  liveFingerprint: 'aa'.repeat(32),
  liveFilesMatch: true,
});
assert.equal(mismatchLive.published, false);

const inflation = await loadSpokenArticle('altadakhom-explained-simply', ROOT);
const inflationSplit = splitSpokenArticle(inflation, { settings: QUOTA_SPLIT, liveDurationSeconds: 655 });
assert.ok(inflationSplit.maxPartEstimatedSeconds <= 180 + 1e-6);
assert.ok(inflationSplit.maxPartEstimatedTokens <= 8192);
for (const part of inflationSplit.parts) {
  if (part.estimatedSeconds < 150 && inflationSplit.parts.length > 1) {
    assert.ok(part.unavoidableReason, `inflation part ${part.partIndex} is ${part.estimatedSeconds}s without unavoidableReason`);
  }
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-engine-final-'));
const bare = await mkdtemp(path.join(os.tmpdir(), 'bareeq-engine-bare-'));
try {
  git(bare, ['init', '--bare']);
  git(tmp, ['init', '-b', 'arena/01a04a3c-bareeq-world']);
  git(tmp, ['config', 'user.name', 'bareeq-audio']);
  git(tmp, ['config', 'user.email', 'audio@bareeq.local']);
  await writeFile(path.join(tmp, 'README.md'), 'engine-final\n');
  git(tmp, ['add', 'README.md']);
  git(tmp, ['commit', '-m', 'init']);
  git(tmp, ['remote', 'add', 'origin', bare]);
  git(tmp, ['push', '-u', 'origin', 'HEAD:refs/heads/arena/01a04a3c-bareeq-world']);

  const articleId = 'resume-fixture';
  const liveDir = liveAudioDir(articleId, tmp);
  await mkdir(liveDir, { recursive: true });
  const fingerprint = 'ab'.repeat(32);
  const manifest = {
    articleId,
    fingerprint,
    candidateFingerprint: fingerprint,
    fullSha256: 'cd'.repeat(32),
    defaultVoice: 'sadaltager',
    parts: [{ audio: { sadaltager: { src: `/audio/articles/${path.basename(liveDir)}/part.mp3` } } }],
  };
  await writeFile(path.join(liveDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(liveDir, 'part.mp3'), Buffer.from('mp3-bytes'));

  const persisted = await persistPublishedAudio({
    root: tmp,
    liveDir,
    articleId,
    fingerprint,
    fullSha256: manifest.fullSha256,
    parts: manifest.parts,
    defaultVoice: 'sadaltager',
    push: true,
    env: { BAREEQ_AUDIO_PUBLISH_REF: 'arena/01a04a3c-bareeq-world' },
    productionOrigin: '',
  });
  assert.equal(persisted.committed, true);
  assert.equal(persisted.pushed, true);
  assert.equal(persisted.ref, 'refs/heads/arena/01a04a3c-bareeq-world');
  assert.equal(persisted.remoteSha, persisted.sha);
  assert.equal(persisted.preview.cloudflareVerified, false);
  assert.equal(persisted.preview.skipped, true);
  const confirmed = confirmRemoteSha({
    root: tmp,
    ref: 'refs/heads/arena/01a04a3c-bareeq-world',
    expectedSha: persisted.sha,
  });
  assert.equal(confirmed.matched, true);

  let pushFailed = false;
  let sawPush = false;
  try {
    await persistPublishedAudio({
      root: tmp,
      liveDir,
      articleId,
      fingerprint,
      push: true,
      env: { BAREEQ_AUDIO_PUBLISH_REF: 'arena/01a04a3c-bareeq-world' },
      spawn: (cmd, args, options) => {
        if (args[0] === 'config') return { status: 0, stdout: 'bareeq-audio\n', stderr: '' };
        if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'commit') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'rev-parse') return { status: 0, stdout: `${persisted.sha}\n`, stderr: '' };
        if (args[0] === 'push') {
          sawPush = true;
          return { status: 1, stdout: '', stderr: 'rejected non-fast-forward' };
        }
        return spawnSync(cmd, args, options);
      },
    });
  } catch (error) {
    pushFailed = true;
    assert.match(error.message, /push/);
  }
  assert.equal(pushFailed, true);
  assert.equal(sawPush, true);

  const origin = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.endsWith('manifest.json')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(manifest));
        return;
      }
      res.statusCode = 200;
      res.end('part');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
  try {
    const verified = await verifyPublishedManifest({
      origin: `http://127.0.0.1:${origin.port}`,
      articleId,
      fingerprint,
      fullSha256: manifest.fullSha256,
      parts: manifest.parts,
      defaultVoice: 'sadaltager',
    });
    assert.equal(verified.cloudflareVerified, true);
    assert.equal(verified.skipped, false);
    assert.match(verified.contentType, /json/i);
  } finally {
    origin.server.close();
  }

  const skipped = await verifyPublishedManifest({
    origin: '',
    articleId,
    fingerprint,
  });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.cloudflareVerified, false);

  await writeApprovedFixture(tmp, { copyRulesFrom: ROOT });
  const candidate = path.join(tmp, 'audio-candidates', articleId, fingerprint);
  await mkdir(path.join(candidate, 'reports'), { recursive: true });
  const listeningInside = path.join(candidate, 'reports', 'human-listening.json');
  await writeFile(listeningInside, '{}\n');
  const locked = await assertSafeEvidencePath(listeningInside, { root: tmp, articleId, fingerprint });
  assert.equal(locked, await realpath(listeningInside));

  let escaped = false;
  try {
    await assertSafeEvidencePath(path.join(tmp, 'README.md'), { root: tmp, articleId, fingerprint });
  } catch {
    escaped = true;
  }
  assert.equal(escaped, true);

  const foreign = path.join(tmp, 'audio-candidates', 'other-article', fingerprint, 'reports');
  await mkdir(foreign, { recursive: true });
  const foreignFile = path.join(foreign, 'human-listening.json');
  await writeFile(foreignFile, '{}\n');
  let foreignRejected = false;
  try {
    await assertSafeEvidencePath(foreignFile, { root: tmp, articleId, fingerprint });
  } catch {
    foreignRejected = true;
  }
  assert.equal(foreignRejected, true);

  const sneak = path.join(candidate, 'reports', 'sneak.json');
  await symlink(path.join(tmp, 'README.md'), sneak);
  let symlinkRejected = false;
  try {
    await assertSafeEvidencePath(sneak, { root: tmp, articleId, fingerprint });
  } catch {
    symlinkRejected = true;
  }
  assert.equal(symlinkRejected, true);

  const reportsDir = path.join(tmp, 'asr-fail');
  await mkdir(reportsDir, { recursive: true });
  const { ffmpeg } = await assertFfmpeg();
  const audioFile = path.join(tmp, 'asr.mp3');
  await runCommand(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.3',
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', '-y', audioFile,
  ]);

  let startFailed = false;
  try {
    await transcribeDualAsr({
      audioPath: audioFile,
      expectedText: 'مرحبا',
      apiKey: 'test-key',
      reportsDir,
      fingerprint,
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'nope', headers: { get: () => '' } }),
    });
  } catch (error) {
    startFailed = true;
    assert.equal(error.stage, 'start');
    assert.ok(error.dual?.asrReports?.length === 2);
  }
  assert.equal(startFailed, true);
  assert.equal(JSON.parse(await readFile(path.join(reportsDir, 'files-api.json'), 'utf8')).stage, 'start');
  assert.equal(JSON.parse(await readFile(path.join(reportsDir, 'asr-gemini-3.5-transcribe.json'), 'utf8')).status, 'failed');
  assert.equal(JSON.parse(await readFile(path.join(reportsDir, 'asr-gemini-3.6-flash.json'), 'utf8')).status, 'failed');

  const bothDir = path.join(tmp, 'asr-both');
  await mkdir(bothDir, { recursive: true });
  let firstFailedSecondRan = false;
  const models = [];
  try {
    await transcribeDualAsr({
      audioPath: audioFile,
      expectedText: 'مرحبا',
      apiKey: 'test-key',
      reportsDir: bothDir,
      fingerprint,
      fetchImpl: async (url, options = {}) => {
        const headers = options.headers || {};
        const command = headers['X-Goog-Upload-Command'] || headers['x-goog-upload-command'];
        if (String(url).startsWith(GEMINI_FILES_UPLOAD) || command === 'start') {
          return { ok: true, status: 200, headers: { get: (name) => String(name).toLowerCase() === 'x-goog-upload-url' ? 'https://generativelanguage.googleapis.com/upload/session/x' : '' } };
        }
        if (String(url).includes('/upload/session/')) {
          return { ok: true, status: 200, json: async () => ({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/x', name: 'files/x', mimeType: 'audio/mpeg' } }) };
        }
        if (options.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
        if (String(url) === GEMINI_INTERACTIONS || String(url).includes('/interactions')) {
          const payload = JSON.parse(options.body);
          models.push(payload.model);
          if (payload.model === 'gemini-3.5-transcribe') {
            return { ok: false, status: 500, text: async () => 'first-down' };
          }
          return { ok: true, status: 200, text: async () => JSON.stringify({ model: payload.model, output_text: 'مرحبا' }) };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
      },
    });
  } catch (error) {
    firstFailedSecondRan = true;
    assert.ok(error.dual.asrReports.length === 2);
  }
  assert.equal(firstFailedSecondRan, true);
  assert.deepEqual(models, ['gemini-3.5-transcribe', 'gemini-3.6-flash']);
  assert.equal(JSON.parse(await readFile(path.join(bothDir, 'asr-gemini-3.5-transcribe.json'), 'utf8')).status, 'failed');
  assert.equal(JSON.parse(await readFile(path.join(bothDir, 'asr-gemini-3.6-flash.json'), 'utf8')).status, 'passed');

  let uriInvented = false;
  try {
    await uploadResumableFile({
      apiKey: 'test-key',
      bytes: Buffer.from('hello-audio-bytes-hello-audio-bytes'),
      fetchImpl: async (url, options = {}) => {
        if (options.headers?.['X-Goog-Upload-Command'] === 'start') {
          return { ok: true, status: 200, headers: { get: () => 'https://example.test/upload' } };
        }
        const payload = { file: { name: 'files/z' } };
        return {
          ok: true,
          status: 200,
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        };
      },
    });
  } catch (error) {
    uriInvented = /URI/.test(error.message);
  }
  assert.equal(uriInvented, true);

  const snapshot = await runProductionMode({
    mode: 'verify-live',
    articleId: 'missing-live',
    root: tmp,
    storeRoot: tmp,
  }).then(() => null).catch((error) => error);
  assert.ok(snapshot);
  assert.match(snapshot.message, /live audio is missing/);

  const ref = resolvePublishRef(tmp, { BAREEQ_AUDIO_PUBLISH_REF: 'arena/01a04a3c-bareeq-world' });
  assert.equal(ref, 'refs/heads/arena/01a04a3c-bareeq-world');
} finally {
  await rm(tmp, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
}

const rollbackTmp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-engine-rollback-'));
try {
  await writeApprovedFixture(rollbackTmp, { copyRulesFrom: ROOT });
  const liveDir = liveAudioDir('resume-fixture', rollbackTmp);
  await mkdir(liveDir, { recursive: true });
  await writeFile(path.join(liveDir, 'manifest.json'), `${JSON.stringify({
    articleId: 'resume-fixture',
    defaultVoice: 'hamed',
    fingerprint: '11'.repeat(32),
    parts: [{ audio: { hamed: { src: '/audio/articles/x/hamed.mp3' } } }],
  }, null, 2)}\n`);
  await writeFile(path.join(liveDir, 'hamed.mp3'), Buffer.from('KEEP'));
  let restored = false;
  try {
    await publishApprovedCandidate({
      articleId: 'resume-fixture',
      fingerprint: '22'.repeat(32),
      root: rollbackTmp,
      post: { speechApproval: { validation: { valid: true, approved: true }, script: { scriptHash: 'x' }, testClipPlan: { speechScriptHash: 'x' } } },
      record: {
        generated: true,
        humanListening: { status: 'passed', reviewedBy: 'x', reviewedAt: '2026-08-29', evidence: { sha256: 'nope', candidateFingerprint: '22'.repeat(32) } },
      },
      persistGit: async () => {
        throw new Error('injected push failure');
      },
    });
  } catch (error) {
    restored = /candidate files are missing|injected push failure|listening|fingerprint/.test(error.message);
  }
  assert.equal(restored, true);
  const kept = JSON.parse(await readFile(path.join(liveDir, 'manifest.json'), 'utf8'));
  assert.equal(kept.defaultVoice, 'hamed');
} finally {
  await rm(rollbackTmp, { recursive: true, force: true });
}

assert.equal(EXIT_OK, 0);
assert.equal(EXIT_HARD, 1);
console.log('Audio engine-final tests passed: durable git push+verify, snapshot-only vs ledger bind, Files/ASR failure reports, path lock, LUFS/silence/click, inflation unavoidableReason. Zero real provider calls.');
