import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { QUOTA_SPLIT, candidateDir, sha256 } from './audio-constants.mjs';
import { loadSpokenArticle, splitSpokenArticle, activeSplitSettings } from './audio-split.mjs';
import { tokenizeVerbal } from './audio-exact-match.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const STATE_PATH = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');
const LIVE_PATH = path.join(ROOT, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json');

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return fallback; throw error; }
}

function failedTokenIndices(adjudication = {}) {
  const set = new Set();
  for (const diff of [...(adjudication.substantiveDifferences || []), ...(adjudication.unresolved || [])]) {
    const index = Number(diff.expectedIndex);
    if (Number.isInteger(index) && index >= 0) set.add(index);
  }
  return [...set].sort((a, b) => a - b);
}

async function durationFor(articleId) {
  const live = await readJson(LIVE_PATH, { articles: [] });
  return live.articles?.find((x) => x.articleId === articleId)?.durationSeconds ?? null;
}

const state = await readJson(STATE_PATH);
const snapshot = await readJson(SNAPSHOT_PATH);
if (!state?.generationComplete || !Array.isArray(snapshot?.articles)) throw new Error('repair progress recovery requires a valid checkpoint');

let recovered = 0;
let corrected = 0;
for (const item of snapshot.articles) {
  const row = state.articles?.[item.articleId] || {};
  const fingerprint = row.generation?.fingerprint;
  if (!fingerprint || row.generation?.status !== 'generated') continue;
  const dir = candidateDir(item.articleId, fingerprint, ROOT);
  const adjudication = await readJson(path.join(dir, 'reports', 'asr-adjudication.json'), null);
  const checkpoint = await readJson(path.join(dir, 'checkpoint.json'), null);
  const fullPath = path.join(dir, 'full.mp3');
  if (!adjudication || !checkpoint || !await pathExists(fullPath)) continue;
  if ((adjudication.candidateFingerprint || adjudication.fingerprint) !== fingerprint) continue;
  if (adjudication.fullSha256 !== sha256(await readFile(fullPath))) continue;
  const adjudicatedAt = Date.parse(adjudication.generatedAt || '') || 0;
  if (!adjudicatedAt) continue;

  const article = await loadSpokenArticle(item.articleId, ROOT);
  const plan = splitSpokenArticle(article, { settings: activeSplitSettings(QUOTA_SPLIT), liveDurationSeconds: await durationFor(item.articleId) });
  const ranges = [];
  let offset = 0;
  for (const part of plan.parts) {
    const count = tokenizeVerbal(part.text).length;
    ranges.push({ partIndex: part.partIndex, start: offset, end: offset + count - 1 });
    offset += count;
  }
  const target = new Set();
  for (const index of failedTokenIndices(adjudication)) {
    const range = ranges.find((r) => index >= r.start && index <= r.end) || ranges.at(-1);
    if (range) target.add(range.partIndex + 1);
  }
  const targetParts = [...target].sort((a, b) => a - b);
  if (!targetParts.length) continue;

  // Checkpoint part records are the source of truth for partial targeted repair.
  // Never trust an in-memory forceRegeneratedParts list after an interrupted
  // request because it can include the part whose synthesis actually failed.
  const inferred = targetParts.filter((part) => {
    const record = checkpoint.completedParts?.[String(part - 1)];
    return record?.targetedRegeneration === true && (Date.parse(record.savedAt || '') || 0) > adjudicatedAt;
  });
  const planKey = `${fingerprint}:${adjudication.fullSha256 || 'no-sha'}:${targetParts.join(',')}`;
  const previous = row.validation?.repairProgress?.planKey === planKey ? row.validation.repairProgress : null;
  const previousCompleted = [...(previous?.completedParts || [])].map(Number).sort((a, b) => a - b);
  const completed = new Set(inferred.map(Number));
  const completedParts = [...completed].sort((a, b) => a - b);
  const changed = JSON.stringify(previousCompleted) !== JSON.stringify(completedParts);
  if (!inferred.length && !previous && !changed) continue;

  row.validation = {
    ...row.validation,
    status: completedParts.length ? 'paused-partial-repair' : (row.validation?.status || 'failed'),
    fingerprint,
    fullSha256: adjudication.fullSha256,
    consensus: adjudication.consensus,
    repairProgress: {
      planKey,
      sourceFullSha256: adjudication.fullSha256,
      targetParts,
      completedParts,
      remainingParts: targetParts.filter((part) => !completed.has(part)),
      recoveredFromCheckpoint: true,
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  state.articles[item.articleId] = row;
  recovered += inferred.length;
  if (changed) corrected += 1;
  console.log(`PROGRESSIVE_REPAIR_PROGRESS_RECOVER ${item.articleId} completed=${completedParts.join(',') || '-'} remaining=${targetParts.filter((part) => !completed.has(part)).join(',') || '-'} corrected=${changed}`);
}
state.updatedAt = new Date().toISOString();
await writeJson(STATE_PATH, state);
console.log(`PROGRESSIVE_REPAIR_PROGRESS_RECOVER_SUMMARY inferredParts=${recovered} correctedArticles=${corrected}`);

// CI resume trigger: 2026-09-09 quota window.
// Manual Gemini free-tier resume trigger: 2026-09-09T10:16+03:00.
// Resume after user workflow approval; Gemini free tier only.
// Resume after Run #62 approval; force provider work from newest checkpoint.
// Resume after Run #64 self-push skip; Gemini free tier only.
// Resume after stale self-push rerun; Gemini free tier only (2026-09-13).
