/**
 * Generic Gemini Sadaltager pilot clip generator (queue pipeline, stage 1).
 *
 * ARTICLE_ID (env, required) selects the article. The six-segment listening plan
 * in scripts/speech-test-clips/<id>.json must be `ready` and match the current
 * speech script hash. One single guarded TTS request produces the pilot; the
 * MP3 plus metadata are written under scripts/speech-test-evidence/.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { buildGeminiPrompt } from './speech-prompt.mjs';

let ffmpegInstaller = null;
try { ffmpegInstaller = (await import('@ffmpeg-installer/ffmpeg')).default; }
catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const ROOT = process.cwd();
const API_KEY = process.env.GEMINI_API_KEY?.trim();
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const MODEL = process.env.BAREEQ_PILOT_TTS_MODEL?.trim() || 'gemini-3.1-flash-tts-preview';
const VOICE = process.env.BAREEQ_PILOT_TTS_VOICE?.trim() || 'Sadaltager';
const ARTICLE_ID = process.env.ARTICLE_ID?.trim();
const MAX_RETRIES = Number(process.env.BAREEQ_PILOT_MAX_RETRIES ?? '4');
const FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || ffmpegInstaller?.path || 'ffmpeg';
if (!ARTICLE_ID) throw new Error('ARTICLE_ID is required.');
if (!API_KEY) throw new Error('GEMINI_API_KEY is required; no Gemini request was sent.');

const BASENAME = `${ARTICLE_ID}-gemini-pilot-queue-v1`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractAudio(payload) {
  const stepContent = Array.isArray(payload?.steps) ? payload.steps.flatMap((step) => Array.isArray(step?.content) ? step.content : []) : [];
  const legacyContent = Array.isArray(payload?.outputs) ? payload.outputs.flatMap((output) => Array.isArray(output?.content) ? output.content : [output]) : [];
  return [...stepContent, ...legacyContent].find((block) => block?.type === 'audio' && typeof block?.data === 'string') || payload?.output_audio || payload?.outputAudio || null;
}

async function requestGemini(body, attempt = 0) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'x-goog-api-key': API_KEY, 'Api-Revision': API_REVISION, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Bareeq-Article-Pilot/1.0' },
    body: JSON.stringify(body),
  });
  if (response.ok) return response;
  const responseBody = await response.text().catch(() => '');
  if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
    const retryAfter = Number.parseFloat(response.headers.get('retry-after') || '');
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter * 1000) : Math.min(60000, 5000 * (2 ** attempt));
    console.warn(`Gemini pilot HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms.`);
    await sleep(delay);
    return requestGemini(body, attempt + 1);
  }
  throw new Error(`Gemini pilot failed (${response.status}): ${responseBody.slice(0, 500)}`);
}

function encodePcmToMp3(pcm) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0', '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let settled = false;
    const fail = (error) => { if (settled) return; settled = true; reject(error); };
    child.once('error', (error) => fail(new Error(`ffmpeg could not encode pilot PCM: ${error.message}`)));
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') fail(error); });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) { fail(new Error(`ffmpeg failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 700)}`)); return; }
      const mp3 = Buffer.concat(stdout);
      if (mp3.length < 2000) { fail(new Error(`ffmpeg returned an unexpectedly small pilot MP3 (${mp3.length} bytes).`)); return; }
      settled = true; resolve(mp3);
    });
    child.stdin.end(pcm);
  });
}

const speechScript = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'speech-scripts', `${ARTICLE_ID}.json`), 'utf8'));
const plan = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'speech-test-clips', `${ARTICLE_ID}.json`), 'utf8'));
const selectedSegmentIds = (plan?.selectedSegments || []).map((item) => item.segmentId);
if (plan?.status !== 'ready' || plan?.speechScriptHash !== speechScript.scriptHash || selectedSegmentIds.length < 5 || selectedSegmentIds.length > 6) {
  throw new Error('Pilot requires the current ready five-to-six-segment listening plan bound to the current speech script hash.');
}
if (plan.testClipPassed || plan.fullSynthesisAllowed) throw new Error('Pilot generation is only valid before the listening gate is opened.');
const records = new Map((speechScript.segments || []).map((item) => [item.segmentId, item]));
const selectedSegments = selectedSegmentIds.map((segmentId) => {
  const selected = records.get(segmentId);
  if (!selected?.spokenText) throw new Error(`Approved pilot segment is missing: ${segmentId}`);
  return selected;
});
const transcript = selectedSegments.map((item) => item.spokenText).join('\n\n');
const prompt = buildGeminiPrompt({ text: transcript }, { articleTitle: speechScript.articleId });
if (Buffer.byteLength(prompt, 'utf8') > 6500) throw new Error('Pilot prompt exceeds the guarded request size.');

const response = await requestGemini({ model: MODEL, input: prompt, response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: VOICE }] }, store: false });
let payload;
try { payload = await response.json(); } catch (error) { throw new Error(`Gemini returned invalid JSON: ${error.message}`); }
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
if (!(durationSeconds >= 5 && durationSeconds <= 180)) throw new Error(`Implausible pilot duration: ${durationSeconds.toFixed(3)}s.`);

const outputDirectory = path.join(ROOT, 'scripts', 'speech-test-evidence');
const audioFile = path.join(outputDirectory, `${BASENAME}.mp3`);
const metadataFile = path.join(outputDirectory, `${BASENAME}.json`);
await mkdir(outputDirectory, { recursive: true });
await rm(`${audioFile}.tmp`, { force: true }); await rm(`${metadataFile}.tmp`, { force: true });
await writeFile(`${audioFile}.tmp`, mp3);
await writeFile(`${metadataFile}.tmp`, `${JSON.stringify({
  schema: 'bareeq.gemini-article-pilot.v1',
  sampleMode: 'six-segment-pilot',
  articleId: ARTICLE_ID,
  selectedSegmentIds,
  speechScriptHash: speechScript.scriptHash,
  planHash: plan?.planHash ?? null,
  transcriptHash: sha256(transcript),
  promptHash: sha256(prompt),
  provider: 'Google Gemini API',
  model: MODEL,
  voice: VOICE,
  language: 'ar',
  outputFormat: 'audio-48khz-96kbitrate-mono-mp3',
  sourceAudioFormat: 'pcm-s16le-24000hz-mono',
  bytes: mp3.length,
  durationSeconds,
  sha256: sha256(mp3),
  generatedAt: new Date().toISOString(),
  listeningReview: 'pending',
}, null, 2)}\n`);
const { rename } = await import('node:fs/promises');
await rename(`${audioFile}.tmp`, audioFile);
await rename(`${metadataFile}.tmp`, metadataFile);
console.log(`PILOT_WRITTEN=${audioFile}`);
console.log(`PILOT_SHA256=${sha256(mp3)} duration=${durationSeconds.toFixed(3)}s`);
