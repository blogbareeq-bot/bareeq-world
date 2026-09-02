import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, cp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EXIT_CONFIG, EXIT_HARD, EXIT_OK, EXIT_QUOTA, EXIT_USAGE, sha256, liveAudioDir, audioKeyFor, INDEPENDENT_ASR_MODELS } from './audio-constants.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { writeApprovedFixture } from './test-audio-fixture.mjs';
import { validateSyncMap, expectedSyncIds, attachSync } from './audio-sync.mjs';
import { publishApprovedCandidate } from './audio-publish.mjs';
import { loadPublicationPost, loadPublishRecord } from './audio-approval.mjs';

const ROOT = process.cwd();

function sinePcm(seconds = 0.25, sampleRate = 24000, freq = 440) {
  const count = Math.floor(seconds * sampleRate);
  const bytes = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    bytes.writeInt16LE(Math.floor(Math.sin((2 * Math.PI * freq * index) / sampleRate) * 12000), index * 2);
  }
  return bytes;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function startMockServer({ failTtsAt = -1, spoken = 'اختبار الاستئناف فقرة' } = {}) {
  let ttsAttempts = 0;
  let filesStarts = 0;
  let filesFinalizes = 0;
  let filesDeletes = 0;
  let interactions = 0;
  const uris = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/upload/v1beta/files') {
        await readBody(req);
        filesStarts += 1;
        res.setHeader('X-Goog-Upload-URL', `http://127.0.0.1:${server.address().port}/upload/session/1`);
        res.end('{}');
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/upload/session/')) {
        await readBody(req);
        filesFinalizes += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', name: 'files/abc', mimeType: 'audio/mpeg' } }));
        return;
      }
      if (req.method === 'GET' && req.url.includes('/files/')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', name: 'files/abc', mimeType: 'audio/mpeg' }));
        return;
      }
      if (req.method === 'DELETE') {
        filesDeletes += 1;
        res.statusCode = 200;
        res.end('{}');
        return;
      }
      if (req.method === 'POST' && req.url.includes('/interactions')) {
        const raw = await readBody(req);
        const payload = JSON.parse(raw.toString('utf8') || '{}');
        interactions += 1;
        const isTts = Boolean(payload.response_format?.type === 'audio' || payload.generation_config?.speech_config);
        if (isTts) {
          ttsAttempts += 1;
          if (failTtsAt > 0 && ttsAttempts === failTtsAt) {
            res.statusCode = 429;
            res.end('{"error":"RESOURCE_EXHAUSTED"}');
            return;
          }
          const pcm = sinePcm();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            model: payload.model,
            id: `resp-${ttsAttempts}`,
            steps: [{
              type: 'audio',
              content: [{ type: 'audio', data: pcm.toString('base64'), mime_type: 'audio/l16', sample_rate: 24000, channels: 1 }],
            }],
          }));
          return;
        }
        const audioInput = (payload.input || []).find((item) => item.type === 'audio');
        if (audioInput?.uri) uris.push(audioInput.uri);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ model: payload.model, id: `asr-${payload.model}`, output_text: spoken }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    } catch (error) {
      res.statusCode = 500;
      res.end(error.message);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        ttsAttempts: () => ttsAttempts,
        filesStarts: () => filesStarts,
        filesFinalizes: () => filesFinalizes,
        filesDeletes: () => filesDeletes,
        interactions: () => interactions,
        uris: () => uris,
        url: `http://127.0.0.1:${port}`,
      });
    });
  });
}

