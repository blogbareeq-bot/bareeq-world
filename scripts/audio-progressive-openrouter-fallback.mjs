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
import { synthesizeOpenRouterPart } from './audio-openrouter-tts.mjs';
import { runProductionMode } from './audio-production.mjs';
import { validateWithConsensus } from './audio-validate-consensus.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const STATE_PATH = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');
const LIVE_PATH = path.join(ROOT, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json');
const STATUS_PATH = path.join(ROOT, 'docs', 'audio', 'PROGRESSIVE-STATUS.json');
const PARTIAL_MARKER = path.join(ROOT, 'docs', 'audio', 'PUBLISHED-SADALTAGER-PARTIAL-20260903.json');
const FINAL_MARKER = path.join(ROOT, 'docs', 'audio', 'PUBLISHED-SADALTAGER-OPENROUTER-20260901.json');
const KEYS = ['substitutions', 'deletions', 'insertions', 'unresolved'];

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return fallback; throw error; }
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await writeJson(STATE_PATH, state);
}

function exact(consensus = {}) {
  return KEYS.every((key) => Number(consensus?.[key]) === 0);
}

function usable(consensus = {}) {
  return KEYS.every((key) => Number.isFinite(Number(consensus?.[key])) && Number(consensus[key]) >= 0);
}

function errorScore(row = {}) {
  const c = row.validation?.consensus || {};
  return KEYS.reduce((sum, key) => sum + (Number.isFinite(Number(c[key])) ? Number(c[key]) : 1000), 0);
}

async function liveDuration(articleId) {
  const live = await readJson(LIVE_PATH, { articles: [] });
  return live.articles?.find((x) => x.articleId === articleId)?.durationSeconds ?? null;
}

async function currentFullSha(articleId, fingerprint) {
  const full = path.join(candidateDir(articleId, fingerprint, ROOT), 'full.mp3');
  if (!await pathExists(full)) return null;
  return sha256(await readFile(full));
}

async function currentAdjudication(articleId, fingerprint, state) {
  const row = state.articles?.[articleId] || {};
  const dir = candidateDir(articleId, fingerprint, ROOT);
  const reportPath = path.join(dir, 'reports', 'asr-adjudication.json');
  const fullSha = await currentFullSha(articleId, fingerprint);
  const cached = await readJson(reportPath, null);
  if (cached && usable(cached.consensus)
    && (cached.candidateFingerprint || cached.fingerprint) === fingerprint
    && cached.fullSha256 === fullSha) {
    return { status: exact(cached.consensus) ? 'exact' : 'repairable', report: cached };
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
      repairProgress: null,
      completedAt: new Date().toISOString(),
    };
    state.articles[articleId] = row;
    await saveState(state);
    return { status: 'exact', report: result };
  } catch (error) {
    if (error?.result?.consensus && usable(error.result.consensus)) {
      row.validation = {
        ...row.validation,
        status: 'failed',
        fingerprint,
        fullSha256: error.result.fullSha256 || fullSha,
        consensus: error.result.consensus,
        representationOnly: error.result.representationOnly?.length || 0,
        modelDisagreements: error.result.modelDisagreements?.length || 0,
        repairProgress: null,
        updatedAt: new Date().toISOString(),
      };
      state.articles[articleId] = row;
      await saveState(state);
      return { status: 'repairable', report: error.result };
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
    return { status: 'provider-block', report: null };
  }
}

function failedTokenIndices(adjudication = {}) {
  const set = new Set();
  for (const diff of [...(adjudication.substantiveDifferences || []), ...(adjudication.unresolved || [])]) {
    const index = Number(diff.expectedIndex);
    if (Number.isInteger(index) && index >= 0) set.add(index);
  }
  return [...set].sort((a, b) => a - b);
}

