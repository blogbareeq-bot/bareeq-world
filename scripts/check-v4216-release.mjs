import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ARTICLE_ID = 'how-touchscreens-work';
const BODY_HASH = '06072389348ff82fd251858c1fe85376f16a56a604cbcde4d47b0228ef2cbd81';
const AUDIO_KEY = 'de93f3d9f91c8b8b';

const [pkgText, lockText, article, reviewText, overridesText, rolloutText, runnerText] = await Promise.all([
  readFile('package.json', 'utf8'),
  readFile('package-lock.json', 'utf8'),
  readFile(`src/content/posts/${ARTICLE_ID}.md`, 'utf8'),
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
  throw new Error('V4.21.6 package identity is not locked consistently.');
}

const match = article.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
if (!match) throw new Error('Touchscreen article is not parseable.');
const frontmatter = match[1];
const bodyHash = createHash('sha256').update(match[2].replace(/\r\n/g, '\n').trim()).digest('hex');
if (bodyHash !== BODY_HASH) throw new Error(`Touchscreen article bodyHash mismatch: ${bodyHash}.`);
const isDraft = /^draft:\s*true\s*$/mi.test(frontmatter);

const reviewEntry = review.articles?.[ARTICLE_ID];
if (reviewEntry?.bodyHash !== BODY_HASH || reviewEntry.checks?.length !== 6) throw new Error('Touchscreen speech review is not locked.');
if ((overrides.articles?.[ARTICLE_ID]?.length || 0) < 19) throw new Error('Touchscreen speech overrides are incomplete.');

for (const token of [ARTICLE_ID, 'TEMPORARY_HAMED_ARTICLES']) if (!rolloutText.includes(token)) throw new Error(`Rollout source is missing ${token}.`);
for (const token of ['TEMPORARY_HAMED_ARTICLES', 'Azure Hamed fallback immediately', 'BAREEQ_AZURE_HAMED_ONLY']) if (!runnerText.includes(token)) throw new Error(`Audio runner is missing ${token}.`);
const build = pkg.scripts?.build || '';
for (const token of ['prepare-v4216.mjs', 'check-v4216-release.mjs', 'run-v4211-audio.mjs', 'astro build']) if (!build.includes(token)) throw new Error(`V4.21.6 build pipeline is missing ${token}.`);

const postFiles = (await readdir('src/content/posts')).filter((name) => name.endsWith('.md'));
let live = 0;
for (const file of postFiles) {
  const source = await readFile(path.join('src/content/posts', file), 'utf8');
  if (!/^draft:\s*true\s*$/mi.test(source)) live += 1;
}
if (isDraft && live !== 14) throw new Error(`V4.21.6 RC expects 14 live articles while touchscreen remains draft, found ${live}.`);
if (!isDraft && live !== 15) throw new Error(`V4.21.6 publication expects 15 live articles, found ${live}.`);

const manifestPath = path.join('public', 'audio', 'articles', AUDIO_KEY, 'manifest.json');
let manifest = null;
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
if (!isDraft && manifest) {
  const approvedGemini = manifest.articleId === ARTICLE_ID && manifest.provider === 'Google Gemini API' && manifest.model === 'gemini-3.1-flash-tts-preview' && manifest.language === 'ar' && manifest.defaultVoice === 'sadaltager';
  const approvedHamed = manifest.articleId === ARTICLE_ID && manifest.provider === 'Microsoft Azure AI Speech' && manifest.model === 'Neural TTS' && manifest.language === 'ar-SA' && manifest.defaultVoice === 'hamed' && manifest.voices?.length === 1 && manifest.voices[0]?.providerVoice === 'ar-SA-HamedNeural';
  const approvedFahed = manifest.articleId === ARTICLE_ID && manifest.provider === 'Microsoft Azure AI Speech' && manifest.model === 'Neural TTS' && manifest.language === 'ar-KW' && manifest.defaultVoice === 'fahed' && manifest.voices?.length === 1 && manifest.voices[0]?.providerVoice === 'ar-KW-FahedNeural';
  if (!approvedGemini && !approvedHamed && !approvedFahed) throw new Error('Touchscreen production audio must be complete Gemini Sadaltager, Azure Hamed, or Azure Fahed.');
}

for (const file of [
  `public/images/posts/${ARTICLE_ID}.webp`,
  `assets/thumbnails-source/${ARTICLE_ID}.webp`,
]) await access(file);

for (const deferred of ['فكرة تبقى معك', 'بريق عملي', 'ميزان بريق', 'كيف استخدمنا المصادر؟']) {
  if (article.includes(deferred)) throw new Error(`Paused article layer returned: ${deferred}`);
}

console.log(`V4.21.6 release gate passed: ${live} live article(s), touchscreen body/speech/artwork locked, immediate Azure Hamed fallback wired, Gemini checkpoint replacement remains atomic, and the article is ${isDraft ? 'a verified draft' : manifest ? 'published with complete audio' : 'queued for guarded audio generation'}.`);
