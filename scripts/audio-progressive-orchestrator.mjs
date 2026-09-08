import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXIT_QUOTA,
  QUOTA_SPLIT,
  candidateDir,
  sha256,
} from './audio-constants.mjs';
import { loadSpokenArticle, splitSpokenArticle, activeSplitSettings } from './audio-split.mjs';
import { tokenizeVerbal } from './audio-exact-match.mjs';
import { synthesizeGeminiPart, synthesizeGeminiGenerateContentPart } from './audio-gemini-tts.mjs';
import { runProductionMode } from './audio-production.mjs';
import { validateWithConsensus } from './audio-validate-consensus.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const STATE_PATH = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');
const LIVE_PATH = path.join(ROOT, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json');
const KEYS = ['substitutions', 'deletions', 'insertions', 'unresolved'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function exactConsensusZero(consensus = {}) {
  return KEYS.every((key) => Number.isFinite(Number(consensus[key])) && Number(consensus[key]) === 0);
}

function usableConsensus(consensus = {}) {
  return KEYS.every((key) => Number.isFinite(Number(consensus[key])) && Number(consensus[key]) >= 0);
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

async function currentFullSha(articleId, fingerprint) {
  const full = path.join(candidateDir(articleId, fingerprint, ROOT), 'full.mp3');
  if (!await pathExists(full)) return null;
  return sha256(await readFile(full));
}

async function reusableAdjudication(articleId, fingerprint) {
  const dir = candidateDir(articleId, fingerprint, ROOT);
  const report = await readJson(path.join(dir, 'reports', 'asr-adjudication.json'), null);
  if (!report || !usableConsensus(report.consensus)) return null;
  if ((report.candidateFingerprint || report.fingerprint) !== fingerprint) return null;
  const fullSha = await currentFullSha(articleId, fingerprint);
  if (!fullSha || report.fullSha256 !== fullSha) return null;
  return report;
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
  return ranges.length ? ranges[ranges.length - 1] : null;
}

function buildCorrectionHint(adjudication = {}, range) {
  const problems = [];
  const inRange = (index) => range.tokens.length > 0 && index >= range.start && index <= range.end;
  for (const diff of adjudication.substantiveDifferences || []) {
    if (!inRange(Number(diff.expectedIndex))) continue;
    if (diff.type === 'insertion') problems.push(`do not insert the extra word(s) "${diff.actual}"`);
    else if (diff.type === 'deletion') problems.push(`speak the reviewed word "${diff.expected}" exactly; it is currently missing`);
    else problems.push(`the reviewed word "${diff.expected}" must be spoken exactly; never "${diff.actual}"`);
  }
  for (const diff of adjudication.unresolved || []) {
    if (!inRange(Number(diff.expectedIndex))) continue;
    const variants = [diff?.first?.actual, diff?.second?.actual].filter(Boolean).join(' or ');
    problems.push(`the reviewed word "${diff.expected}" must be spoken exactly; the following variants were heard: ${variants || 'n/a'}`);
  }
  return problems.join('; ');
}

function isTransientTts(error) {
  const status = Number(error?.httpStatus || 0);
  if ([500, 502, 503, 504].includes(status)) return true;
  return /transport failed|service is currently unavailable|temporarily unavailable|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(error?.message || ''));
}

function retryDelayFromQuota(error) {
  const message = String(error?.message || '');
  const match = message.match(/"retryDelay"\s*:\s*"([0-9.]+)s"/i);
  if (!match) return 0;
  const ms = Math.ceil(Number(match[1]) * 1000);
  return Number.isFinite(ms) ? ms : 0;
}

function quotaError(partNumber, detail = '') {
  return Object.assign(
    new Error(`Gemini TTS quota exhausted for part ${partNumber}${detail ? `: ${detail}` : ''}`),
    { httpStatus: 429, code: 'BAREEQ_QUOTA', exitCode: EXIT_QUOTA },
  );
}

function createSharedSynthesizer({ apiKey }) {
  const transports = [
    ['developer-interactions', synthesizeGeminiPart],
    ['developer-generate-content', synthesizeGeminiGenerateContentPart],
  ];
  const maxRequests = Number(process.env.BAREEQ_REPAIR_MAX_REQUESTS || 10);
  const minSpacingMs = Number(process.env.BAREEQ_REPAIR_MIN_SPACING_MS || 9000);
  const transientRetries = Number(process.env.BAREEQ_REPAIR_TRANSIENT_RETRIES || 2);
  const maxThrottleWaitMs = Number(process.env.BAREEQ_REPAIR_MAX_THROTTLE_WAIT_MS || 90000);
  const budget = {
    sent: 0,
    lastRequestAt: 0,
    quotaTransports: new Set(),
  };

  const synthesize = async (args) => {
    const partNumber = Number(args?.part?.partIndex) + 1;
    let sawQuota = false;
    for (const [transport, synth] of transports) {
      if (budget.quotaTransports.has(transport)) {
        sawQuota = true;
        continue;
      }
      for (let attempt = 1; attempt <= transientRetries; attempt += 1) {
        if (budget.sent >= maxRequests) throw quotaError(partNumber, `run request cap ${maxRequests} reached`);
        const spacingWait = Math.max(0, minSpacingMs - (Date.now() - budget.lastRequestAt));
        if (spacingWait) await sleep(spacingWait);
        budget.sent += 1;
        budget.lastRequestAt = Date.now();
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
          console.log(`PROGRESSIVE_TTS_OK part=${partNumber} transport=${transport} attempt=${attempt} runRequests=${budget.sent}/${maxRequests}`);
          return output;
        } catch (error) {
          const quota = error?.httpStatus === 429 || error?.code === 'BAREEQ_QUOTA' || error?.exitCode === EXIT_QUOTA;
          if (quota) {
            const retryMs = retryDelayFromQuota(error);
            if (retryMs > 0 && retryMs <= maxThrottleWaitMs && attempt < transientRetries) {
              console.log(`PROGRESSIVE_TTS_THROTTLE_RETRY transport=${transport} part=${partNumber} attempt=${attempt} wait=${retryMs}ms`);
              await sleep(retryMs);
              continue;
            }
            budget.quotaTransports.add(transport);
            sawQuota = true;
            console.log(`PROGRESSIVE_TTS_QUOTA transport=${transport} part=${partNumber} runRequests=${budget.sent}/${maxRequests} retryDelayMs=${retryMs || 0}`);
            break;
          }
          if (isTransientTts(error) && attempt < transientRetries) {
            const waitMs = attempt === 1 ? 15000 : 45000;
            console.log(`PROGRESSIVE_TTS_TRANSIENT_RETRY transport=${transport} part=${partNumber} attempt=${attempt} wait=${waitMs}ms`);
            await sleep(waitMs);
            continue;
          }
          throw error;
        }
      }
    }
    if (sawQuota) throw quotaError(partNumber, 'all available transports are quota-blocked');
    throw new Error(`Gemini TTS failed for part ${partNumber} on all transports`);
  };

  return { synthesize, budget };
}

async function ensureAdjudication({ item, state }) {
  const articleId = item.articleId;
  const row = state.articles?.[articleId] || {};
  const fingerprint = row.generation?.fingerprint;
  if (!fingerprint || row.generation?.status !== 'generated') return { status: 'not-ready' };
  if (row.validation?.status === 'validated' && row.validation?.fingerprint === fingerprint && exactConsensusZero(row.validation?.consensus)) {
    return { status: 'exact' };
  }

  const reusable = await reusableAdjudication(articleId, fingerprint);
  if (reusable) {
    const repairProgress = row.validation?.repairProgress || null;
    if (!repairProgress) {
      row.validation = {
        ...row.validation,
        status: exactConsensusZero(reusable.consensus) ? 'validated' : 'failed',
        fingerprint,
        fullSha256: reusable.fullSha256,
        consensus: reusable.consensus,
        representationOnly: reusable.representationOnly?.length || 0,
        modelDisagreements: reusable.modelDisagreements?.length || 0,
        evidenceReused: true,
        updatedAt: new Date().toISOString(),
      };
      state.articles[articleId] = row;
      await saveState(state);
    }
    console.log(`PROGRESSIVE_ASR_REUSE ${articleId} consensus=${JSON.stringify(reusable.consensus)} progress=${repairProgress ? 'yes' : 'no'}`);
    return { status: exactConsensusZero(reusable.consensus) ? 'exact' : 'repairable', adjudication: reusable };
  }

  console.log(`PROGRESSIVE_ASR_START ${articleId} ${fingerprint}`);
  try {
    const result = await validateWithConsensus({ articleId, fingerprint, root: ROOT });
    row.validation = {
      status: result.status,
      fingerprint,
      fullSha256: result.fullSha256,
      consensus: result.consensus,
      representationOnly: result.representationOnly,
      modelDisagreements: result.modelDisagreements,
      completedAt: new Date().toISOString(),
    };
    state.articles[articleId] = row;
    await saveState(state);
    return { status: 'exact' };
  } catch (error) {
    if (error?.result?.consensus && usableConsensus(error.result.consensus)) {
      row.validation = {
        status: 'failed',
        fingerprint,
        fullSha256: error.result.fullSha256 || await currentFullSha(articleId, fingerprint),
        consensus: error.result.consensus,
        representationOnly: error.result.representationOnly?.length || 0,
        modelDisagreements: error.result.modelDisagreements?.length || 0,
        updatedAt: new Date().toISOString(),
      };
      state.articles[articleId] = row;
      await saveState(state);
      console.log(`PROGRESSIVE_ASR_QUALITY ${articleId} consensus=${JSON.stringify(error.result.consensus)}`);
      return { status: 'repairable', adjudication: error.result };
    }
    const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
    const message = String(error?.message || error || '').slice(0, 700);
    row.validation = {
      ...row.validation,
      status: quota ? 'paused-asr-quota' : 'paused-asr',
      fingerprint,
      error: message,
      updatedAt: new Date().toISOString(),
    };
    state.articles[articleId] = row;
    await saveState(state);
    console.log(`PROGRESSIVE_ASR_PROVIDER_BLOCK ${articleId} ${message.slice(0, 220)}`);
    return { status: 'provider-block', error: message };
  }
}

async function buildRepairPlan({ item, state, adjudication }) {
  const articleId = item.articleId;
  const row = state.articles?.[articleId] || {};
  const fingerprint = row.generation?.fingerprint;
  const article = await loadSpokenArticle(articleId, ROOT);
  const duration = await liveDuration(articleId);
  const { plan, ranges, total } = buildPartRanges(article, duration);
  const articleTokens = tokenizeVerbal(article.spokenText);
  if (total !== articleTokens.length) throw new Error(`${articleId}: rebuilt ${total} tokens vs expected ${articleTokens.length}`);
  const generationReport = await readJson(path.join(candidateDir(articleId, fingerprint, ROOT), 'generation-report.json'), {});
  if (generationReport.split?.parts && generationReport.split.parts.length !== plan.parts.length) {
    throw new Error(`${articleId}: rebuilt ${plan.parts.length} parts vs generated ${generationReport.split.parts.length}`);
  }

  const indices = failedTokenIndices(adjudication);
  const failedPartMap = new Map();
  for (const index of indices) {
    const range = partForTokenIndex(ranges, index);
    if (range) failedPartMap.set(range.partIndex, range);
  }
  const targetParts = [...failedPartMap.keys()].sort((a, b) => a - b).map((index) => index + 1);
  if (!targetParts.length) return null;
  const planKey = `${fingerprint}:${adjudication.fullSha256 || 'no-sha'}:${targetParts.join(',')}`;
  const previousProgress = row.validation?.repairProgress?.planKey === planKey ? row.validation.repairProgress : null;
  const completedParts = new Set((previousProgress?.completedParts || []).map(Number));
  const remainingParts = targetParts.filter((part) => !completedParts.has(part));
  const hints = {};
  for (const [partIndex, range] of failedPartMap) {
    const oneBased = partIndex + 1;
    if (!remainingParts.includes(oneBased)) continue;
    hints[String(oneBased)] = buildCorrectionHint(adjudication, range)
      || 'Read the reviewed transcript verbatim; preserve every spoken token and ending.';
  }
  return {
    article,
    planKey,
    targetParts,
    completedParts: [...completedParts].sort((a, b) => a - b),
    remainingParts,
    hints,
    errorTokens: indices.length,
  };
}

async function persistRepairProgress({ state, articleId, fingerprint, adjudication, plan, newlyCompleted = [], status, error = null }) {
  const row = state.articles?.[articleId] || {};
  const completed = new Set([...plan.completedParts, ...newlyCompleted].map(Number));
  row.validation = {
    ...row.validation,
    status,
    fingerprint,
    fullSha256: adjudication.fullSha256 || row.validation?.fullSha256 || null,
    consensus: adjudication.consensus || row.validation?.consensus || null,
    repairProgress: {
      planKey: plan.planKey,
      sourceFullSha256: adjudication.fullSha256 || null,
      targetParts: plan.targetParts,
      completedParts: [...completed].sort((a, b) => a - b),
      remainingParts: plan.targetParts.filter((part) => !completed.has(part)),
      updatedAt: new Date().toISOString(),
    },
    error: error ? String(error).slice(0, 700) : null,
    updatedAt: new Date().toISOString(),
  };
  state.articles[articleId] = row;
  await saveState(state);
}

async function repairOne({ item, state, adjudication, plan, synthesize }) {
  const articleId = item.articleId;
  const row = state.articles?.[articleId] || {};
  const fingerprint = row.generation?.fingerprint;
  process.env.BAREEQ_FORCE_TTS_PARTS = plan.remainingParts.join(',');
  process.env.BAREEQ_TTS_CORRECTION_HINTS_JSON = JSON.stringify(plan.hints);
  console.log(`PROGRESSIVE_REPAIR_START ${articleId} target=${plan.targetParts.join(',')} completed=${plan.completedParts.join(',') || '-'} remaining=${plan.remainingParts.join(',') || '-'} errors=${plan.errorTokens}`);

  let generated;
  try {
    generated = await runProductionMode({
      mode: 'generate-candidate',
      articleId,
      root: ROOT,
      synthesize,
    });
  } catch (error) {
    const partial = error?.result || {};
    const newlyCompleted = Array.isArray(partial.forceRegeneratedParts) ? partial.forceRegeneratedParts : [];
    const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
    await persistRepairProgress({
      state,
      articleId,
      fingerprint,
      adjudication,
      plan,
      newlyCompleted,
      status: quota ? 'paused-quota' : 'repair-failed',
      error: error?.message || error,
    });
    console.log(`PROGRESSIVE_REPAIR_PAUSE ${articleId} status=${quota ? 'paused-quota' : 'repair-failed'} newlyCompleted=${newlyCompleted.join(',') || '-'} message=${String(error?.message || error || '').slice(0, 220)}`);
    return { status: quota ? 'quota' : 'failed', newlyCompleted };
  }

  const newlyCompleted = Array.isArray(generated.forceRegeneratedParts) ? generated.forceRegeneratedParts : [];
  await persistRepairProgress({
    state,
    articleId,
    fingerprint,
    adjudication,
    plan,
    newlyCompleted,
    status: 'repair-generated-awaiting-asr',
  });

  console.log(`PROGRESSIVE_REPAIR_ASR ${articleId} newlyCompleted=${newlyCompleted.join(',') || '-'} resumed=${generated.resumedParts}`);
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
      repairedParts: plan.targetParts,
      completedAt: new Date().toISOString(),
    };
    state.articles[articleId] = row;
    await saveState(state);
    console.log(`PROGRESSIVE_REPAIR_EXACT ${articleId} consensus=${JSON.stringify(result.consensus)}`);
    return { status: 'exact' };
  } catch (error) {
    if (error?.result?.consensus && usableConsensus(error.result.consensus)) {
      row.validation = {
        status: 'failed',
        fingerprint,
        fullSha256: error.result.fullSha256 || await currentFullSha(articleId, fingerprint),
        consensus: error.result.consensus,
        representationOnly: error.result.representationOnly?.length || 0,
        modelDisagreements: error.result.modelDisagreements?.length || 0,
        repairApplied: true,
        repairedParts: plan.targetParts,
        error: String(error?.message || error || '').slice(0, 700),
        updatedAt: new Date().toISOString(),
      };
      state.articles[articleId] = row;
      await saveState(state);
      console.log(`PROGRESSIVE_REPAIR_QUALITY ${articleId} consensus=${JSON.stringify(error.result.consensus)}`);
      return { status: 'quality' };
    }
    const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
    row.validation = {
      ...row.validation,
      status: quota ? 'paused-asr-quota' : 'paused-asr',
      fingerprint,
      error: String(error?.message || error || '').slice(0, 700),
      updatedAt: new Date().toISOString(),
    };
    state.articles[articleId] = row;
    await saveState(state);
    console.log(`PROGRESSIVE_REPAIR_ASR_BLOCK ${articleId} message=${String(error?.message || error || '').slice(0, 220)}`);
    return { status: 'asr-block' };
  }
}

