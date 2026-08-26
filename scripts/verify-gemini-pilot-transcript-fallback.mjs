import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARABIC_TRANSCRIPT_COMPARISON_PROFILE, compareArabicTranscripts } from './arabic-transcript-match.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';

let ffmpegInstaller = null;
try { ffmpegInstaller = (await import('@ffmpeg-installer/ffmpeg')).default; }
catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const ROOT = process.cwd();
const ARTICLE_ID = 'how-touchscreens-work';
const BASENAME = `${ARTICLE_ID}-gemini-pilot-v1`;
const API_KEY = process.env.GEMINI_API_KEY?.trim();
const AZURE_API_KEY = process.env.AZURE_SPEECH_KEY?.trim();
const AZURE_REGION = process.env.AZURE_SPEECH_REGION?.trim().toLowerCase();
const AZURE_LOCALE = process.env.AZURE_STT_LOCALE?.trim() || 'ar-EG';
const GEMINI_MODEL_CHAIN = (process.env.GEMINI_ASR_MODELS?.trim() || 'gemini-3.7-flash,gemini-3.6-flash,gemini-2.5-flash')
  .split(',').map((value) => value.trim()).filter(Boolean);
const PROVIDER_CHAIN = (process.env.BAREEQ_ASR_PROVIDERS?.trim() || 'azure-stt,gemini')
  .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
const GEMINI_OFFICIAL_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const AZURE_OFFICIAL_ENDPOINT = `https://${AZURE_REGION || 'region'}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`;
const CONTRACT_TEST = process.env.BAREEQ_ASR_CONTRACT_TEST === '1';
const configuredGeminiEndpoint = process.env.GEMINI_ASR_ENDPOINT?.trim();
const configuredAzureEndpoint = process.env.AZURE_STT_ENDPOINT?.trim();
const GEMINI_ENDPOINT = configuredGeminiEndpoint || GEMINI_OFFICIAL_ENDPOINT;
const AZURE_ENDPOINT = configuredAzureEndpoint || AZURE_OFFICIAL_ENDPOINT;
const DISABLE_CHUNKING = process.env.BAREEQ_ASR_DISABLE_CHUNKING === '1';
const NO_WRITE = process.argv.includes('--no-write');
const MAX_RETRIES = Number(process.env.BAREEQ_ASR_MAX_RETRIES || '5');
const MIN_INTERVAL_MS = Number(process.env.BAREEQ_ASR_MIN_INTERVAL_MS || '4000');
const PASS_COUNT = 2;
const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;
const FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || ffmpegInstaller?.path || 'ffmpeg';
const SILENCE_DB = Number(process.env.BAREEQ_ASR_SILENCE_DB || '-36');
const SILENCE_MIN_SECONDS = Number(process.env.BAREEQ_ASR_SILENCE_MIN_SECONDS || '0.45');
const CHUNK_MIN_SECONDS = Number(process.env.BAREEQ_ASR_CHUNK_MIN_SECONDS || '7');
const CHUNK_IDEAL_SECONDS = Number(process.env.BAREEQ_ASR_CHUNK_IDEAL_SECONDS || '24');
const CHUNK_MAX_SECONDS = Number(process.env.BAREEQ_ASR_CHUNK_MAX_SECONDS || '32');
const CHUNK_HARD_MAX_SECONDS = Number(process.env.BAREEQ_ASR_CHUNK_HARD_MAX_SECONDS || '42');

