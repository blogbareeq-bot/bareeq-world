import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { EXIT_HARD, EXIT_USAGE, candidateDir } from './audio-constants.mjs';

function isInside(parent, file) {
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return file === parent || file.startsWith(prefix);
}

export async function assertSafeEvidencePath(inputPath, { root, articleId, fingerprint }) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw Object.assign(new Error('evidence path is required'), { exitCode: EXIT_USAGE });
  }
  if (inputPath.includes('\0') || inputPath.includes('..')) {
    throw Object.assign(new Error('evidence path traversal refused'), { exitCode: EXIT_HARD });
  }
  if (!articleId || !fingerprint) {
    throw Object.assign(new Error('evidence path lock requires article and fingerprint'), { exitCode: EXIT_USAGE });
  }
  const abs = path.resolve(root, inputPath);
  const candidate = path.resolve(candidateDir(articleId, fingerprint, root));
  let realFile;
  let realCandidate;
  let realRoot;
  try {
    realFile = await realpath(abs);
    realCandidate = await realpath(candidate);
    realRoot = await realpath(root);
  } catch {
    throw Object.assign(new Error('evidence path could not be resolved inside the article candidate directory'), { exitCode: EXIT_HARD });
  }
  if (!isInside(realCandidate, realFile)) {
    throw Object.assign(new Error('evidence path must stay inside the article candidate directory'), { exitCode: EXIT_HARD });
  }
  if (!isInside(realRoot, realFile)) {
    throw Object.assign(new Error('evidence path escaped the workspace'), { exitCode: EXIT_HARD });
  }
  const articleMarker = `${path.sep}${articleId}${path.sep}`;
  if (!realFile.includes(articleMarker)) {
    throw Object.assign(new Error('evidence path is not for this article'), { exitCode: EXIT_HARD });
  }
  return realFile;
}
