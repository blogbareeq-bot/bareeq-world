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

const requests = [];
const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      assert.equal(body.model, 'gemini-3.7-flash');
      assert.equal(body.input?.[1]?.type, 'audio');
      assert.equal(body.input?.[1]?.mime_type, 'audio/mp3');
      assert.ok(body.input[1].data.length > 1000);
      assert.equal(body.input[0].text.includes(expected.slice(0, 24)), false, 'The expected article transcript leaked into the ASR prompt.');
      assert.equal(body.input[0].text.includes('بِبَسَاطَة'), false, 'The focus word leaked into the ASR prompt.');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ transcript: expected }) }] }],
      }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error.stack || error.message);
    }
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();

const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/verify-gemini-pilot-transcript-chunked.mjs', '--no-write'], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_API_KEY: 'contract-test-key',
      BAREEQ_ASR_CONTRACT_TEST: '1',
      BAREEQ_ASR_DISABLE_CHUNKING: '1',
      GEMINI_ASR_ENDPOINT: `http://127.0.0.1:${address.port}/v1beta/interactions`,
      BAREEQ_ASR_MIN_INTERVAL_MS: '0',
      BAREEQ_ASR_MAX_RETRIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
});
await new Promise((resolve) => server.close(resolve));

assert.equal(result.code, 0, result.stderr || result.stdout);
assert.equal(requests.length, 2);
assert.match(result.stdout, /2 independent ASR pass\(es\)/);
assert.match(result.stdout, /0 substitutions, 0 deletions, 0 insertions/);
console.log('Gemini chunked audio transcript contract passed: two audio-only ASR requests, exact comparison, and no expected-text leakage.');
