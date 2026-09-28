import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXIT_OK,
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
import {
  ADJUDICATION_POLICY_VERSION,
  adjudicateCandidate,
} from './audio-dual-asr-adjudicate.mjs';
import {
  appendRequestLog,
  checkpointPaths,
  loadCompletedPart,
  saveCompletedPart,
  writeJson,
  pathExists,
} from './audio-checkpoint.mjs';
import { decodePcm } from './audio-merge.mjs';
import { encodePcm48kToMp3 } from './audio-normalize-parts.mjs';
import {
  buildMicroPart,
  locateSegmentRepair,
  planSegmentSplice,
  spliceSegmentPcm,
} from './audio-segment-repair.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const STATE_PATH = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');
const LIVE_PATH = path.join(ROOT, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The quota belongs to the Google project + model, not to an HTTP transport.
// Keep one budget for the whole run; creating a new synthesizer per article
// previously reset the counter and scattered the daily allowance across the
// entire backlog. A true daily/RPD exhaustion is terminal for this run. When
// Gemini supplies a short explicit retry delay, honor it even if the quota ID
// contains "per day"; treating a 36-second reset as terminal previously threw
// away requests that were still usable in the same run.
export function createBudgetedSynthesizer({ apiKey, sleepImpl = sleep, transportEntries = null } = {}) {
  const transports = transportEntries || [
    ['developer-interactions', synthesizeGeminiPart],
    ['developer-generate-content', synthesizeGeminiGenerateContentPart],
  ];
  const minSpacingMs = Number(process.env.BAREEQ_REPAIR_MIN_INTERVAL_MS || 9000);
  const maxRequests = Number(process.env.BAREEQ_REPAIR_MAX_REQUESTS || 10);
  const retryAttempts = Number(process.env.BAREEQ_REPAIR_MAX_429_RETRIES || 2);
  const maxTransientRetryMs = Number(process.env.BAREEQ_REPAIR_MAX_TRANSIENT_RETRY_MS || 120000);
  let lastRequestAt = 0;
  let sent = 0;
  let successful = 0;
  let quotaRejected = 0;
  let dailyQuotaExhausted = false;
  let budgetExhausted = false;

  const quotaError = (partNumber, detail) => Object.assign(
    new Error(`Gemini TTS quota exhausted after retries for part ${partNumber}${detail ? `: ${detail}` : ''}`),
    { httpStatus: 429, exitCode: EXIT_QUOTA, code: 'BAREEQ_QUOTA' },
  );

  const synthesize = async (args) => {
    const partNumber = Number(args?.part?.partIndex) + 1;
    for (const [transport, synth] of transports) {
      for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
        if (sent >= maxRequests) {
          budgetExhausted = true;
          throw quotaError(partNumber, `request cap ${maxRequests} reached`);
        }
        const now = Date.now();
        const spacingWait = Math.max(0, minSpacingMs - (now - lastRequestAt));
        if (spacingWait) await sleepImpl(spacingWait);
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
          successful += 1;
          console.log(`PROGRESSIVE_REPAIR_TTS_OK part=${partNumber} transport=${transport} attempt=${attempt}`);
          return output;
        } catch (error) {
          const quota = error?.httpStatus === 429 || error?.code === 'BAREEQ_QUOTA';
          if (!quota) throw error;
          quotaRejected += 1;
          const retryMs = Number(error?.retryDelayMs) || 0;
          const daily = error?.dailyQuota === true
            || error?.quotaInfo?.daily === true
            || /per.?day|requests.?per.?day|rpd/i.test(String(error?.message || ''));
          const shortExplicitRetry = retryMs > 0 && retryMs <= maxTransientRetryMs;
          if ((daily && !shortExplicitRetry) || retryMs > 10 * 60 * 1000) {
            dailyQuotaExhausted = true;
            console.log(`PROGRESSIVE_REPAIR_DAILY_QUOTA_STOP part=${partNumber} transport=${transport} retry=${retryMs ? `${retryMs}ms` : 'next-reset'}`);
            throw error;
          }
          if (attempt >= retryAttempts) break;
          const boundedRetryMs = Math.max(retryMs, 15000);
          console.log(`PROGRESSIVE_REPAIR_RATE_WAIT part=${partNumber} transport=${transport} attempt=${attempt} wait=${boundedRetryMs}ms`);
          await sleepImpl(boundedRetryMs);
        }
      }
    }
    throw quotaError(partNumber);
  };
  synthesize.stats = () => ({ sent, successful, quotaRejected, maxRequests, dailyQuotaExhausted, budgetExhausted });
  return synthesize;
}

function csvArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || '';
  return new Set(raw.split(',').map((value) => value.trim()).filter(Boolean));
}

function exactConsensusZero(consensus = {}) {
  return ['substitutions', 'deletions', 'insertions', 'unresolved']
    .every((key) => Number(consensus[key]) === 0);
}

export function consensusErrorTotal(consensus = {}) {
  return ['substitutions', 'deletions', 'insertions', 'unresolved']
    .reduce((total, key) => total + (Number(consensus[key]) || 0), 0);
}

export function chooseRepairPart(partIndexes, partAttempts = new Map(), maxTrialsPerPart = 1) {
  const limit = Math.max(1, Number(maxTrialsPerPart) || 1);
  return [...partIndexes]
    .sort((a, b) => a - b)
    .find((partIndex) => (partAttempts.get(partIndex) || 0) < limit);
}

export function compareRepairCandidates(a, b) {
  // Publication-first: maximize newly exact articles per scarce free Gemini
  // request. Prefer the smallest confirmed error surface first. An in-progress
  // article only breaks ties; it must never outrank a cleaner near-exact item.
  return a.errorScore - b.errorScore
    || a.partCount - b.partCount
    || a.tokenCount - b.tokenCount
    || a.repairPriority - b.repairPriority
    || a.order - b.order;
}