if (!PROVIDER_CHAIN.length || PROVIDER_CHAIN.some((provider) => !['azure-stt', 'gemini'].includes(provider))) {
  throw new Error('BAREEQ_ASR_PROVIDERS must be a comma-separated subset of: azure-stt,gemini.');
}
if (!GEMINI_MODEL_CHAIN.length || GEMINI_MODEL_CHAIN.length !== new Set(GEMINI_MODEL_CHAIN).size) {
  throw new Error('GEMINI_ASR_MODELS must be a comma-separated list of unique Gemini model identifiers.');
}
if (configuredGeminiEndpoint) {
  if (!CONTRACT_TEST) throw new Error('GEMINI_ASR_ENDPOINT is restricted to BAREEQ_ASR_CONTRACT_TEST=1.');
  const endpoint = new URL(configuredGeminiEndpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) throw new Error('The Gemini ASR contract-test endpoint must be local HTTP.');
}
if (configuredAzureEndpoint) {
  if (!CONTRACT_TEST) throw new Error('AZURE_STT_ENDPOINT is restricted to BAREEQ_ASR_CONTRACT_TEST=1.');
  const endpoint = new URL(configuredAzureEndpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) throw new Error('The Azure STT contract-test endpoint must be local HTTP.');
}
if (PROVIDER_CHAIN.includes('azure-stt') && !configuredAzureEndpoint && !AZURE_REGION) throw new Error('AZURE_SPEECH_REGION is required for the Azure STT fallback.');
if (DISABLE_CHUNKING && !CONTRACT_TEST) throw new Error('BAREEQ_ASR_DISABLE_CHUNKING is restricted to contract tests.');
if (!Number.isInteger(MAX_RETRIES) || MAX_RETRIES < 0) throw new Error('BAREEQ_ASR_MAX_RETRIES must be zero or a positive integer.');
if (!Number.isFinite(MIN_INTERVAL_MS) || MIN_INTERVAL_MS < 0) throw new Error('BAREEQ_ASR_MIN_INTERVAL_MS must be zero or positive.');
for (const [name, value] of Object.entries({ SILENCE_MIN_SECONDS, CHUNK_MIN_SECONDS, CHUNK_IDEAL_SECONDS, CHUNK_MAX_SECONDS, CHUNK_HARD_MAX_SECONDS })) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
}
if (!(CHUNK_MIN_SECONDS < CHUNK_IDEAL_SECONDS && CHUNK_IDEAL_SECONDS < CHUNK_MAX_SECONDS && CHUNK_MAX_SECONDS < CHUNK_HARD_MAX_SECONDS)) {
  throw new Error('Chunk duration bounds must satisfy min < ideal < max < hard max.');
}
if (!CONTRACT_TEST) {
  if (PROVIDER_CHAIN.includes('gemini') && !API_KEY) throw new Error('GEMINI_API_KEY is required for the gemini ASR provider; no transcription request was sent.');
  if (PROVIDER_CHAIN.includes('azure-stt') && !AZURE_API_KEY) throw new Error('AZURE_SPEECH_KEY is required for the azure-stt ASR provider; no transcription request was sent.');
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let lastRequestStartedAt = 0;

const TRANSCRIPTION_PROMPTS = [
  `استمع إلى التسجيل المرفق وحوّل الكلام المسموع إلى نص عربي حرفي كامل.
- اكتب فقط الكلمات التي تسمعها وبالترتيب نفسه.
- لا تلخّص، ولا تعِد الصياغة، ولا تصحّح المتحدث، ولا تضف مقدمة أو تعليقًا.
- لا تعتمد على أي نص خارجي؛ التسجيل وحده هو المصدر.
- اكتب أسماء الحروف والاختصارات ككلمات عربية وفق ما تسمعه.
- لا حاجة إلى التشكيل أو علامات الترقيم.
أعد حقل transcript فقط وفق مخطط JSON المطلوب.`,
  `Produce a verbatim Arabic transcript of the attached audio, using the audio as the only source.
Write every audible word once and in its original order. Do not infer, summarize, repair, paraphrase, add commentary, or consult any reference text. Render spoken letter names and abbreviations as Arabic words exactly as heard. Diacritics and punctuation are optional. Return only the transcript field required by the JSON schema.`,
];

function extractText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (typeof payload?.outputText === 'string') return payload.outputText;
  const containers = [payload?.steps, payload?.outputs].filter(Array.isArray);
  const texts = [];
  for (const container of containers) {
    for (const item of container) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const block of content) if (block?.type === 'text' && typeof block?.text === 'string') texts.push(block.text);
    }
  }
  return texts.join('');
}

function retryDelay(attempt, response = null) {
  const retryAfter = Number.parseFloat(response?.headers?.get?.('retry-after') || '');
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter * 1000);
  return Math.min(30000, 2000 * (2 ** attempt));
}

async function paceRequests() {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestStartedAt));
  if (wait) await sleep(wait);
  lastRequestStartedAt = Date.now();
}

function isQuotaExhausted(status, responseBody) {
  return status === 429 && /quota[_ ]exceeded|resource[_ ]exhausted|free[_ ]tier/i.test(responseBody);
}