function buildCorrectionHint(adjudication = {}, range) {
  const problems = [];
  const inRange = (index) => index >= range.start && index <= range.end;
  for (const diff of adjudication.substantiveDifferences || []) {
    if (!inRange(Number(diff.expectedIndex))) continue;
    if (diff.type === 'insertion') problems.push(`do not insert the extra word(s) "${diff.actual}"`);
    else if (diff.type === 'deletion') problems.push(`speak the reviewed word "${diff.expected}" exactly; it is currently missing`);
    else problems.push(`the reviewed word "${diff.expected}" must be spoken exactly; never "${diff.actual}"`);
  }
  for (const diff of adjudication.unresolved || []) {
    if (!inRange(Number(diff.expectedIndex))) continue;
    const variants = [diff?.first?.actual, diff?.second?.actual].filter(Boolean).join(' or ');
    problems.push(`the reviewed word "${diff.expected}" must be spoken exactly; variants heard: ${variants || 'n/a'}`);
  }
  return problems.join('; ') || 'Read the reviewed transcript verbatim; preserve every spoken token and ending.';
}

async function buildRepairPlan(item, state, adjudication) {
  const row = state.articles[item.articleId] || {};
  const fingerprint = row.generation?.fingerprint;
  const article = await loadSpokenArticle(item.articleId, ROOT);
  const plan = splitSpokenArticle(article, {
    settings: activeSplitSettings(QUOTA_SPLIT),
    liveDurationSeconds: await liveDuration(item.articleId),
  });
  const ranges = [];
  let offset = 0;
  for (const part of plan.parts) {
    const tokens = tokenizeVerbal(part.text);
    ranges.push({ partIndex: part.partIndex, start: offset, end: offset + tokens.length - 1, tokens });
    offset += tokens.length;
  }
  const target = new Map();
  for (const index of failedTokenIndices(adjudication)) {
    const range = ranges.find((r) => index >= r.start && index <= r.end) || ranges.at(-1);
    if (range) target.set(range.partIndex + 1, range);
  }
  const targetParts = [...target.keys()].sort((a, b) => a - b);
  if (!targetParts.length) return null;
  const planKey = `${fingerprint}:${adjudication.fullSha256 || 'no-sha'}:${targetParts.join(',')}`;
  const previous = row.validation?.repairProgress?.planKey === planKey ? row.validation.repairProgress : null;
  const completed = new Set((previous?.completedParts || []).map(Number));
  const remaining = targetParts.filter((part) => !completed.has(part));
  const maxParts = Math.max(1, Number(process.env.BAREEQ_OPENROUTER_MAX_PARTS || 1));
  const selected = remaining.slice(0, maxParts);
  const hints = {};
  for (const part of selected) hints[String(part)] = buildCorrectionHint(adjudication, target.get(part));
  return { article, planKey, targetParts, completedParts: [...completed], remainingParts: remaining, selectedParts: selected, hints };
}

