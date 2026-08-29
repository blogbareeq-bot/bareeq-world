import { mkdir, readFile, rename, rm, cp, writeFile } from 'node:fs/promises';
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
import { loadBoundEvidence, listeningMatchesFingerprint as listeningBound } from './audio-evidence.mjs';
import { boundIdentity } from './audio-report.mjs';
import { atomicWriteFile } from './audio-io.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { loadSpokenArticle } from './audio-split.mjs';

export function listeningMatchesFingerprint(review, fullSha256, candidateFingerprint) {
  return listeningBound(review, fullSha256, candidateFingerprint);
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

export function persistPublishedAudio({
  root,
  liveDir,
  articleId,
  fingerprint,
  evidencePaths = [],
  message,
  push = process.env.BAREEQ_AUDIO_PUBLISH_PUSH === '1',
  waitPreview,
}) {
  const identity = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' });
  if (identity.status !== 0 || !identity.stdout.trim()) {
    const name = spawnSync('git', ['config', 'user.name', process.env.GIT_AUTHOR_NAME || 'bareeq-audio'], { cwd: root, encoding: 'utf8' });
    if (name.status !== 0) throw Object.assign(new Error(`git config user.name failed: ${name.stderr}`), { exitCode: EXIT_HARD });
  }
  const email = spawnSync('git', ['config', 'user.email'], { cwd: root, encoding: 'utf8' });
  if (email.status !== 0 || !email.stdout.trim()) {
    const setEmail = spawnSync('git', ['config', 'user.email', process.env.GIT_AUTHOR_EMAIL || 'audio@bareeq.local'], { cwd: root, encoding: 'utf8' });
    if (setEmail.status !== 0) throw Object.assign(new Error(`git config user.email failed: ${setEmail.stderr}`), { exitCode: EXIT_HARD });
  }
  const relLive = path.relative(root, liveDir);
  const addArgs = ['add', '-f', '--', relLive, ...evidencePaths.map((item) => path.relative(root, item))];
  const add = spawnSync('git', addArgs, { cwd: root, encoding: 'utf8' });
  if (add.status !== 0) {
    throw Object.assign(new Error(`git add failed: ${add.stderr || add.stdout}`), { exitCode: EXIT_HARD });
  }
  const commit = spawnSync('git', ['commit', '-m', message || `audio: publish ${articleId} ${String(fingerprint || '').slice(0, 12)}`], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) {
    throw Object.assign(new Error(`git commit failed: ${commit.stderr || commit.stdout}`), { exitCode: EXIT_HARD });
  }
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  let pushed = false;
  if (push) {
    const remote = spawnSync('git', ['push', 'origin', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (remote.status !== 0) {
      throw Object.assign(new Error(`git push failed: ${remote.stderr || remote.stdout}`), { exitCode: EXIT_HARD });
    }
    pushed = true;
  }
  const preview = typeof waitPreview === 'function' ? waitPreview({ sha: sha.stdout.trim(), articleId }) : { skipped: true };
  return { committed: true, sha: sha.stdout.trim(), relativeDir: relLive, pushed, preview };
}

async function restoreManifest(liveDir, previous) {
  if (!previous) {
    await rm(path.join(liveDir, 'manifest.json'), { force: true }).catch(() => {});
    return;
  }
  await atomicWriteFile(path.join(liveDir, 'manifest.json'), `${JSON.stringify(previous, null, 2)}\n`);
}

export async function publishApprovedCandidate({
  articleId,
  fingerprint,
  root = process.cwd(),
  post,
  record,
  listening,
  persistGit = process.env.BAREEQ_AUDIO_PUBLISH_GIT === '1',
  afterManifestWrite,
}) {
  if (!articleId || !fingerprint) {
    throw Object.assign(new Error('publish-approved requires article and candidate fingerprint'), { exitCode: EXIT_USAGE });
  }
  const dir = candidateDir(articleId, fingerprint, root);
  const fullFile = path.join(dir, 'full.mp3');
  const playerManifestPath = path.join(dir, 'manifest.json');
  if (!await pathExists(fullFile) || !await pathExists(playerManifestPath)) {
    throw Object.assign(new Error('publish-approved refused: candidate files are missing'), { exitCode: EXIT_HARD });
  }
  const article = await loadSpokenArticle(articleId, root).catch(() => ({ articleId, speechScriptHash: record?.speechScriptHash || null }));
  const fullSha256 = sha256(await readFile(fullFile));
  const playerManifest = JSON.parse(await readFile(playerManifestPath, 'utf8'));
  if ((playerManifest.candidateFingerprint || playerManifest.fingerprint) !== fingerprint) {
    throw Object.assign(new Error('candidate fingerprint mismatch'), { exitCode: EXIT_HARD });
  }
  if (playerManifest.fullSha256 && playerManifest.fullSha256 !== fullSha256) {
    throw Object.assign(new Error('player manifest fullSha256 does not match full.mp3'), { exitCode: EXIT_HARD });
  }
  if (!isValidProductionManifest(playerManifest)) {
    throw Object.assign(new Error('publish-approved refused: candidate manifest is not player-compatible'), { exitCode: EXIT_HARD });
  }
  const human = listening || record?.humanListening;
  if (!listeningMatchesFingerprint(human, fullSha256, fingerprint)) {
    throw Object.assign(new Error('publish-approved refused: human listening is missing or not tied to this file fingerprint'), { exitCode: EXIT_HARD });
  }
  await loadBoundEvidence({
    dir,
    fingerprint,
    fullSha256,
    articleId,
    speechScriptHash: article.speechScriptHash,
    listening: human,
    record,
  });
  const publication = evaluatePublishability(post, record);
  if (!publication.passed) {
    throw Object.assign(new Error(`publish-approved refused:\n${publication.reasons.map((reason) => `- ${reason}`).join('\n')}`), {
      exitCode: EXIT_HARD,
      reasons: publication.reasons,
    });
  }

  const liveDir = liveAudioDir(articleId, root);
  await mkdir(liveDir, { recursive: true });
  const liveManifestPath = path.join(liveDir, 'manifest.json');
  const previousManifest = await pathExists(liveManifestPath)
    ? JSON.parse(await readFile(liveManifestPath, 'utf8'))
    : null;
  const previousFingerprint = previousManifest?.fingerprint || previousManifest?.publishedFromCandidate || 'none';
  const rollbackDir = path.join(root, 'audio-rollback', `${articleId}-${String(previousFingerprint).slice(0, 12)}`);
  await mkdir(rollbackDir, { recursive: true });
  if (previousManifest) {
    await writeJson(path.join(rollbackDir, 'manifest.json'), previousManifest);
    await writeJson(path.join(rollbackDir, 'rollback.json'), {
      articleId,
      previousFingerprint,
      restoredFrom: liveManifestPath,
      savedAt: new Date().toISOString(),
    });
  }

  const publishedAt = new Date().toISOString();
  const publishedManifest = {
    ...playerManifest,
    ...boundIdentity({
      article,
      fingerprint,
      fullSha256,
      status: 'published',
      schema: playerManifest.schema || 'bareeq.audio-production-manifest.v3',
      extra: {
        generatedAt: publishedAt,
        speechScriptHash: article.speechScriptHash,
      },
    }),
    fullSha256,
    fingerprint,
    candidateFingerprint: fingerprint,
    publishedFromCandidate: fingerprint,
    publishedAt,
  };

  const copied = [];
  try {
    for (const part of publishedManifest.parts) {
      const asset = part.audio?.[publishedManifest.defaultVoice];
      const filename = path.basename(asset.src);
      const source = path.join(dir, 'parts', filename);
      if (!await pathExists(source)) {
        throw Object.assign(new Error(`publish-approved refused: missing part ${filename}`), { exitCode: EXIT_HARD });
      }
      const bytes = await readFile(source);
      if (sha256(bytes) !== asset.sha256) {
        throw Object.assign(new Error(`publish-approved refused: part ${filename} SHA-256 changed`), { exitCode: EXIT_HARD });
      }
      if (asset.bytes && asset.bytes !== bytes.length) {
        throw Object.assign(new Error(`publish-approved refused: part ${filename} size changed`), { exitCode: EXIT_HARD });
      }
      const duration = mp3DurationSeconds(bytes);
      if (asset.durationSeconds && Math.abs(duration - Number(asset.durationSeconds)) > 0.35) {
        throw Object.assign(new Error(`publish-approved refused: part ${filename} duration changed`), { exitCode: EXIT_HARD });
      }
      const dest = path.join(liveDir, filename);
      await cp(source, dest);
      copied.push(dest);
      asset.src = `/audio/articles/${audioKeyFor(articleId)}/${filename}`;
    }
    const tempManifest = path.join(liveDir, `manifest.${fingerprint.slice(0, 12)}.tmp.json`);
    await atomicWriteFile(tempManifest, `${JSON.stringify(publishedManifest, null, 2)}\n`);
    if (afterManifestWrite) await afterManifestWrite({ liveDir, tempManifest, previousManifest });
    await rename(tempManifest, liveManifestPath);
  } catch (error) {
    await restoreManifest(liveDir, previousManifest);
    throw error;
  }

  await writeJson(path.join(dir, 'reports', 'publish-record.json'), boundIdentity({
    article,
    fingerprint,
    fullSha256,
    status: 'published',
    schema: 'bareeq.audio-publish.v1',
    extra: {
      generatedAt: publishedAt,
      liveDir,
      rollbackDir,
      previousFingerprint,
      humanListening: human,
    },
  }));

  let git = null;
  if (persistGit) {
    const persist = typeof persistGit === 'function' ? persistGit : persistPublishedAudio;
    git = await persist({
      root,
      liveDir,
      articleId,
      fingerprint,
      evidencePaths: [
        path.join(dir, 'reports', 'publish-record.json'),
        path.join(rollbackDir, 'manifest.json'),
      ].filter(Boolean),
      message: `audio: publish ${articleId} ${fingerprint.slice(0, 12)}`,
    });
  }

  return {
    liveDir,
    rollbackDir,
    fullSha256,
    fingerprint,
    manifestPath: liveManifestPath,
    previousManifestKept: Boolean(previousManifest),
    oldFilesPreserved: true,
    git,
    exitCode: EXIT_OK,
    status: 'published',
  };
}
