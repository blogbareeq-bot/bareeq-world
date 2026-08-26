/**
 * Whole-article ASR verification for a completed candidate (stage 4b).
 *
 * Two independent Gemini ASR models transcribe every audio part with generic
 * prompts; the concatenated transcript of each pass must match the approved
 * Speech Script with zero lexical substitutions/deletions/insertions.
 * An optional local Whisper transcript (WHISPER_TRANSCRIPT_FILE) is recorded
 * as independent cross-engine evidence. A vocalized ASR pass then inspects
 * high-risk multi-reading words (contextual ambiguities) at their exact
 * positions: an occurrence is only hard-flagged when both vocalized passes
 * disagree with the approved reading.
 *
 * Env:
 *   ARTICLE_ID, GEMINI_API_KEY        required
 *   GEMINI_ASR_MODELS                 default 'gemini-3.6-flash,gemini-3.5-flash'
 *   WHISPER_TRANSCRIPT_FILE           optional independent cross-engine transcript
 *   BAREEQ_VOCALIZED_PASSES           default 2
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareArabicTranscripts, normalizeArabicTranscript, transcriptTokens } from './arabic-transcript-match.mjs';
import { stripDiacritics } from './speech-script-core.mjs';

const ROOT = process.cwd();
const API_KEY = process.env.GEMINI_API_KEY?.trim();
const ARTICLE_ID = process.env.ARTICLE_ID?.trim();
const ASR_MODELS = (process.env.GEMINI_ASR_MODELS || 'gemini-3.6-flash,gemini-3.5-flash').split(',').map((v) => v.trim()).filter(Boolean);
const VOCALIZED_MODEL = process.env.BAREEQ_VOCALIZED_MODEL || 'gemini-3.6-flash';
const VOCALIZED_PASSES = Number(process.env.BAREEQ_VOCALIZED_PASSES ?? '2');
const WHISPER_FILE = process.env.WHISPER_TRANSCRIPT_FILE?.trim();
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const MAX_RETRIES = Number(process.env.BAREEQ_ASR_MAX_RETRIES ?? '10');
const MIN_INTERVAL_MS = Number(process.env.BAREEQ_ASR_MIN_INTERVAL_MS ?? '12000');
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
  `Listen only to this Arabic audio and transcribe every audible lexical word verbatim and exactly once, in order. Do not correct grammar, infer missing words, replace synonyms, add conjunctions, or use any external text. Return transcript only in the requested JSON schema.`,
];
const VOCALIZED_PROMPT = `استمع إلى التسجيل المرفق واكتب كل كلمة تسمعها بالتشكيل الكامل (الحركات، السكون، الشدة، التنوين) تمامًا كما تُنطق في الصوت، وبالترتيب نفسه. لا تعتمد على أي نص خارجي ولا تصحح ما تسمعه. أعد حقل transcript فقط وفق مخطط JSON المطلوب.`;

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

async function requestAsr(audioB64, model, prompt, label) {
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
      try { return JSON.parse(raw).transcript.trim(); } catch { return raw; }
    }
    if (response.status !== 429 && response.status < 500) throw new Error(`${label}: HTTP ${response.status} ${body.slice(0, 300)}`);
    const hinted = Number(body.match(/retry in ([0-9.]+)s/i)?.[1] || 0);
    const delay = hinted ? (Math.ceil(hinted) + 3) * 1000 : Math.min(75000, 10000 + attempt * 10000);
    console.warn(`${label}: HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s.`);
    await sleep(delay);
  }
  throw new Error(`${label}: retries exhausted (quota)`);
}

const audioKey = sha256(ARTICLE_ID).slice(0, 16);
const manifest = JSON.parse(await readFile(path.join(ROOT, 'public', 'audio', 'articles', audioKey, 'manifest.json'), 'utf8'));
if (manifest.articleId !== ARTICLE_ID) throw new Error('Manifest article mismatch.');
const script = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'speech-scripts', `${ARTICLE_ID}.json`), 'utf8'));
const expectedFull = script.segments.map((segment) => segment.spokenText).join(' ');
const expectedHash = sha256(expectedFull);
const defaultVoice = manifest.defaultVoice;
const parts = [];
for (const [index, part] of manifest.parts.entries()) {
  const asset = part?.audio?.[defaultVoice];
  if (!asset?.src) throw new Error(`part ${index + 1} missing audio asset`);
  const bytes = await readFile(path.join(ROOT, 'public', asset.src.replace(/^\//, '')));
  if (asset.sha256 && sha256(bytes) !== asset.sha256) throw new Error(`part ${index + 1} SHA mismatch`);
  parts.push({ part: index + 1, b64: bytes.toString('base64'), sha256: asset.sha256 ?? sha256(bytes), bytes: bytes.length });
}
console.log(`FULL_VERIFY article=${ARTICLE_ID} parts=${parts.length} expectedWords=${transcriptTokens(expectedFull).length} provider=${manifest.provider} model=${manifest.model} voice=${defaultVoice}`);

const passes = [];
for (const [passIndex, model] of ASR_MODELS.entries()) {
  const prompt = PROMPTS[passIndex % PROMPTS.length];
  const chunks = [];
  for (const part of parts) {
    const transcript = await requestAsr(part.b64, model, prompt, `PASS${passIndex + 1}_PART${part.part}(${model})`);
    chunks.push({ part: part.part, transcript, transcriptSha256: sha256(transcript) });
    console.log(`PASS${passIndex + 1}_PART_${part.part}=DONE`);
    await sleep(MIN_INTERVAL_MS);
  }
  const assembled = chunks.map((chunk) => chunk.transcript).join(' ');
  const comparison = compareArabicTranscripts(expectedFull, assembled);
  passes.push({
    pass: passIndex + 1,
    provider: 'Google Gemini API',
    model,
    promptSha256: sha256(prompt),
    transcript: assembled,
    transcriptSha256: sha256(assembled),
    actualWordCount: comparison.actualWordCount,
    exact: comparison.wordErrorCount === 0,
    wordErrorCount: comparison.wordErrorCount,
    substitutions: comparison.substitutions,
    deletions: comparison.deletions,
    insertions: comparison.insertions,
    differences: comparison.operations,
    chunks,
  });
  console.log(`FULL_PASS_${passIndex + 1} model=${model} expected=${comparison.expectedWordCount} actual=${comparison.actualWordCount} errors=${comparison.wordErrorCount}`);
}

// Independent Whisper cross-engine evidence (recorded, analyzed, not the primary gate).
let whisper = null;
if (WHISPER_FILE) {
  const text = (await readFile(WHISPER_FILE, 'utf8')).trim();
  const comparison = compareArabicTranscripts(expectedFull, text);
  whisper = { provider: 'local faster-whisper', model: 'large-v3', transcriptSha256: sha256(text), actualWordCount: comparison.actualWordCount, wordErrorCount: comparison.wordErrorCount, differences: comparison.operations };
  console.log(`WHISPER_CROSSCHECK errors=${comparison.wordErrorCount}`);
}

// Vocalized high-risk word inspection.
const ambiguityRules = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'contextual-ambiguities.json'), 'utf8'));
const foldBare = (token) => stripDiacritics(String(token)).toLowerCase()
  .replace(/[\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ؤ/g, 'و')
  .replace(/ئ/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[^\p{L}\p{N}]/gu, '');
const riskLexemes = [...new Set([
  ...(ambiguityRules.rules ?? []).map((rule) => foldBare(rule.lexeme)).filter((v) => v.length >= 3),
  // Person-ambiguous past forms flagged by the 2026-08-26 contextual review.
  ...['كنت', 'عرفت', 'رأيت', 'قلت', 'فعلت', 'وجدت'].map((v) => foldBare(v)),
])];
const expectedTokensRaw = expectedFull.split(/\s+/).filter(Boolean);
const riskPositions = [];
expectedTokensRaw.forEach((token, index) => {
  const bare = foldBare(token);
  if (bare.length >= 3 && riskLexemes.some((lexeme) => bare === lexeme || (lexeme.length >= 4 && bare.includes(lexeme)))) {
    riskPositions.push({ index, expected: token });
  }
});
const DIACRITIC_CHAR = /[\u064B-\u065F\u0670\u06D6-\u06ED]/u;
const diacriticKey = (token) => [...String(token)].filter((ch) => DIACRITIC_CHAR.test(ch)).join('');
// Align a vocalized ASR token stream to the expected stream on folded forms so
// that token splits/merges in ASR cannot silently shift inspected positions.
function alignTokens(expectedBare, heardRawTokens) {
  const heardBare = heardRawTokens.map((token) => foldBare(token)).filter((token) => token.length > 0);
  const heardKept = heardRawTokens.filter((token) => foldBare(token).length > 0);
  const map = new Map();
  let cursor = 0;
  for (let expectedIndex = 0; expectedIndex < expectedBare.length && cursor < heardBare.length; expectedIndex++) {
    const foundAt = heardBare.indexOf(expectedBare[expectedIndex], cursor);
    if (foundAt === -1) continue;
    map.set(expectedIndex, heardKept[foundAt]);
    cursor = foundAt + 1;
  }
  return map;
}
const vocalizedResults = [];
if (riskPositions.length) {
  const vocalizedPasses = [];
  for (let pass = 0; pass < VOCALIZED_PASSES; pass++) {
    const transcripts = [];
    for (const part of parts) {
      const transcript = await requestAsr(part.b64, VOCALIZED_MODEL, VOCALIZED_PROMPT, `VOC_PASS${pass + 1}_PART${part.part}`);
      transcripts.push(transcript);
      await sleep(MIN_INTERVAL_MS);
    }
    vocalizedPasses.push(transcripts.join(' ').split(/\s+/).filter(Boolean));
  }
  const expectedBare = expectedTokensRaw.map((token) => foldBare(token));
  const alignedPasses = vocalizedPasses.map((tokens) => alignTokens(expectedBare, tokens));
  for (const position of riskPositions) {
    const heard = alignedPasses.map((map) => map.get(position.index) ?? null);
    const expectedDiacritics = diacriticKey(position.expected);
    const statuses = heard.map((token) => {
      if (token == null) return 'not-aligned';
      if (stripDiacritics(token) !== stripDiacritics(position.expected)) return 'lexical-variant';
      return diacriticKey(token) === expectedDiacritics ? 'match' : 'diacritic-variant';
    });
    vocalizedResults.push({
      index: position.index,
      expected: position.expected,
      heard,
      statuses,
      anyMatch: statuses.includes('match'),
    });
  }
}
// A position is only hard-flagged when every vocalized pass heard a clearly
// different reading; ASR noise (not-aligned/lexical-variant) is recorded but
// must not block publication on its own.
const hardFlags = vocalizedResults.filter((item) => !item.anyMatch && item.statuses.every((status) => status === 'diacritic-variant'));

const primaryExact = passes.every((pass) => pass.exact);
const status = primaryExact && hardFlags.length === 0 ? 'passed' : 'failed';
const report = {
  schema: 'bareeq.article-full-cross-model-verification.v1',
  status,
  articleId: ARTICLE_ID,
  tts: { provider: manifest.provider, model: manifest.model, voice: defaultVoice },
  partCount: parts.length,
  partSha256: parts.map((part) => part.sha256),
  expectedTranscriptSha256: expectedHash,
  expectedWordCount: transcriptTokens(expectedFull).length,
  comparisonProfile: 'arabic-lexical-exact-v1',
  expectedTextDisclosure: 'ASR received only audio plus generic transcription instructions; the expected text was used only after responses.',
  primaryGate: { exactPasses: passes.filter((p) => p.exact).length, required: 2 },
  passes,
  whisperCrosscheck: whisper,
  vocalizedInspection: {
    model: VOCALIZED_MODEL,
    passCount: riskPositions.length ? VOCALIZED_PASSES : 0,
    inspected: vocalizedResults.length,
    hardFlags,
  },
  verifiedAt: new Date().toISOString(),
};
const outFile = path.join(ROOT, 'scripts', 'speech-transcript-evidence', `${ARTICLE_ID}-full-cross-model-queue-v1.json`);
await writeFile(outFile, JSON.stringify(report, null, 2) + '\n');
console.log(`FULL_VERIFICATION=${status} hardFlags=${hardFlags.length} file=${outFile}`);
if (status !== 'passed') process.exitCode = 2;
