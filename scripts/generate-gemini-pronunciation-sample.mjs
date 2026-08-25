import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';

let ffmpegInstaller = null;
try { ffmpegInstaller = (await import('@ffmpeg-installer/ffmpeg')).default; }
catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const ROOT = process.cwd();
const API_KEY = process.env.GEMINI_API_KEY?.trim();
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const MODEL = 'gemini-3.1-flash-tts-preview';
const VOICE = 'Sadaltager';
const ARTICLE_ID = 'how-touchscreens-work';
const SEGMENT_ID = 'quote-7b1d6e9dad57';
const PILOT_MODE = process.argv.includes('--pilot');
const BASENAME = PILOT_MODE
  ? `${ARTICLE_ID}-gemini-pilot-v1`
  : `${ARTICLE_ID}-gemini-bibasaata-v1`;
const FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || ffmpegInstaller?.path || 'ffmpeg';
const MAX_RETRIES = 5;

if (!API_KEY) throw new Error('GEMINI_API_KEY is required; no Gemini request was sent.');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function extractAudio(payload) {
  const stepContent = Array.isArray(payload?.steps)
    ? payload.steps.flatMap((step) => Array.isArray(step?.content) ? step.content : [])
    : [];
  const legacyContent = Array.isArray(payload?.outputs)
    ? payload.outputs.flatMap((output) => Array.isArray(output?.content) ? output.content : [output])
    : [];
  return [...stepContent, ...legacyContent].find((block) => block?.type === 'audio' && typeof block?.data === 'string')
    || payload?.output_audio
    || payload?.outputAudio
    || null;
}

async function requestGemini(body, attempt = 0) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-goog-api-key': API_KEY,
      'Api-Revision': API_REVISION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Bareeq-Gemini-Pronunciation-Sample/1.0',
    },
    body: JSON.stringify(body),
  });
  if (response.ok) return response;
  const responseBody = await response.text().catch(() => '');
  if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
    const retryAfter = Number.parseFloat(response.headers.get('retry-after') || '');
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.ceil(retryAfter * 1000)
      : Math.min(30000, 2000 * (2 ** attempt));
    console.warn(`Gemini HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms.`);
    await sleep(delay);
    return requestGemini(body, attempt + 1);
  }
  throw new Error(`Gemini pronunciation sample failed (${response.status}): ${responseBody.slice(0, 500)}`);
}

function encodePcmToMp3(pcm) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
      '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once('error', (error) => fail(new Error(`ffmpeg could not encode Gemini PCM: ${error.message}`)));
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') fail(error); });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`ffmpeg failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 700)}`));
        return;
      }
      const mp3 = Buffer.concat(stdout);
      if (mp3.length < 2000) {
        fail(new Error(`ffmpeg returned an unexpectedly small MP3 (${mp3.length} bytes).`));
        return;
      }
      settled = true;
      resolve(mp3);
    });
    child.stdin.end(pcm);
  });
}

const scriptFile = path.join(ROOT, 'scripts', 'speech-scripts', `${ARTICLE_ID}.json`);
const planFile = path.join(ROOT, 'scripts', 'speech-test-clips', `${ARTICLE_ID}.json`);
const speechScript = JSON.parse(await readFile(scriptFile, 'utf8'));
const segment = speechScript.segments?.find((item) => item.segmentId === SEGMENT_ID);
if (!segment?.spokenText?.startsWith('بِبَسَاطَة')) throw new Error('Approved focus segment is missing or no longer begins with بِبَسَاطَة.');

const plan = PILOT_MODE ? JSON.parse(await readFile(planFile, 'utf8')) : null;
const records = new Map((speechScript.segments || []).map((item) => [item.segmentId, item]));
const selectedSegmentIds = PILOT_MODE
  ? (plan?.selectedSegments || []).map((item) => item.segmentId)
  : [SEGMENT_ID];
if (PILOT_MODE && (plan?.status !== 'ready' || plan?.speechScriptHash !== speechScript.scriptHash || selectedSegmentIds.length !== 6)) {
  throw new Error('Gemini pilot requires the current ready six-segment listening plan.');
}
const selectedSegments = selectedSegmentIds.map((segmentId) => {
  const selected = records.get(segmentId);
  if (!selected?.spokenText) throw new Error(`Approved pilot segment is missing: ${segmentId}`);
  return selected;
});
const transcript = selectedSegments.map((item) => item.spokenText).join('\n\n');
const prompt = `### TASK
Read only the Arabic text under TRANSCRIPT, exactly as written. Do not read these instructions, labels, or any commentary.

### AUDIO PROFILE
A mature, knowledgeable Arabic narrator for Bareeq. Natural Modern Standard Arabic, warm tone, clear articulation, comfortable medium pace, normal volume, and no newsreader or advertising delivery.

### CRITICAL PRONUNCIATION
When the transcript reaches بِبَسَاطَة, pronounce it completely as “bi-basaat-ah”, with the final light h sound clearly audible. Never truncate it to بِبَسَاط. Preserve every Arabic word and diacritic; add, omit, paraphrase, and reorder nothing.

### TRANSCRIPT
${transcript}`;

