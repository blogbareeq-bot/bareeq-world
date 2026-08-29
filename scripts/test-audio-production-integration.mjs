import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, cp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EXIT_CONFIG, EXIT_HARD, EXIT_OK, EXIT_QUOTA, EXIT_USAGE } from './audio-constants.mjs';
import { loadSpokenArticle } from './audio-split.mjs';

const ROOT = process.cwd();

function sinePcm(seconds = 0.2, sampleRate = 24000, freq = 440) {
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
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/upload/v1beta/files') {
        await readBody(req);
        res.setHeader('X-Goog-Upload-URL', `http://127.0.0.1:${server.address().port}/upload/session/1`);
        res.end('{}');
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/upload/session/')) {
        await readBody(req);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ file: { uri: 'files/abc', name: 'files/abc', mimeType: 'audio/mpeg' } }));
        return;
      }
      if (req.method === 'DELETE') {
        res.statusCode = 200;
        res.end('{}');
        return;
      }
      if (req.method === 'POST' && req.url.includes('/interactions')) {
        const raw = await readBody(req);
        const payload = JSON.parse(raw.toString('utf8') || '{}');
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
            steps: [{
              type: 'audio',
              content: [{ type: 'audio', data: pcm.toString('base64'), mime_type: 'audio/l16', sample_rate: 24000, channels: 1 }],
            }],
          }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ model: payload.model, output_text: spoken }));
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
        url: `http://127.0.0.1:${port}`,
      });
    });
  });
}

async function writeFixture(dir) {
  const posts = path.join(dir, 'src', 'content', 'posts');
  await mkdir(posts, { recursive: true });
  await writeFile(path.join(posts, 'resume-fixture.md'), `---
title: "اختبار الاستئناف"
draft: false
---
هذه فقرة أولى مخصصة لتقسيم الأجزاء أثناء الاختبار.

هذه فقرة ثانية مخصصة لتقسيم الأجزاء أثناء الاختبار.
`);
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'audio-production.mjs'), ...args], {
    cwd: cwd || ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runCliAsync(args, { cwd, env = {}, timeoutMs = 25000 } = {}) {
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
await writeFixture(tmp);
const fixtureArticle = await loadSpokenArticle('resume-fixture', tmp);
const mock = await startMockServer({ failTtsAt: 2, spoken: fixtureArticle.spokenText });
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
  if (first.status !== EXIT_QUOTA) {
    throw new Error(`generate status ${first.status} stdout=${first.stdout} stderr=${first.stderr}`);
  }
  assert.match(first.stderr + first.stdout, /429|quota|paused/i);
  const candidates = path.join(tmp, 'audio-candidates', 'resume-fixture');
  const names = (await (await import('node:fs/promises')).readdir(candidates)).filter((name) => name.length > 8);
  assert.ok(names.length >= 1);
  const fingerprint = names[0];

  await writeFixture(tmp2);
  await cp(path.join(tmp, 'audio-candidates'), path.join(tmp2, 'audio-candidates'), { recursive: true });
  const second = await runCliAsync(['--mode=generate-candidate', '--article=resume-fixture'], { cwd: tmp2, env });
  assert.equal(second.status, EXIT_OK, second.stderr + second.stdout);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.status, 'generated');
  assert.ok(payload.fingerprint);

  const validate = await runCliAsync(['--mode=validate-candidate', `--article=resume-fixture`, `--fingerprint=${payload.fingerprint}`], { cwd: tmp2, env });
  assert.equal(validate.status, EXIT_OK, validate.stderr + validate.stdout);

  const publish = await runCliAsync(['--mode=publish-approved', `--article=resume-fixture`, `--fingerprint=${payload.fingerprint}`], { cwd: tmp2, env });
  assert.equal(publish.status, EXIT_HARD, `publish without listening must fail: ${publish.stderr}`);
  assert.ok(mock.ttsAttempts() >= 2);
} finally {
  mock.server.close();
  await rm(tmp, { recursive: true, force: true });
  await rm(tmp2, { recursive: true, force: true });
}

console.log('Audio production integration tests passed: CLI four modes, lock, required fingerprint, mock TTS 429 resume across checkouts, validate, publish refused without listen. Zero real provider calls.');
