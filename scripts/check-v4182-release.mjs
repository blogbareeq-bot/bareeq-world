import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const read = (file) => readFile(path.join(root, file), 'utf8');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const requireAll = (label, text, tokens) => {
  for (const token of tokens) if (!text.includes(token)) failures.push(`${label}: missing ${token}`);
};

const [
  pkgText, lockText, generator, audioAudit, productionVoices, interactionAudit,
  envExample, readme, testReport, deployGuide, launchAudit, mobileAudit,
  component, client, audioCore, css, bundledMapText, studioMapText,
  postPage, postsLib, baseLayout, middleware, categoryStrip, homeIntro, header, notFound,
] = await Promise.all([
  read('package.json'), read('package-lock.json'), read('scripts/generate-audio.mjs'), read('scripts/check-audio-dist.mjs'),
  read('scripts/check-production-voices.mjs'), read('scripts/check-interactions.mjs'), read('.env.example'), read('README.md'),
  read('TEST-REPORT.md'), read('docs/دليل-النشر-والرجوع-v4.18.2.md'), read('scripts/check-launch-readiness.mjs'),
  read('scripts/check-mobile-nav-cost.mjs'), read('src/components/ReadingModes.astro'), read('public/scripts/article.js'),
  read('public/scripts/audio-core.js'), read('src/styles/global.css'), read('scripts/bundled-azure-audio-map.json'),
  read('scripts/studio-audio-map.json'), read('src/pages/posts/[id].astro'), read('src/lib/posts.ts'), read('src/layouts/BaseLayout.astro'),
  read('functions/_middleware.js'), read('src/components/CategoryStrip.astro'), read('src/components/HomeIntro.astro'),
  read('src/components/Header.astro'), read('src/pages/404.astro'),
]);

const pkg = JSON.parse(pkgText);
const packageLock = JSON.parse(lockText);
if (pkg.version !== '4.18.2' || packageLock.version !== '4.18.2' || packageLock.packages?.['']?.version !== '4.18.2') {
  failures.push('package/package-lock version must be 4.18.2.');
}

requireAll('build pipeline', pkg.scripts?.build || '', [
  'node --check scripts/check-v4182-release.mjs',
  'node scripts/check-v4182-release.mjs',
  'node scripts/import-bundled-azure-audio.mjs',
  'node scripts/import-studio-audio.mjs',
  'node scripts/generate-audio.mjs',
  'astro build',
  'node scripts/check-audio-dist.mjs',
  'node scripts/check-interactions.mjs',
]);
if ((pkg.scripts?.build || '').includes('node scripts/check-v4172-release.mjs && node scripts/generate-images.mjs')) failures.push('V4.17.2 audit is still the active release gate.');
if (pkg.scripts?.['audit:v4182'] !== 'node scripts/check-v4182-release.mjs') failures.push('audit:v4182 script is missing or incorrect.');
if (!pkg.scripts?.['plan:audio:gemini:all']) failures.push('plan:audio:gemini:all script is missing.');

requireAll('Gemini generator', generator, [
  "GEMINI_MODEL = 'gemini-3.1-flash-tts-preview'",
  "providerVoice: 'Sadaltager'",
  "GEMINI_TTS_MIN_INTERVAL_MS || '9000'",
  "BAREEQ_TTS_MAX_RETRIES || process.env.AZURE_SPEECH_MAX_RETRIES || '8'",
  "BAREEQ_GEMINI_MAX_REQUESTS_PER_BUILD || '80'",
  "BAREEQ_GEMINI_SYNTHESIS_BUDGET_MS || '780000'",
  "const synthesisPosts = PROVIDER === 'gemini'\n  ? posts",
  'retry-after',
  'retryDelay',
  'error.httpStatus = response.status',
  "error?.httpStatus === 429",
  "error?.code === 'BAREEQ_GEMINI_BUDGET'",
  'Safe progressive fallback',
  'restoreFromProduction',
  'full Sadaltager rollout plan',
  'Gemini progressive rollout safely paused',
  "Bareeq-Audio-Builder/4.18.2",
  'const GENERATOR_VERSION = 8',
]);
for (const forbidden of ['GEMINI_PILOT_ARTICLE_ID', 'one-article pilot', 'BAREEQ_GEMINI_VOICES', 'Gacrux', 'Sulafat']) {
  if (generator.includes(forbidden)) failures.push(`Gemini generator still contains forbidden pilot/multi-voice token: ${forbidden}`);
}
const geminiVoiceBranch = generator.match(/const VOICES = PROVIDER === 'gemini'([\s\S]*?): PROVIDER === 'openai'/)?.[1] || '';
if (!geminiVoiceBranch.includes("providerVoice: 'Sadaltager'") || (geminiVoiceBranch.match(/providerVoice:/g) || []).length !== 1) failures.push('Gemini voice branch must contain exactly one Sadaltager voice.');