function lastJson(text) {
  const start = text.lastIndexOf('{');
  if (start < 0) throw new Error(`no JSON in output: ${text}`);
  return JSON.parse(text.slice(start));
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'audio-production.mjs'), ...args], {
    cwd: cwd || ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runCliAsync(args, { cwd, env = {}, timeoutMs = 40000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'audio-production.mjs'), ...args], {
      cwd: cwd || ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms args=${args.join(' ')} stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const duplicate = validateSyncMap(
  { items: [{ type: 'paragraph', runtimeId: 'b0001', text: 'أ' }, { type: 'paragraph', runtimeId: 'b0002', text: 'ب' }] },
  [
    attachSync({ items: [{ type: 'paragraph', runtimeId: 'b0001', text: 'أ' }], partIndex: 0 }),
    attachSync({ items: [{ type: 'paragraph', runtimeId: 'b0001', text: 'أ' }], partIndex: 1 }),
  ],
);
assert.equal(duplicate.passed, false);
assert.ok(duplicate.failures.some((item) => /duplicate/.test(item)));

const reversed = validateSyncMap(
  { items: [{ type: 'paragraph', runtimeId: 'b0001', text: 'أ' }, { type: 'paragraph', runtimeId: 'b0002', text: 'ب' }] },
  [
    attachSync({ items: [{ type: 'paragraph', runtimeId: 'b0002', text: 'ب' }], partIndex: 0 }),
    attachSync({ items: [{ type: 'paragraph', runtimeId: 'b0001', text: 'أ' }], partIndex: 1 }),
  ],
);
assert.equal(reversed.passed, false);

const missing = validateSyncMap(
  { items: [{ type: 'paragraph', runtimeId: 'b0001', text: 'أ' }, { type: 'paragraph', runtimeId: 'b0002', text: 'ب' }] },
  [attachSync({ items: [{ type: 'paragraph', runtimeId: 'b0001', text: 'أ' }], partIndex: 0 })],
);
assert.equal(missing.passed, false);

const dry = runCli(['--mode=dry-run']);
assert.equal(dry.status, EXIT_OK, dry.stderr);
assert.match(dry.stdout, /Zero provider requests were sent/);

const missingArticle = runCli(['--mode=generate-candidate']);
assert.equal(missingArticle.status, EXIT_USAGE);

const unlocked = runCli(['--mode=generate-candidate', '--article=altadakhom-explained-simply']);
assert.equal(unlocked.status, EXIT_CONFIG);

const validateNoFp = runCli(['--mode=validate-candidate', '--article=altadakhom-explained-simply']);
assert.equal(validateNoFp.status, EXIT_USAGE);

const publishNoFp = runCli(['--mode=publish-approved', '--article=altadakhom-explained-simply']);
assert.equal(publishNoFp.status, EXIT_USAGE);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'bareeq-audio-cli-'));
const tmp2 = await mkdtemp(path.join(os.tmpdir(), 'bareeq-audio-cli-b-'));
await writeApprovedFixture(tmp, { copyRulesFrom: ROOT });
const fixtureArticle = await loadSpokenArticle('resume-fixture', tmp);
const mock = await startMockServer({ failTtsAt: 3, spoken: fixtureArticle.spokenText });
try {
  const env = {
    GEMINI_API_KEY: 'contract-test-key',
    BAREEQ_AUDIO_PRODUCTION_LOCK: '1',
    BAREEQ_TTS_CONTRACT_TEST: '1',
    GEMINI_TTS_ENDPOINT: `${mock.url}/v1beta/interactions`,
    GEMINI_INTERACTIONS_ENDPOINT: `${mock.url}/v1beta/interactions`,
    GEMINI_FILES_ENDPOINT: `${mock.url}/upload/v1beta/files`,
    GEMINI_FILES_REST_ENDPOINT: `${mock.url}/v1beta`,
    BAREEQ_AUDIO_TEST_SPLIT: 'tiny',
  };
  const first = await runCliAsync(['--mode=generate-candidate', '--article=resume-fixture'], { cwd: tmp, env });
  assert.equal(first.status, EXIT_QUOTA, `generate status ${first.status} stdout=${first.stdout} stderr=${first.stderr}`);
  assert.match(first.stderr + first.stdout, /429|quota|paused/i);
  const candidates = path.join(tmp, 'audio-candidates', 'resume-fixture');
  const names = (await readdir(candidates)).filter((name) => name.length >= 16);
  assert.ok(names.length >= 1);
  const requestLog = JSON.parse(await readFile(path.join(candidates, names[0], 'request-log.json'), 'utf8'));
  const synthesized = requestLog.entries.filter((entry) => entry.action === 'synthesize');
  assert.equal(synthesized.length, 2, 'first two parts must succeed before the 429');

  await writeApprovedFixture(tmp2, { copyRulesFrom: ROOT });
  await cp(path.join(tmp, 'audio-candidates'), path.join(tmp2, 'audio-candidates'), { recursive: true });
  const second = await runCliAsync(['--mode=generate-candidate', '--article=resume-fixture'], { cwd: tmp2, env });
  assert.equal(second.status, EXIT_OK, second.stderr + second.stdout);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.status, 'generated');
  assert.ok(payload.fingerprint);
  const secondLog = JSON.parse(await readFile(path.join(tmp2, 'audio-candidates', 'resume-fixture', payload.fingerprint, 'request-log.json'), 'utf8'));
  const skipped = secondLog.entries.filter((entry) => entry.action === 'resume-skip');
  assert.ok(skipped.length >= 2, 'restored checkout must not resend the first two parts');

  const validate = await runCliAsync(['--mode=validate-candidate', `--article=resume-fixture`, `--fingerprint=${payload.fingerprint}`], { cwd: tmp2, env });
  assert.equal(validate.status, EXIT_OK, validate.stderr + validate.stdout);
  assert.equal(mock.filesStarts(), 1);
  assert.equal(mock.filesFinalizes(), 1);
  assert.equal(mock.filesDeletes(), 1);
  assert.equal(new Set(mock.uris()).size, 1, 'both ASR models must reuse one Files URI');

  const candidateDir = path.join(tmp2, 'audio-candidates', 'resume-fixture', payload.fingerprint);
  const fullSha = sha256(await readFile(path.join(candidateDir, 'full.mp3')));
  const publishBare = await runCliAsync(['--mode=publish-approved', `--article=resume-fixture`, `--fingerprint=${payload.fingerprint}`], { cwd: tmp2, env });
  assert.equal(publishBare.status, EXIT_USAGE, `publish without listening must fail usage: ${publishBare.stderr}`);

  const listeningPath = path.join(candidateDir, 'reports', 'human-listening.json');
  await writeFile(listeningPath, `${JSON.stringify({
    status: 'passed',
    reviewedBy: 'integration-reviewer',
    reviewedAt: '2026-08-29T00:00:00.000Z',
    evidence: { sha256: fullSha, candidateFingerprint: payload.fingerprint },
  }, null, 2)}\n`);

  const flipTargets = [
    path.join(candidateDir, 'full.mp3'),
    path.join(candidateDir, 'reports', `asr-${INDEPENDENT_ASR_MODELS[0]}.json`),
    path.join(candidateDir, 'reports', 'technical-qa.json'),
    path.join(candidateDir, 'manifest.json'),
  ];
  const partFile = (await readdir(path.join(candidateDir, 'parts'))).find((name) => name.endsWith('.mp3'));
  flipTargets.unshift(path.join(candidateDir, 'parts', partFile));
  for (const file of flipTargets) {
    const original = await readFile(file);
    const mutated = Buffer.from(original);
    mutated[Math.min(20, mutated.length - 1)] ^= 0x01;
    await writeFile(file, mutated);
    const flipped = await runCliAsync(['--mode=publish-approved', `--article=resume-fixture`, `--fingerprint=${payload.fingerprint}`, `--listening=${listeningPath}`], { cwd: tmp2, env });
    assert.equal(flipped.status, EXIT_HARD, `byte flip of ${path.basename(file)} must fail publish: ${flipped.stderr}`);
    await writeFile(file, original);
  }

  spawnSync('git', ['init'], { cwd: tmp2, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'bareeq-audio'], { cwd: tmp2, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'audio@bareeq.local'], { cwd: tmp2, encoding: 'utf8' });
  spawnSync('git', ['add', '-A'], { cwd: tmp2, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'fixture'], { cwd: tmp2, encoding: 'utf8' });

  const liveDir = liveAudioDir('resume-fixture', tmp2);
  await mkdir(liveDir, { recursive: true });
  await writeFile(path.join(liveDir, 'hamed.mp3'), Buffer.from('LIVE-HAMED-KEEP'));
  await writeFile(path.join(liveDir, 'manifest.json'), `${JSON.stringify({
    articleId: 'resume-fixture',
    defaultVoice: 'hamed',
    fingerprint: 'ab'.repeat(32),
    candidateFingerprint: 'ab'.repeat(32),
    parts: [{ audio: { hamed: { src: `/audio/articles/${audioKeyFor('resume-fixture')}/hamed.mp3`, durationSeconds: 1 } }, sync: [] }],
    voices: [{ id: 'hamed' }],
  }, null, 2)}\n`);

  const article = await loadSpokenArticle('resume-fixture', tmp2);
  const post = await loadPublicationPost('resume-fixture', tmp2);
  const record = await loadPublishRecord({
    candidateDir,
    listeningPath,
    fingerprint: payload.fingerprint,
    fullSha256: fullSha,
    article,
  });
  let rolled = false;
  try {
    await publishApprovedCandidate({
      articleId: 'resume-fixture',
      fingerprint: payload.fingerprint,
      root: tmp2,
      post,
      record,
      listening: record.humanListening,
      persistGit: false,
      afterManifestWrite: async () => {
        throw new Error('injected manifest failure');
      },
    });
  } catch (error) {
    rolled = true;
    assert.match(error.message, /injected manifest failure/);
  }
  assert.equal(rolled, true);
  const restored = JSON.parse(await readFile(path.join(liveDir, 'manifest.json'), 'utf8'));
  assert.equal(restored.defaultVoice, 'hamed');
  assert.equal(await readFile(path.join(liveDir, 'hamed.mp3'), 'utf8'), 'LIVE-HAMED-KEEP');

  const publishEnv = {
    ...env,
    BAREEQ_AUDIO_PUBLISH_GIT: '1',
    BAREEQ_AUDIO_ARTICLE: 'resume-fixture',
    BAREEQ_AUDIO_FINGERPRINT: payload.fingerprint,
    BAREEQ_AUDIO_LISTENING: listeningPath,
  };
  const workflowCmd = await runCliAsync([
    '--mode=publish-approved',
    '--article=resume-fixture',
    `--fingerprint=${payload.fingerprint}`,
    `--listening=${listeningPath}`,
  ], { cwd: tmp2, env: publishEnv });
  assert.equal(workflowCmd.status, EXIT_OK, `positive publish failed: ${workflowCmd.stderr}\n${workflowCmd.stdout}`);
  const published = JSON.parse(workflowCmd.stdout);
  assert.equal(published.status, 'published');
  const liveManifest = JSON.parse(await readFile(path.join(published.liveDir, 'manifest.json'), 'utf8'));
  assert.equal(liveManifest.defaultVoice, 'sadaltager');
  assert.equal(liveManifest.candidateFingerprint, payload.fingerprint);
  assert.equal(await readFile(path.join(liveDir, 'hamed.mp3'), 'utf8'), 'LIVE-HAMED-KEEP');

  const verifyLive = await runCliAsync(['--mode=verify-live', '--article=resume-fixture'], { cwd: tmp2, env });
  assert.equal(verifyLive.status, EXIT_OK, `verify-live failed: ${verifyLive.stderr}\\n${verifyLive.stdout}`);
  const verifyPayload = JSON.parse(verifyLive.stdout);
  assert.equal(verifyPayload.status, 'live-snapshot-unverified');
  assert.equal(await readFile(path.join(liveDir, 'hamed.mp3'), 'utf8'), 'LIVE-HAMED-KEEP');
  assert.equal(liveManifest.defaultVoice, 'sadaltager');

  assert.ok(mock.ttsAttempts() >= 3);
} finally {
  mock.server.close();
  await rm(tmp, { recursive: true, force: true });
  await rm(tmp2, { recursive: true, force: true });
}

console.log('Audio production integration tests passed: CLI two-checkout 429 resume, dual ASR one URI, listening required, positive publish, byte-flip, rollback. Zero real provider calls.');