async function repairOne() {
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error('OPENROUTER_API_KEY is absent');
  const state = await readJson(STATE_PATH);
  const snapshot = await readJson(SNAPSHOT_PATH);
  if (!state?.generationComplete || !Array.isArray(snapshot?.articles) || snapshot.articles.length !== 15) {
    throw new Error('OpenRouter fallback requires the generation-complete 15/15 checkpoint');
  }

  const candidates = snapshot.articles
    .filter((item) => {
      const row = state.articles?.[item.articleId] || {};
      return row.generation?.status === 'generated'
        && !(row.validation?.status === 'validated' && row.validation?.fingerprint === row.generation?.fingerprint && exact(row.validation?.consensus));
    })
    .sort((a, b) => {
      const ar = state.articles?.[a.articleId] || {};
      const br = state.articles?.[b.articleId] || {};
      const ap = Number((ar.validation?.repairProgress?.remainingParts || []).length > 0);
      const bp = Number((br.validation?.repairProgress?.remainingParts || []).length > 0);
      if (ap !== bp) return bp - ap;
      return errorScore(ar) - errorScore(br);
    });

  for (const item of candidates) {
    const row = state.articles[item.articleId];
    const fingerprint = row.generation.fingerprint;
    const adjudicated = await currentAdjudication(item.articleId, fingerprint, state);
    if (adjudicated.status === 'exact') {
      console.log(`OPENROUTER_FALLBACK_ALREADY_EXACT ${item.articleId}`);
      continue;
    }
    if (adjudicated.status !== 'repairable' || !adjudicated.report) {
      console.log(`OPENROUTER_FALLBACK_SKIP ${item.articleId} status=${adjudicated.status}`);
      continue;
    }
    const repair = await buildRepairPlan(item, state, adjudicated.report);
    if (!repair?.selectedParts?.length) continue;

    process.env.BAREEQ_FORCE_TTS_PARTS = repair.selectedParts.join(',');
    process.env.BAREEQ_TTS_CORRECTION_HINTS_JSON = JSON.stringify(repair.hints);
    console.log(`OPENROUTER_FALLBACK_START article=${item.articleId} parts=${repair.selectedParts.join(',')} target=${repair.targetParts.join(',')}`);
    try {
      const generated = await runProductionMode({
        mode: 'generate-candidate',
        articleId: item.articleId,
        root: ROOT,
        synthesize: ({ part, voice }) => synthesizeOpenRouterPart({ part, voice }),
      });
      console.log(`OPENROUTER_FALLBACK_GENERATED article=${item.articleId} parts=${generated.forceRegeneratedParts?.join(',') || repair.selectedParts.join(',')}`);
    } catch (error) {
      const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || [402, 429].includes(error?.httpStatus);
      row.validation = {
        ...row.validation,
        status: quota ? 'paused-openrouter-quota' : 'openrouter-repair-failed',
        fingerprint,
        repairProgress: {
          planKey: repair.planKey,
          sourceFullSha256: adjudicated.report.fullSha256,
          targetParts: repair.targetParts,
          completedParts: repair.completedParts,
          remainingParts: repair.remainingParts,
          updatedAt: new Date().toISOString(),
        },
        error: String(error?.message || error || '').slice(0, 700),
        updatedAt: new Date().toISOString(),
      };
      state.articles[item.articleId] = row;
      state.progressiveOrchestrator = {
        ...(state.progressiveOrchestrator || {}),
        status: quota ? 'paused-openrouter-quota' : 'openrouter-repair-failed',
        fallbackTransport: 'openrouter-speech',
        updatedAt: new Date().toISOString(),
      };
      await saveState(state);
      if (quota) {
        console.log(`OPENROUTER_FALLBACK_QUOTA article=${item.articleId} ${String(error?.message || '').slice(0, 260)}`);
        return;
      }
      throw error;
    }

    try {
      const result = await validateWithConsensus({ articleId: item.articleId, fingerprint, root: ROOT });
      row.validation = {
        status: result.status,
        fingerprint,
        fullSha256: result.fullSha256,
        consensus: result.consensus,
        representationOnly: result.representationOnly,
        modelDisagreements: result.modelDisagreements,
        repairProgress: null,
        repairApplied: true,
        repairedParts: repair.selectedParts,
        completedAt: new Date().toISOString(),
      };
      state.articles[item.articleId] = row;
      state.progressiveOrchestrator = {
        ...(state.progressiveOrchestrator || {}),
        status: 'openrouter-pass-complete',
        fallbackTransport: 'openrouter-speech',
        updatedAt: new Date().toISOString(),
      };
      await saveState(state);
      console.log(`OPENROUTER_FALLBACK_EXACT article=${item.articleId} consensus=${JSON.stringify(result.consensus)}`);
    } catch (error) {
      const quota = error?.exitCode === EXIT_QUOTA || error?.code === 'BAREEQ_QUOTA' || error?.httpStatus === 429;
      const fresh = await readJson(path.join(candidateDir(item.articleId, fingerprint, ROOT), 'reports', 'asr-adjudication.json'), null);
      row.validation = {
        ...row.validation,
        status: quota ? 'paused-asr-quota' : 'failed',
        fingerprint,
        fullSha256: fresh?.fullSha256 || await currentFullSha(item.articleId, fingerprint),
        consensus: fresh?.consensus || null,
        repairProgress: null,
        repairApplied: true,
        repairedParts: repair.selectedParts,
        error: String(error?.message || error || '').slice(0, 700),
        updatedAt: new Date().toISOString(),
      };
      state.articles[item.articleId] = row;
      state.progressiveOrchestrator = {
        ...(state.progressiveOrchestrator || {}),
        status: quota ? 'paused-asr-quota' : 'openrouter-quality-remains',
        fallbackTransport: 'openrouter-speech',
        updatedAt: new Date().toISOString(),
      };
      await saveState(state);
      console.log(`OPENROUTER_FALLBACK_${quota ? 'ASR_QUOTA' : 'QUALITY_REMAINS'} article=${item.articleId} consensus=${JSON.stringify(fresh?.consensus || null)}`);
    }
    return;
  }
  console.log('OPENROUTER_FALLBACK_NO_REPAIRABLE_ARTICLE');
}

