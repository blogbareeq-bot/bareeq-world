import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const articleId = 'how-touchscreens-work';
const [scriptRaw, metadataRaw] = await Promise.all([
  readFile(path.join(ROOT, 'scripts', 'speech-scripts', `${articleId}.json`), 'utf8'),
  readFile(path.join(ROOT, 'scripts', 'speech-test-evidence', `${articleId}-gemini-pilot-v1.json`), 'utf8'),
]);
const script = JSON.parse(scriptRaw);
const metadata = JSON.parse(metadataRaw);
const segments = new Map(script.segments.map((segment) => [segment.segmentId, segment]));
const expected = metadata.selectedSegmentIds.map((segmentId) => segments.get(segmentId)?.spokenText).join('\n\n');
assert.ok(expected.length > 100);
const corrupted = expected.replace(/\S+/u, (firstWord) => `كلمةخاطئة${firstWord.length}`);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function createMock(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
      requests.push({ url: request.url || '/', raw, body });
      handler(request, response, body, raw, (error) => {
        if (error) {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end(error.stack || error.message);
          return;
        }
      });
    });
  });
  return { server, requests };
}

function assertNoReferenceLeak(raw, body) {
  const decoded = raw.toString('utf8');
  assert.equal(decoded.includes(expected.slice(0, 24)), false, 'The expected article transcript leaked into an ASR request.');
  if (body?.input?.[0]?.text) {
    assert.equal(body.input[0].text.includes('بِبَسَاطَة'), false, 'The focus word leaked into the ASR prompt.');
  }
}

async function runVerifier(env) {
  const child = spawn(process.execPath, ['scripts/verify-gemini-pilot-transcript-fallback.mjs', '--no-write'], {
    cwd: ROOT,
    env: {
      ...process.env,
      BAREEQ_ASR_CONTRACT_TEST: '1',
      BAREEQ_ASR_DISABLE_CHUNKING: '1',
      BAREEQ_ASR_MIN_INTERVAL_MS: '0',
      BAREEQ_ASR_MAX_RETRIES: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

// Scenario A: azure-stt serves pass 1 and gemini serves pass 2; both exact; no leakage.
{
  const azure = createMock((request, response, body, raw, fail) => {
    try {
      assert.match(request.url || '', /language=ar-EG/u);
      assertNoReferenceLeak(raw, null);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ RecognitionStatus: 'Success', DisplayText: expected }));
    } catch (error) { fail(error); }
  });
  const gemini = createMock((request, response, body, raw, fail) => {
    try {
      assert.equal(body?.input?.[1]?.type, 'audio');
      assert.equal(body?.input?.[1]?.mime_type, 'audio/mp3');
      assert.ok(body.input[1].data.length > 1000);
      assert.ok(['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'].includes(body.model));
      assertNoReferenceLeak(raw, body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ transcript: expected }) }] }],
      }));
    } catch (error) { fail(error); }
  });
  const azurePort = await listen(azure.server);
  const geminiPort = await listen(gemini.server);
  const result = await runVerifier({
    GEMINI_API_KEY: 'contract-test-key',
    AZURE_SPEECH_KEY: 'contract-test-key',
    BAREEQ_ASR_PROVIDERS: 'azure-stt,gemini',
    AZURE_STT_ENDPOINT: `http://127.0.0.1:${azurePort}/speech/recognition/conversation/cognitiveservices/v1`,
    GEMINI_ASR_ENDPOINT: `http://127.0.0.1:${geminiPort}/v1beta/interactions`,
  });
  await new Promise((resolve) => azure.server.close(resolve));
  await new Promise((resolve) => gemini.server.close(resolve));
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(azure.requests.length, 1);
  assert.equal(gemini.requests.length, 1);
  assert.match(result.stdout, /0 substitutions, 0 deletions, 0 insertions/u);
  console.log('Scenario A passed: azure-stt + gemini dual-provider verification, audio-only requests, zero word errors.');
}

// Scenario B: a single corrupted word must fail the whole gate with a non-zero exit.
{
  const azure = createMock((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ RecognitionStatus: 'Success', DisplayText: corrupted }));
  });
  const azurePort = await listen(azure.server);
  const result = await runVerifier({
    AZURE_SPEECH_KEY: 'contract-test-key',
    BAREEQ_ASR_PROVIDERS: 'azure-stt',
    AZURE_STT_ENDPOINT: `http://127.0.0.1:${azurePort}/speech/recognition/conversation/cognitiveservices/v1`,
  });
  await new Promise((resolve) => azure.server.close(resolve));
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /word error\(s\)/u);
  console.log('Scenario B passed: a single substituted word is rejected by the zero-error gate.');
}

// Scenario C: gemini-only passes must advance past an exhausted free-tier quota bucket to the next model.
{
  const gemini = createMock((request, response, body, raw, fail) => {
    try {
      assertNoReferenceLeak(raw, body);
      if (body?.model === 'gemini-3.7-flash') {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        response.end(JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric generate_content_free_tier_requests, limit: 20' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ transcript: expected }) }] }],
      }));
    } catch (error) { fail(error); }
  });
  const geminiPort = await listen(gemini.server);
  const result = await runVerifier({
    GEMINI_API_KEY: 'contract-test-key',
    BAREEQ_ASR_PROVIDERS: 'gemini',
    GEMINI_ASR_ENDPOINT: `http://127.0.0.1:${geminiPort}/v1beta/interactions`,
  });
  await new Promise((resolve) => gemini.server.close(resolve));
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.ok(gemini.requests.some((entry) => entry.body?.model === 'gemini-3.7-flash'));
  assert.ok(gemini.requests.some((entry) => entry.body?.model === 'gemini-3.6-flash'));
  assert.match(result.stdout + result.stderr, /quota is exhausted; advancing/u);
  assert.match(result.stdout, /0 substitutions, 0 deletions, 0 insertions/u);
  console.log('Scenario C passed: gemini quota exhaustion advances to the next independent model bucket and still verifies.');
}

console.log('Gemini pilot fallback transcript contract passed: dual-provider chain, audio-only ASR requests, quota failover, and an unbypassable zero-error comparison.');
