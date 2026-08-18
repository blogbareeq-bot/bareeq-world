import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const AUDIO_ONLY = process.argv.includes('--audio-only');
const pcm = Buffer.alloc(Math.round(24000 * 2 * 0.85));
const calls = [];
const contractKey = 'bareeq-gemini-local-contract-key-never-publish';

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1beta/interactions') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      if (request.headers['x-goog-api-key'] !== contractKey) throw new Error('Gemini x-goog-api-key header is incorrect.');
      if (request.headers['api-revision'] !== '2026-05-20') throw new Error('Gemini REST schema revision header is missing or incorrect.');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== 'gemini-3.1-flash-tts-preview') throw new Error(`Unexpected model ${body.model}`);
      if (body.response_format?.type !== 'audio') throw new Error('Gemini audio response contract is missing.');
      const speech = body.generation_config?.speech_config;
      if (!Array.isArray(speech) || speech.length !== 1 || speech[0]?.voice !== 'Sadaltager') throw new Error('Sadaltager single-speaker contract is incorrect.');
      if (typeof body.input !== 'string' || !body.input.includes('### TRANSCRIPT') || !body.input.includes('normal conversational volume') || !body.input.includes('never a whisper') || !/[\u0600-\u06ff]/.test(body.input)) throw new Error('Bareeq Arabic performance prompt/transcript is incomplete.');
      calls.push(body);
      const payload = JSON.stringify({
        id: `int_contract_${calls.length}`,
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
      });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      response.end(payload);
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error.message);
    }
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not bind the local Gemini contract server.');

let exitCode = 1;
const contractEnv = {
  ...process.env,
  BAREEQ_TTS_PROVIDER: 'gemini',
  GEMINI_API_KEY: contractKey,
  BAREEQ_TTS_CONTRACT_TEST: '1',
  GEMINI_TTS_ENDPOINT: `http://127.0.0.1:${address.port}/v1beta/interactions`,
  GEMINI_TTS_MIN_INTERVAL_MS: '0',
};
const runChild = (command, args, env = contractEnv) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', env });
  child.once('error', reject);
  child.once('close', (code) => resolve(code ?? 1));
});
const plan = execFileSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: contractEnv,
  maxBuffer: 4 * 1024 * 1024,
});
const expectedCalls = Number(plan.match(/(\d+) synthesis request\(s\)/)?.[1] || 0);
if (!expectedCalls) throw new Error('Could not resolve the Gemini contract request count from the generation plan.');

try {
  await rm(path.join(ROOT, 'public', 'audio'), { recursive: true, force: true });
  if (AUDIO_ONLY) {
    exitCode = await runChild(process.execPath, ['scripts/import-bundled-azure-audio.mjs']);
    if (exitCode === 0) exitCode = await runChild(process.execPath, ['scripts/import-studio-audio.mjs']);
    if (exitCode === 0) exitCode = await runChild(process.execPath, ['scripts/generate-audio.mjs']);
    if (exitCode === 0) exitCode = await runChild(process.execPath, ['scripts/check-audio-dist.mjs'], { ...contractEnv, BAREEQ_AUDIO_AUDIT_PUBLIC: '1' });
  } else {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    exitCode = await runChild(npm, ['run', 'build']);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(path.join(ROOT, 'public', 'audio'), { recursive: true, force: true });
  execFileSync(process.execPath, ['scripts/import-bundled-azure-audio.mjs'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/import-studio-audio.mjs'], { cwd: ROOT, stdio: 'inherit' });
}
if (exitCode !== 0) process.exit(exitCode);
if (calls.length !== expectedCalls) throw new Error(`Expected ${expectedCalls} authenticated Gemini requests, received ${calls.length}.`);

console.log(AUDIO_ONLY
  ? `Offline Gemini full-rollout contract passed: ${calls.length} authenticated Sadaltager requests across all published articles, steps/model_output parsing, PCM-to-MP3 encoding, synchronization, integrity, and secret-leakage audits.`
  : `Offline Gemini full-rollout production contract passed: ${calls.length} authenticated Sadaltager requests with the post-May-2026 steps schema followed by the complete production build and audits.`);
