import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAzureSsml } from './azure-speech-ssml.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import {
  loadPublishedArticleModels,
  readAmbiguityRules,
  readSpeechScript,
  readTestClipPlan,
  validateSpeechScript,
} from './speech-script-core.mjs';

const ROOT = process.cwd();
const ARTICLE_ID = process.argv.find((argument) => argument.startsWith('--article='))?.slice('--article='.length)
  || process.env.BAREEQ_TTS_INCLUDE_IDS?.trim();
const API_KEY = process.env.AZURE_SPEECH_KEY?.trim();
const REGION = process.env.AZURE_SPEECH_REGION?.trim().toLowerCase() || 'eastus';
const RESOURCE_ENDPOINT = process.env.AZURE_SPEECH_ENDPOINT?.trim().replace(/\/$/u, '') || `https://${REGION}.api.cognitive.microsoft.com`;
const TTS_BASE = process.env.AZURE_SPEECH_TTS_BASE?.trim().replace(/\/$/u, '') || `https://${REGION}.tts.speech.microsoft.com`;
const VOICE = 'ar-KW-FahedNeural';
const LANGUAGE = 'ar-KW';
const RATE = process.env.AZURE_SPEECH_SYNTHESIS_RATE?.trim() || '-2%';
const OUTPUT_FORMAT = 'audio-48khz-96kbitrate-mono-mp3';
const MAX_RETRIES = Number(process.env.BAREEQ_TTS_MAX_RETRIES || '5');
const USER_AGENT = 'Bareeq-Fahed-Test-Clip/4.22.0';

if (!ARTICLE_ID || ARTICLE_ID.includes(',')) throw new Error('Pass exactly one published article with --article=<article-id>.');
if (!API_KEY) throw new Error('AZURE_SPEECH_KEY is required; no provider request was sent.');
if (!Number.isInteger(MAX_RETRIES) || MAX_RETRIES < 0 || MAX_RETRIES > 10) throw new Error('BAREEQ_TTS_MAX_RETRIES must be an integer from 0 to 10.');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function azureUrls() {
  let resource;
  let tts;
  try {
    resource = new URL(RESOURCE_ENDPOINT);
    tts = new URL(TTS_BASE);
  } catch { throw new Error('Azure Speech endpoints must be valid HTTPS URLs.'); }
  const resourceHost = resource.hostname.toLowerCase();
  const ttsHost = tts.hostname.toLowerCase();
  const officialResource = resource.protocol === 'https:' && (resourceHost.endsWith('.api.cognitive.microsoft.com') || resourceHost.endsWith('.cognitiveservices.azure.com'));
  const officialTts = tts.protocol === 'https:' && ttsHost.endsWith('.tts.speech.microsoft.com');
  if (!officialResource || !officialTts) throw new Error('Azure Speech credentials may only be sent to official microsoft.com or azure.com Speech endpoints.');
  if (resourceHost.endsWith('.cognitiveservices.azure.com')) {
    return {
      voices: `${RESOURCE_ENDPOINT}/tts/cognitiveservices/voices/list`,
      synthesize: `${RESOURCE_ENDPOINT}/cognitiveservices/v1`,
    };
  }
  return {
    voices: `${TTS_BASE}/cognitiveservices/voices/list`,
    synthesize: `${TTS_BASE}/cognitiveservices/v1`,
  };
}

async function providerRequest(url, options, label, attempt = 0) {
  const response = await fetch(url, options);
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
    const retryAfter = Number.parseFloat(response.headers.get('retry-after') || '');
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter * 1000) : Math.min(30000, 2000 * (2 ** attempt));
    console.warn(`${label} HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms.`);
    await sleep(delay);
    return providerRequest(url, options, label, attempt + 1);
  }
  throw new Error(`${label} failed (${response.status}): ${body.slice(0, 500)}`);
}

const models = await loadPublishedArticleModels(ROOT);
const model = models.find((candidate) => candidate.articleId === ARTICLE_ID);
if (!model) throw new Error(`Unknown or draft article: ${ARTICLE_ID}`);
const rules = await readAmbiguityRules(ROOT);
const script = await readSpeechScript(ARTICLE_ID, ROOT);
const plan = await readTestClipPlan(ARTICLE_ID, ROOT);
const validation = validateSpeechScript(model, script, rules, { requireReviews: true });
if (!validation.approved) throw new Error(`${ARTICLE_ID}: Speech Script is not approved; no provider request was sent.`);
if (!plan || plan.speechScriptHash !== script.scriptHash || plan.status !== 'ready') throw new Error(`${ARTICLE_ID}: test clip plan is missing, stale, or not ready; no provider request was sent.`);

