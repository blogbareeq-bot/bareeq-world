import { mkdir, readFile, rename, rm, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { evaluatePublishability } from './audio-lifecycle.mjs';
import { EXIT_HARD, EXIT_USAGE, liveAudioDir, candidateDir, sha256 } from './audio-constants.mjs';
import { pathExists } from './audio-checkpoint.mjs';

export function listeningMatchesFingerprint(review, fullSha256, candidateFingerprint) {
  const evidence = review?.evidence || {};
  return review?.status === 'passed'
    && Boolean(review.reviewedBy)
    && Boolean(review.reviewedAt)
    && evidence.sha256 === fullSha256
    && (!evidence.candidateFingerprint || evidence.candidateFingerprint === candidateFingerprint);
}

export async function publishApprovedCandidate({
  articleId,
  fingerprint,
  root = process.cwd(),
  post,
  record,
}) {
  if (!articleId || !fingerprint) {
    throw Object.assign(new Error('publish-approved requires article and candidate fingerprint'), { exitCode: EXIT_USAGE });
  }
  const dir = candidateDir(articleId, fingerprint, root);
  const fullFile = path.join(dir, 'full.mp3');
  const manifestPath = path.join(dir, 'manifest.candidate.json');
  if (!await pathExists(fullFile) || !await pathExists(manifestPath)) {
    throw Object.assign(new Error('publish-approved refused: candidate files are missing'), { exitCode: EXIT_HARD });
  }
  const fullSha256 = sha256(await readFile(fullFile));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.fingerprint !== fingerprint) {
    throw Object.assign(new Error('candidate fingerprint mismatch'), { exitCode: EXIT_HARD });
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
  const rollbackDir = path.join(root, 'audio-rollback', `${articleId}-${Date.now()}`);
  if (await pathExists(liveDir)) {
    await mkdir(path.dirname(rollbackDir), { recursive: true });
    await cp(liveDir, rollbackDir, { recursive: true });
  }
  const tempDir = `${liveDir}.publish-${process.pid}`;
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await cp(dir, tempDir, { recursive: true });
  await writeFile(path.join(tempDir, 'published-from.json'), `${JSON.stringify({
    articleId,
    fingerprint,
    fullSha256,
    publishedAt: new Date().toISOString(),
    rollback: await pathExists(rollbackDir) ? rollbackDir : null,
  }, null, 2)}\n`);
  await rm(liveDir, { recursive: true, force: true });
  await mkdir(path.dirname(liveDir), { recursive: true });
  await rename(tempDir, liveDir);
  return { liveDir, rollbackDir: await pathExists(rollbackDir) ? rollbackDir : null, fullSha256 };
}
