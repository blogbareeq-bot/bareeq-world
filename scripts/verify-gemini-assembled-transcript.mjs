import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARABIC_TRANSCRIPT_COMPARISON_PROFILE, compareArabicTranscripts } from './arabic-transcript-match.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ROOT = process.cwd();
const ARTICLE_ID = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length)?.trim();
const AUDIO_ARG = process.argv.find((arg) => arg.startsWith('--audio='))?.slice('--audio='.length)?.trim();
const EXPECTED_ARG = process.argv.find((arg) => arg.startsWith('--expected='))?.slice('--expected='.length)?.trim();
const REPORT_ARG = process.argv.find((arg) => arg.startsWith('--report='))?.slice('--report='.length)?.trim();
const API_KEY = process.env.GEMINI_API_KEY?.trim();
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_RETRIES = Number(process.env.BAREEQ_ASR_MAX_RETRIES || '2');
const MIN_INTERVAL_MS = Number(process.env.BAREEQ_ASR_MIN_INTERVAL_MS || '4000');
const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;
const PASS_MODELS = [
  ['gemini-3.5-flash'],
  ['gemini-3.6-flash', 'gemini-3.5-flash'],
];

if (!ARTICLE_ID || !AUDIO_ARG || !EXPECTED_ARG || !REPORT_ARG) throw new Error('Pass --article, --audio, --expected, and --report.');
if (!API_KEY) throw new Error('GEMINI_API_KEY is required; no ASR request was sent.');
if (!Number.isInteger(MAX_RETRIES) || MAX_RETRIES < 0 || !Number.isFinite(MIN_INTERVAL_MS) || MIN_INTERVAL_MS < 0) throw new Error('Invalid ASR retry/pacing configuration.');

const audioFile = path.resolve(ROOT, AUDIO_ARG);
const expectedFile = path.resolve(ROOT, EXPECTED_ARG);
const reportFile = path.resolve(ROOT, REPORT_ARG);
for (const file of [audioFile, expectedFile, reportFile]) {
  if (!file.startsWith(`${path.resolve(ROOT)}${path.sep}`) && !file.startsWith('/tmp/')) throw new Error(`Path escapes guarded roots: ${file}`);
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastRequestAt = 0;

const PROMPTS = [
  `استمع إلى التسجيل العربي المرفق كاملًا وحوّله إلى نص حرفي كامل.
- التسجيل وحده هو المصدر.
- اكتب كل كلمة مسموعة مرة واحدة وبالترتيب نفسه.
- لا تلخص، ولا تعِد الصياغة، ولا تصحح النحو، ولا تستبدل كلمة بمرادف، ولا تضف تعليقًا.
- لا تضف كلمات غير مسموعة حتى لو بدت مناسبة للسياق.
- لا حاجة إلى التشكيل أو علامات الترقيم.
أعد حقل transcript فقط وفق مخطط JSON المطلوب.`,
  `Produce a complete verbatim Arabic transcript of the attached audio using the audio as the only source.
Write every audible word once and in original order. Do not infer, repair grammar, replace words with synonyms, summarize, paraphrase, normalize wording, or add commentary. Do not add anything that is not audibly spoken. Diacritics and punctuation are optional. Return only the transcript field required by the JSON schema.`,
];

function extractText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (typeof payload?.outputText === 'string') return payload.outputText;
  const texts = [];
  for (const container of [payload?.steps, payload?.outputs].filter(Array.isArray)) {
    for (const item of container) for (const block of (Array.isArray(item?.content) ? item.content : [])) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  return texts.join('');
}

function technicalFallbackAllowed(status, body) {
  if (status === 404) return true;
  if (status !== 429) return false;
  return /quota|resource[_ ]exhausted|free[_ ]tier|not available/i.test(body);
}

async function pace() {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (wait) await sleep(wait);
  lastRequestAt = Date.now();
}

async function requestModel(audio, prompt, model) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await pace();
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'x-goog-api-key': API_KEY,
          'Api-Revision': '2026-05-20',
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Bareeq-Assembled-Full-Audio-Transcript-Gate/1.0',
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
            schema: { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] },
          },
          store: false,
        }),
      });
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(15000, 1500 * (2 ** attempt)));
        continue;
      }
      return { technicalFailure: true, detail: `${model}: transport ${error?.message || error}` };
    }
    const body = await response.text();
    if (!response.ok) {
      if (technicalFallbackAllowed(response.status, body)) return { technicalFailure: true, detail: `${model}: HTTP ${response.status} ${body.slice(0, 240)}` };
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(Math.min(15000, 1500 * (2 ** attempt)));
        continue;
      }
      throw new Error(`${model} ASR failed (${response.status}): ${body.slice(0, 700)}`);
    }
    let payload;
    try { payload = JSON.parse(body); }
    catch (error) { throw new Error(`${model} ASR returned invalid JSON: ${error.message}`); }
    const output = extractText(payload).trim();
    if (!output) throw new Error(`${model} ASR returned empty text output.`);
    let structured;
    try { structured = JSON.parse(output); }
    catch (error) { throw new Error(`${model} ASR structured output is invalid JSON: ${output.slice(0, 300)}`); }
    if (typeof structured?.transcript !== 'string' || !structured.transcript.trim()) throw new Error(`${model} ASR returned no transcript.`);
    return { transcript: structured.transcript.trim(), model };
  }
  throw new Error(`${model} ASR exhausted retries.`);
}

