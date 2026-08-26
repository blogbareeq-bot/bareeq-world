import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareArabicTranscripts, normalizeArabicTranscript } from './arabic-transcript-match.mjs';

const ROOT = process.cwd();
const ARTICLE_ID = 'how-touchscreens-work';
const AUDIO_KEY = 'de93f3d9f91c8b8b';
const MANIFEST_FILE = path.join(ROOT, 'public', 'audio', 'articles', AUDIO_KEY, 'manifest.json');
const SCRIPT_FILE = path.join(ROOT, 'scripts', 'speech-scripts', `${ARTICLE_ID}.json`);
const META_FILE = path.join(ROOT, 'scripts', 'speech-test-evidence', `${ARTICLE_ID}-hamed-final-production-v3.json`);
const FULL_AUDIO_FILE = path.join(ROOT, 'scripts', 'speech-test-evidence', `${ARTICLE_ID}-hamed-final-production-v3.mp3`);
const REPORT_FILE = path.join(ROOT, 'scripts', 'speech-transcript-evidence', `${ARTICLE_ID}-hamed-final-production-v3.json`);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required.');

const MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash'];
const PROMPTS = [
  'استمع إلى التسجيل الصوتي المرفق فقط واكتب تفريغًا عربيًا حرفيًا لكل كلمة معجمية مسموعة مرة واحدة وبالترتيب نفسه. لا تصحح اللغة، ولا تستنتج، ولا تضف أو تحذف أو تستبدل أي كلمة، ولا تستخدم أي نص خارجي. أعد transcript فقط وفق JSON المطلوب.',
  'Transcribe only the attached Arabic audio strictly verbatim. Preserve every audible lexical word exactly once and in order. Do not repair grammar, infer wording, add, omit, or replace words, and do not use external text. Return transcript only in the requested JSON schema.',
];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastRequestAt = new Map();

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (typeof payload?.outputText === 'string') return payload.outputText;
  const output = [];
  for (const collection of [payload?.steps, payload?.outputs].filter(Array.isArray)) {
    for (const item of collection) {
      for (const block of (Array.isArray(item?.content) ? item.content : [])) {
        if (block?.type === 'text' && typeof block.text === 'string') output.push(block.text);
      }
    }
  }
  return output.join('');
}

async function pace(model) {
  const previous = lastRequestAt.get(model) || 0;
  const remaining = 9000 - (Date.now() - previous);
  if (remaining > 0) await sleep(remaining);
  lastRequestAt.set(model, Date.now());
}

async function transcribe(model, prompt, audio, label) {
  let lastBody = '';
  for (let technicalAttempt = 1; technicalAttempt <= 8; technicalAttempt += 1) {
    await pace(model);
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
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
    lastBody = await response.text();
    if (response.ok) {
      const payload = JSON.parse(lastBody);
      const raw = extractOutputText(payload).trim();
      const transcript = JSON.parse(raw)?.transcript?.trim();
      if (!transcript) throw new Error(`${label}: empty transcript.`);
      return { transcript, technicalAttempts: technicalAttempt };
    }
    if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`${label}: ASR HTTP ${response.status}: ${lastBody.slice(0, 800)}`);
    const hinted = Number(lastBody.match(/retry in ([0-9.]+)s/i)?.[1] || 0);
    const waitSeconds = hinted > 0 ? Math.ceil(hinted) + 3 : Math.min(90, 20 + technicalAttempt * 8);
    console.log(`${label}: retryable HTTP ${response.status}; wait ${waitSeconds}s (${technicalAttempt}/8)`);
    await sleep(waitSeconds * 1000);
  }
  throw new Error(`${label}: technical retries exhausted: ${lastBody.slice(0, 600)}`);
}

const manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8'));
const script = JSON.parse(await readFile(SCRIPT_FILE, 'utf8'));
const meta = JSON.parse(await readFile(META_FILE, 'utf8'));
const fullAudio = await readFile(FULL_AUDIO_FILE);

if (manifest.articleId !== ARTICLE_ID || manifest.provider !== 'Microsoft Azure AI Speech' || manifest.model !== 'Neural TTS' || manifest.defaultVoice !== 'hamed' || manifest.voices?.length !== 1 || manifest.voices[0]?.providerVoice !== 'ar-SA-HamedNeural') throw new Error('Final production manifest identity mismatch.');
if (manifest.parts?.length !== 10 || meta.partCount !== 10) throw new Error(`Expected exactly 10 immutable production parts; manifest=${manifest.parts?.length} meta=${meta.partCount}.`);
if (sha256(fullAudio) !== meta.fullAudioSha256 || meta.fullAudioSha256 !== 'c46d1426210c595562aeda5d3acc40e82f98475d712d9ca3ba7caf7632d9f1ce') throw new Error('Full immutable candidate SHA mismatch.');

