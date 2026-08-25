import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARABIC_TRANSCRIPT_COMPARISON_PROFILE, compareArabicTranscripts } from './arabic-transcript-match.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ROOT = process.cwd();
const PILOT_MODE = process.argv.includes('--pilot');
const ARTICLE_ID = process.argv.find((argument) => argument.startsWith('--article='))?.slice('--article='.length)?.trim();
const NO_WRITE = process.argv.includes('--no-write');
const API_KEY = process.env.GEMINI_API_KEY?.trim();
const MODEL = 'gemini-3.7-flash';
const OFFICIAL_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const CONTRACT_TEST = process.env.BAREEQ_ASR_CONTRACT_TEST === '1';
const configuredEndpoint = process.env.GEMINI_ASR_ENDPOINT?.trim();
const ENDPOINT = configuredEndpoint || OFFICIAL_ENDPOINT;
const MAX_RETRIES = Number(process.env.BAREEQ_ASR_MAX_RETRIES || '5');
const MIN_INTERVAL_MS = Number(process.env.BAREEQ_ASR_MIN_INTERVAL_MS || '2000');
const PASS_COUNT = 2;
const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;

if (Boolean(PILOT_MODE) === Boolean(ARTICLE_ID)) throw new Error('Pass exactly one of --pilot or --article=<article-id>.');
if (!API_KEY) throw new Error('GEMINI_API_KEY is required; no transcription request was sent.');
if (configuredEndpoint) {
  if (!CONTRACT_TEST) throw new Error('GEMINI_ASR_ENDPOINT is restricted to BAREEQ_ASR_CONTRACT_TEST=1.');
  const endpoint = new URL(configuredEndpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) throw new Error('The ASR contract-test endpoint must be local HTTP.');
}
if (!Number.isInteger(MAX_RETRIES) || MAX_RETRIES < 0) throw new Error('BAREEQ_ASR_MAX_RETRIES must be zero or a positive integer.');
if (!Number.isFinite(MIN_INTERVAL_MS) || MIN_INTERVAL_MS < 0) throw new Error('BAREEQ_ASR_MIN_INTERVAL_MS must be zero or positive.');

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

async function requestTranscription(audio, prompt, attempt = 0) {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestStartedAt));
  if (wait) await sleep(wait);
  lastRequestStartedAt = Date.now();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-goog-api-key': API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Bareeq-Audio-Transcript-Gate/1.0',
    },
    body: JSON.stringify({
      model: MODEL,
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
  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number.parseFloat(response.headers.get('retry-after') || '');
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter * 1000)
        : Math.min(30000, 2000 * (2 ** attempt));
      console.warn(`Gemini ASR HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms.`);
      await sleep(delay);
      return requestTranscription(audio, prompt, attempt + 1);
    }
    const error = new Error(`Gemini ASR failed (${response.status}): ${responseBody.slice(0, 700)}`);
    error.httpStatus = response.status;
    throw error;
  }
  let payload;
  try { payload = await response.json(); }
  catch (error) { throw new Error(`Gemini ASR returned invalid JSON: ${error.message}`); }
  const outputText = extractText(payload).trim();
  if (!outputText) throw new Error('Gemini ASR response did not contain text output.');
  let structured;
  try { structured = JSON.parse(outputText); }
  catch (error) { throw new Error(`Gemini ASR structured output was invalid JSON: ${error.message}; output=${outputText.slice(0, 300)}`); }
  if (typeof structured?.transcript !== 'string' || !structured.transcript.trim()) throw new Error('Gemini ASR structured output did not contain a non-empty transcript.');
  return structured.transcript.trim();
}

async function loadPilotTarget() {
  const articleId = 'how-touchscreens-work';
  const basename = `${articleId}-gemini-pilot-v1`;
  const script = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'speech-scripts', `${articleId}.json`), 'utf8'));
  const plan = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'speech-test-clips', `${articleId}.json`), 'utf8'));
  const metadataFile = path.join(ROOT, 'scripts', 'speech-test-evidence', `${basename}.json`);
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  const relativeAudioFile = path.posix.join('scripts', 'speech-test-evidence', `${basename}.mp3`);
  const audioFile = path.join(ROOT, relativeAudioFile);
  if (metadata.schema !== 'bareeq.gemini-pronunciation-sample.v1' || metadata.sampleMode !== 'six-segment-pilot' || metadata.articleId !== articleId) throw new Error('Gemini pilot metadata identity mismatch.');
  if (metadata.model !== 'gemini-3.1-flash-tts-preview' || metadata.voice !== 'Sadaltager' || metadata.language !== 'ar') throw new Error('Gemini pilot synthesis contract mismatch.');
  if (metadata.speechScriptHash !== script.scriptHash || metadata.planHash !== plan.planHash || plan.speechScriptHash !== script.scriptHash) throw new Error('Gemini pilot targets a stale Speech Script or test plan.');
  const plannedSegmentIds = (plan.selectedSegments || []).map((segment) => segment.segmentId);
  if (JSON.stringify(metadata.selectedSegmentIds) !== JSON.stringify(plannedSegmentIds)) throw new Error('Gemini pilot segment selection does not match the immutable listening plan.');
  const segments = new Map((script.segments || []).map((segment) => [segment.segmentId, segment]));
  const expectedText = (metadata.selectedSegmentIds || []).map((segmentId) => {
    const segment = segments.get(segmentId);
    if (!segment?.spokenText) throw new Error(`Gemini pilot segment is missing from the approved Speech Script: ${segmentId}`);
    return segment.spokenText;
  }).join('\n\n');
  if (sha256(expectedText) !== metadata.transcriptHash) throw new Error('Gemini pilot expected transcript hash mismatch.');
  return {
    mode: 'six-segment-pilot', articleId, basename, metadata, metadataFile,
    parts: [{ index: 0, expectedText, relativeAudioFile, audioFile, expectedAsset: metadata }],
  };
}

