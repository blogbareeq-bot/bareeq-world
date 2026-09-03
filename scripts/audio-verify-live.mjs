import { mkdir, readFile, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXIT_CONFIG, EXIT_HARD, EXIT_OK, EXIT_USAGE, candidateDir, sha256 } from './audio-constants.mjs';
import { inspectLiveSnapshot, runTechnicalQa } from './audio-technical-qa.mjs';
import { pathExists, writeJson } from './audio-checkpoint.mjs';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { expectedSyncIds, validateSyncMap } from './audio-sync.mjs';
import { mergeCandidateParts } from './audio-merge.mjs';
import { boundIdentity } from './audio-report.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { partFileName } from './audio-checkpoint.mjs';
import { transcribeDualAsr } from './audio-asr-transcribe.mjs';

export async function snapshotLiveSadaltager({
  articleId,
  root = process.cwd(),
  fetchImpl,
  skipAsr = true,
  withAsr = false,
  apiKey = process.env.GEMINI_API_KEY,
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
  const runAsr = Boolean(withAsr) && !skipAsr;
  let asr = {
    skipped: true,
    certified: false,
    note: 'snapshot-only is not a certified live verification. Dual ASR was not run.',
  };
  if (runAsr) {
    if (!apiKey?.trim() && !fetchImpl) {
      throw Object.assign(new Error('verify-live --with-asr requires GEMINI_API_KEY. No transcription request was sent.'), { exitCode: EXIT_CONFIG });
    }
    try {
      const dual = await transcribeDualAsr({
        audioPath: path.join(dir, 'full.mp3'),
        expectedText: article.spokenText,
        apiKey: apiKey || 'test-key',
        fetchImpl,
        reportsDir: path.join(dir, 'reports'),
        fingerprint,
        fullSha256,
        article,
      });
      asr = {
        skipped: false,
        certified: false,
        status: 'passed',
        note: 'Dual ASR ran against a copied snapshot. Live public/audio was not modified. Human listening is still required; this is not production certification.',
        ...dual,
      };
    } catch (error) {
      asr = {
        skipped: false,
        certified: false,
        status: 'failed',
        error: error.message,
        dual: error.dual || null,
      };
      await writeJson(path.join(dir, 'live-snapshot.json'), boundIdentity({
        article,
        fingerprint,
        fullSha256,
        status: 'live-asr-failed',
        schema: 'bareeq.audio-live-snapshot.v2',
        extra: {
          liveFingerprint: live.fingerprint,
          liveUntouched: true,
          skipAsr: false,
          asr,
          certified: false,
          note: 'verify-live --with-asr failed. Not certified.',
        },
      }));
      const liveAfterFail = await inspectLiveSnapshot(articleId, root);
      if (liveAfterFail.fingerprint !== live.fingerprint) {
        throw Object.assign(new Error(`${articleId}: verify-live changed live audio`), { exitCode: EXIT_HARD });
      }
      throw Object.assign(error, { asr, liveUntouched: true });
    }
  }
  const status = runAsr ? 'live-asr-checked' : 'live-snapshot-unverified';
  const snapshot = {
    ...boundIdentity({ article, fingerprint, fullSha256, status, schema: 'bareeq.audio-live-snapshot.v2' }),
    liveFingerprint: live.fingerprint,
    provider: live.provider,
    voiceId: live.voiceId,
    liveUntouched: true,
    scriptConflict,
    skipAsr: !runAsr,
    certified: false,
    asr,
    note: runAsr
      ? 'Read-only snapshot with dual ASR. Live public/audio was not modified. Not certified without fingerprint-bound human listening.'
      : 'Read-only snapshot-only. Uncertified. Live public/audio was not modified. Dual ASR was skipped.',
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
    asr,
    certified: false,
    status,
    exitCode: EXIT_OK,
  };
}