const expectedFull = script.segments.map((segment) => segment.spokenText).join(' ');
const partInputs = [];
const seenOrdinals = [];
for (const [partIndex, part] of manifest.parts.entries()) {
  const asset = part.audio?.hamed;
  if (!asset?.src || !asset.sha256) throw new Error(`Part ${partIndex + 1}: missing Hamed asset.`);
  const metaPart = meta.parts?.[partIndex];
  if (metaPart?.sha256 !== asset.sha256 || metaPart?.src !== asset.src || metaPart?.bytes !== asset.bytes) throw new Error(`Part ${partIndex + 1}: metadata/manifest mismatch.`);
  const audioFile = path.join(ROOT, 'public', asset.src.replace(/^\//u, ''));
  const audio = await readFile(audioFile);
  if (sha256(audio) !== asset.sha256 || audio.length !== asset.bytes) throw new Error(`Part ${partIndex + 1}: immutable audio integrity mismatch.`);
  const ordinals = part.sync.map((entry) => {
    if (!/^b\d{4}$/u.test(entry?.id || '')) throw new Error(`Part ${partIndex + 1}: invalid sync id ${entry?.id}.`);
    return Number(entry.id.slice(1));
  });
  for (const ordinal of ordinals) {
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal >= script.segments.length) throw new Error(`Part ${partIndex + 1}: invalid speech ordinal ${ordinal}.`);
    seenOrdinals.push(ordinal);
  }
  const expectedSegments = ordinals.map((ordinal) => script.segments[ordinal].spokenText);
  if (partIndex === 0) expectedSegments.unshift(script.segments[0].spokenText);
  const expectedText = expectedSegments.join(' ');
  partInputs.push({ part: partIndex + 1, audioFile, audio, audioSha256: asset.sha256, expectedText });
}

const uniqueOrdinals = [...new Set(seenOrdinals)];
if (uniqueOrdinals.length !== script.segments.length - 1 || seenOrdinals.length !== uniqueOrdinals.length) throw new Error('Production parts do not cover each non-title speech segment exactly once.');
for (let ordinal = 1; ordinal < script.segments.length; ordinal += 1) if (uniqueOrdinals[ordinal - 1] !== ordinal) throw new Error(`Speech segment coverage gap at ordinal ${ordinal}.`);
const reconstructedFull = partInputs.map((part) => part.expectedText).join(' ');
if (normalizeArabicTranscript(reconstructedFull) !== normalizeArabicTranscript(expectedFull)) throw new Error('Part-boundary reconstruction does not exactly cover the full approved speech script.');

const report = {
  schema: 'bareeq.hamed-final-production-cross-model-per-part.v1',
  status: 'running',
  articleId: ARTICLE_ID,
  audioSha256: meta.fullAudioSha256,
  partCount: partInputs.length,
  expectedWordCount: compareArabicTranscripts(expectedFull, expectedFull).expectedWordCount,
  verificationMode: 'ten-immutable-production-parts-two-distinct-models-selected-exact-pass',
  models: MODELS,
  expectedTextDisclosure: 'ASR receives only each immutable audio part and generic transcription instructions. Expected text remains local and is compared only after each response.',
  humanListening: false,
  parts: [],
  technicalError: null,
  verifiedAt: null,
};

try {
  for (const part of partInputs) {
    const expectedSelf = compareArabicTranscripts(part.expectedText, part.expectedText);
    const partReport = {
      part: part.part,
      audioSha256: part.audioSha256,
      expectedWordCount: expectedSelf.expectedWordCount,
      models: [],
    };
    console.log(`PART_${part.part}_BEGIN expectedWords=${partReport.expectedWordCount} sha=${part.audioSha256}`);
    for (const model of MODELS) {
      const attempts = [];
      let selected = null;
      for (let lexicalAttempt = 0; lexicalAttempt < PROMPTS.length; lexicalAttempt += 1) {
        const label = `PART_${part.part}_${model}_ATTEMPT_${lexicalAttempt + 1}`;
        const result = await transcribe(model, PROMPTS[lexicalAttempt], part.audio, label);
        const comparison = compareArabicTranscripts(part.expectedText, result.transcript);
        const attempt = {
          attempt: lexicalAttempt + 1,
          promptSha256: sha256(PROMPTS[lexicalAttempt]),
          technicalAttempts: result.technicalAttempts,
          transcript: result.transcript,
          transcriptSha256: sha256(result.transcript),
          exact: comparison.exact,
          expectedWordCount: comparison.expectedWordCount,
          actualWordCount: comparison.actualWordCount,
          wordErrorCount: comparison.wordErrorCount,
          substitutions: comparison.substitutions,
          deletions: comparison.deletions,
          insertions: comparison.insertions,
          differences: comparison.operations,
        };
        attempts.push(attempt);
        console.log(`${label} expected=${comparison.expectedWordCount} actual=${comparison.actualWordCount} errors=${comparison.wordErrorCount} diff=${JSON.stringify(comparison.operations)}`);
        if (comparison.exact) {
          selected = attempt;
          break;
        }
      }
      partReport.models.push({ model, status: selected ? 'passed' : 'failed', selectedAttempt: selected?.attempt ?? null, attempts });
    }
    report.parts.push(partReport);
  }
  const allPassed = report.parts.every((part) => part.models.length === MODELS.length && part.models.every((model) => model.status === 'passed' && model.attempts.find((attempt) => attempt.attempt === model.selectedAttempt)?.exact === true));
  report.status = allPassed ? 'passed' : 'failed';
} catch (error) {
  report.status = 'technical-failure';
  report.technicalError = String(error?.stack || error);
  console.error(report.technicalError);
}

report.verifiedAt = new Date().toISOString();
report.selectedExactPasses = report.parts.reduce((count, part) => count + part.models.filter((model) => model.status === 'passed').length, 0);
report.failedModelParts = report.parts.flatMap((part) => part.models.filter((model) => model.status !== 'passed').map((model) => ({ part: part.part, model: model.model })));
report.selectedWordErrorCount = report.parts.reduce((sum, part) => sum + part.models.reduce((inner, model) => {
  const selected = model.attempts.find((attempt) => attempt.attempt === model.selectedAttempt);
  return inner + (selected?.wordErrorCount ?? 0);
}, 0), 0);
report.selectedSubstitutions = report.parts.reduce((sum, part) => sum + part.models.reduce((inner, model) => inner + (model.attempts.find((attempt) => attempt.attempt === model.selectedAttempt)?.substitutions ?? 0), 0), 0);
report.selectedDeletions = report.parts.reduce((sum, part) => sum + part.models.reduce((inner, model) => inner + (model.attempts.find((attempt) => attempt.attempt === model.selectedAttempt)?.deletions ?? 0), 0), 0);
report.selectedInsertions = report.parts.reduce((sum, part) => sum + part.models.reduce((inner, model) => inner + (model.attempts.find((attempt) => attempt.attempt === model.selectedAttempt)?.insertions ?? 0), 0), 0);
await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);