export function shouldRetryCurrentArticle(status) {
  // A rejected trial restored the same baseline. Give another article the
  // remaining shared TTS budget instead of immediately repeating that trial.
  return ['failed', 'improved', 'repair-failed'].includes(status);
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

async function currentAdjudication(dir, fingerprint) {
  const report = await readJson(path.join(dir, 'reports', 'asr-adjudication.json'), null);
  const fullPath = path.join(dir, 'full.mp3');
  if (!report || !await pathExists(fullPath)) return null;
  const fullSha256 = sha256(await readFile(fullPath));
  const reportFingerprint = report.fingerprint || report.candidateFingerprint;
  if (reportFingerprint !== fingerprint
    || report.fullSha256 !== fullSha256
    || Number(report.policy?.version) !== ADJUDICATION_POLICY_VERSION) return null;
  return report;
}

async function invalidateDerivedEvidence(dir) {
  await rm(path.join(dir, 'reports'), { recursive: true, force: true });
  for (const name of ['full.mp3', 'concat.txt', 'manifest.json', 'manifest.candidate.json']) {
    await rm(path.join(dir, name), { force: true });
  }
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

function unpackRepairSynthesis(value) {
  if (Buffer.isBuffer(value)) return { audio: value, transport: 'developer-interactions' };
  if (Buffer.isBuffer(value?.audio)) return { audio: value.audio, transport: value.transport || 'unknown' };
  return { audio: null, transport: 'unknown' };
}

async function regenerateSynchronizedSegment({
  article,
  splitPlan,
  fingerprint,
  failedIndices: indices,
  correctionHint,
  synth,
}) {
  const repair = locateSegmentRepair(splitPlan, indices);
  if (!repair) return null;
  const paths = checkpointPaths(article.articleId, fingerprint, ROOT);
  const existing = await loadCompletedPart(paths, article, splitPlan, repair.part);
  if (!existing) return null;

  // Resolve both cut points before spending a TTS request. A paragraph is only
  // eligible when its weighted sync estimates land near real silence on both
  // sides; otherwise the caller safely falls back to whole-part replacement.
  const originalPcm = await decodePcm(existing.file);
  let splicePlan;
  try {
    splicePlan = planSegmentSplice(originalPcm, repair);
  } catch (error) {
    console.log(`PROGRESSIVE_SEGMENT_REPAIR_SKIP ${article.articleId} segment=${repair.segmentId} reason=${JSON.stringify(String(error?.message || error))}`);
    return null;
  }
  console.log(`PROGRESSIVE_SEGMENT_REPAIR_START ${article.articleId} part=${repair.partIndex + 1} segment=${repair.segmentId} cut=${splicePlan.start.seconds.toFixed(3)}-${splicePlan.end.seconds.toFixed(3)}s textBytes=${repair.text.length}`);

  const microPart = buildMicroPart(repair, repair.part);
  const generated = unpackRepairSynthesis(await synth({
    article,
    part: microPart,
    splitPlan,
    correctionHint,
  }));
  if (!generated.audio || generated.audio.length < 100) throw new Error(`synthesized segment ${repair.segmentId} is too small`);

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'bareeq-segment-repair-'));
  try {
    const replacementFile = path.join(tempRoot, 'replacement.mp3');
    await writeFile(replacementFile, generated.audio);
    const replacementPcm = await decodePcm(replacementFile);
    const spliced = spliceSegmentPcm(originalPcm, replacementPcm, splicePlan);
    const bytes = await encodePcm48kToMp3(spliced.pcm);
    await saveCompletedPart(paths, article, splitPlan, repair.part, bytes, {
      resumed: false,
      transport: generated.transport,
      targetedRegeneration: true,
      targetedSegmentRepair: true,
      repairedSegmentId: repair.segmentId,
      correctionHintApplied: Boolean(correctionHint),
      previousSha256: existing.record?.sha256 || null,
      spliceStartSeconds: Number(splicePlan.start.seconds.toFixed(3)),
      spliceEndSeconds: Number(splicePlan.end.seconds.toFixed(3)),
      replacementSeconds: Number(spliced.replacementSeconds.toFixed(3)),
    });
    await appendRequestLog(paths, {
      partIndex: repair.partIndex,
      action: 'targeted-segment-regeneration-synthesize',
      providerCalls: 1,
      providerAttempts: 1,
      transport: generated.transport,
      segmentId: repair.segmentId,
      previousSha256: existing.record?.sha256 || null,
      bytes: bytes.length,
      spliceStartSeconds: Number(splicePlan.start.seconds.toFixed(3)),
      spliceEndSeconds: Number(splicePlan.end.seconds.toFixed(3)),
      replacementSeconds: Number(spliced.replacementSeconds.toFixed(3)),
      startBoundary: spliced.startMetrics,
      endBoundary: spliced.endMetrics,
      correctionHintApplied: Boolean(correctionHint),
    });
    console.log(`PROGRESSIVE_SEGMENT_REPAIR_DONE ${article.articleId} part=${repair.partIndex + 1} segment=${repair.segmentId} replacement=${spliced.replacementSeconds.toFixed(3)}s output=${spliced.outputSeconds.toFixed(3)}s`);
    return { repair, splicePlan, spliced };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function repairArticle({
  articleId,
  state,
  synth,
  partAttempts = new Map(),
  maxTrialsPerPart = 1,
}) {
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
  let adjudication = await currentAdjudication(dir, fingerprint);
  if (!adjudication) {
    console.log(`PROGRESSIVE_REPAIR_CLASSIFY ${articleId} reason=missing-or-stale-adjudication`);
    try {
      const result = await validateWithConsensus({ articleId, fingerprint, root: ROOT });
      row.validation = {
        status: result.status,
        fingerprint,
        fullSha256: result.fullSha256,
        consensus: result.consensus,
        representationOnly: result.representationOnly,
        modelDisagreements: result.modelDisagreements,
        repairInProgress: false,
        completedAt: new Date().toISOString(),
      };
      state.articles[articleId] = { ...row };
      await saveState(state);
      return { articleId, status: 'validated', consensus: result.consensus, parts: [] };
    } catch (error) {
      adjudication = await currentAdjudication(dir, fingerprint);
      const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
      if (!adjudication) {
        row.validation = {
          ...previousValidation,
          status: quota ? 'paused-quota' : 'classification-failed',
          fingerprint,
          error: String(error?.message || error || '').slice(0, 700),
          updatedAt: new Date().toISOString(),
        };
        state.articles[articleId] = { ...row };
        await saveState(state);
        return { articleId, status: quota ? 'paused-quota' : 'classification-failed', error: row.validation.error };
      }
      row.validation = {
        status: 'failed',
        fingerprint,
        fullSha256: adjudication.fullSha256,
        consensus: adjudication.consensus,
        error: String(error?.message || error || '').slice(0, 700),
        updatedAt: new Date().toISOString(),
      };
      state.articles[articleId] = { ...row };
      await saveState(state);
    }
  }
  if (exactConsensusZero(adjudication.consensus)) {
    row.validation = {
      ...(row.validation || previousValidation),
      status: 'validated',
      fingerprint,
      fullSha256: adjudication.fullSha256,
      consensus: adjudication.consensus,
      repairInProgress: false,
      completedAt: new Date().toISOString(),
    };
    state.articles[articleId] = { ...row };
    await saveState(state);
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

  // A part regeneration is stochastic: replacing several parts at once can
  // fix one word while introducing errors elsewhere. Trial one failed part at
  // a time and compare it with the preserved candidate before accepting it.
  const trialPartIndex = chooseRepairPart(failedPartMap.keys(), partAttempts, maxTrialsPerPart);
  if (!Number.isInteger(trialPartIndex)) {
    return {
      articleId,
      status: 'part-trial-limit',
      note: `all failing parts reached the per-part trial limit (${maxTrialsPerPart})`,
    };
  }
  partAttempts.set(trialPartIndex, (partAttempts.get(trialPartIndex) || 0) + 1);
  const parts = [trialPartIndex + 1];
  const hints = {};
  for (const [partIndex, entry] of failedPartMap) {
    if (partIndex !== trialPartIndex) continue;
    const hint = buildCorrectionHint(adjudication, entry.range);
    hints[String(partIndex + 1)] = hint || 'Read the reviewed transcript verbatim; preserve every spoken token and ending.';
  }

  const baselineScore = consensusErrorTotal(adjudication.consensus);
  const backupRoot = await mkdtemp(path.join(tmpdir(), 'bareeq-audio-trial-'));
  const backupDir = path.join(backupRoot, 'candidate');
  await cp(dir, backupDir, { recursive: true });
  const restoreBaseline = async () => {
    await rm(dir, { recursive: true, force: true });
    await cp(backupDir, dir, { recursive: true });
  };

  console.log(`PROGRESSIVE_REPAIR_START ${articleId} fingerprint=${fingerprint} parts=${parts.join(',')} tokens=${indices.length} consensus=${JSON.stringify(adjudication.consensus)}`);
  try {
    const failedInTrialPart = failedPartMap.get(trialPartIndex)?.indices || [];
    const segmentRepair = await regenerateSynchronizedSegment({
      article,
      splitPlan: plan,
      fingerprint,
      failedIndices: failedInTrialPart,
      correctionHint: hints[String(trialPartIndex + 1)],
      synth,
    });
    if (!segmentRepair) {
      process.env.BAREEQ_FORCE_TTS_PARTS = parts.join(',');
      process.env.BAREEQ_TTS_CORRECTION_HINTS_JSON = JSON.stringify(hints);
      const generated = await runProductionMode({
        mode: 'generate-candidate',
        articleId,
        root: ROOT,
        synthesize: synth,
      });
      console.log(`PROGRESSIVE_REPAIR_GENERATED ${articleId} parts=${generated.forceRegeneratedParts.join(',')} resumed=${generated.resumedParts}`);
    }
    await invalidateDerivedEvidence(dir);
  } catch (error) {
    const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
    const status = quota ? 'paused-quota' : 'repair-failed';
    await restoreBaseline();
    await rm(backupRoot, { recursive: true, force: true });
    row.validation = {
      ...(row.validation || previousValidation),
      status,
      fingerprint,
      repairInProgress: false,
      repairedParts: parts,
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
      repairInProgress: false,
      repairedParts: parts,
      completedAt: new Date().toISOString(),
    };
    state.articles[articleId] = { ...row };
    await saveState(state);
    console.log(`PROGRESSIVE_REPAIR_DONE ${articleId} parts=${parts.join(',')} consensus=${JSON.stringify(result.consensus)}`);
    await rm(backupRoot, { recursive: true, force: true });
    return { articleId, status: 'validated', consensus: result.consensus, parts };
  } catch (error) {
    const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
    const boundFresh = await currentAdjudication(dir, fingerprint);
    const trialScore = boundFresh ? consensusErrorTotal(boundFresh.consensus) : Number.POSITIVE_INFINITY;
    const improved = !quota && boundFresh && trialScore < baselineScore;
    if (improved) {
      row.validation = {
        status: 'failed',
        fingerprint,
        consensus: boundFresh.consensus,
        fullSha256: boundFresh.fullSha256,
        error: String(error?.message || error || '').slice(0, 700),
        repairApplied: true,
        repairInProgress: true,
        repairedParts: parts,
        baselineScore,
        acceptedScore: trialScore,
        updatedAt: new Date().toISOString(),
      };
      console.log(`PROGRESSIVE_REPAIR_IMPROVED ${articleId} part=${parts[0]} score=${baselineScore}->${trialScore}`);
    } else {
      await restoreBaseline();
      row.validation = {
        ...previousValidation,
        status: quota ? 'paused-quota' : 'failed',
        fingerprint,
        consensus: adjudication.consensus,
        fullSha256: adjudication.fullSha256,
        repairInProgress: false,
        rejectedPart: parts[0],
        rejectedScore: Number.isFinite(trialScore) ? trialScore : null,
        baselineScore,
        error: String(error?.message || error || '').slice(0, 700),
        updatedAt: new Date().toISOString(),
      };
      console.log(`PROGRESSIVE_REPAIR_REJECTED ${articleId} part=${parts[0]} score=${baselineScore}->${Number.isFinite(trialScore) ? trialScore : 'unverified'} restored=yes`);
    }
    await rm(backupRoot, { recursive: true, force: true });
    state.articles[articleId] = { ...row };
    await saveState(state);
    return {
      articleId,
      status: quota ? 'paused-quota' : (improved ? 'improved' : 'trial-rejected'),
      error: String(error?.message || error || '').slice(0, 200),
      consensus: improved ? boundFresh.consensus : adjudication.consensus,
      baselineScore,
      trialScore: Number.isFinite(trialScore) ? trialScore : null,
    };
  }
}

export async function runProgressiveRepair() {
const only = csvArg('only');
const skip = csvArg('skip');
const state = await readJson(STATE_PATH);
const snapshot = await readJson(SNAPSHOT_PATH);
if (!state?.generationComplete || !Array.isArray(snapshot?.articles) || snapshot.articles.length !== 15) {
  throw new Error('progressive repair requires a generation-complete 15/15 checkpoint and the 15-article truth snapshot');
}
const selectedArticles = snapshot.articles.filter((item) => !skip.has(item.articleId)
  && (only.size === 0 || only.has(item.articleId)));
if (process.argv.includes('--plan-only')) {
  const pendingArticleIds = selectedArticles.filter((item) => {
    const row = state.articles?.[item.articleId] || {};
    return !(row.validation?.status === 'validated'
      && row.validation?.fingerprint === row.generation?.fingerprint
      && exactConsensusZero(row.validation?.consensus));
  }).map((item) => item.articleId);
  const preview = {
    status: 'plan-only',
    campaignId: CAMPAIGN_ID,
    skippedArticleIds: snapshot.articles.filter((item) => skip.has(item.articleId)).map((item) => item.articleId),
    selectedArticleIds: selectedArticles.map((item) => item.articleId),
    pendingArticleIds,
    providerCalls: 0,
    liveUntouched: true,
  };
  console.log(JSON.stringify(preview, null, 2));
  return preview;
}
console.log(`PROGRESSIVE_SKIP_ARTICLES ${snapshot.articles.filter((item) => skip.has(item.articleId)).map((item) => item.articleId).join(',') || 'none'}`);

// Classify every pending candidate before spending any TTS allowance. ASR and
// TTS have independent budgets; the old interleaved loop stopped at the first
// TTS RPD response and left later articles unclassified. That also prevented
// the easiest-first sorter from seeing candidates needing a tiny repair.
for (const item of selectedArticles) {
  const articleId = item.articleId;
  const row = state.articles?.[articleId] || {};
  const fingerprint = row.generation?.fingerprint;
  if (!fingerprint || row.generation?.status !== 'generated') continue;
  if (row.validation?.status === 'validated'
    && row.validation?.fingerprint === fingerprint
    && exactConsensusZero(row.validation?.consensus)) continue;
  const dir = candidateDir(articleId, fingerprint, ROOT);
  if (await currentAdjudication(dir, fingerprint)) continue;
  console.log(`PROGRESSIVE_PRECLASSIFY ${articleId} reason=missing-or-stale-adjudication`);
  // An adjudication policy update does not make the immutable raw ASR reports
  // stale. Re-run consensus locally first, so representation-only fixes never
  // consume ASR or TTS allowance. If the raw reports are missing or bound to a
  // different audio SHA, the normal provider-backed validation follows.
  let refreshedAdjudication = null;
  try {
    refreshedAdjudication = await adjudicateCandidate({ articleId, fingerprint, root: ROOT });
  } catch {
    refreshedAdjudication = await currentAdjudication(dir, fingerprint);
  }
  if (refreshedAdjudication) {
    row.validation = {
      status: refreshedAdjudication.passed ? 'validated' : 'failed',
      fingerprint,
      fullSha256: refreshedAdjudication.fullSha256,
      consensus: refreshedAdjudication.consensus,
      representationOnly: refreshedAdjudication.representationOnly?.length || 0,
      modelDisagreements: refreshedAdjudication.modelDisagreements?.length || 0,
      repairInProgress: false,
      completedAt: new Date().toISOString(),
    };
    state.articles[articleId] = { ...row };
    await saveState(state);
    console.log(`PROGRESSIVE_PRECLASSIFY_OFFLINE ${articleId} consensus=${JSON.stringify(refreshedAdjudication.consensus)}`);
    continue;
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
      repairInProgress: false,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    const adjudication = await currentAdjudication(dir, fingerprint);
    const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
    row.validation = adjudication ? {
      status: 'failed',
      fingerprint,
      fullSha256: adjudication.fullSha256,
      consensus: adjudication.consensus,
      error: String(error?.message || error || '').slice(0, 700),
      updatedAt: new Date().toISOString(),
    } : {
      ...(row.validation || {}),
      status: quota ? 'paused-quota' : 'classification-failed',
      fingerprint,
      error: String(error?.message || error || '').slice(0, 700),
      updatedAt: new Date().toISOString(),
    };
  }
  state.articles[articleId] = { ...row };
  await saveState(state);
}

async function repairScore(item, order) {
  const articleId = item.articleId;
  const row = state.articles?.[articleId] || {};
  const fingerprint = row.generation?.fingerprint;
  const missing = Number.MAX_SAFE_INTEGER;
  if (!fingerprint) return { item, order, errorScore: missing, repairPriority: 1, partCount: missing, tokenCount: missing };
  const dir = candidateDir(articleId, fingerprint, ROOT);
  const adjudication = await currentAdjudication(dir, fingerprint);
  if (!adjudication) {
    return {
      item,
      order,
      errorScore: missing - 1,
      repairPriority: 1,
      partCount: missing - 1,
      tokenCount: missing - 1,
    };
  }
  const article = await loadSpokenArticle(articleId, ROOT);
  const duration = await liveDuration(articleId);
  const { ranges } = buildPartRanges(article, duration);
  const indices = failedTokenIndices(adjudication);
  const parts = new Set(indices.map((index) => partForTokenIndex(ranges, index)?.partIndex).filter(Number.isInteger));
  return {
    item,
    order,
    errorScore: consensusErrorTotal(adjudication.consensus),
    repairPriority: row.validation?.repairInProgress === true ? 0 : 1,
    partCount: parts.size || missing - 2,
    tokenCount: indices.length,
  };
}

const candidates = [];
for (const [order, item] of selectedArticles.entries()) {
  const articleId = item.articleId;
  const row = state.articles?.[articleId] || {};
  const gen = row.generation || {};
  const val = row.validation || {};
  if (gen.status !== 'generated') continue;
  if (val.status === 'validated' && val.fingerprint === gen.fingerprint && exactConsensusZero(val.consensus)) {
    console.log(`PROGRESSIVE_REPAIR_SKIP ${articleId} already-exact`);
    continue;
  }
  candidates.push(await repairScore(item, order));
}
candidates.sort(compareRepairCandidates);
console.log(`PROGRESSIVE_REPAIR_ORDER ${candidates.map(({ item, errorScore, partCount }) => `${item.articleId}:${Number.isSafeInteger(errorScore) && errorScore < 1000 ? `errors=${errorScore},parts=${partCount}` : 'classify'}`).join(',')}`);

const maxArticlesArg = Number(process.argv.find((arg) => arg.startsWith('--max-articles='))?.slice('--max-articles='.length) || 10);
const maxRounds = Number(process.env.BAREEQ_REPAIR_MAX_ROUNDS_PER_ARTICLE || 4);
const maxTrialsPerPart = Number(process.env.BAREEQ_REPAIR_MAX_TRIALS_PER_PART || maxRounds);
const synth = createBudgetedSynthesizer({ apiKey: process.env.GEMINI_API_KEY });
const results = [];
let visited = 0;
let stopRun = false;
for (const candidate of candidates) {
  if (visited >= maxArticlesArg || stopRun) break;
  const articleId = candidate.item.articleId;
  visited += 1;
  const partAttempts = new Map();
  for (let round = 1; round <= maxRounds; round += 1) {
    console.log(`PROGRESSIVE_REPAIR_ROUND ${articleId} round=${round}/${maxRounds}`);
    const result = await repairArticle({ articleId, state, synth, partAttempts, maxTrialsPerPart });
    results.push({ ...result, round });
    if (result.status === 'validated' || result.status === 'already-exact') break;
    const stats = synth.stats();
    if (result.status === 'paused-quota' || stats.dailyQuotaExhausted || stats.budgetExhausted) {
      stopRun = true;
      break;
    }
    // Fair-share policy: a stubborn stochastic part must not monopolize the
    // run's free Gemini allowance. Once this article reaches its configured
    // round cap, continue to the next easiest pending article with the same
    // shared provider budget and immutable accepted baseline.
    if (!shouldRetryCurrentArticle(result.status)) break;
  }
}

const nowExact = snapshot.articles.filter((item) => {
  const row = state.articles?.[item.articleId] || {};
  return row.validation?.status === 'validated'
    && row.validation?.fingerprint === row.generation?.fingerprint
    && exactConsensusZero(row.validation?.consensus);
});
console.log(`PROGRESSIVE_REPAIR_SUMMARY exact=${nowExact.length}/15 attemptedRounds=${results.length} visited=${visited} tts=${JSON.stringify(synth.stats())}`);
console.log(JSON.stringify(results, null, 2));
return { exactCount: nowExact.length, results, visited, tts: synth.stats(), exitCode: EXIT_OK };
}

const isCli = process.argv[1] && path.basename(process.argv[1]) === 'audio-progressive-repair.mjs';
if (isCli) {
  try {
    await runProgressiveRepair();
    process.exit(EXIT_OK);
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exit(error?.exitCode || 1);
  }
}