async function transcribeWithGemini(audio, prompt) {
  const failures = [];
  for (const model of GEMINI_MODEL_CHAIN) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      await paceRequests();
      let response;
      try {
        response = await fetch(GEMINI_ENDPOINT, {
          method: 'POST',
          headers: {
            'x-goog-api-key': API_KEY || 'contract-test-key',
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'Bareeq-Fallback-Audio-Transcript-Gate/1.0',
          },
          body: JSON.stringify({
            model,
            input: [
              { type: 'text', text: prompt },
              { type: 'audio', data: audio.toString('base64'), mime_type: 'audio/mp3' },
            ],
            response_format: {
              type: 'text',
              mime_type: 'application/json',
              schema: {
                type: 'object',
                properties: { transcript: { type: 'string' } },
                required: ['transcript'],
              },
            },
            store: false,
          }),
        });
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          const delay = retryDelay(attempt);
          console.warn(`Gemini ASR (${model}) transport error (${error?.cause?.code || error?.code || error?.message || 'unknown'}); retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms.`);
          await sleep(delay);
          continue;
        }
        failures.push(`${model}: transport ${error?.message}`);
        break;
      }
      if (!response.ok) {
        const responseBody = await response.text().catch(() => '');
        if (isQuotaExhausted(response.status, responseBody)) {
          console.warn(`Gemini ASR (${model}) free-tier quota is exhausted; advancing to the next independent quota bucket.`);
          failures.push(`${model}: 429 quota exhausted`);
          break;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
          const delay = retryDelay(attempt, response);
          console.warn(`Gemini ASR (${model}) HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms.`);
          await sleep(delay);
          continue;
        }
        failures.push(`${model}: HTTP ${response.status} ${responseBody.slice(0, 200)}`);
        break;
      }
      let payload;
      try { payload = await response.json(); }
      catch (error) { failures.push(`${model}: invalid JSON ${error.message}`); break; }
      const outputText = extractText(payload).trim();
      if (!outputText) { failures.push(`${model}: empty text output`); break; }
      let structured;
      try { structured = JSON.parse(outputText); }
      catch (error) { failures.push(`${model}: structured output was invalid JSON: ${outputText.slice(0, 160)}`); break; }
      if (typeof structured?.transcript !== 'string' || !structured.transcript.trim()) { failures.push(`${model}: structured output did not contain a non-empty transcript.`); break; }
      return { transcript: structured.transcript.trim(), provider: 'Google Gemini API', model };
    }
  }
  throw new Error(`Gemini ASR failed across the model chain (${GEMINI_MODEL_CHAIN.join(' -> ')}). ${failures.join(' | ')}`);
}

async function transcribeWithAzure(wavAudio) {
  const url = new URL(AZURE_ENDPOINT);
  url.searchParams.set('language', AZURE_LOCALE);
  url.searchParams.set('format', 'simple');
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await paceRequests();
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': AZURE_API_KEY || 'contract-test-key',
          'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
          Accept: 'application/json',
          'User-Agent': 'Bareeq-Fallback-Audio-Transcript-Gate/1.0',
        },
        body: wavAudio,
      });
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        const delay = retryDelay(attempt);
        console.warn(`Azure STT transport error (${error?.cause?.code || error?.code || error?.message || 'unknown'}); retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms.`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Azure STT transport failed after ${MAX_RETRIES + 1} attempt(s): ${error?.message}`);
    }
    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const delay = retryDelay(attempt, response);
        console.warn(`Azure STT HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms.`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Azure STT failed (${response.status}): ${responseBody.slice(0, 700)}`);
    }
    let payload;
    try { payload = await response.json(); }
    catch (error) { throw new Error(`Azure STT returned invalid JSON: ${error.message}`); }
    if (payload?.RecognitionStatus && payload.RecognitionStatus !== 'Success') {
      if (payload.RecognitionStatus === 'Error' && attempt < MAX_RETRIES) {
        const delay = retryDelay(attempt);
        console.warn(`Azure STT returned transient Error; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms.`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Azure STT recognition status was ${payload.RecognitionStatus}.`);
    }
    const transcript = String(payload?.DisplayText || '').trim();
    if (!transcript) throw new Error('Azure STT returned an empty DisplayText for a non-silent chunk.');
    return { transcript, provider: 'Microsoft Azure Speech', model: `conversation-rest-v1 (${AZURE_LOCALE})` };
  }
  throw new Error('Azure STT exhausted its retry budget.');
}

function runFfmpeg(args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => { if (captureStdout) stdout.push(chunk); });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => reject(new Error(`ffmpeg could not start: ${error.message}`)));
    child.once('close', (code) => {
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(`ffmpeg failed (${code}): ${err.slice(-1400)}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: err });
    });
  });
}