const state = await readJson(STATE_PATH);
const snapshot = await readJson(SNAPSHOT_PATH);
if (!state?.generationComplete || state.campaignId !== CAMPAIGN_ID || !Array.isArray(snapshot?.articles) || snapshot.articles.length !== 15) {
  throw new Error('progressive orchestrator requires the matching generation-complete 15/15 checkpoint and truth snapshot');
}

const { synthesize, budget } = createSharedSynthesizer({ apiKey: process.env.GEMINI_API_KEY });
const repairable = [];
const missingEvidence = [];

for (const item of snapshot.articles) {
  const row = state.articles?.[item.articleId] || {};
  const fingerprint = row.generation?.fingerprint;
  if (!fingerprint || row.generation?.status !== 'generated') continue;
  if (row.validation?.status === 'validated' && row.validation?.fingerprint === fingerprint && exactConsensusZero(row.validation?.consensus)) {
    console.log(`PROGRESSIVE_ORCHESTRATOR_SKIP ${item.articleId} already-exact`);
    continue;
  }
  const adjudication = await reusableAdjudication(item.articleId, fingerprint);
  if (adjudication) {
    const ensured = await ensureAdjudication({ item, state });
    if (ensured.status === 'repairable') {
      const plan = await buildRepairPlan({ item, state, adjudication: ensured.adjudication });
      if (plan) repairable.push({ item, adjudication: ensured.adjudication, plan });
    }
  } else {
    missingEvidence.push(item);
  }
}