async function loadArticleTarget(articleId) {
  const audioKey = sha256(articleId).slice(0, 16);
  const manifestFile = path.join(ROOT, 'public', 'audio', 'articles', audioKey, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.articleId !== articleId || manifest.provider !== 'Google Gemini API' || manifest.model !== 'gemini-3.1-flash-tts-preview') throw new Error('Full Gemini article manifest identity mismatch.');
  if (manifest.language !== 'ar' || manifest.defaultVoice !== 'sadaltager' || manifest.voices?.length !== 1 || manifest.voices[0]?.providerVoice !== 'Sadaltager') throw new Error('Full Gemini article voice contract mismatch.');
  const qaRaw = execFileSync(process.execPath, ['scripts/generate-audio.mjs', '--speech-qa-json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, BAREEQ_TTS_PROVIDER: 'gemini', BAREEQ_TTS_INCLUDE_IDS: articleId, GEMINI_TTS_ENDPOINT: '', BAREEQ_TTS_CONTRACT_TEST: '' },
  });
  const qa = JSON.parse(qaRaw).find((entry) => entry.id === articleId);
  if (!qa || !Array.isArray(qa.audioParts) || qa.audioParts.length !== manifest.parts?.length) throw new Error('Full Gemini article audio-part plan does not match its manifest.');
  const parts = qa.audioParts.map((audioPart, index) => {
    const asset = manifest.parts[index]?.audio?.sadaltager;
    if (!asset?.src || !asset.src.endsWith('.mp3')) throw new Error(`Full Gemini article part ${index + 1} has no Sadaltager MP3.`);
    return {
      index,
      expectedText: audioPart.text,
      relativeAudioFile: path.posix.join('public', asset.src.replace(/^\//u, '')),
      audioFile: path.join(ROOT, 'public', asset.src.replace(/^\//u, '')),
      expectedAsset: asset,
    };
  });
  return { mode: 'full-article', articleId, basename: `${articleId}-gemini-full-v1`, manifest, manifestFile, parts };
}

const target = PILOT_MODE ? await loadPilotTarget() : await loadArticleTarget(ARTICLE_ID);
const reportParts = [];
let totalExpectedWords = 0;
let totalWordErrors = 0;

for (const part of target.parts) {
  const audio = await readFile(part.audioFile);
  if (audio.length > MAX_INLINE_AUDIO_BYTES) throw new Error(`${part.relativeAudioFile} is too large for the guarded inline ASR request.`);
  const measuredDurationSeconds = mp3DurationSeconds(audio);
  if (part.expectedAsset.bytes !== audio.length || part.expectedAsset.sha256 !== sha256(audio) || Math.abs(part.expectedAsset.durationSeconds - measuredDurationSeconds) > 0.1) {
    throw new Error(`Audio integrity mismatch before transcription: ${part.relativeAudioFile}`);
  }
  const passes = [];
  for (let passIndex = 0; passIndex < PASS_COUNT; passIndex += 1) {
    const transcript = await requestTranscription(audio, TRANSCRIPTION_PROMPTS[passIndex]);
    const comparison = compareArabicTranscripts(part.expectedText, transcript);
    passes.push({
      pass: passIndex + 1,
      promptSha256: sha256(TRANSCRIPTION_PROMPTS[passIndex]),
      transcript,
      transcriptSha256: sha256(transcript),
      normalizedTranscript: comparison.actualNormalized,
      normalizedTranscriptSha256: sha256(comparison.actualNormalized),
      exact: comparison.exact,
      actualWordCount: comparison.actualWordCount,
      wordErrorCount: comparison.wordErrorCount,
      substitutions: comparison.substitutions,
      deletions: comparison.deletions,
      insertions: comparison.insertions,
      differences: comparison.operations.slice(0, 50),
    });
    console.log(`${comparison.exact ? '✓' : '✗'} ${target.articleId} part ${part.index + 1}/${target.parts.length}, ASR pass ${passIndex + 1}/${PASS_COUNT}: ${comparison.wordErrorCount} word error(s).`);
  }
  const baseline = compareArabicTranscripts(part.expectedText, passes[0].transcript);
  totalExpectedWords += baseline.expectedWordCount;
  totalWordErrors += passes.reduce((sum, pass) => sum + pass.wordErrorCount, 0);
  reportParts.push({
    index: part.index + 1,
    audioFile: part.relativeAudioFile,
    audioSha256: sha256(audio),
    audioBytes: audio.length,
    durationSeconds: Number(measuredDurationSeconds.toFixed(3)),
    expectedTranscriptSha256: sha256(part.expectedText),
    normalizedExpectedTranscript: baseline.expectedNormalized,
    normalizedExpectedTranscriptSha256: sha256(baseline.expectedNormalized),
    expectedWordCount: baseline.expectedWordCount,
    passes,
  });
}

const passed = totalWordErrors === 0 && reportParts.every((part) => part.passes.length === PASS_COUNT && part.passes.every((pass) => pass.exact));
const report = {
  schema: 'bareeq.audio-transcript-verification.v1',
  status: passed ? 'passed' : 'failed',
  articleId: target.articleId,
  audioMode: target.mode,
  ttsProvider: 'Google Gemini API',
  ttsModel: 'gemini-3.1-flash-tts-preview',
  ttsVoice: 'Sadaltager',
  transcriptionProvider: 'Google Gemini API',
  transcriptionModel: MODEL,
  transcriptionPassesPerPart: PASS_COUNT,
  expectedTextDisclosure: 'The transcription model received audio and instructions only; the expected article text was never included in an ASR request.',
  comparisonProfile: ARABIC_TRANSCRIPT_COMPARISON_PROFILE,
  comparisonRule: 'Exact word sequence after Unicode normalization, removal of non-lexical Arabic diacritics/tatweel/punctuation, digit normalization, and spoken abbreviation normalization. Taa marbuta (ة) is preserved.',
  partCount: reportParts.length,
  expectedWordCount: totalExpectedWords,
  wordErrorCountAcrossAllPasses: totalWordErrors,
  substitutions: reportParts.flatMap((part) => part.passes).reduce((sum, pass) => sum + pass.substitutions, 0),
  deletions: reportParts.flatMap((part) => part.passes).reduce((sum, pass) => sum + pass.deletions, 0),
  insertions: reportParts.flatMap((part) => part.passes).reduce((sum, pass) => sum + pass.insertions, 0),
  verifiedAt: new Date().toISOString(),
  parts: reportParts,
};

const relativeReportFile = path.posix.join('scripts', 'speech-transcript-evidence', `${target.basename}.json`);
const reportFile = path.join(ROOT, relativeReportFile);
const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (!NO_WRITE) {
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, reportBytes);
}

if (!passed) {
  const firstFailure = reportParts.flatMap((part) => part.passes.map((pass) => ({ part: part.index, ...pass }))).find((pass) => !pass.exact);
  if (firstFailure) console.error(`First mismatch: part ${firstFailure.part}, pass ${firstFailure.pass}: ${JSON.stringify(firstFailure.differences.slice(0, 12))}`);
  throw new Error(`Automated transcript gate rejected ${target.articleId}: ${totalWordErrors} total word error(s) across ${PASS_COUNT} independent ASR pass(es). Nothing is approved for publication.`);
}

if (!NO_WRITE) {
  const summary = {
    schema: report.schema,
    status: 'passed',
    transcriptionProvider: report.transcriptionProvider,
    transcriptionModel: MODEL,
    transcriptionPassesPerPart: PASS_COUNT,
    comparisonProfile: ARABIC_TRANSCRIPT_COMPARISON_PROFILE,
    reportFile: relativeReportFile,
    reportSha256: sha256(reportBytes),
    partCount: report.partCount,
    expectedWordCount: report.expectedWordCount,
    wordErrorCountAcrossAllPasses: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    verifiedAt: report.verifiedAt,
  };
  if (PILOT_MODE) {
    target.metadata.automatedTranscriptReview = summary;
    await writeFile(target.metadataFile, `${JSON.stringify(target.metadata, null, 2)}\n`, 'utf8');
  } else {
    target.manifest.automatedTranscriptReview = summary;
    await writeFile(target.manifestFile, `${JSON.stringify(target.manifest, null, 2)}\n`, 'utf8');
  }
}
console.log(`Automated transcript gate passed: ${target.parts.length} part(s), ${PASS_COUNT} independent ASR pass(es) per part, ${totalExpectedWords} expected words, 0 substitutions, 0 deletions, 0 insertions.`);
