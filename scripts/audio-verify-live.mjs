import { mkdir, readFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { EXIT_HARD, EXIT_USAGE, candidateDir, sha256 } from './audio-constants.mjs';
import { inspectLiveSnapshot } from './audio-technical-qa.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';

export async function snapshotLiveSadaltager({ articleId, root = process.cwd() }) {
  if (!articleId) throw Object.assign(new Error('verify-live requires --article'), { exitCode: EXIT_USAGE });
  const live = await inspectLiveSnapshot(articleId, root);
  if (!live.exists) throw Object.assign(new Error(`${articleId}: live audio is missing`), { exitCode: EXIT_HARD });
  if (live.voiceId !== PRODUCTION_NARRATOR.voiceId || live.provider !== PRODUCTION_NARRATOR.provider) {
    throw Object.assign(new Error(`${articleId}: live voice is ${live.voiceId}/${live.provider}, not reusable Sadaltager`), { exitCode: EXIT_HARD });
  }
  const fingerprint = `live-${live.fingerprint}`;
  const dir = candidateDir(articleId, fingerprint, root);
  await mkdir(path.join(dir, 'parts'), { recursive: true });
  await mkdir(path.join(dir, 'reports'), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(live.dir, 'manifest.json'), 'utf8'));
  for (const part of manifest.parts || []) {
    const asset = part.audio?.[manifest.defaultVoice];
    if (!asset?.src) continue;
    const source = path.join(root, 'public', asset.src.replace(/^\//, ''));
    if (!await pathExists(source)) continue;
    await cp(source, path.join(dir, 'parts', path.basename(asset.src)));
  }
  await writeJson(path.join(dir, 'live-snapshot.json'), {
    schema: 'bareeq.audio-live-snapshot.v1',
    articleId,
    fingerprint,
    liveFingerprint: live.fingerprint,
    provider: live.provider,
    voiceId: live.voiceId,
    liveUntouched: true,
    note: 'Read-only snapshot. Live public/audio was not modified. Do not treat this as generated-from-current-speech-script unless hashes match.',
  });
  return { articleId, fingerprint, candidateDir: dir, liveUntouched: true, liveFingerprint: live.fingerprint };
}
