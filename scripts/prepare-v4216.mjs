import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ARTICLE_ID = 'how-touchscreens-work';
const BODY_HASH = '06072389348ff82fd251858c1fe85376f16a56a604cbcde4d47b0228ef2cbd81';
const AUDIO_KEY = 'de93f3d9f91c8b8b';
const ARTICLE_FILE = `src/content/posts/${ARTICLE_ID}.md`;
const COVER = `public/images/posts/${ARTICLE_ID}.webp`;
const THUMBNAIL_SOURCE = `assets/thumbnails-source/${ARTICLE_ID}.webp`;

const [pkgText, lockText, article, reviewText, overridesText, rollout, runner] = await Promise.all([
  readFile('package.json', 'utf8'),
  readFile('package-lock.json', 'utf8'),
  readFile(ARTICLE_FILE, 'utf8'),
  readFile('scripts/speech-review.json', 'utf8'),
  readFile('scripts/speech-overrides.json', 'utf8'),
  readFile('scripts/cloud-tts-rollout.mjs', 'utf8'),
  readFile('scripts/run-v4211-audio.mjs', 'utf8'),
]);
const pkg = JSON.parse(pkgText);
const lock = JSON.parse(lockText);
const review = JSON.parse(reviewText);
const overrides = JSON.parse(overridesText);

if (!['4.21.6', '4.22.0'].includes(pkg.version) || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  throw new Error('V4.21.6 package and dependency-lock identities must match.');
}

const match = article.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
if (!match) throw new Error('Touchscreen article frontmatter/body could not be parsed.');
const frontmatter = match[1];
const body = match[2].replace(/\r\n/g, '\n').trim();
const bodyHash = createHash('sha256').update(body).digest('hex');
if (bodyHash !== BODY_HASH) throw new Error(`Touchscreen article bodyHash drifted: ${bodyHash}.`);
for (const token of [
  'title: "كيف تعرف شاشة هاتفك أين وضعت إصبعك؟"',
  'categorySlug: "simply"',
  'seriesSlug: "technology-simply"',
  `image: "/images/posts/${ARTICLE_ID}.webp"`,
  `thumbnail: "/images/thumbnails/${ARTICLE_ID}.webp"`,
]) if (!frontmatter.includes(token)) throw new Error(`Touchscreen article frontmatter is missing: ${token}`);

const reviewEntry = review.articles?.[ARTICLE_ID];
if (reviewEntry?.bodyHash !== BODY_HASH || !Array.isArray(reviewEntry.checks) || reviewEntry.checks.length !== 6) {
  throw new Error('Touchscreen Arabic speech review lock is incomplete.');
}
const overrideEntry = overrides.articles?.[ARTICLE_ID];
if (!Array.isArray(overrideEntry) || overrideEntry.length < 19) throw new Error('Touchscreen speech overrides are incomplete.');
for (const token of ['Projected Capacitive Touchscreens', 'Mutual Capacitance', 'Touch Controller', 'Multi-Touch']) {
  if (!overrideEntry.some((entry) => entry?.from === token)) throw new Error(`Touchscreen speech override is missing ${token}.`);
}

for (const [label, file] of [['cover', COVER], ['thumbnail source', THUMBNAIL_SOURCE]]) {
  const metadata = await sharp(file).metadata();
  if (metadata.width !== 1600 || metadata.height !== 900 || metadata.format !== 'webp') {
    throw new Error(`Touchscreen ${label} must be a 1600x900 WebP, got ${metadata.width}x${metadata.height} ${metadata.format}.`);
  }
}

for (const token of [ARTICLE_ID, 'TEMPORARY_HAMED_ARTICLES']) if (!rollout.includes(token)) throw new Error(`V4.21.6 rollout is missing ${token}.`);
for (const token of ['TEMPORARY_HAMED_ARTICLES', 'Azure Hamed fallback immediately', 'BAREEQ_AZURE_HAMED_ONLY']) if (!runner.includes(token)) throw new Error(`V4.21.6 audio runner is missing ${token}.`);

const isDraft = /^draft:\s*true\s*$/mi.test(frontmatter);
let manifestExists = true;
try { await access(path.join('public', 'audio', 'articles', AUDIO_KEY, 'manifest.json')); }
catch { manifestExists = false; }
if (!isDraft && !manifestExists) console.log('V4.21.6 touchscreen audio is queued for the guarded Azure Hamed publication stage.');

console.log(`V4.21.6 preparation passed: touchscreen text, sources, 1600x900 artwork, Arabic speech lock, and immediate Hamed fallback policy are locked; article ${isDraft ? 'remains draft' : manifestExists ? 'has production audio' : 'is queued for audio'}.`);
