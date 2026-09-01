/**
 * OpenRouter ASR capability probe.
 *
 * Runs inside GitHub Actions (the only place OPENROUTER_API_KEY exists) and
 * answers the questions that decide the ASR architecture:
 *
 *   1. Which OpenRouter models can transcribe at all?
 *   2. Which of them actually handle Modern Standard Arabic well enough that
 *      the existing exact 0/0/0 consensus gate is reachable?
 *
 * It transcribes a small number of *parts* of an already-generated candidate
 * (no TTS is performed, nothing is regenerated) and reports exact lexical
 * S/D/I against the expected part text, using the unmodified comparison from
 * audio-exact-match.mjs.
 *
 * Output is written as JSON so it can be committed to the branch and read
 * without access to Actions logs or artifacts.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { candidateDir, sha256 } from './audio-constants.mjs';
import { compareExactSpokenText } from './audio-exact-match.mjs';
import { loadSpokenArticle, splitSpokenArticle } from './audio-split.mjs';
import {
  listAudioInputModels,
  listTranscriptionModels,
  transcribeViaChatAudio,
  transcribeViaSttEndpoint,
} from './audio-openrouter-asr.mjs';

const ROOT = process.cwd();
const STORE = process.env.BAREEQ_AUDIO_STORE || path.join(ROOT, 'audio-candidates');
const CAMPAIGN = process.env.BAREEQ_AUDIO_CAMPAIGN_ID || 'sadaltager-openrouter-20260901-v1';
const ARTICLE = process.env.BAREEQ_PROBE_ARTICLE || 'ai-agents-future-now';
const OUT = process.env.BAREEQ_PROBE_OUTPUT || path.join(ROOT, 'docs', 'audio', 'asr-probe', 'openrouter-probe.json');
const MAX_PARTS = Number(process.env.BAREEQ_PROBE_MAX_PARTS || 3);

const STT_CANDIDATES = (process.env.BAREEQ_PROBE_STT_MODELS
  || 'openai/whisper-large-v3,openai/whisper-large-v3-turbo,mistralai/voxtral-mini-transcribe,openai/gpt-4o-transcribe'
).split(',').map((value) => value.trim()).filter(Boolean);

const CHAT_CANDIDATES = (process.env.BAREEQ_PROBE_CHAT_MODELS
  || 'google/gemini-2.5-flash,google/gemini-2.5-pro,openai/gpt-4o-audio-preview'
).split(',').map((value) => value.trim()).filter(Boolean);

const apiKey = process.env.OPENROUTER_API_KEY;

async function loadCandidate() {
  const statePath = path.join(STORE, '_campaigns', CAMPAIGN, 'state.json');
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    let topLevel = [];
    try { topLevel = await readdir(STORE); } catch { /* store missing */ }
    throw new Error(`cannot read campaign state at ${statePath}: ${error.message}; store contains: ${topLevel.slice(0, 40).join(', ')}`);
  }
  const fingerprint = state?.articles?.[ARTICLE]?.generation?.fingerprint;
  if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) {
    throw new Error(`no generated fingerprint for ${ARTICLE}; known articles: ${Object.keys(state?.articles || {}).join(', ')}`);
  }
  const dir = candidateDir(ARTICLE, fingerprint, STORE);
  let checkpoint = null;
  try {
    checkpoint = JSON.parse(await readFile(path.join(dir, 'checkpoint.json'), 'utf8'));
  } catch { /* checkpoint is optional for the probe */ }
  const partsDir = path.join(dir, 'parts');
  let files = [];
  try {
    files = (await readdir(partsDir)).filter((name) => name.endsWith('.mp3')).sort();
  } catch (error) {
    let dirEntries = [];
    try { dirEntries = await readdir(dir); } catch { /* candidate dir missing */ }
    throw new Error(`cannot read parts dir ${partsDir}: ${error.message}; candidate dir contains: ${dirEntries.join(', ')}`);
  }
  if (!files.length) throw new Error(`no part mp3 files under ${partsDir}`);
  return { fingerprint, dir, partsDir, files, checkpoint };
}

/**
 * Expected text per part comes from the deterministic split plan, which is the
 * exact text that part was synthesised from. The checkpoint stores part
 * fingerprints but not the text, so recomputing the split is the only
 * authoritative source.
 */
function expectedForPart(splitPlan, partIndex) {
  return splitPlan?.parts?.[partIndex]?.text ?? null;
}