async function detectSilenceMidpoints(audioFile, durationSeconds) {
  const { stderr } = await runFfmpeg([
    '-i', audioFile,
    '-af', `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN_SECONDS}`,
    '-f', 'null', '-'
  ]);
  const lines = stderr.split(/\r?\n/u);
  const intervals = [];
  let start = null;
  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/u);
    if (startMatch) start = Number(startMatch[1]);
    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/u);
    if (endMatch) {
      const end = Number(endMatch[1]);
      const measuredDuration = Number(endMatch[2]);
      const resolvedStart = start ?? Math.max(0, end - measuredDuration);
      if (Number.isFinite(resolvedStart) && Number.isFinite(end) && end > resolvedStart && resolvedStart > 0.15 && end < durationSeconds - 0.15) {
        intervals.push({ start: resolvedStart, end, duration: end - resolvedStart, midpoint: (resolvedStart + end) / 2 });
      }
      start = null;
    }
  }
  return intervals;
}

function chooseChunkBoundaries(durationSeconds, silences) {
  if (durationSeconds <= CHUNK_MAX_SECONDS) return [0, durationSeconds];
  const candidates = silences.map((item) => item.midpoint).sort((a, b) => a - b);
  const boundaries = [0];
  let cursor = 0;

  while (durationSeconds - cursor > CHUNK_MAX_SECONDS) {
    const preferred = candidates.filter((point) => point >= cursor + CHUNK_MIN_SECONDS && point <= cursor + CHUNK_MAX_SECONDS);
    let split = null;
    if (preferred.length) {
      split = preferred.reduce((best, point) => Math.abs(point - (cursor + CHUNK_IDEAL_SECONDS)) < Math.abs(best - (cursor + CHUNK_IDEAL_SECONDS)) ? point : best, preferred[0]);
    } else {
      const extended = candidates.filter((point) => point >= cursor + CHUNK_MIN_SECONDS && point <= cursor + CHUNK_HARD_MAX_SECONDS);
      if (extended.length) split = extended[0];
    }
    if (split == null || split <= cursor + 0.5) {
      throw new Error(`No safe silence boundary was found between ${cursor.toFixed(2)}s and ${Math.min(durationSeconds, cursor + CHUNK_HARD_MAX_SECONDS).toFixed(2)}s. Refusing to cut through speech.`);
    }
    boundaries.push(split);
    cursor = split;
  }
  boundaries.push(durationSeconds);
  return boundaries;
}