requireAll('progressive audio audit', audioAudit, [
  "['bundled', 'openai', 'gemini'].includes(provider)",
  'Gemini production may generate Sadaltager for any published article',
  'generatedArticles + importedArticles + bundledArticles',
  'Gemini progressive rollout coverage is incomplete',
  'manifest.generatorVersion !== 8',
]);
requireAll('production voice audit', productionVoices, [
  'GEMINI_REQUEST_HARD_LIMIT', 'GEMINI_SYNTHESIS_BUDGET_MS', 'Safe progressive',
  'Google Gemini API full Sadaltager rollout plan', '70 synthesis request(s)', '80664 source character(s)',
  'V4.18.2 targets Sadaltager across all 11 articles',
]);
requireAll('interaction audit', interactionAudit, [
  "productionProvider === 'gemini'", "['sadaltager', 'hamed'].includes(activeVoice)",
  'Gemini progressive player must initialize from either Sadaltager',
]);
requireAll('Cloudflare env example', envExample, [
  'BAREEQ_TTS_PROVIDER=gemini', 'GEMINI_API_KEY=', 'GEMINI_TTS_MIN_INTERVAL_MS=9000',
  'GEMINI_TTS_MAX_REQUEST_BYTES=2400', 'BAREEQ_TTS_MAX_RETRIES=8',
  'BAREEQ_GEMINI_MAX_REQUESTS_PER_BUILD=80', 'BAREEQ_GEMINI_SYNTHESIS_BUDGET_MS=780000',
  'BAREEQ_AUDIO_CACHE_ORIGIN=https://bareeqworld.com',
]);
if (!launchAudit.includes("pkg.version !== '4.18.2'")) failures.push('launch-readiness audit does not enforce V4.18.2.');
requireAll('mobile/cost audit', mobileAudit, ['GEMINI_TTS_MIN_INTERVAL_MS=9000', 'BAREEQ_TTS_MAX_RETRIES=8', 'BAREEQ_GEMINI_MAX_REQUESTS_PER_BUILD=80', 'BAREEQ_GEMINI_SYNTHESIS_BUDGET_MS=780000']);

const plan = execFileSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, BAREEQ_TTS_PROVIDER: 'gemini', GEMINI_TTS_ENDPOINT: '', BAREEQ_TTS_CONTRACT_TEST: '' },
});
for (const token of ['Google Gemini API full Sadaltager rollout plan', '11 articles total', '70 synthesis request(s)', '80664 source character(s)', 'سادالتاجر (Sadaltager) [Sadaltager]']) {
  if (!plan.includes(token)) failures.push(`Gemini V4.18.2 plan missing ${token}`);
}
if ((plan.match(/\n- /g) || []).length !== 11) failures.push('Gemini plan must list exactly 11 published articles.');

const bundledMap = JSON.parse(bundledMapText);
if (bundledMap.version !== 1 || bundledMap.schema !== 'bareeq.bundled-azure.lock.v1' || bundledMap.releaseId !== 'azure-hamed-live-20260815' || bundledMap.articles?.length !== 10) failures.push('bundled Azure lock identity changed.');
let bundledParts = 0;
let bundledBytes = 0;
for (const article of bundledMap.articles || []) {
  if (!/^[a-f0-9]{16}$/.test(article.audioKey || '') || !/^[a-f0-9]{64}$/.test(article.sourceSnapshotSha256 || '') || !/^[a-f0-9]{64}$/.test(article.sourceManifestSha256 || '')) failures.push(`invalid bundled identity for ${article.articleId}`);
  for (const part of article.parts || []) {
    const file = path.join(root, bundledMap.bundleRoot, article.audioKey, part.file || '');
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size !== part.bytes || !/^[a-f0-9]{64}$/.test(part.sha256 || '') || !(part.durationSeconds > 0)) failures.push(`bundled MP3 missing/changed: ${article.articleId}/${part.file}`);
    bundledParts += 1;
    bundledBytes += Number(part.bytes || 0);
  }
}
if (bundledParts !== 29 || bundledBytes !== 93092832) failures.push(`expected 29 Hamed MP3s / 93,092,832 bytes, found ${bundledParts} / ${bundledBytes}.`);
const studioMap = JSON.parse(studioMapText);
const studioEntries = Object.values(studioMap.imports || {});
if (studioEntries.length !== 1 || studioEntries[0]?.segmentIds?.length !== 21 || !/^[a-f0-9]{64}$/.test(studioEntries[0]?.syncSourceSha256 || '')) failures.push('approved Cedar Studio fallback mapping changed.');