async function transcribePass(audio, prompt, passIndex) {
  const technicalFailures = [];
  for (const model of PASS_MODELS[passIndex]) {
    const result = await requestModel(audio, prompt, model);
    if (result.technicalFailure) {
      technicalFailures.push(result.detail);
      console.warn(`ASR pass ${passIndex + 1}: ${result.detail}; trying technical fallback if configured.`);
      continue;
    }
    return result;
  }
  throw new Error(`ASR pass ${passIndex + 1} has no available model. ${technicalFailures.join(' | ')}`);
}

const [audio, expectedTextRaw] = await Promise.all([readFile(audioFile), readFile(expectedFile, 'utf8')]);
const expectedText = expectedTextRaw.trim();
if (audio.length < 10000 || audio.length > MAX_INLINE_AUDIO_BYTES) throw new Error(`Assembled audio size is outside guarded limits: ${audio.length} bytes.`);
if (!expectedText) throw new Error('Expected full-article transcript is empty.');
const audioDurationSeconds = mp3DurationSeconds(audio);
const passes = [];
for (let passIndex = 0; passIndex < 2; passIndex += 1) {
  const result = await transcribePass(audio, PROMPTS[passIndex], passIndex);
  const comparison = compareArabicTranscripts(expectedText, result.transcript);
  passes.push({
    pass: passIndex + 1,
    provider: 'Google Gemini API',
    model: result.model,
    promptSha256: sha256(PROMPTS[passIndex]),
    transcript: result.transcript,
    transcriptSha256: sha256(result.transcript),
    normalizedTranscript: comparison.actualNormalized,
    normalizedTranscriptSha256: sha256(comparison.actualNormalized),
    exact: comparison.exact,
    actualWordCount: comparison.actualWordCount,
    wordErrorCount: comparison.wordErrorCount,
    substitutions: comparison.substitutions,
    deletions: comparison.deletions,
    insertions: comparison.insertions,
    differences: comparison.operations.slice(0, 100),
  });
  console.log(`${comparison.exact ? '✓' : '✗'} ${ARTICLE_ID} assembled full audio, pass ${passIndex + 1}/2 via ${result.model}: ${comparison.wordErrorCount} word error(s).`);
}
const baseline = compareArabicTranscripts(expectedText, passes[0].transcript);
const passed = passes.every((pass) => pass.exact && pass.wordErrorCount === 0 && pass.substitutions === 0 && pass.deletions === 0 && pass.insertions === 0);
const report = {
  schema: 'bareeq.audio-transcript-verification.v1',
  status: passed ? 'passed' : 'failed',
  articleId: ARTICLE_ID,
  audioMode: 'assembled-full-article',
  ttsProvider: 'Google Gemini API',
  ttsModel: 'gemini-3.1-flash-tts-preview',
  ttsVoice: 'Sadaltager',
  transcriptionProvider: 'Google Gemini API',
  transcriptionModels: passes.map((pass) => pass.model),
  verificationScope: 'assembled-full-article',
  transcriptionPassesPerArticle: 2,
  expectedTextDisclosure: 'ASR requests received the assembled audio and generic transcription instructions only; the expected article text was never included in a request.',
  comparisonProfile: ARABIC_TRANSCRIPT_COMPARISON_PROFILE,
  comparisonRule: 'Exact word sequence after Unicode normalization, removal of non-lexical Arabic diacritics/tatweel/punctuation, digit normalization, and spoken abbreviation normalization. Taa marbuta (ة) is preserved.',
  partCount: Number(process.env.BAREEQ_ASSEMBLED_PART_COUNT || '0') || null,
  audioFile: path.relative(ROOT, audioFile),
  audioSha256: sha256(audio),
  audioBytes: audio.length,
  durationSeconds: Number(audioDurationSeconds.toFixed(3)),
  expectedTranscriptSha256: sha256(expectedText),
  normalizedExpectedTranscript: baseline.expectedNormalized,
  normalizedExpectedTranscriptSha256: sha256(baseline.expectedNormalized),
  expectedWordCount: baseline.expectedWordCount,
  wordErrorCountAcrossAllPasses: passes.reduce((sum, pass) => sum + pass.wordErrorCount, 0),
  substitutions: passes.reduce((sum, pass) => sum + pass.substitutions, 0),
  deletions: passes.reduce((sum, pass) => sum + pass.deletions, 0),
  insertions: passes.reduce((sum, pass) => sum + pass.insertions, 0),
  passes,
  verifiedAt: new Date().toISOString(),
};
const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
await mkdir(path.dirname(reportFile), { recursive: true });
await writeFile(reportFile, reportBytes);
if (!passed) {
  const first = passes.find((pass) => !pass.exact);
  console.error(`First full-article mismatch: ${JSON.stringify(first?.differences?.slice(0, 20) || [])}`);
  throw new Error(`Assembled full-article transcript gate rejected ${ARTICLE_ID}: ${report.wordErrorCountAcrossAllPasses} total word error(s). Nothing is approved for publication.`);
}
console.log(`Assembled full-article transcript gate passed: ${baseline.expectedWordCount} words, 2 independent ASR passes, 0 substitutions, 0 deletions, 0 insertions.`);