if (Buffer.byteLength(prompt, 'utf8') > 6000) throw new Error('Gemini pronunciation prompt exceeds the guarded request size.');

const response = await requestGemini({
  model: MODEL,
  input: prompt,
  response_format: { type: 'audio' },
  generation_config: { speech_config: [{ voice: VOICE }] },
  store: false,
});
let payload;
try { payload = await response.json(); }
catch (error) { throw new Error(`Gemini returned invalid JSON: ${error.message}`); }
const outputAudio = extractAudio(payload);
const encoded = typeof outputAudio?.data === 'string' ? outputAudio.data.replace(/\s+/gu, '') : '';
if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('Gemini response has no valid audio content.');
const mimeType = String(outputAudio?.mime_type || outputAudio?.mimeType || '').toLowerCase();
if (mimeType && !mimeType.includes('l16') && !mimeType.includes('pcm')) throw new Error(`Unsupported Gemini audio MIME type: ${mimeType}`);
const sampleRate = Number(outputAudio?.sample_rate || outputAudio?.sampleRate || 24000);
const channels = Number(outputAudio?.channels || 1);
if (sampleRate !== 24000 || channels !== 1) throw new Error(`Unsupported Gemini PCM layout: ${sampleRate} Hz, ${channels} channel(s).`);
const pcm = Buffer.from(encoded, 'base64');
if (pcm.length < 100 || pcm.length % 2 !== 0) throw new Error(`Invalid Gemini 16-bit PCM (${pcm.length} bytes).`);

const mp3 = await encodePcmToMp3(pcm);
const durationSeconds = mp3DurationSeconds(mp3);
if (!(durationSeconds >= 5 && durationSeconds <= 180)) throw new Error(`Implausible sample duration: ${durationSeconds.toFixed(3)}s.`);

const outputDirectory = path.join(ROOT, 'scripts', 'speech-test-evidence');
const audioFile = path.join(outputDirectory, `${BASENAME}.mp3`);
const metadataFile = path.join(outputDirectory, `${BASENAME}.json`);
const temporaryAudio = `${audioFile}.tmp-${process.pid}`;
const temporaryMetadata = `${metadataFile}.tmp-${process.pid}`;
await mkdir(outputDirectory, { recursive: true });
await rm(temporaryAudio, { force: true });
await rm(temporaryMetadata, { force: true });
await writeFile(temporaryAudio, mp3);
await writeFile(temporaryMetadata, `${JSON.stringify({
  schema: 'bareeq.gemini-pronunciation-sample.v1',
  sampleMode: PILOT_MODE ? 'six-segment-pilot' : 'focus-word',
  articleId: ARTICLE_ID,
  segmentId: PILOT_MODE ? undefined : SEGMENT_ID,
  selectedSegmentIds,
  speechScriptHash: speechScript.scriptHash,
  planHash: plan?.planHash,
  transcriptHash: sha256(transcript),
  promptHash: sha256(prompt),
  provider: 'Google Gemini API',
  model: MODEL,
  voice: VOICE,
  language: 'ar',
  focusWord: 'بِبَسَاطَة',
  rejectedReading: 'بِبَسَاط',
  outputFormat: 'audio-48khz-96kbitrate-mono-mp3',
  sourceAudioFormat: 'pcm-s16le-24000hz-mono',
  bytes: mp3.length,
  durationSeconds: Number(durationSeconds.toFixed(3)),
  sha256: sha256(mp3),
  generatedAt: new Date().toISOString(),
  listeningReview: 'pending',
}, null, 2)}\n`, 'utf8');
await rename(temporaryAudio, audioFile);
await rename(temporaryMetadata, metadataFile);
console.log(`Gemini ${PILOT_MODE ? 'six-segment pilot' : 'pronunciation'} sample generated: ${mp3.length.toLocaleString('en-US')} bytes, ${durationSeconds.toFixed(2)}s, ${VOICE}. Listening review is pending.`);
