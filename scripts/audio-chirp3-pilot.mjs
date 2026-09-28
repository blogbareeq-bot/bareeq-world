import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudTtsEndpoint, extractCloudTtsMp3, getCloudTtsAccessToken, hasCloudTtsCredentials } from './cloud-tts.mjs';

const ROOT = process.cwd();
export const PILOT_ENGINE = Object.freeze({
  provider: 'google-cloud-text-to-speech',
  model: 'Chirp3-HD',
  languageCode: 'ar-XA',
  voice: 'ar-XA-Chirp3-HD-Sadaltager',
  audioEncoding: 'MP3',
});
export const DEFAULT_SAMPLES = path.join(ROOT, 'docs', 'audio', 'CHIRP-PILOT-SAMPLES.json');
export const DEFAULT_OUTPUT = path.join(ROOT, 'chirp-pilot-artifacts');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const utf8Bytes = (value) => Buffer.byteLength(String(value ?? ''), 'utf8');

export function pilotFingerprint(sample, engine = PILOT_ENGINE) {
  return sha256(JSON.stringify({
    schema: 'bareeq.audio-chirp3-pilot-fingerprint.v1',
    engine,
    sampleId: sample.sampleId,
    articleId: sample.articleId,
    sourceSegmentId: sample.sourceSegmentId,
    text: sample.text,
  }));
}

export function buildChirpRequest({ accessToken, projectId, text, env = process.env }) {
  const project = String(projectId || '').trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error('GOOGLE_CLOUD_PROJECT must be a valid Google Cloud project ID.');
  if (!String(accessToken || '').trim()) throw new Error('A Google Cloud OAuth access token is required.');
  const textBytes = utf8Bytes(text);
  if (!textBytes || textBytes > 5000) throw new Error(`Chirp pilot sample text must be 1..5000 UTF-8 bytes; received ${textBytes}.`);
  return {
    url: `${cloudTtsEndpoint(env, false)}/v1/text:synthesize`,
    options: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-goog-user-project': project,
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        'User-Agent': 'Bareeq-Chirp3-Sadaltager-Pilot',
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: PILOT_ENGINE.languageCode,
          name: PILOT_ENGINE.voice,
        },
        audioConfig: {
          audioEncoding: PILOT_ENGINE.audioEncoding,
        },
      }),
    },
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
    throw new Error(`${sample.sampleId}: sample text is stale and no longer matches the approved spokenText.`);
  }
  return {
    speechScriptHash: speech.scriptHash || null,
    sourceSnapshotHash: speech.sourceSnapshotHash || null,
    sourceSegmentHash: segment.sourceHash || null,
  };
}

async function synthesizeSample({ sample, bindings, accessToken, projectId, outputRoot, fetchImpl = fetch }) {
  const fingerprint = pilotFingerprint(sample);
  const request = buildChirpRequest({ accessToken, projectId, text: sample.text });
  const response = await fetchImpl(request.url, request.options);
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const detail = String(payload?.error?.message || payload?.error || `HTTP ${response.status}`).slice(0, 600);
    throw new Error(`${sample.sampleId}: Chirp request failed: ${detail}`);
  }
  const mp3 = extractCloudTtsMp3(payload);
  await mkdir(outputRoot, { recursive: true });
  const audioPath = path.join(outputRoot, `${sample.sampleId}.mp3`);
  const reportPath = path.join(outputRoot, `${sample.sampleId}.json`);
  await writeFile(audioPath, mp3);
  const report = {
    schema: 'bareeq.audio-chirp3-pilot-sample.v1',
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
    textUtf8Bytes: utf8Bytes(sample.text),
    audioBytes: mp3.length,
    audioSha256: sha256(mp3),
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
  if (!Array.isArray(config.samples) || config.samples.length !== 3) throw new Error('Chirp pilot requires exactly three locked samples.');
  if (config.engine?.voice !== PILOT_ENGINE.voice || config.engine?.languageCode !== PILOT_ENGINE.languageCode) {
    throw new Error('Chirp pilot sample config engine identity does not match the locked runner identity.');
  }
  const prepared = [];
  for (const sample of config.samples) {
    const bindings = await assertSampleStillBound(sample);
    prepared.push({ sample, bindings, fingerprint: pilotFingerprint(sample) });
  }

  if (!live) {
    return {
      schema: 'bareeq.audio-chirp3-pilot-plan.v1',
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

  if (env.BAREEQ_CHIRP_PILOT_ACTIVATE !== '1') {
    throw new Error('Live Chirp pilot is locked. Set BAREEQ_CHIRP_PILOT_ACTIVATE=1 only after Billing, Text-to-Speech API, IAM and project credentials are verified.');
  }
  if (!hasCloudTtsCredentials(env)) throw new Error('Live Chirp pilot requires GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CLOUD_ACCESS_TOKEN.');
  const projectId = String(env.GOOGLE_CLOUD_PROJECT || '').trim();
  if (!projectId) throw new Error('Live Chirp pilot requires GOOGLE_CLOUD_PROJECT.');
  const accessToken = await getCloudTtsAccessToken(env, fetchImpl);
  const reports = [];
  for (const { sample, bindings } of prepared) {
    reports.push(await synthesizeSample({ sample, bindings, accessToken, projectId, outputRoot, fetchImpl }));
  }
  const index = {
    schema: 'bareeq.audio-chirp3-pilot-run.v1',
    status: 'generated-awaiting-dual-asr-and-splice-review',
    engine: PILOT_ENGINE,
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
  const result = await runPilot({ live });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  await cli();
}
