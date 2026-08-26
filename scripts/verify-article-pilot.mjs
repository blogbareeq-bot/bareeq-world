/**
 * Cross-model zero-error verification of an article pilot clip (stage 2).
 *
 * Two independent Gemini ASR models (different from the TTS model) each
 * transcribe the pilot audio with generic prompts; the expected Speech Script
 * text is never sent to ASR. The gate passes only when both selected passes
 * are lexically exact (zero substitutions, deletions, insertions).
 *
 * Env:
 *   ARTICLE_ID           required
 *   GEMINI_API_KEY       required
 *   GEMINI_ASR_MODELS    comma list, default 'gemini-3.6-flash,gemini-3.5-flash'
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareArabicTranscripts, transcriptTokens } from './arabic-transcript-match.mjs';

const ROOT = process.cwd();
const API_KEY = process.env.GEMINI_API_KEY?.trim();
const ARTICLE_ID = process.env.ARTICLE_ID?.trim();
const ASR_MODELS = (process.env.GEMINI_ASR_MODELS || 'gemini-3.6-flash,gemini-3.5-flash').split(',').map((v) => v.trim()).filter(Boolean);
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const MAX_RETRIES = Number(process.env.BAREEQ_ASR_MAX_RETRIES ?? '8');
const MIN_INTERVAL_MS = Number(process.env.BAREEQ_ASR_MIN_INTERVAL_MS ?? '9000');
if (!ARTICLE_ID) throw new Error('ARTICLE_ID is required.');
if (!API_KEY) throw new Error('GEMINI_API_KEY is required; no request was sent.');
if (ASR_MODELS.length !== 2 || ASR_MODELS[0] === ASR_MODELS[1]) throw new Error('Exactly two distinct GEMINI_ASR_MODELS are required.');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;
async function pace() { const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt)); if (wait) await sleep(wait); lastRequestAt = Date.now(); }

const PROMPTS = [
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
  for (const container of containers) for (const item of container) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) if (block?.type === 'text' && typeof block?.text === 'string') texts.push(block.text);
  }
  return texts.join('');
}

async function transcribe(audioB64, model, prompt, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await pace();
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': API_KEY, 'Api-Revision': API_REVISION, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model,
        input: [{ type: 'text', text: prompt }, { type: 'audio', data: audioB64, mime_type: 'audio/mp3' }],
        response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] } },
        store: false,
      }),
    });
    const body = await response.text();
    if (response.ok) {
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw new Error(`${label}: invalid JSON response`); }
      const raw = extractText(parsed).trim();
      try { return JSON.parse(raw).transcript.trim(); }
      catch { return raw; }
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) throw new Error(`${label}: HTTP ${response.status} ${body.slice(0, 300)}`);
    const hinted = Number(body.match(/retry in ([0-9.]+)s/i)?.[1] || 0);
    const delay = hinted ? (Math.ceil(hinted) + 3) * 1000 : Math.min(60000, 5000 * (2 ** attempt));
    console.warn(`${label}: HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms.`);
    await sleep(delay);
  }
  throw new Error(`${label}: retries exhausted`);
}

const BASENAME = `${ARTICLE_ID}-gemini-pilot-queue-v1`;
const audio = await readFile(path.join(ROOT, 'scripts', 'speech-test-evidence', `${BASENAME}.mp3`));
const meta = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'speech-test-evidence', `${BASENAME}.json`), 'utf8'));
if (sha256(audio) !== meta.sha256) throw new Error('Pilot audio integrity mismatch.');
const script = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'speech-scripts', `${ARTICLE_ID}.json`), 'utf8'));
const byId = new Map(script.segments.map((s) => [s.segmentId, s]));
const expected = meta.selectedSegmentIds.map((id) => byId.get(id)?.spokenText || '').join('\n\n');
const expectedHash = sha256(expected);
if (expectedHash !== meta.transcriptHash) throw new Error('Pilot transcript hash mismatch against the speech script.');
const audioB64 = audio.toString('base64');

const passes = [];
for (const [index, model] of ASR_MODELS.entries()) {
  const prompt = PROMPTS[index % PROMPTS.length];
  const transcript = await transcribe(audioB64, model, prompt, `ASR ${model}`);
  const comparison = compareArabicTranscripts(expected, transcript);
  passes.push({
    pass: index + 1,
    provider: 'Google Gemini API',
    model,
    promptSha256: sha256(prompt),
    transcript,
    transcriptSha256: sha256(transcript),
    actualWordCount: comparison.actualWordCount,
    exact: comparison.wordErrorCount === 0,
    wordErrorCount: comparison.wordErrorCount,
    substitutions: comparison.substitutions,
    deletions: comparison.deletions,
    insertions: comparison.insertions,
    differences: comparison.operations,
  });
  console.log(`PILOT_PASS_${index + 1} model=${model} words=${comparison.actualWordCount} errors=${comparison.wordErrorCount}`);
  await sleep(9000);
}
const exactPasses = passes.filter((p) => p.exact);
const status = exactPasses.length === 2 ? 'passed' : 'failed';
const report = {
  schema: 'bareeq.audio-transcript-cross-model-verification.v1',
  status,
  articleId: ARTICLE_ID,
  audioMode: 'six-segment-pilot',
  tts: { provider: meta.provider, model: meta.model, voice: meta.voice },
  audioSha256: meta.sha256,
  expectedTranscriptSha256: expectedHash,
  expectedWordCount: transcriptTokens(expected).length,
  comparisonProfile: 'arabic-lexical-exact-v1',
  comparisonRule: 'Diacritics, punctuation, tatweel, spacing, and Unicode variance are normalized; every lexical word must appear exactly once in order.',
  expectedTextDisclosure: 'Both source ASR passes received audio and generic transcription instructions only; the expected article text was never included in an ASR request.',
  successfulIndependentPasses: exactPasses.length,
  wordErrorCountAcrossSelectedPasses: passes.reduce((sum, p) => sum + p.wordErrorCount, 0),
  substitutions: passes.reduce((sum, p) => sum + p.substitutions, 0),
  deletions: passes.reduce((sum, p) => sum + p.deletions, 0),
  insertions: passes.reduce((sum, p) => sum + p.insertions, 0),
  passes,
  approvalBasis: status === 'passed'
    ? 'Two distinct Gemini ASR models, independent of the TTS model, both produced lexically exact transcripts.'
    : 'Cross-model pilot verification did not reach two exact passes.',
  verifiedAt: new Date().toISOString(),
};
const outFile = path.join(ROOT, 'scripts', 'speech-transcript-evidence', `${ARTICLE_ID}-gemini-pilot-cross-model-queue-v1.json`);
await writeFile(outFile, JSON.stringify(report, null, 2) + '\n');
console.log(`PILOT_VERIFICATION=${status} file=${outFile}`);
if (status !== 'passed') process.exitCode = 2;
