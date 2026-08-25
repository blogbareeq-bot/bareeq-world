import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const AUDIO_ONLY = process.argv.includes('--audio-only');
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bareeq-openai-contract-'));
const fixture = path.join(tempDir, 'speech.mp3');
const ffmpeg = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
  '-t', '0.85', '-c:a', 'libmp3lame', '-b:a', '64k', '-map_metadata', '-1', '-y', fixture,
], { stdio: 'inherit' });
if (ffmpeg.status !== 0) throw new Error('ffmpeg is required for the offline production-audio contract fixture.');
const mp3 = await readFile(fixture);
const calls = [];
const contractKey = 'bareeq-local-contract-key-never-publish';

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/audio/speech') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      if (request.headers.authorization !== `Bearer ${contractKey}`) throw new Error('OpenAI Authorization header is incorrect.');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== 'gpt-4o-mini-tts-2025-12-15') throw new Error(`Unexpected model ${body.model}`);
      if (!['cedar', 'marin'].includes(body.voice)) throw new Error(`Unexpected voice ${body.voice}`);
      if (body.response_format !== 'mp3' || body.speed !== 1) throw new Error('OpenAI MP3/speed contract is incorrect.');
      if (typeof body.input !== 'string' || body.input.length < 2 || typeof body.instructions !== 'string' || !body.instructions.includes('العربية الفصحى')) throw new Error('Arabic input/style instructions are missing.');
      calls.push(body);
      response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length });
      response.end(mp3);
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
if (!address || typeof address === 'string') throw new Error('Could not bind the local OpenAI contract server.');

let exitCode = 1;
const contractEnv = {
  ...process.env,
  BAREEQ_TTS_PROVIDER: 'openai',
  OPENAI_API_KEY: contractKey,
  BAREEQ_TTS_CONTRACT_TEST: '1',
  BAREEQ_SPEECH_GATE_UNSAFE_TEST_BYPASS: 'I_ACKNOWLEDGE_LOCAL_CONTRACT_ONLY',
  OPENAI_TTS_ENDPOINT: `http://127.0.0.1:${address.port}/v1/audio/speech`,
  OPENAI_TTS_MIN_INTERVAL_MS: '0',
};
const runChild = (command, args, env = contractEnv) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', env });
  child.once('error', reject);
  child.once('close', (code) => resolve(code ?? 1));
});
try {
  await rm(path.join(ROOT, 'public', 'audio'), { recursive: true, force: true });
  if (AUDIO_ONLY) {
    exitCode = await runChild(process.execPath, ['scripts/import-bundled-azure-audio.mjs']);
    if (exitCode === 0) exitCode = await runChild(process.execPath, ['scripts/import-studio-audio.mjs']);
    if (exitCode === 0) exitCode = await runChild(process.execPath, ['scripts/generate-audio.mjs']);
    if (exitCode === 0) exitCode = await runChild(process.execPath, ['scripts/check-audio-dist.mjs'], { ...contractEnv, BAREEQ_AUDIO_AUDIT_PUBLIC: '1' });
  } else {
    if (process.env.BAREEQ_TEST_DIRECT_BUILD === '1' && process.platform !== 'win32') {
      const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
      exitCode = await runChild('sh', ['-c', pkg.scripts.build], {
        ...contractEnv,
        PATH: `${path.join(ROOT, 'node_modules', '.bin')}:${process.env.PATH || ''}`,
      });
    } else {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      exitCode = await runChild(npm, ['run', 'build']);
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
  if (AUDIO_ONLY) {
    await rm(path.join(ROOT, 'public', 'audio'), { recursive: true, force: true });
    execFileSync(process.execPath, ['scripts/import-bundled-azure-audio.mjs'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync(process.execPath, ['scripts/import-studio-audio.mjs'], { cwd: ROOT, stdio: 'inherit' });
  }
}
if (exitCode !== 0) process.exit(exitCode);

const cedar = calls.filter((call) => call.voice === 'cedar').length;
const marin = calls.filter((call) => call.voice === 'marin').length;
if (calls.length !== 72 || cedar !== 36 || marin !== 36) throw new Error(`Expected 72 OpenAI calls for the ten non-imported articles (36 Cedar + 36 Marin), received ${calls.length} (${cedar} + ${marin}).`);
console.log(AUDIO_ONLY
  ? `Offline OpenAI audio contract passed: one verified real Studio Cedar release plus ${calls.length} authenticated mock requests for the remaining articles (${cedar} Cedar + ${marin} Marin), with all public-stage MP3, duration, synchronization, and leakage audits.`
  : `Offline OpenAI production contract passed: one verified real Studio Cedar release plus ${calls.length} authenticated mock requests for the remaining articles (${cedar} Cedar + ${marin} Marin), followed by the complete release build and audits.`);