async function probeModel({ kind, model, samples }) {
  const runs = [];
  for (const sample of samples) {
    const bytes = await readFile(sample.file);
    let result;
    try {
      const run = kind === 'stt' ? transcribeViaSttEndpoint : transcribeViaChatAudio;
      result = await run({ apiKey, model, bytes, format: 'mp3' });
    } catch (error) {
      runs.push({
        part: sample.partIndex + 1,
        ok: false,
        error: String(error?.message || error).slice(0, 500),
        audioSha256: sha256(bytes),
      });
      continue;
    }
    const comparison = sample.expected && result.transcript
      ? compareExactSpokenText(sample.expected, result.transcript)
      : null;
    runs.push({
      part: sample.partIndex + 1,
      ok: result.ok,
      httpStatus: result.httpStatus,
      requestId: result.requestId,
      responseModel: result.responseModel,
      usage: result.usage,
      audioSha256: result.audioSha256,
      audioBytes: result.audioBytes,
      error: result.error,
      transcript: (result.transcript || '').slice(0, 4000),
      expectedTokens: comparison?.expectedTokens ?? null,
      transcriptTokens: comparison?.transcriptTokens ?? null,
      substitutions: comparison?.substitutions ?? null,
      deletions: comparison?.deletions ?? null,
      insertions: comparison?.insertions ?? null,
      exact: comparison?.passed ?? null,
      sampleDifferences: (comparison?.differences || []).slice(0, 25),
    });
  }
  const scored = runs.filter((run) => Number.isFinite(run.substitutions));
  const totals = scored.reduce((acc, run) => ({
    substitutions: acc.substitutions + run.substitutions,
    deletions: acc.deletions + run.deletions,
    insertions: acc.insertions + run.insertions,
    expectedTokens: acc.expectedTokens + (run.expectedTokens || 0),
  }), { substitutions: 0, deletions: 0, insertions: 0, expectedTokens: 0 });
  const errors = totals.substitutions + totals.deletions + totals.insertions;
  return {
    kind,
    model,
    usable: scored.length > 0,
    partsProbed: runs.length,
    partsScored: scored.length,
    totals,
    tokenErrorRate: totals.expectedTokens ? Number((errors / totals.expectedTokens).toFixed(5)) : null,
    runs,
  };
}

async function main() {
  const report = {
    schema: 'bareeq.openrouter-asr-probe.v1',
    generatedAt: new Date().toISOString(),
    gateway: 'openrouter',
    article: ARTICLE,
    campaignId: CAMPAIGN,
    note: 'Probe only. No TTS was performed and no audio was regenerated.',
    stage: 'start',
    fatalError: null,
    discovery: {},
    probes: [],
  };

  // Actions logs and artifacts are not readable from the release workspace, so
  // the report is flushed to disk after every stage. Whatever fails, the
  // committed JSON explains why.
  const flush = async () => {
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
  };

  try {
    if (!apiKey?.trim()) {
      report.stage = 'missing-credential';
      report.fatalError = 'OPENROUTER_API_KEY is absent';
      await flush();
      console.error('OPENROUTER_API_KEY_PRESENT=no');
      process.exit(78);
    }

    report.stage = 'discovery';
    await flush();
    try {
      report.discovery.transcriptionModels = await listTranscriptionModels({ apiKey });
    } catch (error) {
      report.discovery.transcriptionModelsError = String(error?.message || error).slice(0, 800);
    }
    try {
      report.discovery.audioInputModels = await listAudioInputModels({ apiKey });
    } catch (error) {
      report.discovery.audioInputModelsError = String(error?.message || error).slice(0, 800);
    }
    await flush();

    report.stage = 'load-candidate';
    const candidate = await loadCandidate();
    report.fingerprint = candidate.fingerprint;
    report.totalParts = candidate.files.length;
    report.partFiles = candidate.files;
    await flush();

    report.stage = 'load-article';
    const article = await loadSpokenArticle(ARTICLE, ROOT);
    const splitPlan = splitSpokenArticle(article);
    report.speechScriptHash = article.speechScriptHash;
    report.splitParts = splitPlan.parts.length;
    if (splitPlan.parts.length !== candidate.files.length) {
      report.partCountMismatch = {
        splitPlan: splitPlan.parts.length,
        candidateFiles: candidate.files.length,
      };
    }

    // Probe part 1, part 5 (the confirmed «المشكلة» singular correction) and
    // part 3, so the probe covers both corrected and untouched audio.
    const wanted = [...new Set([0, 4, 2])]
      .filter((index) => index < candidate.files.length && index < splitPlan.parts.length)
      .slice(0, MAX_PARTS);
    const samples = wanted.map((partIndex) => ({
      partIndex,
      file: path.join(candidate.partsDir, candidate.files[partIndex]),
      expected: expectedForPart(splitPlan, partIndex),
    }));
    report.samples = samples.map((sample) => ({
      part: sample.partIndex + 1,
      file: path.basename(sample.file),
      hasExpectedText: Boolean(sample.expected),
      expectedChars: sample.expected ? sample.expected.length : 0,
    }));
    await flush();

    report.stage = 'probing';
    for (const model of STT_CANDIDATES) {
      console.log(`probing STT ${model}`);
      report.probes.push(await probeModel({ kind: 'stt', model, samples }));
      await flush();
    }
    for (const model of CHAT_CANDIDATES) {
      console.log(`probing CHAT ${model}`);
      report.probes.push(await probeModel({ kind: 'chat', model, samples }));
      await flush();
    }

    report.stage = 'complete';
    await flush();

    console.log('--- PROBE SUMMARY ---');
    for (const probe of report.probes) {
      console.log([
        probe.kind,
        probe.model,
        `scored=${probe.partsScored}/${probe.partsProbed}`,
        `S/D/I=${probe.totals.substitutions}/${probe.totals.deletions}/${probe.totals.insertions}`,
        `tokens=${probe.totals.expectedTokens}`,
        `errRate=${probe.tokenErrorRate}`,
      ].join(' '));
    }
    console.log(`PROBE_OUTPUT=${OUT}`);
  } catch (error) {
    report.fatalError = {
      stage: report.stage,
      message: String(error?.message || error).slice(0, 1200),
      stack: String(error?.stack || '').slice(0, 3000),
    };
    await flush();
    throw error;
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(error?.exitCode || 1);
});
