import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXIT_OK,
  EXIT_QUOTA,
  QUOTA_SPLIT,
  candidateDir,
} from './audio-constants.mjs';
import { loadSpokenArticle, splitSpokenArticle, activeSplitSettings } from './audio-split.mjs';
import { tokenizeVerbal } from './audio-exact-match.mjs';
import { synthesizeGeminiPart, synthesizeGeminiGenerateContentPart } from './audio-gemini-tts.mjs';
import { runProductionMode } from './audio-production.mjs';
import { validateWithConsensus } from './audio-validate-consensus.mjs';
import { writeJson, pathExists } from './audio-checkpoint.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const STATE_PATH = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');
const LIVE_PATH = path.join(ROOT, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gemini free-tier TTS is throttled to ~10 requests/min. The project's own
// generator already uses both Gemini transports (developer-interactions and
// developer-generate-content) as a fallback pair. We retry each part across
// both transports with 9s pacing, bounded retries and a per-run request cap so
// a single run records which parts it finished and pauses cleanly on quota.
async function dualTransportSynthesize({ apiKey }) {
  const transports = [
    ['developer-interactions', synthesizeGeminiPart],
    ['developer-generate-content', synthesizeGeminiGenerateContentPart],
  ];
  const minSpacingMs = 9000;
  const maxRequests = Number(process.env.BAREEQ_REPAIR_MAX_REQUESTS || 40);
  const retryAttempts = Number(process.env.BAREEQ_REPAIR_MAX_429_RETRIES || 6);
  let lastRequestAt = 0;
  let sent = 0;

  const quotaError = (partNumber, detail) => Object.assign(
    new Error(`Gemini TTS quota exhausted after retries for part ${partNumber}${detail ? `: ${detail}` : ''}`),
    { httpStatus: 429, code: 'BAREEQ_QUOTA' },
  );

  return async (args) => {
    const partNumber = Number(args?.part?.partIndex) + 1;
    for (const [transport, synth] of transports) {
      for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
        if (sent >= maxRequests) {
          throw quotaError(partNumber, `request cap ${maxRequests} reached`);
        }
        const now = Date.now();
        const spacingWait = Math.max(0, minSpacingMs - (now - lastRequestAt));
        if (spacingWait) await sleep(spacingWait);
        sent += 1;
        try {
          const output = await synth({
            apiKey,
            part: args.part,
            context: {
              articleTitle: args.article.title,
              partIndex: args.part.partIndex,
              partCount: args.splitPlan.parts.length,
              correctionHint: args.correctionHint,
            },
          });
          lastRequestAt = Date.now();
          console.log(`PROGRESSIVE_REPAIR_TTS_OK part=${partNumber} transport=${transport} attempt=${attempt}`);
          return output;
        } catch (error) {
          const quota = error?.httpStatus === 429 || error?.code === 'BAREEQ_QUOTA';
          if (!quota) throw error;
          const retryMs = Math.max(Number(error?.retryDelay) || 0, 45000);
          console.log(`PROGRESSIVE_REPAIR_QUOTA_WAIT part=${partNumber} transport=${transport} attempt=${attempt} wait=${retryMs}ms`);
          await sleep(retryMs);
        }
      }
    }
    throw quotaError(partNumber);
  };
}

function csvArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || '';
  return new Set(raw.split(',').map((value) => value.trim()).filter(Boolean));
}

function exactConsensusZero(consensus = {}) {
  return ['substitutions', 'deletions', 'insertions', 'unresolved']
    .every((key) => Number(consensus[key]) === 0);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await writeJson(STATE_PATH, state);
}

async function liveDuration(articleId) {
  const live = await readJson(LIVE_PATH, { articles: [] });
  return live?.articles?.find((item) => item.articleId === articleId)?.durationSeconds ?? null;
}

function failedTokenIndices(adjudication = {}) {
  const set = new Set();
  for (const diff of adjudication.substantiveDifferences || []) {
    const index = Number(diff.expectedIndex);
    if (Number.isInteger(index) && index >= 0) set.add(index);
  }
  for (const diff of adjudication.unresolved || []) {
    const index = Number(diff.expectedIndex);
    if (Number.isInteger(index) && index >= 0) set.add(index);
  }
  return [...set].sort((a, b) => a - b);
}

