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
  const inferred = targetParts.filter((part) => {
    const record = checkpoint.completedParts?.[String(part - 1)];
    return record?.targetedRegeneration === true && (Date.parse(record.savedAt || '') || 0) > adjudicatedAt;
  });
  if (!inferred.length) continue;

  const planKey = `${fingerprint}:${adjudication.fullSha256 || 'no-sha'}:${targetParts.join(',')}`;
  const previous = row.validation?.repairProgress?.planKey === planKey ? row.validation.repairProgress : null;
  const completed = new Set([...(previous?.completedParts || []), ...inferred].map(Number));
  row.validation = {
    ...row.validation,
    status: 'paused-partial-repair',
    fingerprint,
    fullSha256: adjudication.fullSha256,
    consensus: adjudication.consensus,
    repairProgress: {
      planKey,
      sourceFullSha256: adjudication.fullSha256,
      targetParts,
      completedParts: [...completed].sort((a, b) => a - b),
      remainingParts: targetParts.filter((part) => !completed.has(part)),
      recoveredFromCheckpoint: true,
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  state.articles[item.articleId] = row;
  recovered += inferred.length;
  console.log(`PROGRESSIVE_REPAIR_PROGRESS_RECOVER ${item.articleId} completed=${[...completed].sort((a,b)=>a-b).join(',')} remaining=${targetParts.filter((part) => !completed.has(part)).join(',') || '-'}`);
}
state.updatedAt = new Date().toISOString();
await writeJson(STATE_PATH, state);
console.log(`PROGRESSIVE_REPAIR_PROGRESS_RECOVER_SUMMARY inferredParts=${recovered}`);
