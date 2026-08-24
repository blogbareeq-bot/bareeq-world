import { createHash } from 'node:crypto';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ARTICLE_ID = 'why-some-passports-are-stronger';
const ARTICLE_KEY = '34e34b6f4633d928';
const BODY_HASH = '2b2999dba95bff5e6bfb8ff16d2848fa3b677ffe8f595a5b6166ca15ebf7d4c1';

const [pkgText, lockText, article, reviewText, overridesText, rolloutText, workflow, runner, header, css] = await Promise.all([
  readFile('package.json', 'utf8'),
  readFile('package-lock.json', 'utf8'),
  readFile(`src/content/posts/${ARTICLE_ID}.md`, 'utf8'),
  readFile('scripts/speech-review.json', 'utf8'),
  readFile('scripts/speech-overrides.json', 'utf8'),
  readFile('scripts/cloud-tts-rollout.mjs', 'utf8'),
  readFile('.github/workflows/generate-passport-audio.yml', 'utf8'),
  readFile('scripts/run-v4211-audio.mjs', 'utf8'),
  readFile('src/components/Header.astro', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
]);
const pkg = JSON.parse(pkgText);
const lock = JSON.parse(lockText);
const review = JSON.parse(reviewText);

if (pkg.version !== '4.21.5' || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  throw new Error('package.json and package-lock.json must both identify the committed V4.21.5 release.');
}

const match = article.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
if (!match) throw new Error('Passport article is not parseable.');
const actualBodyHash = createHash('sha256').update(match[1].replace(/\r\n/g, '\n').trim()).digest('hex');
if (actualBodyHash !== BODY_HASH) throw new Error(`Passport bodyHash mismatch: ${actualBodyHash}.`);

const isDraft = /^draft:\s*true\s*$/mi.test(article);
const reviewEntry = review.articles?.[ARTICLE_ID];
if (reviewEntry?.bodyHash !== BODY_HASH || !Array.isArray(reviewEntry.checks) || reviewEntry.checks.length !== 8) {
  throw new Error('Passport article must retain its complete eight-item speech-review lock before synthesis or publication.');
}
for (const token of ['ETA', 'e-Visa', 'Arton Capital', 'Passport Index', 'C-181/23']) {
  if (!overridesText.includes(token)) throw new Error(`speech-overrides lost ${token}.`);
}

const build = pkg.scripts?.build || '';
for (const token of [
  'prepare-v4215.mjs',
  'check-v4215-release.mjs',
  'run-v4211-audio.mjs',
  'import-bundled-gemini-audio.mjs',
  'astro build',
]) {
  if (!build.includes(token)) throw new Error(`V4.21.5 build pipeline is missing ${token}.`);
}
if (!build.includes('BAREEQ_GEMINI_FREE_ROLLOUT=0 BAREEQ_CLOUD_TTS_ACTIVATE=0 node scripts/run-v4211-audio.mjs')) {
  throw new Error('Normal production build must restore verified audio only and must not synthesize Gemini/Cloud audio.');
}
if (!pkg.scripts?.['audio:gemini:resume:prepare']?.includes('prepare-v4215-gemini-resume.mjs')) {
  throw new Error('V4.21.5 resumable Gemini preparation command is missing.');
}
if (!pkg.scripts?.['capture:audio:gemini:baseline']?.includes('capture-bundled-gemini-audio.mjs')) {
  throw new Error('V4.21.5 immutable Gemini baseline capture command is missing.');
}

for (const token of [
  'workflow_dispatch:',
  'GEMINI_API_KEY',
  'prepare-v4215-gemini-resume.mjs',
  '.bareeq-audio-checkpoints',
  'actions/cache/restore@v4',
  'actions/cache/save@v4',
  'git add -f public/audio/articles/34e34b6f4633d928/',
  '${{ github.ref_name }}',
  ARTICLE_ID,
]) {
  if (!workflow.includes(token)) throw new Error(`Passport audio workflow is missing resumable Gemini token: ${token}`);
}
if (/\npush:\s*$/m.test(workflow)) throw new Error('V4.21.5 audio synthesis workflow must be manual-only; push-triggered synthesis is forbidden.');
if (/azure/i.test(workflow)) throw new Error('Passport audio workflow must not substitute Azure for Gemini.');
for (const token of [
  "runStrict('scripts/import-bundled-gemini-audio.mjs')",
  "BAREEQ_TTS_CACHE_ONLY: '1'",
  "BAREEQ_GEMINI_FREE_ROLLOUT",
]) {
  if (!runner.includes(token)) throw new Error(`No-synthesis production audio runner is missing ${token}.`);
}
await access('scripts/bundled-gemini-audio-map.json');
await access('scripts/import-bundled-gemini-audio.mjs');

if (!rolloutText.includes('RELEASE_CANDIDATE_PUBLISHED') || !rolloutText.includes('EXPECTED_PUBLISHED_ARTICLES')) {
  throw new Error('Cloud TTS rollout is not draft-aware for the release-candidate article.');
}

const postFiles = (await readdir('src/content/posts')).filter((name) => name.endsWith('.md'));
let live = 0;
for (const file of postFiles) {
  const source = await readFile(`src/content/posts/${file}`, 'utf8');
  if (!/^draft:\s*true\s*$/mi.test(source)) live += 1;
}
if (![13, 14].includes(live)) throw new Error(`V4.21.5 expects 13 RC or 14 published articles, found ${live}.`);
if (isDraft && live !== 13) throw new Error('Passport article is marked draft but the published article count is not the 13-article RC state.');
if (!isDraft && live !== 14) throw new Error('Published passport article requires the 14-article release state.');

const manifestPath = path.join('public', 'audio', 'articles', ARTICLE_KEY, 'manifest.json');
let manifestExists = true;
try { await access(manifestPath); } catch { manifestExists = false; }
if (!isDraft && !manifestExists) throw new Error('Published passport article has no production audio manifest.');

let audioStatus = 'audio pending';
if (manifestExists) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== 3 || manifest.generatorVersion !== 8 || manifest.articleId !== ARTICLE_ID ||
      manifest.provider !== 'Google Gemini API' || manifest.model !== 'gemini-3.1-flash-tts-preview' ||
      manifest.language !== 'ar' || manifest.outputFormat !== 'audio-48khz-96kbitrate-mono-mp3' ||
      manifest.defaultVoice !== 'sadaltager' || manifest.syncMethod !== 'paragraph-weighted') {
    throw new Error('Passport production audio manifest is not the approved Gemini Sadaltager recording.');
  }
  if (!Array.isArray(manifest.voices) || manifest.voices.length !== 1 || manifest.voices[0]?.id !== 'sadaltager' || manifest.voices[0]?.providerVoice !== 'Sadaltager') {
    throw new Error('Passport production audio manifest has an unexpected voice declaration.');
  }
  if (!Array.isArray(manifest.parts) || manifest.parts.length !== 11) throw new Error(`Passport audio must contain exactly 11 MP3 parts, found ${manifest.parts?.length}.`);

  const root = path.resolve('public', 'audio', 'articles', ARTICLE_KEY);
  const expectedPrefix = `/audio/articles/${ARTICLE_KEY}/`;
  const syncIds = new Set();
  const assets = new Set();
  let totalDuration = 0;
  for (const [index, part] of manifest.parts.entries()) {
    if (!Array.isArray(part?.sync) || !part.sync.length || Object.keys(part.audio || {}).join(',') !== 'sadaltager') {
      throw new Error(`Passport audio part ${index + 1} is missing Gemini sync/audio data.`);
    }
    for (const entry of part.sync) {
      if (!entry?.id || syncIds.has(entry.id) || !(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end)) {
        throw new Error(`Passport audio has an invalid or duplicate sync block at part ${index + 1}.`);
      }
      syncIds.add(entry.id);
    }
    const asset = part.audio.sadaltager;
    if (typeof asset?.src !== 'string' || !asset.src.startsWith(expectedPrefix) || !Number.isInteger(asset.bytes) || asset.bytes < 100 ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || !(asset.durationSeconds > 0) || assets.has(asset.src)) {
      throw new Error(`Passport Gemini asset metadata is invalid at part ${index + 1}.`);
    }
    assets.add(asset.src);
    const local = path.resolve('public', asset.src.replace(/^\//, ''));
    if (!local.startsWith(`${root}${path.sep}`)) throw new Error(`Passport Gemini asset escapes its article directory: ${asset.src}.`);
    const info = await stat(local);
    const bytes = await readFile(local);
    if (!info.isFile() || bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      throw new Error(`Passport Gemini asset integrity mismatch: ${asset.src}.`);
    }
    const measuredDuration = mp3DurationSeconds(bytes);
    if (Math.abs(measuredDuration - asset.durationSeconds) > 0.1) throw new Error(`Passport Gemini asset duration mismatch: ${asset.src}.`);
    totalDuration += asset.durationSeconds;
  }
  if (syncIds.size !== 81 || assets.size !== 11) throw new Error(`Passport audio must contain 11 unique MP3 assets and 81 unique sync blocks; found ${assets.size} assets and ${syncIds.size} blocks.`);
  audioStatus = `11/11 Gemini MP3s and 81/81 sync blocks validated (${totalDuration.toFixed(2)} seconds)`;
}

for (const token of ['header-design-one', 'data-ticker-primary', 'ticker-copy']) if (!header.includes(token)) throw new Error(`V4.21.4 header compatibility lost: ${token}`);
for (const token of ['header-design-one-desktop.svg', 'header-design-one-mobile.svg', 'mobileTickerLabel']) if (!css.includes(token)) throw new Error(`V4.21.4 visual compatibility lost: ${token}`);
for (const deferred of ['فكرة تبقى معك', 'بريق عملي', 'ميزان بريق', 'كيف استخدمنا المصادر؟']) {
  if ([header, css].some((source) => source.includes(deferred))) throw new Error(`Paused layer returned: ${deferred}`);
}

console.log(`V4.21.5 release gate passed: package identity locked, V4.21.4 UX preserved, infographic deferred, ${live} live article(s), safe no-synthesis production build, resumable Gemini workflow, and ${audioStatus}.`);
