import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const read = (file) => readFile(path.join(root, file), 'utf8');
const failures = [];
const sha = (value) => createHash('sha256').update(value).digest('hex');
const requireAll = (name, text, tokens) => {
  for (const token of tokens) if (!text.includes(token)) failures.push(`${name}: missing ${token}`);
};

const [pkgText, lockText, bundledImporter, studioImporter, studioMappingText, component, audioCore, client, generator, audioAudit, geminiContract, css, homeIntro, categoryStrip, header, postPage, postsLib, baseLayout, middleware, notFound, envExample, voiceLabEnv, readme, testReport, deployGuide, packageLockText] = await Promise.all([
  read('package.json'),
  read('scripts/bundled-azure-audio-map.json'),
  read('scripts/import-bundled-azure-audio.mjs'),
  read('scripts/import-studio-audio.mjs'),
  read('scripts/studio-audio-map.json'),
  read('src/components/ReadingModes.astro'),
  read('public/scripts/audio-core.js'),
  read('public/scripts/article.js'),
  read('scripts/generate-audio.mjs'),
  read('scripts/check-audio-dist.mjs'),
  read('scripts/test-gemini-production-build.mjs'),
  read('src/styles/global.css'),
  read('src/components/HomeIntro.astro'),
  read('src/components/CategoryStrip.astro'),
  read('src/components/Header.astro'),
  read('src/pages/posts/[id].astro'),
  read('src/lib/posts.ts'),
  read('src/layouts/BaseLayout.astro'),
  read('functions/_middleware.js'),
  read('src/pages/404.astro'),
  read('.env.example'),
  read('.env.voice-lab.example'),
  read('README.md'),
  read('docs/تقرير-اختبار-v4.17.2.md'),
  read('docs/دليل-النشر-والرجوع-v4.17.2.md'),
  read('package-lock.json'),
]);
const pkg = JSON.parse(pkgText);
const lock = JSON.parse(lockText);
const studioMapping = JSON.parse(studioMappingText);
const packageLock = JSON.parse(packageLockText);

if (pkg.version !== '4.17.2' || packageLock.version !== '4.17.2' || packageLock.packages?.['']?.version !== '4.17.2') failures.push('package/package-lock version must be 4.17.2.');
for (const token of ['node --check scripts/import-bundled-azure-audio.mjs', 'node scripts/import-bundled-azure-audio.mjs', 'node scripts/import-studio-audio.mjs', 'node scripts/generate-audio.mjs', 'node --check scripts/test-gemini-production-build.mjs', 'node scripts/check-audio-dist.mjs', 'node scripts/check-v4172-release.mjs']) if (!pkg.scripts?.build?.includes(token)) failures.push(`build pipeline is missing ${token}`);
if (pkg.scripts?.['import:audio'] !== 'node scripts/import-bundled-azure-audio.mjs && node scripts/import-studio-audio.mjs') failures.push('import:audio must import bundled Hamed before Studio Cedar.');
if (pkg.scripts?.['test:audio:gemini:mock'] !== 'node scripts/test-gemini-production-build.mjs --audio-only') failures.push('Gemini offline audio contract command is missing.');

