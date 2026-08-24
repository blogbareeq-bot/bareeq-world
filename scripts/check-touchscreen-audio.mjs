import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ARTICLE_ID = 'how-touchscreens-work';
const AUDIO_KEY = 'de93f3d9f91c8b8b';
const root = path.join('public', 'audio', 'articles', AUDIO_KEY);
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.articleId !== ARTICLE_ID) throw new Error('Touchscreen audio articleId mismatch.');
if (manifest.provider !== 'Microsoft Azure AI Speech' || manifest.model !== 'Neural TTS' || manifest.language !== 'ar-SA') throw new Error('Touchscreen fallback must use Azure Neural TTS in ar-SA.');
if (manifest.defaultVoice !== 'hamed' || manifest.voices?.length !== 1 || manifest.voices[0]?.providerVoice !== 'ar-SA-HamedNeural') throw new Error('Touchscreen fallback must contain Hamed only.');
if (!Array.isArray(manifest.parts) || !manifest.parts.length) throw new Error('Touchscreen audio has no parts.');

const planResult = spawnSync(process.execPath, ['scripts/generate-audio.mjs', '--sync-plan'], {
  encoding: 'utf8',
  env: { ...process.env, BAREEQ_TTS_PROVIDER: 'azure', BAREEQ_TTS_INCLUDE_IDS: ARTICLE_ID },
  maxBuffer: 8 * 1024 * 1024,
});
if (planResult.error) throw planResult.error;
if (planResult.status !== 0) throw new Error(`Touchscreen sync plan failed: ${planResult.stderr || planResult.stdout}`);
const planned = JSON.parse(planResult.stdout).find((item) => item.id === ARTICLE_ID);
if (!planned) throw new Error('Touchscreen article is absent from the Azure sync plan.');
const normalizedManifestSync = manifest.parts.map((part) => ({
  sync: part.sync.map(({ id, start, end }) => ({ id, start, end })),
}));
if (JSON.stringify(planned.parts) !== JSON.stringify(normalizedManifestSync)) throw new Error('Touchscreen manifest synchronization differs from the locked Azure plan.');

const syncIds = new Set();
let duration = 0;
for (const part of manifest.parts) {
  if (!Array.isArray(part.sync) || !part.sync.length) throw new Error('Touchscreen audio part is missing sync entries.');
  for (const entry of part.sync) {
    if (!entry?.id || syncIds.has(entry.id)) throw new Error(`Invalid or duplicate touchscreen sync id: ${entry?.id}`);
    syncIds.add(entry.id);
  }
  const asset = part.audio?.hamed;
  if (!asset?.src) throw new Error('Touchscreen audio part is missing Hamed.');
  const local = path.join('public', asset.src.replace(/^\//, ''));
  const info = await stat(local);
  if (!info.isFile() || info.size !== asset.bytes || info.size < 100) throw new Error(`Touchscreen MP3 size mismatch: ${asset.src}`);
  const bytes = await readFile(local);
  if (asset.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error(`Touchscreen MP3 SHA mismatch: ${asset.src}`);
  const measured = mp3DurationSeconds(bytes);
  if (!(asset.durationSeconds > 0) || Math.abs(measured - asset.durationSeconds) > 0.1) throw new Error(`Touchscreen MP3 duration mismatch: ${asset.src}`);
  duration += asset.durationSeconds;
}
if (syncIds.size !== planned.segments.length) throw new Error(`Touchscreen sync coverage mismatch: ${syncIds.size}/${planned.segments.length}.`);
console.log(`Touchscreen Azure Hamed audio passed: ${manifest.parts.length} MP3 part(s), ${syncIds.size} sync blocks, ${duration.toFixed(2)} seconds.`);
