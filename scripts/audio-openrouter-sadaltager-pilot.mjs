import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
export const OPENROUTER_TTS_ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';
export const OPENROUTER_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';
export const PILOT_ENGINE = Object.freeze({
  provider: 'openrouter',
  model: 'google/gemini-3.1-flash-tts-preview',
  voice: 'Sadaltager',
  responseFormat: 'mp3',
});
export const DEFAULT_SAMPLES = path.join(ROOT, 'docs', 'audio', 'OPENROUTER-SADALTAGER-PILOT-SAMPLES.json');
export const DEFAULT_OUTPUT = path.join(ROOT, 'openrouter-sadaltager-pilot-artifacts');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const utf8Bytes = (value) => Buffer.byteLength(String(value ?? ''), 'utf8');

export function pilotFingerprint(sample, engine = PILOT_ENGINE) {
  return sha256(JSON.stringify({
    schema: 'bareeq.audio-openrouter-sadaltager-pilot-fingerprint.v1',
    engine,
    sampleId: sample.sampleId,
    articleId: sample.articleId,
    sourceSegmentId: sample.sourceSegmentId,
    text: sample.text,
  }));
}

export function buildOpenRouterRequest({ apiKey, text }) {
  if (!String(apiKey || '').trim()) throw new Error('OPENROUTER_API_KEY is required.');
  const bytes = utf8Bytes(text);
  if (!bytes || bytes > 12000) throw new Error(`OpenRouter pilot sample text must be 1..12000 UTF-8 bytes; received ${bytes}.`);
  return {
    url: OPENROUTER_TTS_ENDPOINT,
    options: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg,application/octet-stream',
        'HTTP-Referer': 'https://bareeqworld.com',
        'X-Title': 'Bareeq Sadaltager Audio Pilot',
      },
      body: JSON.stringify({
        model: PILOT_ENGINE.model,
        input: text,
        voice: PILOT_ENGINE.voice,
        response_format: PILOT_ENGINE.responseFormat,
      }),
    },
  };
}

export async function probeOpenRouterKey({ apiKey, fetchImpl = fetch } = {}) {
  if (!String(apiKey || '').trim()) {
    return { status: 'missing', authorized: false, note: 'OPENROUTER_API_KEY is not configured.' };
  }
  const response = await fetchImpl(OPENROUTER_KEY_ENDPOINT, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    return {
      status: 'unavailable',
      authorized: false,
      httpStatus: response.status,
      note: String(payload?.error?.message || payload?.error || `HTTP ${response.status}`).slice(0, 300),
    };
  }
  const data = payload?.data || {};
  return {
    status: 'authorized',
    authorized: true,
    isFreeTier: data.is_free_tier ?? null,
    keyLimit: data.limit ?? null,
    keyLimitRemaining: data.limit_remaining ?? null,
    keyLimitReset: data.limit_reset ?? null,
    usage: data.usage ?? null,
    usageDaily: data.usage_daily ?? null,
    note: 'This probe validates the key and key-level limit only. It does not guarantee account credits; a live TTS request can still return HTTP 402 if the shared credit pool is insufficient.',
  };
}

async function loadJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function assertSampleStillBound(sample) {
  const speechPath = path.join(ROOT, 'scripts', 'speech-scripts', `${sample.articleId}.json`);
  const speech = await loadJson(speechPath);
  const segment = (speech.segments || []).find((item) => item.segmentId === sample.sourceSegmentId);
  if (!segment) throw new Error(`${sample.sampleId}: source segment ${sample.sourceSegmentId} no longer exists.`);
  if (String(segment.spokenText || '').trim() !== String(sample.text || '').trim()) {
    throw new Error(`${sample.sampleId}: sample text is stale and no longer matches approved spokenText.`);
  }
  return {
    speechScriptHash: speech.scriptHash || null,
    sourceSnapshotHash: speech.sourceSnapshotHash || null,
    sourceSegmentHash: segment.sourceHash || null,
  };
}

