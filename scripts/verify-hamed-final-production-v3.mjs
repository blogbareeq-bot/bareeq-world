import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
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

const REQUIRED_MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash'];
const requestedModels = (process.env.QA_MODELS || 'gemini-3.6-flash').split(',').map((value) => value.trim()).filter(Boolean);
for (const model of requestedModels) if (!REQUIRED_MODELS.includes(model)) throw new Error(`Unsupported QA model ${model}.`);
const maxNewLexicalAttempts = Math.max(1, Number(process.env.QA_MAX_NEW_LEXICAL_ATTEMPTS || 1));
const PROMPTS = [
  'استمع إلى التسجيل الصوتي المرفق فقط واكتب تفريغًا عربيًا حرفيًا لكل كلمة معجمية مسموعة مرة واحدة وبالترتيب نفسه. لا تصحح اللغة، ولا تستنتج، ولا تضف أو تحذف أو تستبدل أي كلمة، ولا تستخدم أي نص خارجي. أعد transcript فقط وفق JSON المطلوب.',
  'Transcribe only the attached Arabic audio strictly verbatim. Preserve every audible lexical word exactly once and in order. Do not repair grammar, infer wording, add, omit, or replace words, and do not use external text. Return transcript only in the requested JSON schema.',
  'فرّغ الصوت العربي كما سمعته حرفيًا دون تحسين أو تصحيح أو إعادة صياغة. حافظ على كل كلمة معجمية وترتيبها، ولا تستبدل كلمة بمرادف أو صيغة تراها أفصح. أعد JSON المطلوب فقط.',
  'Listen only to the attached Arabic recording and produce a literal lexical transcript. Do not normalize, correct, paraphrase, infer, add, remove, or synonym-substitute any word. Output only the requested JSON.',
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastRequestAt = new Map();

class TechnicalQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TechnicalQuotaError';
  }
}

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

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
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
          schema: { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] },
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
  throw new TechnicalQuotaError(`${label}: technical retries exhausted: ${lastBody.slice(0, 600)}`);
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
  partInputs.push({ part: partIndex + 1, audio, audioSha256: asset.sha256, expectedText: expectedSegments.join(' ') });
}

const uniqueOrdinals = [...new Set(seenOrdinals)];
if (uniqueOrdinals.length !== script.segments.length - 1 || seenOrdinals.length !== uniqueOrdinals.length) throw new Error('Production parts do not cover each non-title speech segment exactly once.');
for (let ordinal = 1; ordinal < script.segments.length; ordinal += 1) if (uniqueOrdinals[ordinal - 1] !== ordinal) throw new Error(`Speech segment coverage gap at ordinal ${ordinal}.`);
const reconstructedFull = partInputs.map((part) => part.expectedText).join(' ');
if (normalizeArabicTranscript(reconstructedFull) !== normalizeArabicTranscript(expectedFull)) throw new Error('Part-boundary reconstruction does not exactly cover the full approved speech script.');

let report = null;
if (await exists(REPORT_FILE)) {
  const previous = JSON.parse(await readFile(REPORT_FILE, 'utf8'));
  if (previous?.audioSha256 === meta.fullAudioSha256 && previous?.partCount === 10 && Array.isArray(previous.parts)) report = previous;
}
if (!report) {
  report = {
    schema: 'bareeq.hamed-final-production-cross-model-per-part.v2',
    status: 'pending',
    articleId: ARTICLE_ID,
    audioSha256: meta.fullAudioSha256,
    partCount: 10,
    expectedWordCount: compareArabicTranscripts(expectedFull, expectedFull).expectedWordCount,
    verificationMode: 'ten-immutable-production-parts-two-distinct-models-exact-checkpointed',
    requiredModels: REQUIRED_MODELS,
    expectedTextDisclosure: 'ASR receives only immutable audio and generic transcription instructions; expected text is compared locally after each response.',
    humanListening: false,
    parts: [],
    technicalEvents: [],
    verifiedAt: null,
  };
}
report.schema = 'bareeq.hamed-final-production-cross-model-per-part.v2';
report.requiredModels = REQUIRED_MODELS;
report.verificationMode = 'ten-immutable-production-parts-two-distinct-models-exact-checkpointed';
report.lastRequestedModels = requestedModels;

