import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PENDING_CLOUD } from './cloud-tts-rollout.mjs';

const ROOT = process.cwd();
const selected = [PENDING_CLOUD[0], PENDING_CLOUD[8]];
const contractKey = 'bareeq-gemini-v4211-local-contract-key-never-publish';
const pcm = Buffer.alloc(Math.round(24000 * 2 * 0.9));
let responseMode = 'success';
let calls = 0;

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  calls += 1;
  try {
    if (request.method !== 'POST' || request.url !== '/v1beta/interactions') throw new Error('Unexpected Gemini contract route.');
    if (request.headers['x-goog-api-key'] !== contractKey) throw new Error('Gemini contract key header is missing.');
    if (request.headers['api-revision'] !== '2026-05-20') throw new Error('Gemini API revision header is incorrect.');
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.model !== 'gemini-3.1-flash-tts-preview') throw new Error('Unexpected Gemini model.');
    if (body.response_format?.type !== 'audio') throw new Error('Gemini audio response format is missing.');
    if (body.generation_config?.speech_config?.[0]?.voice !== 'Sadaltager') throw new Error('Sadaltager was not selected.');
    if (typeof body.input !== 'string' || !body.input.includes('### TRANSCRIPT') || !/[\u0600-\u06ff]/.test(body.input)) throw new Error('Arabic transcript contract is incomplete.');

    if (responseMode === '429') {
      response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      response.end(JSON.stringify({ error: { code: 429, message: 'Free-tier quota exhausted for contract test.' } }));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      status: 'completed',
      steps: [{
        type: 'model_output',
        content: [{
          type: 'audio',
          data: pcm.toString('base64'),
          mime_type: 'audio/l16',
          sample_rate: 24000,
          channels: 1,
        }],
      }],
    }));
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error.message);
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not bind the local Gemini V4.21.1 contract server.');

const baseEnv = {
  ...process.env,
  BAREEQ_TTS_PROVIDER: 'gemini',
  BAREEQ_TTS_INCLUDE_IDS: selected.join(','),
  BAREEQ_TTS_CONTRACT_TEST: '1',
  BAREEQ_SPEECH_GATE_UNSAFE_TEST_BYPASS: 'I_ACKNOWLEDGE_LOCAL_CONTRACT_ONLY',
  BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD: '1',
  BAREEQ_TTS_MAX_RETRIES: '0',
  GEMINI_API_KEY: contractKey,
  GEMINI_TTS_ENDPOINT: `http://127.0.0.1:${address.port}/v1beta/interactions`,
  GEMINI_TTS_MIN_INTERVAL_MS: '0',
};

async function makeFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'bareeq-v4211-gemini-'));
  await mkdir(path.join(fixture, 'src', 'content'), { recursive: true });
  await mkdir(path.join(fixture, 'public'), { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(path.join(ROOT, 'scripts'), path.join(fixture, 'scripts'), linkType);
  await symlink(path.join(ROOT, 'src', 'content', 'posts'), path.join(fixture, 'src', 'content', 'posts'), linkType);
  await symlink(path.join(ROOT, 'node_modules'), path.join(fixture, 'node_modules'), linkType);
  return fixture;
}

function runCapture(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/generate-audio.mjs'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

const sha = (value) => createHash('sha256').update(value).digest('hex');
let successFixture;
let quotaFixture;

try {
  successFixture = await makeFixture();
  const plan = execFileSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
    cwd: successFixture,
    env: baseEnv,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const planned = [...plan.matchAll(/^- (.+?): (\d+) part\(s\)/gm)].map((match) => ({ id: match[1], parts: Number(match[2]) }));
  if (planned.length !== 2 || !planned[0]?.parts) throw new Error('Could not resolve the two-article Gemini contract plan.');
  const prioritized = [...planned].sort((left, right) => left.parts - right.parts || left.id.localeCompare(right.id, 'ar'))[0];

  responseMode = 'success';
  calls = 0;
  const success = await runCapture(successFixture, baseEnv);
  if (success.code !== 0) throw new Error(`One-article Gemini contract failed:\n${success.stdout}${success.stderr}`);
  if (calls !== prioritized.parts) throw new Error(`Expected ${prioritized.parts} requests for the shortest article, received ${calls}.`);
  if (!success.stdout.includes(`Progressive article priority: shortest unresolved transcript first (${prioritized.id}, ${prioritized.parts} part(s))`)) throw new Error('Shortest-first progressive priority was not reported.');
  if (!success.stdout.includes('Progressive article cap: selected 1 of 2 unresolved article(s)')) throw new Error('One-article progressive cap was not reported.');
  if (!success.stdout.includes('Gemini free-tier step complete: 1 Sadaltager article(s) completed atomically')) throw new Error('Atomic one-article completion was not reported.');

  const articleRoot = path.join(successFixture, 'public', 'audio', 'articles');
  const generatedDirs = await readdir(articleRoot);
  if (generatedDirs.length !== 1 || generatedDirs[0] !== sha(prioritized.id).slice(0, 16)) throw new Error('The free-tier step did not generate exactly the shortest unresolved article.');
  const manifest = JSON.parse(await readFile(path.join(articleRoot, generatedDirs[0], 'manifest.json'), 'utf8'));
  if (manifest.articleId !== prioritized.id || manifest.provider !== 'Google Gemini API' || manifest.defaultVoice !== 'sadaltager') throw new Error('Generated one-article manifest is invalid.');
  await access(path.join(successFixture, 'public', manifest.parts[0].audio.sadaltager.src.replace(/^\//, '')));

  quotaFixture = await makeFixture();
  responseMode = '429';
  calls = 0;
  const quota = await runCapture(quotaFixture, baseEnv);
  if (quota.code !== 0) throw new Error(`Persistent-429 contract must exit successfully:\n${quota.stdout}${quota.stderr}`);
  const quotaOutput = `${quota.stdout}\n${quota.stderr}`;
  if (!quotaOutput.includes('Gemini progressive rollout paused') || !quotaOutput.includes('persistent HTTP 429') || !quotaOutput.includes('Safe progressive fallback')) throw new Error('Persistent-429 safe fallback was not reported.');
  const quotaArticleRoot = path.join(quotaFixture, 'public', 'audio', 'articles');
  const quotaDirs = await readdir(quotaArticleRoot).catch(() => []);
  if (quotaDirs.length) throw new Error('A partial article directory survived the persistent-429 test.');
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (successFixture) await rm(successFixture, { recursive: true, force: true });
  if (quotaFixture) await rm(quotaFixture, { recursive: true, force: true });
}

console.log('V4.21.1 Gemini free-tier contract passed: shortest unresolved article first, exactly one article per build, authenticated Sadaltager PCM-to-MP3 generation, atomic publication, and persistent-429 fallback preservation. External API requests: 0.');