const records = new Map(script.segments.map((segment) => [segment.segmentId, segment]));
const items = plan.selectedSegments.map(({ segmentId }) => {
  const record = records.get(segmentId);
  if (!record) throw new Error(`${ARTICLE_ID}: selected test segment is missing: ${segmentId}`);
  return { type: record.type, text: record.spokenText, segmentId };
});
if (!items.length) throw new Error(`${ARTICLE_ID}: test clip plan selects no segments.`);

const ssml = buildAzureSsml({ language: LANGUAGE, voice: VOICE, rate: RATE, items });
if (Buffer.byteLength(ssml, 'utf8') >= 64000) throw new Error(`${ARTICLE_ID}: test clip SSML exceeds Azure's 64 KB limit.`);
const urls = azureUrls();
const authHeaders = { 'Ocp-Apim-Subscription-Key': API_KEY, 'User-Agent': USER_AGENT };
const voicesResponse = await providerRequest(urls.voices, { headers: authHeaders }, 'Azure voice discovery');
const voices = await voicesResponse.json();
if (!Array.isArray(voices) || !voices.some((voice) => voice?.ShortName === VOICE && voice?.Locale === LANGUAGE)) throw new Error(`${VOICE} is unavailable in Azure region ${REGION}.`);

const audioResponse = await providerRequest(urls.synthesize, {
  method: 'POST',
  headers: {
    ...authHeaders,
    'Content-Type': 'application/ssml+xml; charset=utf-8',
    'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
    Accept: 'audio/mpeg',
  },
  body: ssml,
}, 'Azure Fahed test synthesis');
const audio = Buffer.from(await audioResponse.arrayBuffer());
if (audio.length < 100 || !['ID3', '\u00ff\u00fb', '\u00ff\u00f3', '\u00ff\u00f2'].some((signature) => audio.subarray(0, signature.length).toString('latin1') === signature)) {
  throw new Error(`${ARTICLE_ID}: Azure returned an invalid or unexpectedly small MP3 (${audio.length} bytes).`);
}
const durationSeconds = mp3DurationSeconds(audio);
if (!(durationSeconds >= 10 && durationSeconds <= 600)) throw new Error(`${ARTICLE_ID}: implausible test clip duration ${durationSeconds.toFixed(3)}s.`);

const outputDirectory = path.join(ROOT, 'scripts', 'speech-test-evidence');
const basename = `${ARTICLE_ID}-fahed-v1`;
const audioFile = path.join(outputDirectory, `${basename}.mp3`);
const metadataFile = path.join(outputDirectory, `${basename}.json`);
const temporaryAudio = `${audioFile}.tmp-${process.pid}`;
const temporaryMetadata = `${metadataFile}.tmp-${process.pid}`;
await mkdir(outputDirectory, { recursive: true });
await rm(temporaryAudio, { force: true });
await rm(temporaryMetadata, { force: true });
await writeFile(temporaryAudio, audio);
await writeFile(temporaryMetadata, `${JSON.stringify({
  schema: 'bareeq.fahed-test-clip.v1',
  articleId: ARTICLE_ID,
  speechScriptHash: script.scriptHash,
  planHash: plan.planHash,
  provider: 'Microsoft Azure AI Speech',
  model: 'Neural TTS',
  voice: VOICE,
  language: LANGUAGE,
  region: REGION,
  synthesisRate: RATE,
  outputFormat: OUTPUT_FORMAT,
  selectedSegmentIds: items.map((item) => item.segmentId),
  bytes: audio.length,
  durationSeconds: Number(durationSeconds.toFixed(3)),
  sha256: sha256(audio),
  generatedAt: new Date().toISOString(),
  listeningReview: 'pending',
}, null, 2)}\n`, 'utf8');
await rename(temporaryAudio, audioFile);
await rename(temporaryMetadata, metadataFile);
console.log(`Fahed test clip generated and verified for ${ARTICLE_ID}: ${audio.length.toLocaleString('en-US')} bytes, ${durationSeconds.toFixed(2)}s, ${items.length} approved segment(s). Listening review is still pending.`);