requireAll('bundled importer', bundledImporter, [
  'bareeq.bundled-azure.lock.v1', 'sourceSnapshotSha256', 'sourceManifestSha256', 'normalizeMatchText',
  'mp3DurationSeconds', 'ar-SA-HamedNeural', 'paragraph-weighted-legacy', 'bareeq.bundled-azure.v1',
  'previousReleases', 'await rename(finalDir, backupDir)', 'await rename(tempDir, finalDir)', 'no network or synthesis API calls',
]);
if (bundledImporter.includes('OPENAI_API_KEY') || bundledImporter.includes('AZURE_SPEECH_KEY') || bundledImporter.includes('fetch(') || bundledImporter.includes('/v1/audio/speech')) failures.push('bundled importer may not use a synthesis key or network request.');
if (lock.version !== 1 || lock.schema !== 'bareeq.bundled-azure.lock.v1' || lock.releaseId !== 'azure-hamed-live-20260815' || lock.articles?.length !== 10) failures.push('bundled Azure lock must contain exactly ten approved articles.');
const articleIds = new Set();
let lockedParts = 0;
let lockedBytes = 0;
for (const article of lock.articles || []) {
  const expectedKey = sha(article.articleId).slice(0, 16);
  if (article.audioKey !== expectedKey || articleIds.has(article.articleId) || !/^[a-f0-9]{64}$/.test(article.sourceSnapshotSha256 || '') || !/^[a-f0-9]{64}$/.test(article.sourceManifestSha256 || '') || !/^[a-f0-9]{64}$/.test(article.legacySourceHash || '')) failures.push(`invalid bundle lock identity for ${article.articleId}`);
  articleIds.add(article.articleId);
  const sourceManifestFile = path.join(root, lock.bundleRoot, article.audioKey, 'source-manifest.json');
  const sourceRaw = await readFile(sourceManifestFile, 'utf8').catch(() => '');
  if (!sourceRaw || sha(sourceRaw) !== article.sourceManifestSha256) failures.push(`source manifest is missing or changed for ${article.articleId}`);
  for (const part of article.parts || []) {
    const file = path.join(root, lock.bundleRoot, article.audioKey, part.file || '');
    const info = await stat(file).catch(() => null);
    if (!/^[a-f0-9]{64}$/.test(part.sha256 || '') || !info?.isFile() || info.size !== part.bytes || !(part.durationSeconds > 0)) failures.push(`locked MP3 is missing or size-mismatched: ${article.articleId}/${part.file}`);
    lockedParts += 1;
    lockedBytes += Number(part.bytes || 0);
  }
}
if (lockedParts !== 29 || lockedBytes !== 93092832) failures.push(`expected 29 bundled MP3 files / 93,092,832 bytes; found ${lockedParts} / ${lockedBytes}`);

