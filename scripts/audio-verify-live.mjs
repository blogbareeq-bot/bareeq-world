import { mkdir, readFile, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXIT_HARD, EXIT_OK, EXIT_USAGE, candidateDir, sha256 } from './audio-constants.mjs';
import { inspectLiveSnapshot, runTechnicalQa } from './audio-technical-qa.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { expectedSyncIds, validateSyncMap } from './audio-sync.mjs';
import { mergeCandidateParts } from './audio-merge.mjs';
import { boundIdentity } from './audio-report.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { partFileName } from './audio-checkpoint.mjs';

export async function snapshotLiveSadaltager({
  articleId,
  root = process.cwd(),
  fetchImpl,
  skipAsr = true,
}) {
  if (!articleId) throw Object.assign(new Error('verify-live requires --article'), { exitCode: EXIT_USAGE });
  const live = await inspectLiveSnapshot(articleId, root);
  if (!live.exists) throw Object.assign(new Error(`${articleId}: live audio is missing`), { exitCode: EXIT_HARD });
  if (live.missing?.length) {
    throw Object.assign(new Error(`${articleId}: live files missing: ${live.missing.join(', ')}`), { exitCode: EXIT_HARD });
  }
  if (live.voiceId !== PRODUCTION_NARRATOR.voiceId || live.provider !== PRODUCTION_NARRATOR.provider) {
    throw Object.assign(new Error(`${articleId}: live voice is ${live.voiceId}/${live.provider}, not reusable Sadaltager`), { exitCode: EXIT_HARD });
  }
  const manifest = live.manifest || JSON.parse(await readFile(path.join(live.dir, 'manifest.json'), 'utf8'));
  const mismatches = [];
  const liveParts = [];
  for (const [index, part] of (manifest.parts || []).entries()) {
    const asset = part.audio?.[manifest.defaultVoice];
    if (!asset?.src) throw Object.assign(new Error(`${articleId}: live part missing src`), { exitCode: EXIT_HARD });
    const source = path.join(root, 'public', asset.src.replace(/^\//, ''));
    if (!await pathExists(source)) {
      throw Object.assign(new Error(`${articleId}: live file missing ${asset.src}`), { exitCode: EXIT_HARD });
    }
    const bytes = await readFile(source);
    const digest = sha256(bytes);
    let duration = null;
    try { duration = mp3DurationSeconds(bytes); } catch { duration = null; }
    if (asset.sha256 && asset.sha256 !== digest) mismatches.push(`${path.basename(source)} sha256`);
    if (asset.bytes && asset.bytes !== bytes.length) mismatches.push(`${path.basename(source)} bytes`);
    if (asset.durationSeconds && duration != null && Math.abs(Number(asset.durationSeconds) - duration) > 0.35) {
      mismatches.push(`${path.basename(source)} duration`);
    }
    liveParts.push({
      partIndex: index,
      source,
      digest,
      bytes: bytes.length,
      durationSeconds: duration,
      sync: part.sync || [],
      syncIds: part.syncIds || (part.sync || []).map((entry) => entry.id),
      file: partFileName(index, digest),
    });
  }
  if (mismatches.length) {
    throw Object.assign(new Error(`${articleId}: live manifest does not match files: ${mismatches.join(', ')}`), { exitCode: EXIT_HARD });
  }
  if (!liveParts.length) {
    throw Object.assign(new Error(`${articleId}: live manifest has no audio parts`), { exitCode: EXIT_HARD });
  }

  const article = await loadSpokenArticle(articleId, root);
  const scriptConflict = manifest.speechScriptHash && article.speechScriptHash && manifest.speechScriptHash !== article.speechScriptHash
    ? 'live speechScriptHash does not match current Speech Script'
    : null;
  const fingerprint = sha256(JSON.stringify({
    kind: 'live-sadaltager-snapshot',
    articleId,
    liveFingerprint: live.fingerprint,
    speechScriptHash: article.speechScriptHash,
    files: liveParts.map((part) => ({ sha256: part.digest, bytes: part.bytes, durationSeconds: part.durationSeconds })),
  }));
  const dir = candidateDir(articleId, fingerprint, root);
  await mkdir(path.join(dir, 'parts'), { recursive: true });
  await mkdir(path.join(dir, 'reports'), { recursive: true });

  const copied = [];
  for (const part of liveParts) {
    const dest = path.join(dir, 'parts', part.file);
    await cp(part.source, dest);
    copied.push(dest);
  }

  await writeJson(path.join(dir, 'manifest.candidate.json'), {
    ...boundIdentity({
      article,
      fingerprint,
      fullSha256: 'pending-merge',
      status: 'live-snapshot',
      schema: 'bareeq.audio-candidate.v3',
    }),
    title: article.title,
    liveUntouched: true,
    parts: liveParts.map((part) => ({
      partIndex: part.partIndex,
      fingerprint: part.digest,
      file: part.file,
      sha256: part.digest,
      bytes: part.bytes,
      durationSeconds: part.durationSeconds,
      sync: part.sync,
      syncIds: part.syncIds,
    })),
  });

  const merge = await mergeCandidateParts({
    articleId,
    fingerprint,
    root,
    partFiles: copied,
    speechScriptHash: article.speechScriptHash,
  });
  const fullSha256 = merge.sha256;
  const sync = validateSyncMap(article, liveParts);
  await writeJson(path.join(dir, 'reports', 'sync.json'), {
    ...boundIdentity({ article, fingerprint, fullSha256, status: sync.passed ? 'passed' : 'failed', schema: 'bareeq.audio-sync.v2' }),
    ...sync,
    status: sync.passed ? 'passed' : 'failed',
    conflict: scriptConflict,
  });
  let technical = null;
  try {
    technical = await runTechnicalQa({
      articleId,
      fingerprint,
      root,
      expectedSyncIds: expectedSyncIds(article),
      liveBefore: live,
      fullSha256,
      article,
    });
  } catch (error) {
    technical = error.report || { passed: false, failures: error.failures || [error.message] };
  }
  await writeJson(path.join(dir, 'reports', 'technical-qa.json'), {
    ...boundIdentity({ article, fingerprint, fullSha256, status: technical.passed ? 'passed' : 'failed', schema: 'bareeq.audio-technical-qa.v4' }),
    ...technical,
  });
  const listeningPack = [
    `# Live Sadaltager snapshot — ${article.title}`,
    '',
    `- Article: \`${articleId}\``,
    `- Snapshot fingerprint: \`${fingerprint}\``,
    `- full.mp3 SHA-256: \`${fullSha256}\``,
    '- Status: **not performed**. This worksheet is not a passed review.',
    '- Live `public/audio` was not modified.',
    scriptConflict ? `- Conflict: ${scriptConflict}` : '',
    '',
  ].filter(Boolean).join('\n');
  await writeFile(path.join(dir, 'reports', 'listening-pack.md'), listeningPack);
  const snapshot = {
    ...boundIdentity({ article, fingerprint, fullSha256, status: 'live-snapshot', schema: 'bareeq.audio-live-snapshot.v2' }),
    liveFingerprint: live.fingerprint,
    provider: live.provider,
    voiceId: live.voiceId,
    liveUntouched: true,
    scriptConflict,
    skipAsr: Boolean(skipAsr) || !fetchImpl,
    note: 'Read-only snapshot. Live public/audio was not modified. Do not treat this as generated-from-current-speech-script unless hashes match.',
  };
  await writeJson(path.join(dir, 'live-snapshot.json'), snapshot);
  const liveAfter = await inspectLiveSnapshot(articleId, root);
  if (liveAfter.fingerprint !== live.fingerprint) {
    throw Object.assign(new Error(`${articleId}: verify-live changed live audio`), { exitCode: EXIT_HARD });
  }
  return {
    articleId,
    fingerprint,
    candidateDir: dir,
    liveUntouched: true,
    liveFingerprint: live.fingerprint,
    fullSha256,
    scriptConflict,
    technical,
    sync,
    merge,
    status: 'live-snapshot',
    exitCode: EXIT_OK,
  };
}
