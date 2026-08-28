import { mkdir, readFile, rename, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluatePublishability } from './audio-lifecycle.mjs';
import {
  EXIT_HARD,
  EXIT_OK,
  EXIT_USAGE,
  liveAudioDir,
  candidateDir,
  sha256,
  audioKeyFor,
} from './audio-constants.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';
import { isValidProductionManifest } from './audio-manifest.mjs';

export function listeningMatchesFingerprint(review, fullSha256, candidateFingerprint) {
  const evidence = review?.evidence || {};
  return review?.status === 'passed'
    && Boolean(review.reviewedBy)
    && Boolean(review.reviewedAt)
    && evidence.sha256 === fullSha256
    && (!evidence.candidateFingerprint || evidence.candidateFingerprint === candidateFingerprint);
}

export async function atomicReplaceDir(liveDir, stagingDir, { afterLiveMoved } = {}) {
  const backup = `${liveDir}.prev-${process.pid}`;
  await rm(backup, { recursive: true, force: true });
  let hadLive = true;
  try {
    await rename(liveDir, backup);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    hadLive = false;
  }
  try {
    if (afterLiveMoved) await afterLiveMoved({ backup, stagingDir, liveDir, hadLive });
    await mkdir(path.dirname(liveDir), { recursive: true });
    await rename(stagingDir, liveDir);
  } catch (error) {
    if (hadLive) await rename(backup, liveDir).catch(() => {});
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { backup: hadLive ? backup : null, hadLive };
}

export function persistPublishedAudio({ root, liveDir, articleId, message }) {
  const rel = path.relative(root, liveDir);
  const add = spawnSync('git', ['add', '--', rel], { cwd: root, encoding: 'utf8' });
  if (add.status !== 0) {
    throw Object.assign(new Error(`git add failed: ${add.stderr || add.stdout}`), { exitCode: EXIT_HARD });
  }
  const commit = spawnSync('git', ['commit', '-m', message || `audio: publish ${articleId}`], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) {
    throw Object.assign(new Error(`git commit failed: ${commit.stderr || commit.stdout}`), { exitCode: EXIT_HARD });
  }
  return { committed: true, relativeDir: rel };
}

export async function publishApprovedCandidate({
  articleId,
  fingerprint,
  root = process.cwd(),
  post,
  record,
  persistGit = process.env.BAREEQ_AUDIO_PUBLISH_GIT === '1',
  afterLiveMoved,
}) {
  if (!articleId || !fingerprint) {
    throw Object.assign(new Error('publish-approved requires article and candidate fingerprint'), { exitCode: EXIT_USAGE });
  }
  const dir = candidateDir(articleId, fingerprint, root);
  const fullFile = path.join(dir, 'full.mp3');
  const playerManifestPath = path.join(dir, 'manifest.json');
  const candidateManifestPath = path.join(dir, 'manifest.candidate.json');
  if (!await pathExists(fullFile) || !await pathExists(playerManifestPath)) {
    throw Object.assign(new Error('publish-approved refused: candidate files are missing'), { exitCode: EXIT_HARD });
  }
  const fullSha256 = sha256(await readFile(fullFile));
  const playerManifest = JSON.parse(await readFile(playerManifestPath, 'utf8'));
  const candidateMeta = await pathExists(candidateManifestPath)
    ? JSON.parse(await readFile(candidateManifestPath, 'utf8'))
    : playerManifest;
  if ((candidateMeta.fingerprint || playerManifest.fingerprint) !== fingerprint) {
    throw Object.assign(new Error('candidate fingerprint mismatch'), { exitCode: EXIT_HARD });
  }
  if (playerManifest.fullSha256 && playerManifest.fullSha256 !== fullSha256) {
    throw Object.assign(new Error('player manifest fullSha256 does not match full.mp3'), { exitCode: EXIT_HARD });
  }
  if (!isValidProductionManifest(playerManifest)) {
    throw Object.assign(new Error('publish-approved refused: candidate manifest is not player-compatible'), { exitCode: EXIT_HARD });
  }
  if (!listeningMatchesFingerprint(record?.humanListening, fullSha256, fingerprint)) {
    throw Object.assign(new Error('publish-approved refused: human listening is missing or not tied to this file fingerprint'), { exitCode: EXIT_HARD });
  }
  const publication = evaluatePublishability(post, record);
  if (!publication.passed) {
    throw Object.assign(new Error(`publish-approved refused:\n${publication.reasons.map((reason) => `- ${reason}`).join('\n')}`), {
      exitCode: EXIT_HARD,
      reasons: publication.reasons,
    });
  }

  const liveDir = liveAudioDir(articleId, root);
  const rollbackDir = path.join(root, 'audio-rollback', `${articleId}-${fingerprint.slice(0, 12)}`);
  const staging = `${liveDir}.next-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const publishedManifest = {
    ...playerManifest,
    fullSha256,
    fingerprint,
    publishedFromCandidate: fingerprint,
    publishedAt: new Date().toISOString(),
  };
  const copied = new Set();
  for (const part of publishedManifest.parts) {
    const asset = part.audio?.[publishedManifest.defaultVoice];
    const filename = path.basename(asset.src);
    const source = path.join(dir, 'parts', filename);
    if (!await pathExists(source)) {
      throw Object.assign(new Error(`publish-approved refused: missing part ${filename}`), { exitCode: EXIT_HARD });
    }
    await cp(source, path.join(staging, filename));
    copied.add(filename);
    asset.src = `/audio/articles/${audioKeyFor(articleId)}/${filename}`;
  }
  await writeJson(path.join(staging, 'manifest.json'), publishedManifest);
  await writeJson(path.join(staging, 'published-from.json'), {
    articleId,
    fingerprint,
    fullSha256,
    publishedAt: publishedManifest.publishedAt,
  });

  const swap = await atomicReplaceDir(liveDir, staging, { afterLiveMoved });
  if (swap.hadLive && swap.backup) {
    await mkdir(path.dirname(rollbackDir), { recursive: true });
    await rm(rollbackDir, { recursive: true, force: true });
    await cp(swap.backup, rollbackDir, { recursive: true });
    await rm(swap.backup, { recursive: true, force: true });
  }

  let git = null;
  if (persistGit) {
    const persist = typeof persistGit === 'function'
      ? persistGit
      : persistPublishedAudio;
    git = await persist({
      root,
      liveDir,
      articleId,
      message: `audio: publish ${articleId} ${fingerprint.slice(0, 12)}`,
    });
  }

  return {
    liveDir,
    rollbackDir: await pathExists(rollbackDir) ? rollbackDir : null,
    fullSha256,
    fingerprint,
    manifestPath: path.join(liveDir, 'manifest.json'),
    git,
    exitCode: EXIT_OK,
  };
}
