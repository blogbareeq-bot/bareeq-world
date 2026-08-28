import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';

const ROOT = process.cwd();
const articleId = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length);
if (!articleId) {
  console.log('Technical QA: pass --article=<id> after candidate files exist locally. This command never synthesizes.');
  process.exit(0);
}

const { createHash } = await import('node:crypto');
const key = createHash('sha256').update(articleId).digest('hex').slice(0, 16);
const dir = path.join(ROOT, 'public', 'audio', 'articles', key);
const manifestPath = path.join(dir, 'manifest.json');
try { await access(manifestPath); } catch {
  console.log(`Technical QA pending for ${articleId}: local candidate is not present at ${path.relative(ROOT, manifestPath)}. Live audio was not modified.`);
  process.exit(0);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const failures = [];
if (manifest.articleId !== articleId) failures.push(`articleId ${manifest.articleId}`);
if (manifest.provider !== PRODUCTION_NARRATOR.provider) failures.push(`provider ${manifest.provider}`);
if (manifest.model !== PRODUCTION_NARRATOR.model) failures.push(`model ${manifest.model}`);
if (manifest.defaultVoice !== PRODUCTION_NARRATOR.voiceId) failures.push(`voice ${manifest.defaultVoice}`);
if (manifest.language !== PRODUCTION_NARRATOR.language) failures.push(`language ${manifest.language}`);
if (manifest.generatorVersion !== PRODUCTION_NARRATOR.generatorVersion) failures.push(`generatorVersion ${manifest.generatorVersion}`);
if (!Array.isArray(manifest.parts) || !manifest.parts.length) failures.push('missing parts');

const syncIds = new Set();
let totalDuration = 0;
for (const part of manifest.parts || []) {
  if (!Array.isArray(part?.sync) || !part.sync.length) failures.push('a part has no sync map');
  let previous = -1;
  for (const entry of part.sync || []) {
    if (!entry?.id || syncIds.has(entry.id)) failures.push(`invalid sync id ${entry?.id}`);
    if (!(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end) || entry.start < previous) failures.push(`sync range ${entry?.id}`);
    syncIds.add(entry.id);
    previous = entry.start;
  }
  const asset = part.audio?.[PRODUCTION_NARRATOR.voiceId];
  if (!asset?.src) {
    failures.push('missing Sadaltager asset');
    continue;
  }
  const file = path.join(ROOT, 'public', asset.src.replace(/^\//, ''));
  let bytes;
  try { bytes = await readFile(file); } catch {
    failures.push(`missing file ${asset.src}`);
    continue;
  }
  if (bytes.length !== asset.bytes) failures.push(`byte mismatch ${asset.src}`);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (asset.sha256 && sha !== asset.sha256) failures.push(`sha256 mismatch ${asset.src}`);
  const duration = mp3DurationSeconds(bytes);
  if (!(asset.durationSeconds > 0) || Math.abs(duration - asset.durationSeconds) > 0.1) failures.push(`duration mismatch ${asset.src}`);
  totalDuration += asset.durationSeconds;
}

if (failures.length) {
  console.error(`Technical QA failed for ${articleId}:`);
  failures.forEach((item) => console.error(`- ${item}`));
  process.exit(1);
}
console.log(`Technical QA passed for ${articleId}: ${manifest.parts.length} part(s), ${syncIds.size} sync block(s), ${totalDuration.toFixed(3)}s.`);
