import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { sha256 } from './audio-constants.mjs';

const ARTICLE_ID = 'altadakhom-explained-simply';
const AUDIO_KEY = '3fe4cd044730c91d';
const TARGET_SYNC_IDS = ['b0002', 'b0003', 'b0005'];
const DEFAULT_OUT = 'audio-acoustic-trials';

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const root = process.cwd();
const outDir = path.resolve(root, argValue('out-dir', DEFAULT_OUT));
const manifestPath = path.join(root, 'public', 'audio', 'articles', AUDIO_KEY, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (manifest.articleId !== ARTICLE_ID || manifest.defaultVoice !== 'sadaltager') {
  throw new Error('Acoustic baseline manifest identity changed; refusing to guess.');
}

const article = await loadSpokenArticle(ARTICLE_ID, root);
const itemByRuntimeId = new Map(article.items.map((item) => [item.runtimeId, item]));
const { ffmpeg } = await assertFfmpeg();
await mkdir(outDir, { recursive: true });

const cases = [];
for (const [index, syncId] of TARGET_SYNC_IDS.entries()) {
  let located = null;
  for (const [partIndex, part] of manifest.parts.entries()) {
    const sync = (part.sync || []).find((entry) => entry.id === syncId);
    if (sync) {
      located = { part, partIndex, sync };
      break;
    }
  }
  if (!located) throw new Error(`Missing sync id ${syncId} in published baseline.`);
  const item = itemByRuntimeId.get(syncId);
  if (!item?.text) throw new Error(`Missing canonical spoken item for ${syncId}.`);

  const asset = located.part.audio?.[manifest.defaultVoice];
  if (!asset?.src || !(Number(asset.durationSeconds) > 0) || !asset.sha256) {
    throw new Error(`Published baseline asset is incomplete for ${syncId}.`);
  }
  const source = path.join(root, 'public', asset.src.replace(/^\//, ''));
  const sourceBytes = await readFile(source);
  if (sha256(sourceBytes) !== asset.sha256) {
    throw new Error(`Published Sadaltager SHA-256 mismatch for ${syncId}.`);
  }

  const startSeconds = Number((Number(located.sync.start) * Number(asset.durationSeconds)).toFixed(3));
  const endSeconds = Number((Number(located.sync.end) * Number(asset.durationSeconds)).toFixed(3));
  const durationSeconds = Number((endSeconds - startSeconds).toFixed(3));
  if (!(durationSeconds > 1)) throw new Error(`Invalid baseline duration for ${syncId}.`);

  const caseId = `case-${String(index + 1).padStart(2, '0')}-${syncId}`;
  const caseDir = path.join(outDir, caseId);
  await mkdir(caseDir, { recursive: true });
  const baselineFile = path.join(caseDir, 'sadaltager.mp3');
  const cut = await runCommand(ffmpeg, [
    '-v', 'error',
    '-ss', String(startSeconds),
    '-i', source,
    '-t', String(durationSeconds),
    '-ac', '1',
    '-ar', '48000',
    '-c:a', 'libmp3lame',
    '-b:a', '96k',
    '-y', baselineFile,
  ]);
  if (cut.code !== 0) throw new Error(`ffmpeg baseline extraction failed for ${syncId}: ${cut.stderr}`);

  await writeFile(path.join(caseDir, 'expected.txt'), `${item.text.trim()}\n`, 'utf8');
  cases.push({
    caseId,
    syncId,
    type: item.type,
    expectedText: item.text.trim(),
    sourceArticleId: ARTICLE_ID,
    sourceAudioKey: AUDIO_KEY,
    publishedPartIndex: located.partIndex,
    publishedAsset: asset.src,
    publishedAssetSha256: asset.sha256,
    syncStart: located.sync.start,
    syncEnd: located.sync.end,
    extractedStartSeconds: startSeconds,
    extractedDurationSeconds: durationSeconds,
    baseline: {
      engineId: 'gemini',
      model: manifest.model,
      voice: manifest.defaultVoice,
      sourceStatus: 'published-production-reference',
      file: path.relative(outDir, baselineFile),
      sha256: sha256(await readFile(baselineFile)),
    },
  });
}

const payload = {
  schema: 'bareeq.audio-acoustic-trial.v1',
  generatedAt: new Date().toISOString(),
  sourceManifest: path.relative(root, manifestPath),
  sourceManifestFingerprint: manifest.fingerprint,
  sourceSpeechScriptHash: manifest.speechScriptHash,
  publicationLockRequired: true,
  cases,
};
await writeFile(path.join(outDir, 'trial-cases.json'), `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Prepared ${cases.length} published-Sadaltager acoustic baselines under ${path.relative(root, outDir)}.`);