// Prefer the smallest remaining targeted repair first. If a prior run already
// repaired some parts, that progress gets first priority automatically.
repairable.sort((a, b) => (
  a.plan.remainingParts.length - b.plan.remainingParts.length
  || a.plan.errorTokens - b.plan.errorTokens
  || a.item.articleId.localeCompare(b.item.articleId, 'ar')
));

// Only spend ASR on missing/stale evidence when there is no known repairable
// candidate. This avoids re-transcribing unchanged audio on every retry.
if (!repairable.length) {
  for (const item of missingEvidence) {
    const ensured = await ensureAdjudication({ item, state });
    if (ensured.status === 'provider-block') break;
    if (ensured.status === 'repairable') {
      const plan = await buildRepairPlan({ item, state, adjudication: ensured.adjudication });
      if (plan) {
        repairable.push({ item, adjudication: ensured.adjudication, plan });
        break;
      }
    }
  }
}

let newExact = 0;
let quotaStopped = false;
for (const entry of repairable) {
  const result = await repairOne({ ...entry, state, synthesize });
  if (result.status === 'exact') newExact += 1;
  if (result.status === 'quota') {
    quotaStopped = true;
    break;
  }
  if (result.status === 'asr-block') break;
}

const exactArticles = snapshot.articles.filter((item) => {
  const row = state.articles?.[item.articleId] || {};
  return row.validation?.status === 'validated'
    && row.validation?.fingerprint === row.generation?.fingerprint
    && exactConsensusZero(row.validation?.consensus);
});
state.validationComplete = exactArticles.length === snapshot.articles.length;
state.progressiveOrchestrator = {
  status: state.validationComplete ? 'complete' : quotaStopped ? 'paused-quota' : 'partial',
  exactCount: exactArticles.length,
  remainingCount: snapshot.articles.length - exactArticles.length,
  newExact,
  ttsRequestsSent: budget.sent,
  ttsRequestCap: Number(process.env.BAREEQ_REPAIR_MAX_REQUESTS || 10),
  quotaBlockedTransports: [...budget.quotaTransports],
  updatedAt: new Date().toISOString(),
};
await saveState(state);
console.log(`PROGRESSIVE_ORCHESTRATOR_SUMMARY exact=${exactArticles.length}/15 newExact=${newExact} ttsRequests=${budget.sent}/${state.progressiveOrchestrator.ttsRequestCap} quotaStopped=${quotaStopped}`);
