import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ARTICLE_ID = 'why-some-passports-are-stronger';
const ARTICLE_KEY = '34e34b6f4633d928';
const BODY_HASH = '2b2999dba95bff5e6bfb8ff16d2848fa3b677ffe8f595a5b6166ca15ebf7d4c1';

const [pkgText, lockText, article, reviewText, overridesText, rolloutText, audioRunner, workflow, header, css] = await Promise.all([
  readFile('package.json', 'utf8'),
  readFile('package-lock.json', 'utf8'),
  readFile(`src/content/posts/${ARTICLE_ID}.md`, 'utf8'),
  readFile('scripts/speech-review.json', 'utf8'),
  readFile('scripts/speech-overrides.json', 'utf8'),
  readFile('scripts/cloud-tts-rollout.mjs', 'utf8'),
  readFile('scripts/run-v4211-audio.mjs', 'utf8'),
  readFile('.github/workflows/generate-passport-audio.yml', 'utf8'),
  readFile('src/components/Header.astro', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
]);
const pkg = JSON.parse(pkgText);
const lock = JSON.parse(lockText);
const review = JSON.parse(reviewText);

const versionSupported = ['4.21.5', '4.21.6'].includes(pkg.version);
const lockMatches = lock.version === pkg.version && lock.packages?.['']?.version === pkg.version;
const rcMetadataOnly = lock.version === '4.21.4' && lock.packages?.['']?.version === '4.21.4';
if (!versionSupported || (!lockMatches && !(pkg.version === '4.21.5' && rcMetadataOnly))) {
  throw new Error('package.json/package-lock must identify V4.21.5 or V4.21.6 with matching dependency metadata.');
}

const match = article.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
if (!match) throw new Error('Passport article is not parseable.');
const actualBodyHash = createHash('sha256').update(match[1].replace(/\r\n/g, '\n').trim()).digest('hex');
if (actualBodyHash !== BODY_HASH) throw new Error(`Passport bodyHash mismatch: ${actualBodyHash}.`);

const isDraft = /^draft:\s*true\s*$/mi.test(article);
const reviewEntry = review.articles?.[ARTICLE_ID];
if (!isDraft && (reviewEntry?.bodyHash !== BODY_HASH || !Array.isArray(reviewEntry.checks) || reviewEntry.checks.length < 8)) {
  throw new Error('Published passport article must have a complete speech-review lock.');
}
for (const token of ['ETA', 'e-Visa', 'Arton Capital', 'Passport Index', 'C-181/23']) {
  if (!overridesText.includes(token)) throw new Error(`speech-overrides lost ${token}.`);
}

const build = pkg.scripts?.build || '';
for (const token of ['prepare-v4215.mjs', 'check-v4215-release.mjs', 'run-v4211-audio.mjs', 'astro build']) {
  if (!build.includes(token)) throw new Error(`V4.21.5 build pipeline is missing ${token}.`);
}
if (!build.includes('BAREEQ_GEMINI_FREE_ROLLOUT=0 BAREEQ_CLOUD_TTS_ACTIVATE=0 node scripts/run-v4211-audio.mjs')) {
  throw new Error('Normal production build must keep Gemini free rollout and paid Google Cloud synthesis disabled.');
}
for (const token of ['RELEASE_CANDIDATE_ARTICLE', 'RELEASE_CANDIDATE_PUBLISHED', 'TEMPORARY_HAMED_ARTICLES']) {
  if (!rolloutText.includes(token)) throw new Error(`V4.21.5 rollout lost the guarded passport token: ${token}`);
}
for (const token of ['TEMPORARY_HAMED_ARTICLES', 'BAREEQ_AZURE_HAMED_ONLY', "BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD: '1'", 'Azure Hamed fallback immediately']) {
  if (!audioRunner.includes(token)) throw new Error(`V4.21.5-compatible audio runner lost the guarded fallback token: ${token}`);
}
if (!pkg.scripts?.['audio:gemini:resume:prepare']?.includes('prepare-v4215-gemini-resume.mjs')) {
  throw new Error('V4.21.5 resumable Gemini preparation command is missing.');
}

for (const token of ['workflow_dispatch:', 'GEMINI_API_KEY', 'prepare-v4215-gemini-resume.mjs', '.bareeq-audio-checkpoints', 'actions/cache/restore@v4', 'actions/cache/save@v4', ARTICLE_ID]) {
  if (!workflow.includes(token)) throw new Error(`Passport audio workflow is missing resumable token: ${token}`);
}
if (/\npush:\s*$/m.test(workflow)) throw new Error('V4.21.5 audio synthesis workflow must be manual-only; push-triggered synthesis is forbidden.');

if (!rolloutText.includes('RELEASE_CANDIDATE_PUBLISHED') || !rolloutText.includes('EXPECTED_PUBLISHED_ARTICLES')) {
  throw new Error('Cloud TTS rollout is not draft-aware for the release-candidate article.');
}

const postFiles = (await readdir('src/content/posts')).filter((name) => name.endsWith('.md'));
let live = 0;
for (const file of postFiles) {
  const source = await readFile(`src/content/posts/${file}`, 'utf8');
  if (!/^draft:\s*true\s*$/mi.test(source)) live += 1;
}
if (![13, 14, 15].includes(live)) throw new Error(`V4.21.6 compatibility expects 13–15 live articles, found ${live}.`);

const manifestPath = path.join('public', 'audio', 'articles', ARTICLE_KEY, 'manifest.json');
let manifestExists = true;
try { await access(manifestPath); } catch { manifestExists = false; }
if (!isDraft && !manifestExists && pkg.version === '4.21.5') throw new Error('Published passport article has no production audio manifest.');
if (!isDraft && !manifestExists && pkg.version === '4.21.6') console.log('V4.21.5 compatibility: passport audio is queued for verified production-cache restoration before Astro build.');
if (manifestExists) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const approvedGemini = manifest.articleId === ARTICLE_ID
    && manifest.provider === 'Google Gemini API'
    && manifest.model === 'gemini-3.1-flash-tts-preview'
    && manifest.language === 'ar'
    && manifest.defaultVoice === 'sadaltager';
  const approvedTemporaryFallback = manifest.articleId === ARTICLE_ID
    && manifest.provider === 'Microsoft Azure AI Speech'
    && manifest.model === 'Neural TTS'
    && manifest.language === 'ar-SA'
    && manifest.defaultVoice === 'hamed'
    && Array.isArray(manifest.voices)
    && manifest.voices.length === 1
    && manifest.voices[0]?.providerVoice === 'ar-SA-HamedNeural';
  if (!approvedGemini && !approvedTemporaryFallback) {
    throw new Error('Passport production audio must be Gemini Sadaltager or the approved temporary Azure Hamed fallback.');
  }
}

for (const token of ['header-design-one', 'data-ticker-primary', 'ticker-copy']) if (!header.includes(token)) throw new Error(`V4.21.4 header compatibility lost: ${token}`);
for (const token of ['header-design-one-desktop.svg', 'header-design-one-mobile.svg', 'mobileTickerLabel']) if (!css.includes(token)) throw new Error(`V4.21.4 visual compatibility lost: ${token}`);

for (const deferred of ['فكرة تبقى معك', 'بريق عملي', 'ميزان بريق', 'كيف استخدمنا المصادر؟']) {
  if ([header, css].some((source) => source.includes(deferred))) throw new Error(`Paused layer returned: ${deferred}`);
}

console.log(`V4.21.5 compatibility gate passed under V${pkg.version}: package identity locked, V4.21.4 UX preserved, infographic deferred, ${live} live article(s), Gemini/paid-Cloud rollout disabled, guarded Azure fallback compatibility, resumable passport Gemini workflow, and passport audio publication guard are active.`);