for (const part of partInputs) {
  let partReport = report.parts.find((entry) => entry.part === part.part && entry.audioSha256 === part.audioSha256);
  if (!partReport) {
    partReport = { part: part.part, audioSha256: part.audioSha256, expectedWordCount: compareArabicTranscripts(part.expectedText, part.expectedText).expectedWordCount, models: [] };
    report.parts = report.parts.filter((entry) => entry.part !== part.part);
    report.parts.push(partReport);
  }
  for (const model of requestedModels) {
    let modelReport = partReport.models.find((entry) => entry.model === model);
    if (!modelReport) {
      modelReport = { model, status: 'pending', selectedAttempt: null, attempts: [] };
      partReport.models.push(modelReport);
    }
    const alreadyExact = modelReport.attempts.find((attempt) => attempt.exact === true);
    if (alreadyExact) {
      modelReport.status = 'passed';
      modelReport.selectedAttempt = alreadyExact.attempt;
      console.log(`PART_${part.part}_${model}=CHECKPOINT_EXACT attempt=${alreadyExact.attempt}`);
      continue;
    }
    const usedPromptHashes = new Set(modelReport.attempts.map((attempt) => attempt.promptSha256));
    const available = PROMPTS.map((prompt, index) => ({ prompt, index, hash: sha256(prompt) })).filter((entry) => !usedPromptHashes.has(entry.hash));
    let newAttempts = 0;
    for (const promptEntry of available) {
      if (newAttempts >= maxNewLexicalAttempts || modelReport.status === 'passed') break;
      const attemptNumber = modelReport.attempts.length + 1;
      const label = `PART_${part.part}_${model}_ATTEMPT_${attemptNumber}`;
      try {
        const result = await transcribe(model, promptEntry.prompt, part.audio, label);
        const comparison = compareArabicTranscripts(part.expectedText, result.transcript);
        const attempt = {
          attempt: attemptNumber,
          promptIndex: promptEntry.index + 1,
          promptSha256: promptEntry.hash,
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
          checkedAt: new Date().toISOString(),
        };
        modelReport.attempts.push(attempt);
        newAttempts += 1;
        console.log(`${label} expected=${comparison.expectedWordCount} actual=${comparison.actualWordCount} errors=${comparison.wordErrorCount} diff=${JSON.stringify(comparison.operations)}`);
        if (comparison.exact) {
          modelReport.status = 'passed';
          modelReport.selectedAttempt = attemptNumber;
        } else {
          modelReport.status = 'pending';
        }
        await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
      } catch (error) {
        if (error instanceof TechnicalQuotaError) {
          report.technicalEvents.push({ model, part: part.part, at: new Date().toISOString(), message: error.message });
          report.status = 'pending-quota';
          await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
          console.log(`QA_CHECKPOINT_STOP=${model} part=${part.part} reason=quota-or-retry-exhausted`);
          break;
        }
        throw error;
      }
    }
    if (report.status === 'pending-quota') break;
  }
  if (report.status === 'pending-quota') break;
}

report.parts.sort((a, b) => a.part - b.part);
for (const part of report.parts) part.models.sort((a, b) => REQUIRED_MODELS.indexOf(a.model) - REQUIRED_MODELS.indexOf(b.model));
const selectedExactPasses = report.parts.reduce((count, part) => count + REQUIRED_MODELS.filter((model) => part.models.find((entry) => entry.model === model && entry.status === 'passed')).length, 0);
const allPassed = partInputs.every((part) => {
  const partReport = report.parts.find((entry) => entry.part === part.part && entry.audioSha256 === part.audioSha256);
  return REQUIRED_MODELS.every((model) => partReport?.models.find((entry) => entry.model === model && entry.status === 'passed' && entry.attempts.some((attempt) => attempt.attempt === entry.selectedAttempt && attempt.exact === true)));
});
report.selectedExactPasses = selectedExactPasses;
report.requiredExactPasses = partInputs.length * REQUIRED_MODELS.length;
report.progressPercent = Number(((selectedExactPasses / report.requiredExactPasses) * 100).toFixed(1));
report.pendingModelParts = partInputs.flatMap((part) => REQUIRED_MODELS.filter((model) => !report.parts.find((entry) => entry.part === part.part && entry.audioSha256 === part.audioSha256)?.models.find((entry) => entry.model === model && entry.status === 'passed')).map((model) => ({ part: part.part, model })));
report.status = allPassed ? 'passed' : (report.status === 'pending-quota' ? 'pending-quota' : 'pending');
report.verifiedAt = allPassed ? new Date().toISOString() : null;
await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);

if (allPassed) {
  manifest.verifiedStaticAudio = true;
  manifest.automatedTranscriptReview = {
    status: 'passed',
    scope: 'complete-article-all-ten-immutable-parts',
    verificationMode: report.verificationMode,
    reportFile: path.relative(ROOT, REPORT_FILE).replaceAll('\\', '/'),
    reportSha256: sha256(await readFile(REPORT_FILE)),
    transcriptionProvider: 'Google Gemini API',
    transcriptionModels: REQUIRED_MODELS,
    exactModelPassesPerPart: 2,
    partCount: 10,
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
  console.log(`HAMED_FINAL_V3_CROSS_MODEL_ZERO_ERROR=PASS exact=${selectedExactPasses}/${report.requiredExactPasses}`);
} else {
  console.log(`HAMED_FINAL_V3_CHECKPOINT status=${report.status} exact=${selectedExactPasses}/${report.requiredExactPasses} progress=${report.progressPercent}%`);
}