requireAll('Studio importer', studioImporter, [
  "TARGET_VERSION = 'V4.16.0'", 'verifyMp3', 'syncSourceSha256', 'bareeq.audio.current.v1',
  'studio-block-timestamps', 'manifestSha256', 'textSha256', 'copyFile',
  'previousReleases', 'await rename(finalDir, backupDir)', 'await rename(tempDir, finalDir)', 'no API calls',
]);
const pilot = studioMapping.imports?.['cultural-habits-world'];
if (!pilot || Object.keys(studioMapping.imports || {}).length !== 1 || pilot.segmentIds?.length !== 21 || pilot.segmentIds?.[0] !== 'b0001' || pilot.segmentIds?.[20] !== 'b0021' || !/^[a-f0-9]{64}$/.test(pilot.syncSourceSha256 || '')) failures.push('Studio Cedar mapping is incomplete or unlocked.');
const releaseRoot = path.join(root, 'audio-releases', 'cultural-habits-world');
const current = JSON.parse(await readFile(path.join(releaseRoot, 'current.json'), 'utf8'));
const studioRaw = await readFile(path.join(releaseRoot, current.manifest), 'utf8');
const studio = JSON.parse(studioRaw);
if (current.schema !== 'bareeq.audio.current.v1' || current.release_id !== '20260815T050435Z-73ce11f5') failures.push('approved Cedar current pointer changed.');
if (studio.schema !== 'bareeq.audio.v1' || studio.version !== '3.0.0' || studio.target_bareeq_version !== 'V4.16.0' || studio.article?.block_count !== 21 || studio.default_voice !== 'cedar' || Object.keys(studio.voices || {}).join(',') !== 'cedar') failures.push('approved Cedar Studio metadata changed.');
if (studio.voices?.cedar?.duration_seconds !== 281.088 || studio.voices?.cedar?.parts?.length !== 21 || studio.voices?.cedar?.blocks?.length !== 21) failures.push('approved Cedar duration/parts/timeline changed.');
for (const forbidden of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AZURE_SPEECH_KEY', 'visibleText', 'spokenText', 'rawText', 'articleText']) if (studioRaw.includes(forbidden) || lockText.includes(forbidden)) failures.push(`audio release metadata leaks forbidden field/token: ${forbidden}`);

requireAll('Gemini production generator', generator, [
  "|| 'bundled'", "['bundled', 'gemini', 'openai', 'azure']", 'bundledManifestAssets', 'bundled-azure-audio-map.json',
  '0 synthesis request(s)', '0 billable character(s)', 'no API key required',
  "GEMINI_MODEL = 'gemini-3.1-flash-tts-preview'", 'https://generativelanguage.googleapis.com/v1beta/interactions',
  "GEMINI_PILOT_ARTICLE_ID = 'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء'", 'Gemini one-article pilot safety stop', 'const GENERATOR_VERSION = 8',
  "GEMINI_API_REVISION = '2026-05-20'", "'Api-Revision': GEMINI_API_REVISION", 'extractGeminiAudio', 'payload?.steps', "step?.type || 'unknown'",
  "providerVoice: 'Sadaltager'", 'GEMINI_STYLE', 'normal conversational volume', 'never a whisper', '### TRANSCRIPT',
  "GEMINI_TTS_MAX_REQUEST_BYTES || '2400'", "GEMINI_TTS_MIN_INTERVAL_MS || '6500'", 'encodeGeminiPcmToMp3',
  "'-f', 's16le'", "'-ar', '24000'", "'-b:a', '96k'", 'Gemini TTS free-tier plan', 'sha256: sha(audio)',
  'OpenAI TTS cost guard', 'Azure Speech cost guard', "providerVoice: 'cedar'", "providerVoice: 'marin'", "providerVoice: 'ar-SA-HamedNeural'", "providerVoice: 'ar-SA-ZariyahNeural'",
]);
requireAll('mixed production audio audit', audioAudit, ['requiredGeminiArticles', 'generated Gemini audio escaped the one-article pilot boundary', "['bundled', 'gemini'].includes(provider)", 'manifest.generatorVersion !== 8', 'Expected ${requiredGeminiArticles.size} Gemini pilot article(s)']);
requireAll('Gemini contract test', geminiContract, ['x-goog-api-key', 'api-revision', '2026-05-20', 'gemini-3.1-flash-tts-preview', 'Sadaltager', "type: 'model_output'", "type: 'audio'", "mime_type: 'audio/l16'", 'import-bundled-azure-audio.mjs', 'import-studio-audio.mjs', 'check-audio-dist.mjs', 'expectedCalls']);
if (geminiContract.includes('output_audio:')) failures.push('Gemini contract test still mocks the SDK-only output_audio convenience property instead of the REST steps schema.');
requireAll('.env.example', envExample, ['BAREEQ_TTS_PROVIDER=gemini', 'GEMINI_API_KEY=', 'GEMINI_TTS_MIN_INTERVAL_MS=6500', 'GEMINI_TTS_MAX_REQUEST_BYTES=2400', 'BAREEQ_TTS_PROVIDER=bundled', 'OPENAI_API_KEY=', 'AZURE_SPEECH_KEY=']);
if (!voiceLabEnv.includes('GEMINI_API_KEY=')) failures.push('.env.voice-lab.example is missing Gemini Developer API configuration.');
if (pkg.devDependencies?.['@ffmpeg-installer/ffmpeg'] !== '1.1.0' || !packageLock.packages?.['node_modules/@ffmpeg-installer/ffmpeg']) failures.push('cross-platform FFmpeg build dependency is missing or unlocked.');

requireAll('ReadingModes', component, ['استماع متزامن', 'data-audio-seek', 'data-audio-voice-field', 'تتبّع الفقرة', 'موضع الاستماع', 'لمدة 30 يومًا', 'الصوت مولّد بالذكاء الاصطناعي']);
requireAll('audio core', audioCore, ['30 * 24 * 60 * 60 * 1000', 'isSavedProgressValid', 'resolveArticleSeek', 'formatClock']);
requireAll('article client', client, [
  'BareeqAudioCore', 'bareeq-audio-progress-v1', 'readSavedProgress', 'clearSavedProgress',
  'Number.isInteger(entry.ordinal)', "seekInput?.addEventListener('change'", 'voiceField.hidden = voices.length < 2',
  'smartScrollTo', 'nativeFallbackButton', 'audio.playbackRate',
]);
if (client.includes('speechSynthesis') || client.includes('audio.load()')) failures.push('reader reintroduced browser TTS or tablet-unsafe audio.load().');

const mobile900 = css.match(/@media \(max-width:900px\) \{([\s\S]*?)\n\}/)?.[1] || '';
if (!mobile900.includes('flex-wrap:wrap') || !mobile900.includes('flex:1 1 104px') || !mobile900.includes('.category-mobile-link{display:flex') || mobile900.includes('overflow-x:auto')) failures.push('five-category mobile navigation is not visibly wrapped without horizontal scrolling.');
if (categoryStrip.includes('>الكل<') || categoryStrip.includes("'الكل'")) failures.push('removed «الكل» entry returned to the top category strip.');
requireAll('selected mobile home design', `${homeIntro}\n${css}`, ['home-cta', 'ابدأ من أحدث ما نشره بريق', '.home-intro::before,.home-intro::after', 'linear-gradient(115deg', '.home-band--latest .post-card{display:grid;grid-template-columns:112px']);
requireAll('preserved launch fixes', `${postPage}\n${postsLib}\n${baseLayout}\n${middleware}\n${header}`, [
  'encodeURIComponent(decodeURI(articleUrl))',
  'const toc = headings.filter((heading) => heading.depth === 2);',
  'const relatedByIntent = sameSeries || sharedTags > 0;',
  "'@type': 'SearchAction'", "headers.delete('Access-Control-Allow-Origin')", 'ticker-label-mobile', '/scripts/audio-core.js',
]);
if (!notFound.includes('noindex') || !notFound.includes('404')) failures.push('branded noindex 404 page is missing.');
requireAll('V4.17.2 README/report', `${readme}\n${testReport}`, ['V4.17.2', 'Gemini', 'Sadaltager', 'steps', '30 يومًا', '3/3', 'مقال واحد', 'عشرة مقالات']);
requireAll('V4.17.2 deployment guide', deployGuide, ['BAREEQ_TTS_PROVIDER', 'gemini', 'GEMINI_API_KEY', 'Secret', 'bundled', 'feat: limit Gemini TTS to one pilot article in v4.17.2', 'الرجوع الفوري']);
if (!readme.startsWith('# Bareeq World v4.17.2')) failures.push('README still presents an older release as current.');
const nanoidVersion = packageLock.packages?.['node_modules/nanoid']?.version;
if (nanoidVersion !== '3.3.18') failures.push(`nanoid is ${nanoidVersion || 'missing'}, expected patched 3.3.18.`);

const posts = (await readdir(path.join(root, 'src', 'content', 'posts'))).filter((name) => name.endsWith('.md'));
if (posts.length !== 11) failures.push(`article inventory changed: expected 11 Markdown posts, found ${posts.length}.`);

if (failures.length) {
  console.error(`V4.17.2 release source audit found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('V4.17.2 source audit passed: Gemini REST + Sadaltager is hard-limited to the single cultural-habits pilot article, ten bundled Hamed fallbacks remain mandatory, and all rollback, synchronization, 30-day resume, launch, SEO, security, and accessibility safeguards are preserved.');