requireAll('reader component', component, ['data-audio-voice', 'data-audio-seek', 'استماع متزامن', 'الصوت مولّد بالذكاء الاصطناعي', 'لمدة 30 يومًا']);
requireAll('article client', client, ['bareeq-audio-progress-v1', 'readSavedProgress', 'saveProgress', 'switchVoice', 'syncTextToAudio', "seekInput?.addEventListener('change'", 'voiceField.hidden = voices.length < 2']);
requireAll('audio core', audioCore, ['30 * 24 * 60 * 60 * 1000', 'isSavedProgressValid', 'resolveArticleSeek', 'formatClock']);
if (client.includes('speechSynthesis') || client.includes('audio.load()')) failures.push('reader reintroduced browser TTS or tablet-unsafe audio.load().');

const mobile900 = css.match(/@media \(max-width:900px\) \{([\s\S]*?)\n\}/)?.[1] || '';
if (!mobile900.includes('flex-wrap:wrap') || !mobile900.includes('flex:1 1 104px') || !mobile900.includes('.category-mobile-link{display:flex') || mobile900.includes('overflow-x:auto')) failures.push('mobile category navigation lost the wrapped no-horizontal-scroll layout.');
if (categoryStrip.includes('>الكل<') || categoryStrip.includes("'الكل'")) failures.push('removed «الكل» entry returned to the category strip.');
requireAll('selected mobile homepage', `${homeIntro}\n${css}`, ['home-cta', 'ابدأ من أحدث ما نشره بريق', '.home-intro::before,.home-intro::after', 'linear-gradient(115deg']);
requireAll('preserved launch safeguards', `${postPage}\n${postsLib}\n${baseLayout}\n${middleware}\n${header}`, [
  'encodeURIComponent(decodeURI(articleUrl))', 'const toc = headings.filter((heading) => heading.depth === 2);',
  'const relatedByIntent = sameSeries || sharedTags > 0;', "'@type': 'SearchAction'", "headers.delete('Access-Control-Allow-Origin')", 'ticker-label-mobile', '/scripts/audio-core.js',
]);
if (!notFound.includes('noindex') || !notFound.includes('404')) failures.push('branded noindex 404 page is missing.');

if (!readme.startsWith('# Bareeq World v4.18.2')) failures.push('README does not present V4.18.2 as current.');
requireAll('release docs', `${readme}\n${testReport}\n${deployGuide}`, [
  'V4.18.2', 'Sadaltager', '70', '80,664', '9000', '429', '780000', 'Cedar/Hamed', 'GitHub Desktop', 'Cloudflare', 'الرجوع',
]);

const posts = (await readdir(path.join(root, 'src', 'content', 'posts'))).filter((name) => name.endsWith('.md'));
if (posts.length !== 11) failures.push(`article inventory changed: expected 11 Markdown posts, found ${posts.length}.`);
const nanoidVersion = packageLock.packages?.['node_modules/nanoid']?.version;
if (nanoidVersion !== '3.3.18') failures.push(`nanoid is ${nanoidVersion || 'missing'}, expected patched 3.3.18.`);

for (const forbidden of ['AIzaSy', 'sk-proj-', 'AZURE_SPEECH_KEY=ey', 'GEMINI_API_KEY=AIza']) {
  if (`${envExample}\n${readme}\n${testReport}\n${deployGuide}`.includes(forbidden)) failures.push(`release docs appear to contain a secret-like token: ${forbidden}`);
}

if (failures.length) {
  console.error(`V4.18.2 release source audit found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('V4.18.2 source audit passed: full single-voice Sadaltager plan (11 articles / 70 requests), 9s pacing, 8-retry 429 recovery, 80-request cap, 13-minute synthesis budget, progressive Cedar/Hamed fallback, production-cache resume, locked rollback assets, 30-day listening state, mobile UX, SEO, security, and accessibility safeguards are preserved.');
