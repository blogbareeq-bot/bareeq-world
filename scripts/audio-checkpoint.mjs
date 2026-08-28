import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import {
  CHECKPOINT_SCHEMA,
  CANDIDATE_SCHEMA,
  EXIT_QUOTA,
  candidateDir,
  sha256,
} from './audio-constants.mjs';
import { candidateFingerprint, partFingerprint } from './audio-split.mjs';

export function checkpointPaths(articleId, fingerprint, root) {
  const dir = candidateDir(articleId, fingerprint, root);
  return {
    dir,
    partsDir: path.join(dir, 'parts'),
    checkpointFile: path.join(dir, 'checkpoint.json'),
    manifestFile: path.join(dir, 'manifest.candidate.json'),
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
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
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
  await writeJson(paths.checkpointFile, checkpoint);
  await writeJson(paths.manifestFile, {
    schema: CANDIDATE_SCHEMA,
    articleId: article.articleId,
    title: article.title,
    fingerprint,
    speechScriptHash: article.speechScriptHash,
    split: splitPlan.settings,
    parts: splitPlan.parts.map((part) => ({
      partIndex: part.partIndex,
      fingerprint: partFingerprint(article, splitPlan, part),
      chars: part.chars,
      bytes: part.bytes,
      estimatedSeconds: part.estimatedSeconds,
    })),
    livePathUntouched: true,
  });
  return { fingerprint, paths, checkpoint };
}

export function partFileName(partIndex, partFingerprintValue) {
  return `part-${String(partIndex + 1).padStart(3, '0')}-${partFingerprintValue.slice(0, 12)}.mp3`;
}

export async function loadCompletedPart(paths, article, splitPlan, part) {
  const fingerprint = partFingerprint(article, splitPlan, part);
  const record = (await readCheckpoint(paths))?.completedParts?.[String(part.partIndex)];
  if (!record || record.fingerprint !== fingerprint) return null;
  const file = path.join(paths.partsDir, record.file);
  try {
    const bytes = await readFile(file);
    if (sha256(bytes) !== record.sha256) return null;
    return { bytes, record, fingerprint, file };
  } catch {
    return null;
  }
}

export async function saveCompletedPart(paths, article, splitPlan, part, bytes, extra = {}) {
  const fingerprint = partFingerprint(article, splitPlan, part);
  const file = partFileName(part.partIndex, fingerprint);
  const absolute = path.join(paths.partsDir, file);
  await mkdir(paths.partsDir, { recursive: true });
  await writeFile(absolute, bytes);
  const checkpoint = await readCheckpoint(paths) || { completedParts: {} };
  checkpoint.schema = CHECKPOINT_SCHEMA;
  checkpoint.articleId = article.articleId;
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