async function renderChunk(audioFile, startSeconds, endSeconds, wav = false) {
  const { stdout } = await runFfmpeg([
    '-loglevel', 'error',
    '-ss', startSeconds.toFixed(3),
    '-to', endSeconds.toFixed(3),
    '-i', audioFile,
    '-map_metadata', '-1',
    '-vn', '-ac', '1',
    ...(wav ? ['-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav'] : ['-ar', '48000', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3']),
    'pipe:1'
  ], { captureStdout: true });
  if (stdout.length < 1000) throw new Error(`Rendered ASR chunk is unexpectedly small (${stdout.length} bytes).`);
  return stdout;
}

const scriptFile = path.join(ROOT, 'scripts', 'speech-scripts', `${ARTICLE_ID}.json`);
const planFile = path.join(ROOT, 'scripts', 'speech-test-clips', `${ARTICLE_ID}.json`);
const metadataFile = path.join(ROOT, 'scripts', 'speech-test-evidence', `${BASENAME}.json`);
const relativeAudioFile = path.posix.join('scripts', 'speech-test-evidence', `${BASENAME}.mp3`);
const audioFile = path.join(ROOT, relativeAudioFile);
const [scriptRaw, planRaw, metadataRaw, audio] = await Promise.all([
  readFile(scriptFile, 'utf8'),
  readFile(planFile, 'utf8'),
  readFile(metadataFile, 'utf8'),
  readFile(audioFile),
]);
const script = JSON.parse(scriptRaw);
const plan = JSON.parse(planRaw);
const metadata = JSON.parse(metadataRaw);

if (metadata.schema !== 'bareeq.gemini-pronunciation-sample.v1' || metadata.sampleMode !== 'six-segment-pilot' || metadata.articleId !== ARTICLE_ID) throw new Error('Gemini pilot metadata identity mismatch.');
if (metadata.model !== 'gemini-3.1-flash-tts-preview' || metadata.voice !== 'Sadaltager' || metadata.language !== 'ar') throw new Error('Gemini pilot synthesis contract mismatch.');
if (metadata.speechScriptHash !== script.scriptHash || metadata.planHash !== plan.planHash || plan.speechScriptHash !== script.scriptHash) throw new Error('Gemini pilot targets a stale Speech Script or test plan.');
const plannedSegmentIds = (plan.selectedSegments || []).map((segment) => segment.segmentId);
if (JSON.stringify(metadata.selectedSegmentIds) !== JSON.stringify(plannedSegmentIds)) throw new Error('Gemini pilot segment selection does not match the immutable listening plan.');
if (audio.length > MAX_INLINE_AUDIO_BYTES) throw new Error(`${relativeAudioFile} is too large for guarded verification.`);
const measuredDurationSeconds = mp3DurationSeconds(audio);
if (metadata.bytes !== audio.length || metadata.sha256 !== sha256(audio) || Math.abs(metadata.durationSeconds - measuredDurationSeconds) > 0.1) throw new Error('Gemini pilot MP3 integrity mismatch before transcription.');

const segmentMap = new Map((script.segments || []).map((segment) => [segment.segmentId, segment]));
const expectedText = (metadata.selectedSegmentIds || []).map((segmentId) => {
  const segment = segmentMap.get(segmentId);
  if (!segment?.spokenText) throw new Error(`Gemini pilot segment is missing from the approved Speech Script: ${segmentId}`);
  return segment.spokenText;
}).join('\n\n');
if (sha256(expectedText) !== metadata.transcriptHash) throw new Error('Gemini pilot expected transcript hash mismatch.');

let boundaries;
let silences = [];
if (DISABLE_CHUNKING) {
  boundaries = [0, measuredDurationSeconds];
} else {
  silences = await detectSilenceMidpoints(audioFile, measuredDurationSeconds);
  boundaries = chooseChunkBoundaries(measuredDurationSeconds, silences);
}
const chunkSpecs = [];
for (let index = 0; index < boundaries.length - 1; index += 1) {
  const startSeconds = boundaries[index];
  const endSeconds = boundaries[index + 1];
  chunkSpecs.push({
    index: index + 1,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    mp3: DISABLE_CHUNKING ? audio : await renderChunk(audioFile, startSeconds, endSeconds, false),
    wav: null,
    sha256: null,
  });
}
for (const chunk of chunkSpecs) {
  chunk.sha256 = sha256(chunk.mp3);
  if (DISABLE_CHUNKING) chunk.wav = chunk.mp3;
}
if (!chunkSpecs.length) throw new Error('Chunk planner produced no audio chunks.');
if (!DISABLE_CHUNKING && chunkSpecs.some((chunk) => chunk.durationSeconds > CHUNK_HARD_MAX_SECONDS + 0.2)) throw new Error('Chunk planner exceeded the guarded hard maximum duration.');
console.log(`Fallback ASR plan: ${chunkSpecs.length} chunk(s) across ${measuredDurationSeconds.toFixed(2)}s; ${silences.length} safe silence interval(s) detected.`);
console.log(`Chunk durations: ${chunkSpecs.map((chunk) => chunk.durationSeconds.toFixed(2)).join(', ')} seconds.`);
console.log(`Provider chain: ${PROVIDER_CHAIN.join(' -> ')}; Gemini model chain: ${GEMINI_MODEL_CHAIN.join(' -> ')}.`);

async function transcribeChunkWithProvider(chunk, provider, prompt) {
  if (provider === 'azure-stt') {
    if (!chunk.wav) chunk.wav = await renderChunk(audioFile, chunk.startSeconds, chunk.endSeconds, true);
    return transcribeWithAzure(chunk.wav);
  }
  return transcribeWithGemini(chunk.mp3, prompt);
}

async function runPass(passIndex) {
  const prompt = TRANSCRIPTION_PROMPTS[passIndex];
  const orderedProviders = [
    ...PROVIDER_CHAIN.slice(passIndex % PROVIDER_CHAIN.length),
    ...PROVIDER_CHAIN.slice(0, passIndex % PROVIDER_CHAIN.length),
  ];
  const providerErrors = [];
  for (const provider of orderedProviders) {
    try {
      const chunkResults = [];
      for (const chunk of chunkSpecs) {
        console.log(`ASR pass ${passIndex + 1}/${PASS_COUNT} via ${provider}, chunk ${chunk.index}/${chunkSpecs.length} (${chunk.durationSeconds.toFixed(2)}s)...`);
        chunkResults.push(await transcribeChunkWithProvider(chunk, provider, prompt));
      }
      const transcript = chunkResults.map((result) => result.transcript).join('\n');
      return {
        provider,
        transcriptionProvider: chunkResults[0].provider,
        transcriptionModel: chunkResults[0].model,
        promptSha256: provider === 'gemini' ? sha256(prompt) : null,
        requestProfile: provider === 'azure-stt'
          ? { endpoint: 'speech/recognition/conversation/cognitiveservices/v1', locale: AZURE_LOCALE, format: 'simple', audio: 'wav pcm_s16le 16kHz mono', promptTextSent: false }
          : { endpoint: 'v1beta/interactions', audio: 'mp3 96k 48kHz mono', structuredOutput: 'transcript', promptTextSent: true, referenceTextIncluded: false },
        transcript,
        chunkTranscripts: chunkResults.map((result) => result.transcript),
      };
    } catch (error) {
      providerErrors.push(`${provider}: ${error?.message}`);
      console.warn(`ASR pass ${passIndex + 1}/${PASS_COUNT}: provider ${provider} failed: ${error?.message}`);
    }
  }
  throw new Error(`ASR pass ${passIndex + 1}/${PASS_COUNT} failed on every configured provider.\n${providerErrors.join('\n')}`);
}

const passes = [];
for (let passIndex = 0; passIndex < PASS_COUNT; passIndex += 1) {
  const passResult = await runPass(passIndex);
  const comparison = compareArabicTranscripts(expectedText, passResult.transcript);
  passes.push({
    pass: passIndex + 1,
    provider: passResult.provider,
    transcriptionProvider: passResult.transcriptionProvider,
    transcriptionModel: passResult.transcriptionModel,
    promptSha256: passResult.promptSha256,
    requestProfile: passResult.requestProfile,
    transcript: passResult.transcript,
    transcriptSha256: sha256(passResult.transcript),
    normalizedTranscript: comparison.actualNormalized,
    normalizedTranscriptSha256: sha256(comparison.actualNormalized),
    exact: comparison.exact,
    actualWordCount: comparison.actualWordCount,
    wordErrorCount: comparison.wordErrorCount,
    substitutions: comparison.substitutions,
    deletions: comparison.deletions,
    insertions: comparison.insertions,
    differences: comparison.operations.slice(0, 50),
    chunks: chunkSpecs.map((chunk, index) => ({
      index: chunk.index,
      startSeconds: Number(chunk.startSeconds.toFixed(3)),
      endSeconds: Number(chunk.endSeconds.toFixed(3)),
      durationSeconds: Number(chunk.durationSeconds.toFixed(3)),
      audioSha256: chunk.sha256,
      transcript: passResult.chunkTranscripts[index],
      transcriptSha256: sha256(passResult.chunkTranscripts[index]),
    })),
  });
  console.log(`${comparison.exact ? '✓' : '✗'} ${ARTICLE_ID}, ASR pass ${passIndex + 1}/${PASS_COUNT} (${passResult.transcriptionProvider} / ${passResult.transcriptionModel}): ${comparison.wordErrorCount} word error(s).`);
}

const baseline = compareArabicTranscripts(expectedText, passes[0].transcript);
const totalWordErrors = passes.reduce((sum, pass) => sum + pass.wordErrorCount, 0);
const passed = passes.length === PASS_COUNT && passes.every((pass) => pass.exact) && totalWordErrors === 0;
const report = {
  schema: 'bareeq.audio-transcript-verification.v1',
  status: passed ? 'passed' : 'failed',
  articleId: ARTICLE_ID,
  audioMode: 'six-segment-pilot',
  ttsProvider: 'Google Gemini API',
  ttsModel: 'gemini-3.1-flash-tts-preview',
  ttsVoice: 'Sadaltager',
  transcriptionProvider: [...new Set(passes.map((pass) => pass.transcriptionProvider))].join(' + '),
  transcriptionModel: [...new Set(passes.map((pass) => pass.transcriptionModel))].join(' + '),
  providerFallbackChain: PROVIDER_CHAIN,
  geminiModelFallbackChain: PROVIDER_CHAIN.includes('gemini') ? GEMINI_MODEL_CHAIN : null,
  transcriptionPassesPerPart: PASS_COUNT,
  expectedTextDisclosure: 'Each transcription provider received audio chunks and provider-neutral instructions only; the expected article text was never included in any ASR request.',
  comparisonProfile: ARABIC_TRANSCRIPT_COMPARISON_PROFILE,
  comparisonRule: 'Exact word sequence after Unicode normalization, removal of non-lexical Arabic diacritics/tatweel/punctuation, digit normalization, and spoken abbreviation normalization. Taa marbuta (ة) is preserved.',
  chunking: {
    method: DISABLE_CHUNKING ? 'disabled-contract-test' : 'silence-midpoint',
    sourceAudioUnchanged: true,
    silenceThresholdDb: SILENCE_DB,
    silenceMinimumSeconds: SILENCE_MIN_SECONDS,
    chunkCount: chunkSpecs.length,
    boundariesSeconds: boundaries.map((value) => Number(value.toFixed(3))),
  },
  partCount: 1,
  expectedWordCount: baseline.expectedWordCount,
  wordErrorCountAcrossAllPasses: totalWordErrors,
  substitutions: passes.reduce((sum, pass) => sum + pass.substitutions, 0),
  deletions: passes.reduce((sum, pass) => sum + pass.deletions, 0),
  insertions: passes.reduce((sum, pass) => sum + pass.insertions, 0),
  verifiedAt: new Date().toISOString(),
  parts: [{
    index: 1,
    audioFile: relativeAudioFile,
    audioSha256: sha256(audio),
    audioBytes: audio.length,
    durationSeconds: Number(measuredDurationSeconds.toFixed(3)),
    expectedTranscriptSha256: sha256(expectedText),
    normalizedExpectedTranscript: baseline.expectedNormalized,
    normalizedExpectedTranscriptSha256: sha256(baseline.expectedNormalized),
    expectedWordCount: baseline.expectedWordCount,
    passes,
  }],
};

const relativeReportFile = path.posix.join('scripts', 'speech-transcript-evidence', `${BASENAME}.fallback.json`);
const reportFile = path.join(ROOT, relativeReportFile);
const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (!NO_WRITE) {
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, reportBytes);
}

if (!passed) {
  const firstFailure = passes.find((pass) => !pass.exact);
  if (firstFailure) console.error(`First mismatch: pass ${firstFailure.pass} (${firstFailure.transcriptionProvider}/${firstFailure.transcriptionModel}): ${JSON.stringify(firstFailure.differences.slice(0, 12))}`);
  throw new Error(`Automated transcript gate rejected ${ARTICLE_ID}: ${totalWordErrors} total word error(s) across ${PASS_COUNT} independent ASR pass(es). Nothing is approved for publication.`);
}

if (!NO_WRITE) {
  metadata.automatedTranscriptReview = {
    schema: report.schema,
    status: 'passed',
    transcriptionProvider: report.transcriptionProvider,
    transcriptionModel: report.transcriptionModel,
    providerFallbackChain: PROVIDER_CHAIN,
    transcriptionPassesPerPart: PASS_COUNT,
    comparisonProfile: ARABIC_TRANSCRIPT_COMPARISON_PROFILE,
    reportFile: relativeReportFile,
    reportSha256: sha256(reportBytes),
    partCount: 1,
    expectedWordCount: report.expectedWordCount,
    wordErrorCountAcrossAllPasses: 0,
  };
  await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}
console.log(`Automated fallback transcript gate passed for ${ARTICLE_ID}: ${PASS_COUNT} independent ASR passes, 0 substitutions, 0 deletions, 0 insertions.`);