async function synthesizeSample({ sample, bindings, apiKey, outputRoot, fetchImpl = fetch }) {
  const fingerprint = pilotFingerprint(sample);
  const request = buildOpenRouterRequest({ apiKey, text: sample.text });
  const response = await fetchImpl(request.url, request.options);
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { detail = ''; }
    const error = new Error(`${sample.sampleId}: OpenRouter TTS failed HTTP ${response.status}: ${detail.slice(0, 500)}`);
    error.httpStatus = response.status;
    throw error;
  }
  if (contentType.includes('application/json')) {
    let detail = '';
    try { detail = await response.text(); } catch { detail = ''; }
    throw new Error(`${sample.sampleId}: OpenRouter returned JSON instead of audio: ${detail.slice(0, 400)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const mp3Header = bytes.subarray(0, 3).toString('ascii') === 'ID3'
    || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (bytes.length < 100 || !mp3Header) throw new Error(`${sample.sampleId}: OpenRouter returned invalid MP3 data (${bytes.length} bytes).`);

  await mkdir(outputRoot, { recursive: true });
  const audioPath = path.join(outputRoot, `${sample.sampleId}.mp3`);
  const reportPath = path.join(outputRoot, `${sample.sampleId}.json`);
  await writeFile(audioPath, bytes);
  const report = {
    schema: 'bareeq.audio-openrouter-sadaltager-pilot-sample.v1',
    status: 'generated-not-validated-not-publishable',
    sampleId: sample.sampleId,
    articleId: sample.articleId,
    articleTitle: sample.articleTitle,
    type: sample.type,
    baselineErrors: Number(sample.baselineErrors),
    sourceSegmentId: sample.sourceSegmentId,
    engine: PILOT_ENGINE,
    fingerprint,
    bindings,
    generationId: response.headers?.get?.('x-generation-id') || null,
    textUtf8Bytes: utf8Bytes(sample.text),
    audioBytes: bytes.length,
    audioSha256: sha256(bytes),
    outputFile: path.relative(ROOT, audioPath),
    productionAudioTouched: false,
    publicationAllowed: false,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function runPilot({ live = false, samplesPath = DEFAULT_SAMPLES, outputRoot = DEFAULT_OUTPUT, env = process.env, fetchImpl = fetch } = {}) {
  const config = await loadJson(samplesPath);
  if (!Array.isArray(config.samples) || config.samples.length !== 3) throw new Error('OpenRouter Sadaltager pilot requires exactly three locked samples.');
  if (config.engine?.model !== PILOT_ENGINE.model || config.engine?.voice !== PILOT_ENGINE.voice || config.engine?.provider !== PILOT_ENGINE.provider) {
    throw new Error('OpenRouter pilot sample config engine identity does not match the locked runner identity.');
  }
  const prepared = [];
  for (const sample of config.samples) {
    const bindings = await assertSampleStillBound(sample);
    prepared.push({ sample, bindings, fingerprint: pilotFingerprint(sample) });
  }

  if (!live) {
    return {
      schema: 'bareeq.audio-openrouter-sadaltager-pilot-plan.v1',
      mode: 'dry-run',
      engine: PILOT_ENGINE,
      samples: prepared.map(({ sample, bindings, fingerprint }) => ({
        sampleId: sample.sampleId,
        articleId: sample.articleId,
        baselineErrors: sample.baselineErrors,
        sourceSegmentId: sample.sourceSegmentId,
        textUtf8Bytes: utf8Bytes(sample.text),
        fingerprint,
        bindings,
      })),
      providerRequests: 0,
      productionAudioTouched: false,
      publicationAllowed: false,
    };
  }

  if (env.BAREEQ_OPENROUTER_TTS_PILOT_ACTIVATE !== '1') {
    throw new Error('Live OpenRouter pilot is locked. Set BAREEQ_OPENROUTER_TTS_PILOT_ACTIVATE=1 only for the isolated three-sample pilot.');
  }
  const apiKey = String(env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) throw new Error('Live OpenRouter pilot requires OPENROUTER_API_KEY.');
  const keyProbe = await probeOpenRouterKey({ apiKey, fetchImpl });
  if (!keyProbe.authorized) throw new Error(`OpenRouter key preflight failed: ${keyProbe.note || keyProbe.status}`);

  const reports = [];
  for (const { sample, bindings } of prepared) {
    reports.push(await synthesizeSample({ sample, bindings, apiKey, outputRoot, fetchImpl }));
  }
  const index = {
    schema: 'bareeq.audio-openrouter-sadaltager-pilot-run.v1',
    status: 'generated-awaiting-dual-asr-review',
    engine: PILOT_ENGINE,
    keyProbe,
    providerRequests: reports.length,
    productionAudioTouched: false,
    publicationAllowed: false,
    reports,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(outputRoot, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

async function cli() {
  const live = process.argv.includes('--live');
  const probeOnly = process.argv.includes('--probe-key');
  if (probeOnly) {
    const result = await probeOpenRouterKey({ apiKey: process.env.OPENROUTER_API_KEY });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.authorized) process.exitCode = 78;
    return;
  }
  const result = await runPilot({ live });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await cli();
