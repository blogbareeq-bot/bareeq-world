import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEPENDENT_ASR_MODELS, sha256 } from './audio-constants.mjs';
import { compareExactSpokenText } from './audio-exact-match.mjs';
import { adjudicateDualAsr } from './audio-dual-asr-adjudicate.mjs';
import { uploadAudioFile, buildInteractionBody, extractTranscript, extractResponseModel } from './audio-asr-transcribe.mjs';
import { deleteUploadedFile } from './audio-files-api.mjs';
import { probeAudio, measureLoudness, longestInternalSilenceSeconds, edgeSilenceMs, PRODUCTION_LOUDNESS } from './audio-technical-qa.mjs';
import { decodePcm } from './audio-merge.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'openrouter-sadaltager-pilot-artifacts');
const SAMPLES_PATH = path.join(ROOT, 'docs', 'audio', 'OPENROUTER-SADALTAGER-PILOT-SAMPLES.json');
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';

function headers(apiKey) {
  return {
    'x-goog-api-key': apiKey,
    'Api-Revision': API_REVISION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function technicalPass({ probe, loudness, durationSeconds, internalSilenceSeconds, edges }) {
  return Boolean(
    probe?.decoded
    && durationSeconds > 0
    && Number.isFinite(loudness?.integratedLufs)
    && loudness.integratedLufs >= PRODUCTION_LOUDNESS.integratedMinLufs
    && loudness.integratedLufs <= PRODUCTION_LOUDNESS.integratedMaxLufs
    && Number.isFinite(loudness?.truePeakDbTP)
    && loudness.truePeakDbTP <= PRODUCTION_LOUDNESS.maxTruePeakDbTP
    && internalSilenceSeconds <= PRODUCTION_LOUDNESS.maxInternalSilenceSeconds
    && edges.startMs < PRODUCTION_LOUDNESS.silentStartFailMs
  );
}

async function transcribeOne({ model, uploaded, expectedText, apiKey, sample, fingerprint, fullSha256 }) {
  const response = await fetch(INTERACTIONS, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(buildInteractionBody(model, uploaded)),
  });
  const raw = await response.text();
  if (response.status === 429) throw Object.assign(new Error(`ASR quota exhausted for ${model}`), { exitCode: 75 });
  if (!response.ok) throw new Error(`ASR ${model} failed HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const payload = JSON.parse(raw);
  const responseModel = extractResponseModel(payload);
  if (responseModel && !String(responseModel).includes(model)) throw new Error(`ASR response model ${responseModel} does not match requested ${model}`);
  const transcript = extractTranscript(payload);
  if (!transcript) throw new Error(`ASR ${model} returned an empty transcript`);
  const comparison = compareExactSpokenText(expectedText, transcript);
  return {
    schema: 'bareeq.audio-openrouter-sadaltager-pilot-asr.v1',
    status: comparison.passed ? 'passed' : 'failed',
    articleId: sample.articleId,
    sampleId: sample.sampleId,
    candidateFingerprint: fingerprint,
    fingerprint,
    fullSha256,
    model,
    requestedModel: model,
    actualResponseModel: responseModel || null,
    substitutions: comparison.substitutions,
    deletions: comparison.deletions,
    insertions: comparison.insertions,
    transcript,
    differences: comparison.differences,
    provider: 'google-gemini-asr-verification-only',
    ttsEngineUnderTest: 'openrouter/google-gemini-3.1-flash-tts-preview/Sadaltager',
    generatedAt: new Date().toISOString(),
  };
}

async function evaluateSample(sample, indexEntry, apiKey) {
  const audioPath = path.join(ROOT, indexEntry.outputFile);
  const bytes = await readFile(audioPath);
  const fullSha256 = sha256(bytes);
  if (fullSha256 !== indexEntry.audioSha256) throw new Error(`${sample.sampleId}: generated audio SHA mismatch`);
  const probe = await probeAudio(audioPath);
  const loudness = await measureLoudness(audioPath);
  const durationSeconds = mp3DurationSeconds(bytes);
  const pcm = await decodePcm(audioPath);
  const internalSilenceSeconds = longestInternalSilenceSeconds(pcm);
  const edges = edgeSilenceMs(pcm);
  const technicalQa = {
    passed: technicalPass({ probe, loudness, durationSeconds, internalSilenceSeconds, edges }),
    probe,
    loudness: { integratedLufs: loudness.integratedLufs, truePeakDbTP: loudness.truePeakDbTP },
    durationSeconds,
    internalSilenceSeconds,
    edgeSilenceMs: edges,
    thresholds: PRODUCTION_LOUDNESS,
  };

  const uploaded = await uploadAudioFile({ apiKey, bytes, displayName: `bareeq-openrouter-pilot-${sample.sampleId}.mp3` });
  const reports = [];
  try {
    for (const model of INDEPENDENT_ASR_MODELS) {
      reports.push(await transcribeOne({ model, uploaded, expectedText: sample.text, apiKey, sample, fingerprint: indexEntry.fingerprint, fullSha256 }));
    }
  } finally {
    await deleteUploadedFile({ apiKey, name: uploaded.name }).catch(() => ({ deleted: false }));
  }

  const adjudication = adjudicateDualAsr({
    expectedText: sample.text,
    reports,
    articleId: sample.articleId,
    fingerprint: indexEntry.fingerprint,
    fullSha256,
    speechScriptHash: indexEntry.bindings?.speechScriptHash || null,
    models: INDEPENDENT_ASR_MODELS,
  });
  const openrouterErrors = Object.values(adjudication.consensus).reduce((sum, value) => sum + Number(value || 0), 0);
  const baselineErrors = Number(sample.baselineErrors || 0);
  return {
    sampleId: sample.sampleId,
    articleId: sample.articleId,
    baselineErrors,
    openrouterErrors,
    delta: baselineErrors - openrouterErrors,
    technicalQa,
    adjudication,
    asrReports: reports,
    lexicalPass: adjudication.passed,
    audioSha256: fullSha256,
    fingerprint: indexEntry.fingerprint,
  };
}

export function decidePilot(results) {
  const regressions = results.filter((item) => item.delta < 0).length;
  const severeRegression = results.some((item) => item.delta <= -3);
  const moreThanOneRegression = results.some((item) => item.delta < -1);
  const improvements = results.filter((item) => item.delta > 0).length;
  const totalDelta = results.reduce((sum, item) => sum + item.delta, 0);
  const technicalPassAll = results.every((item) => item.technicalQa?.passed === true);
  const passed = technicalPassAll && regressions < 2 && !severeRegression && !moreThanOneRegression && totalDelta > 0 && improvements >= 2;
  return {
    status: passed ? 'technical-pilot-pass-awaiting-engine-activation-review' : 'technical-pilot-fail',
    passed,
    regressions,
    improvements,
    totalDelta,
    technicalPassAll,
    productionActivationAuthorized: false,
    nextGate: passed
      ? 'human review of evidence before wiring OpenRouter as paid secondary transport'
      : 'do not wire OpenRouter into production repair; retain direct Gemini kill switch and evaluate another engine',
  };
}

export async function evaluatePilot({ apiKey = process.env.GEMINI_API_KEY } = {}) {
  if (!apiKey?.trim()) throw new Error('GEMINI_API_KEY is required for independent Dual-ASR verification of the OpenRouter pilot.');
  const config = JSON.parse(await readFile(SAMPLES_PATH, 'utf8'));
  const index = JSON.parse(await readFile(path.join(OUTPUT_ROOT, 'index.json'), 'utf8'));
  if (index.publicationAllowed !== false || index.productionAudioTouched !== false) throw new Error('Pilot index safety contract is invalid.');
  const byId = new Map((index.reports || []).map((entry) => [entry.sampleId, entry]));
  const results = [];
  for (const sample of config.samples || []) {
    const indexEntry = byId.get(sample.sampleId);
    if (!indexEntry) throw new Error(`Missing generated pilot sample ${sample.sampleId}`);
    results.push(await evaluateSample(sample, indexEntry, apiKey));
  }
  const decision = decidePilot(results);
  const report = {
    schema: 'bareeq.audio-openrouter-sadaltager-pilot-evaluation.v1',
    engine: index.engine,
    safety: {
      productionAudioTouched: false,
      publicationAllowed: false,
      automaticEngineSwitchAllowed: false,
    },
    results,
    decision,
    generatedAt: new Date().toISOString(),
  };
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(path.join(OUTPUT_ROOT, 'evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const result = await evaluatePilot();
  console.log(`OPENROUTER_SADALTAGER_PILOT_EVALUATION status=${result.decision.status} totalDelta=${result.decision.totalDelta} improvements=${result.decision.improvements}/3`);
  if (!result.decision.passed) process.exitCode = 1;
}