if (report.status === 'passed') {
  manifest.verifiedStaticAudio = true;
  manifest.automatedTranscriptReview = {
    status: 'passed',
    scope: 'complete-article-all-ten-immutable-parts',
    verificationMode: report.verificationMode,
    reportFile: path.relative(ROOT, REPORT_FILE).replaceAll('\\', '/'),
    reportSha256: sha256(await readFile(REPORT_FILE)),
    transcriptionProvider: 'Google Gemini API',
    transcriptionModels: MODELS,
    exactModelPassesPerPart: 2,
    partCount: report.partCount,
    expectedWordCount: report.expectedWordCount,
    selectedWordErrorCount: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    fullAudioSha256: report.audioSha256,
    humanListening: false,
    reviewedAt: report.verifiedAt,
  };
  meta.qaStatus = 'passed';
  meta.qaReport = path.relative(ROOT, REPORT_FILE).replaceAll('\\', '/');
  meta.qaReportSha256 = manifest.automatedTranscriptReview.reportSha256;
  meta.verifiedAt = report.verifiedAt;
  await writeFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(META_FILE, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`HAMED_FINAL_V3_CROSS_MODEL_ZERO_ERROR=PASS parts=${report.partCount} selectedExactPasses=${report.selectedExactPasses} words=${report.expectedWordCount}`);
} else {
  console.log(`HAMED_FINAL_V3_CROSS_MODEL_ZERO_ERROR=${report.status.toUpperCase()} selectedExactPasses=${report.selectedExactPasses} failed=${JSON.stringify(report.failedModelParts)}`);
}