async function refreshStatus() {
  const state = await readJson(STATE_PATH);
  const snapshot = await readJson(SNAPSHOT_PATH);
  const exactRows = snapshot.articles.filter((item) => {
    const row = state.articles?.[item.articleId] || {};
    return row.validation?.status === 'validated'
      && row.validation?.fingerprint === row.generation?.fingerprint
      && exact(row.validation?.consensus);
  });
  const final = exactRows.length === 15;
  const marker = await readJson(final ? FINAL_MARKER : PARTIAL_MARKER, { articles: [], publishedCount: 0, fallbackCount: 15 });
  const publishedIds = new Set((marker.articles || []).map((x) => x.articleId));
  const previous = await readJson(STATUS_PATH, {});
  const rows = snapshot.articles.map((item) => {
    const row = state.articles?.[item.articleId] || {};
    const gen = row.generation || {};
    const val = row.validation || {};
    const c = val.consensus || {};
    return {
      articleId: item.articleId,
      title: item.title,
      audioKey: item.audioKey,
      fingerprint: gen.fingerprint || null,
      generationStatus: gen.status || 'missing',
      validationStatus: val.status || 'not-run',
      substitutions: Number.isFinite(Number(c.substitutions)) ? Number(c.substitutions) : null,
      deletions: Number.isFinite(Number(c.deletions)) ? Number(c.deletions) : null,
      insertions: Number.isFinite(Number(c.insertions)) ? Number(c.insertions) : null,
      unresolved: Number.isFinite(Number(c.unresolved)) ? Number(c.unresolved) : null,
      exact: Boolean(gen.fingerprint && val.status === 'validated' && val.fingerprint === gen.fingerprint && exact(c)),
      publishedExact: publishedIds.has(item.articleId),
      fullSha256: val.fullSha256 || null,
      repairProgress: val.repairProgress || null,
      error: val.error || null,
    };
  });
  const summary = {
    schema: 'bareeq.audio-progressive-status.v2',
    campaignId: CAMPAIGN_ID,
    checkpointSource: process.env.BAREEQ_CHECKPOINT_SOURCE || previous.checkpointSource || 'openrouter-fallback',
    generatedAt: new Date().toISOString(),
    publishedCount: final ? 15 : Number(marker.publishedCount || publishedIds.size),
    fallbackCount: final ? 0 : Number(marker.fallbackCount ?? (15 - publishedIds.size)),
    exactCount: rows.filter((r) => r.exact).length,
    publicationComplete: final,
    orchestrator: state.progressiveOrchestrator || null,
    rows,
  };
  await writeJson(STATUS_PATH, summary);
  console.log(`OPENROUTER_FALLBACK_STATUS published=${summary.publishedCount}/15 exact=${summary.exactCount} fallback=${summary.fallbackCount} final=${summary.publicationComplete}`);
}

if (process.argv.includes('--refresh-status')) await refreshStatus();
else await repairOne();