function buildPartRanges(article, durationSeconds) {
  const plan = splitSpokenArticle(article, {
    settings: activeSplitSettings(QUOTA_SPLIT),
    liveDurationSeconds: durationSeconds,
  });
  const ranges = [];
  let offset = 0;
  for (const part of plan.parts) {
    const tokens = tokenizeVerbal(part.text);
    ranges.push({
      partIndex: part.partIndex,
      start: offset,
      end: offset + tokens.length - 1,
      tokens,
    });
    offset += tokens.length;
  }
  return { plan, ranges, total: offset };
}

function partForTokenIndex(ranges, index) {
  for (const range of ranges) {
    if (index >= range.start && index <= range.end) return range;
  }
  // Boundary insertions can land exactly after the final token.
  if (ranges.length) return ranges[ranges.length - 1];
  return null;
}

function buildCorrectionHint(adjudication = {}, range) {
  const problems = [];
  const inRange = (index) => {
    if (range.tokens.length === 0) return false;
    const lo = range.start;
    const hi = range.end;
    return index >= lo && index <= hi;
  };
  for (const diff of adjudication.substantiveDifferences || []) {
    if (!inRange(Number(diff.expectedIndex))) continue;
    if (diff.type === 'insertion') {
      problems.push(`do not insert the extra word(s) "${diff.actual}"`);
    } else if (diff.type === 'deletion') {
      problems.push(`speak the reviewed word "${diff.expected}" exactly; it is currently missing`);
    } else {
      problems.push(`the reviewed word "${diff.expected}" must be spoken exactly; never "${diff.actual}"`);
    }
  }
  for (const diff of adjudication.unresolved || []) {
    const index = Number(diff.expectedIndex);
    if (!inRange(index)) continue;
    const variants = [diff?.first?.actual, diff?.second?.actual].filter(Boolean).join(' or ');
    problems.push(`the reviewed word "${diff.expected}" must be spoken exactly; the following variants were heard: ${variants || 'n/a'}`);
  }
  return problems.join('; ');
}

