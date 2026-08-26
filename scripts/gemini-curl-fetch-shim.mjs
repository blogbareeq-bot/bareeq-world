import { spawn } from 'node:child_process';

const nativeFetch = globalThis.fetch.bind(globalThis);
const INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_SECONDS = Number(process.env.BAREEQ_GEMINI_CURL_MAX_SECONDS || '480');
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

if (!Number.isFinite(MAX_SECONDS) || MAX_SECONDS < 60) throw new Error('BAREEQ_GEMINI_CURL_MAX_SECONDS must be at least 60 seconds.');

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return input?.url || String(input);
}

function runCurl(url, init) {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers || {});
    const args = [
      '--silent',
      '--show-error',
      '--location',
      '--connect-timeout', '30',
      '--max-time', String(MAX_SECONDS),
      '--request', String(init.method || 'POST'),
      '--header', `x-goog-api-key: ${headers.get('x-goog-api-key') || ''}`,
      '--header', `Content-Type: ${headers.get('content-type') || 'application/json'}`,
      '--header', `Accept: ${headers.get('accept') || 'application/json'}`,
      '--header', `User-Agent: ${headers.get('user-agent') || 'Bareeq-Audio-Transcript-Gate/1.0'}`,
      '--data-binary', '@-',
      '--write-out', '\n__BAREEQ_HTTP_STATUS__:%{http_code}',
      url,
    ];

    const child = spawn('curl', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) return fail(new Error('Gemini curl response exceeded the guarded output limit.'));
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
    });

    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`Gemini curl transport failed (exit=${code}${signal ? `, signal=${signal}` : ''}): ${err.slice(0, 700)}`));
        return;
      }
      const marker = '\n__BAREEQ_HTTP_STATUS__:';
      const markerIndex = out.lastIndexOf(marker);
      if (markerIndex < 0) {
        reject(new Error('Gemini curl response did not contain an HTTP status marker.'));
        return;
      }
      const body = out.slice(0, markerIndex);
      const status = Number.parseInt(out.slice(markerIndex + marker.length).trim(), 10);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        reject(new Error('Gemini curl response contained an invalid HTTP status marker.'));
        return;
      }
      resolve(new Response(body, {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }));
    });

    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') fail(error);
    });
    child.stdin.end(String(init.body || ''));
  });
}

globalThis.fetch = async function bareeqCurlBackedFetch(input, init = {}) {
  const url = requestUrl(input);
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url !== INTERACTIONS_ENDPOINT || method !== 'POST') return nativeFetch(input, init);
  return runCurl(url, init);
};
