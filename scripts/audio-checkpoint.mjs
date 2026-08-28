import { mkdir, readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import {
  CHECKPOINT_SCHEMA,
  CANDIDATE_SCHEMA,
  EXIT_QUOTA,
  candidateDir,
  sha256,
  audioKeyFor,
} from './audio-constants.mjs';
import { candidateFingerprint, partFingerprint } from './audio-split.mjs';
import { atomicWriteFile, atomicWriteJson } from './audio-io.mjs';
import { buildCandidateManifest } from './audio-manifest.mjs';

export function checkpointPaths(articleId, fingerprint, root) {
  const dir = candidateDir(articleId, fingerprint, root);
  return {
    dir,
    partsDir: path.join(dir, 'parts'),
    checkpointFile: path.join(dir, 'checkpoint.json'),
    manifestFile: path.join(dir, 'manifest.candidate.json'),
    playerManifestFile: path.join(dir, 'manifest.json'),
    requestLogFile: path.join(dir, 'request-log.json'),
    fullFile: path.join(dir, 'full.mp3'),
    reportsDir: path.join(dir, 'reports'),
  };
}

export async function readCheckpoint(paths) {
  try {
    return JSON.parse(await readFile(paths.checkpointFile, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeJson(file, value) {
  await atomicWriteJson(file, value);
}

export function partFileName(partIndex, partFingerprintValue) {
  return `part-${String(partIndex + 1).padStart(3, '0')}-${partFingerprintValue.slice(0, 12)}.mp3`;
}

function candidatePartRecords(article, splitPlan) {
  return splitPlan.parts.map((part) => ({
    partIndex: part.partIndex,
    fingerprint: partFingerprint(article, splitPlan, part),
    chars: part.chars,
    bytes: part.bytes,
    estimatedSeconds: part.estimatedSeconds,
    estimatedTokens: part.estimatedTokens,
    sync: part.sync || [],
    syncIds: part.syncIds || (part.sync || []).map((entry) => entry.id),
  }));
}

export async function initCheckpoint({ article, splitPlan, root }) {
  const fingerprint = candidateFingerprint(article, splitPlan);
  const paths = checkpointPaths(article.articleId, fingerprint, root);
  await mkdir(paths.partsDir, { recursive: true });
  await mkdir(paths.reportsDir, { recursive: true });
  const existing = await readCheckpoint(paths);
  const checkpoint = existing && existing.fingerprint === fingerprint
    ? existing
    : {
        schema: CHECKPOINT_SCHEMA,
        articleId: article.articleId,
        fingerprint,
        model: splitPlan.settings.name,
        splitVersion: splitPlan.settings.version,
        partCount: splitPlan.parts.length,
        completedParts: {},
        status: 'in-progress',
        createdAt: new Date().toISOString(),
      };
  checkpoint.updatedAt = new Date().toISOString();
  checkpoint.partCount = splitPlan.parts.length;
  checkpoint.fingerprint = fingerprint;
  await recoverOrphanParts(paths, article, splitPlan, checkpoint);
  await writeJson(paths.checkpointFile, checkpoint);
  const candidateManifest = {
    schema: CANDIDATE_SCHEMA,
    articleId: article.articleId,
    title: article.title,
    audioKey: audioKeyFor(article.articleId),
    fingerprint,
    speechScriptHash: article.speechScriptHash,
    split: splitPlan.settings,
    parts: candidatePartRecords(article, splitPlan),
    livePathUntouched: true,
  };
  await writeJson(paths.manifestFile, candidateManifest);
  return { fingerprint, paths, checkpoint };
}

export async function recoverOrphanParts(paths, article, splitPlan, checkpoint) {
  checkpoint.completedParts = checkpoint.completedParts || {};
  let names = [];
  try { names = await readdir(paths.partsDir); } catch { return checkpoint; }
  for (const part of splitPlan.parts) {
    const fingerprint = partFingerprint(article, splitPlan, part);
    const file = partFileName(part.partIndex, fingerprint);
    const record = checkpoint.completedParts[String(part.partIndex)];
    if (record?.fingerprint === fingerprint) continue;
    if (!names.includes(file)) continue;
    try {
      const bytes = await readFile(path.join(paths.partsDir, file));
      if (bytes.length < 100) continue;
      checkpoint.completedParts[String(part.partIndex)] = {
        partIndex: part.partIndex,
        fingerprint,
        file,
        sha256: sha256(bytes),
        bytes: bytes.length,
        savedAt: new Date().toISOString(),
        recovered: true,
      };
    } catch { /* ignore unreadable orphans */ }
  }
  return checkpoint;
}

export async function loadCompletedPart(paths, article, splitPlan, part) {
  const fingerprint = partFingerprint(article, splitPlan, part);
  const expected = partFileName(part.partIndex, fingerprint);
  const checkpoint = await readCheckpoint(paths);
  const record = checkpoint?.completedParts?.[String(part.partIndex)];
  const tryFile = async (file, extra = {}) => {
    try {
      const bytes = await readFile(path.join(paths.partsDir, file));
      if (bytes.length < 100) return null;
      const digest = sha256(bytes);
      if (extra.sha256 && extra.sha256 !== digest) return null;
      return { bytes, record: { ...extra, file, sha256: digest, bytes: bytes.length, fingerprint }, fingerprint, file: path.join(paths.partsDir, file) };
    } catch {
      return null;
    }
  };
  if (record?.fingerprint === fingerprint) {
    const hit = await tryFile(record.file, record);
    if (hit) return hit;
  }
  const orphan = await tryFile(expected, { partIndex: part.partIndex, recovered: true });
  if (!orphan) return null;
  const next = checkpoint || { completedParts: {} };
  next.completedParts = next.completedParts || {};
  next.completedParts[String(part.partIndex)] = {
    partIndex: part.partIndex,
    fingerprint,
    file: expected,
    sha256: orphan.record.sha256,
    bytes: orphan.bytes.length,
    savedAt: new Date().toISOString(),
    recovered: true,
  };
  await writeJson(paths.checkpointFile, next);
  return orphan;
}

export async function saveCompletedPart(paths, article, splitPlan, part, bytes, extra = {}) {
  const fingerprint = partFingerprint(article, splitPlan, part);
  const file = partFileName(part.partIndex, fingerprint);
  const absolute = path.join(paths.partsDir, file);
  await mkdir(paths.partsDir, { recursive: true });
  await atomicWriteFile(absolute, bytes);
  const checkpoint = await readCheckpoint(paths) || { completedParts: {} };
  checkpoint.schema = CHECKPOINT_SCHEMA;
  checkpoint.articleId = article.articleId;
  checkpoint.fingerprint = checkpoint.fingerprint || candidateFingerprint(article, splitPlan);
  checkpoint.completedParts = checkpoint.completedParts || {};
  checkpoint.completedParts[String(part.partIndex)] = {
    partIndex: part.partIndex,
    fingerprint,
    file,
    sha256: sha256(bytes),
    bytes: bytes.length,
    savedAt: new Date().toISOString(),
    ...extra,
  };
  checkpoint.updatedAt = new Date().toISOString();
  checkpoint.status = Object.keys(checkpoint.completedParts).length === splitPlan.parts.length ? 'complete' : 'in-progress';
  await writeJson(paths.checkpointFile, checkpoint);
  return checkpoint.completedParts[String(part.partIndex)];
}

export async function markQuotaPause(paths, partIndex, error) {
  const checkpoint = await readCheckpoint(paths) || {};
  checkpoint.status = 'paused-quota';
  checkpoint.pausedAtPart = partIndex;
  checkpoint.pausedReason = error?.httpStatus === 429 ? 'HTTP 429' : error?.message || 'quota';
  checkpoint.exitCode = EXIT_QUOTA;
  checkpoint.updatedAt = new Date().toISOString();
  await writeJson(paths.checkpointFile, checkpoint);
  return checkpoint;
}

export async function appendRequestLog(paths, entry) {
  let log = { schema: 'bareeq.audio-request-log.v1', entries: [] };
  try { log = JSON.parse(await readFile(paths.requestLogFile, 'utf8')); } catch { /* new log */ }
  log.entries.push({ ...entry, at: new Date().toISOString() });
  await writeJson(paths.requestLogFile, log);
}

export async function pathExists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function writePlayerCompatibleCandidateManifest({ article, splitPlan, paths, partAssets, fingerprint }) {
  const manifest = buildCandidateManifest({ article, splitPlan, partAssets, fingerprint });
  await writeJson(paths.playerManifestFile, manifest);
  return manifest;
}