async function repairArticle({ articleId, state, snapshot }) {
  const row = state.articles?.[articleId] || {};
  const gen = row.generation || {};
  const fingerprint = gen.fingerprint;
  if (!fingerprint || gen.status !== 'generated') {
    return { articleId, status: 'not-ready', note: 'generation not ready' };
  }
  const previousValidation = row.validation || {};
  if (previousValidation.status === 'validated' && previousValidation.fingerprint === fingerprint && exactConsensusZero(previousValidation.consensus)) {
    return { articleId, status: 'already-exact', consensus: previousValidation.consensus };
  }

  const dir = candidateDir(articleId, fingerprint, ROOT);
  const reportsDir = path.join(dir, 'reports');
  const adjudication = await readJson(path.join(reportsDir, 'asr-adjudication.json'));
  if (!adjudication) {
    return { articleId, status: 'missing-adjudication', note: 'no asr-adjudication.json; run inventory first' };
  }
  if (exactConsensusZero(adjudication.consensus)) {
    return { articleId, status: 'already-exact', consensus: adjudication.consensus };
  }

  const article = await loadSpokenArticle(articleId, ROOT);
  const articleTokens = tokenizeVerbal(article.spokenText);
  const duration = await liveDuration(articleId);
  const { plan, ranges, total } = buildPartRanges(article, duration);
  if (total !== articleTokens.length) {
    return { articleId, status: 'split-mismatch', note: `rebuilt ${total} tokens vs expected ${articleTokens.length}` };
  }
  const generationReport = await readJson(path.join(dir, 'generation-report.json'), {});
  if (generationReport.split?.parts && generationReport.split.parts.length !== plan.parts.length) {
    return { articleId, status: 'split-mismatch', note: `rebuilt ${plan.parts.length} parts vs generated ${generationReport.split.parts.length}` };
  }

  const indices = failedTokenIndices(adjudication);
  const failedPartMap = new Map();
  for (const index of indices) {
    const range = partForTokenIndex(ranges, index);
    if (range) failedPartMap.set(range.partIndex, { range, indices: [...(failedPartMap.get(range.partIndex)?.indices || []), index] });
  }
  if (failedPartMap.size === 0) {
    return { articleId, status: 'no-parts', note: 'confirmed errors could not be mapped to parts' };
  }

  const parts = [];
  for (const [partIndex, entry] of [...failedPartMap.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(partIndex + 1);
    entry.range;
  }
  const hints = {};
  for (const [partIndex, entry] of failedPartMap) {
    const hint = buildCorrectionHint(adjudication, entry.range);
    hints[String(partIndex + 1)] = hint || 'Read the reviewed transcript verbatim; preserve every spoken token and ending.';
  }

  process.env.BAREEQ_FORCE_TTS_PARTS = parts.join(',');
  process.env.BAREEQ_TTS_CORRECTION_HINTS_JSON = JSON.stringify(hints);
  const synth = await dualTransportSynthesize({ apiKey: process.env.GEMINI_API_KEY });

  console.log(`PROGRESSIVE_REPAIR_START ${articleId} fingerprint=${fingerprint} parts=${parts.join(',')} tokens=${indices.length} consensus=${JSON.stringify(adjudication.consensus)}`);
  try {
    const generated = await runProductionMode({
      mode: 'generate-candidate',
      articleId,
      root: ROOT,
      synthesize: synth,
    });
    console.log(`PROGRESSIVE_REPAIR_GENERATED ${articleId} parts=${generated.forceRegeneratedParts.join(',')} resumed=${generated.resumedParts}`);
  } catch (error) {
    const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
    const status = quota ? 'paused-quota' : 'repair-failed';
    row.validation = {
      status,
      fingerprint,
      error: String(error?.message || error || '').slice(0, 700),
      updatedAt: new Date().toISOString(),
    };
    state.articles[articleId] = { ...row };
    await saveState(state);
    return { articleId, status, error: String(error?.message || error || '').slice(0, 200) };
  }

  try {
    const result = await validateWithConsensus({ articleId, fingerprint, root: ROOT });
    row.validation = {
      status: result.status,
      fingerprint,
      fullSha256: result.fullSha256,
      consensus: result.consensus,
      representationOnly: result.representationOnly,
      modelDisagreements: result.modelDisagreements,
      repairApplied: true,
      repairedParts: parts,
      completedAt: new Date().toISOString(),
    };
    state.articles[articleId] = { ...row };
    await saveState(state);
    console.log(`PROGRESSIVE_REPAIR_DONE ${articleId} parts=${parts.join(',')} consensus=${JSON.stringify(result.consensus)}`);
    return { articleId, status: 'validated', consensus: result.consensus, parts };
  } catch (error) {
    const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
    const status = quota ? 'paused-quota' : 'failed';
    let consensus = null;
    const fresh = await readJson(path.join(reportsDir, 'asr-adjudication.json'), null);
    if (!quota && fresh) consensus = fresh.consensus || null;
    row.validation = {
      status,
      fingerprint,
      consensus,
      fullSha256: fresh?.fullSha256 || null,
      error: String(error?.message || error || '').slice(0, 700),
      repairApplied: true,
      repairedParts: parts,
      updatedAt: new Date().toISOString(),
    };
    state.articles[articleId] = { ...row };
    await saveState(state);
    console.log(`PROGRESSIVE_REPAIR_${quota ? 'QUOTA' : 'QUALITY'}_FAIL ${articleId} parts=${parts.join(',')} message=${String(error?.message || error || '').slice(0, 240)}`);
    return { articleId, status, error: String(error?.message || error || '').slice(0, 200), consensus };
  }
}

const only = csvArg('only');
const skip = csvArg('skip');
const state = await readJson(STATE_PATH);
const snapshot = await readJson(SNAPSHOT_PATH);
if (!state?.generationComplete || !Array.isArray(snapshot?.articles) || snapshot.articles.length !== 15) {
  throw new Error('progressive repair requires a generation-complete 15/15 checkpoint and the 15-article truth snapshot');
}

const results = [];
for (const item of snapshot.articles) {
  const articleId = item.articleId;
  if (skip.has(articleId) || (only.size > 0 && !only.has(articleId))) continue;
  const row = state.articles?.[articleId] || {};
  const gen = row.generation || {};
  const val = row.validation || {};
  if (gen.status !== 'generated') continue;
  if (val.status === 'validated' && val.fingerprint === gen.fingerprint && exactConsensusZero(val.consensus)) {
    console.log(`PROGRESSIVE_REPAIR_SKIP ${articleId} already-exact`);
    continue;
  }
  const result = await repairArticle({ articleId, state, snapshot });
  results.push(result);
}

const nowExact = snapshot.articles.filter((item) => {
  const row = state.articles?.[item.articleId] || {};
  return row.validation?.status === 'validated'
    && row.validation?.fingerprint === row.generation?.fingerprint
    && exactConsensusZero(row.validation?.consensus);
});
console.log(`PROGRESSIVE_REPAIR_SUMMARY exact=${nowExact.length}/15 attempted=${results.length}`);
console.log(JSON.stringify(results, null, 2));
process.exit(EXIT_OK);
