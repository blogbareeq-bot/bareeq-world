import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const read = (file) => readFile(path.join(root, file), 'utf8');
const failures = [];
const requireAll = (name, text, tokens) => {
  for (const token of tokens) if (!text.includes(token)) failures.push(`${name}: missing ${token}`);
};

const [pkgText, importer, mappingText, component, audioCore, client, generator, css, homeIntro, categoryStrip, header, postPage, postsLib, baseLayout, middleware, notFound, readme, testReport, deployGuide] = await Promise.all([
  read('package.json'),
  read('scripts/import-studio-audio.mjs'),
  read('scripts/studio-audio-map.json'),
  read('src/components/ReadingModes.astro'),
  read('public/scripts/audio-core.js'),
  read('public/scripts/article.js'),
  read('scripts/generate-audio.mjs'),
  read('src/styles/global.css'),
  read('src/components/HomeIntro.astro'),
  read('src/components/CategoryStrip.astro'),
  read('src/components/Header.astro'),
  read('src/pages/posts/[id].astro'),
  read('src/lib/posts.ts'),
  read('src/layouts/BaseLayout.astro'),
  read('functions/_middleware.js'),
  read('src/pages/404.astro'),
  read('README.md'),
  read('docs/تقرير-اختبار-v4.16.0.md'),
  read('docs/دليل-النشر-والرجوع-v4.16.0.md'),
]);
const pkg = JSON.parse(pkgText);
const mapping = JSON.parse(mappingText);

if (pkg.version !== '4.16.0') failures.push(`package version is ${pkg.version}, expected 4.16.0`);
for (const token of ['node --check scripts/import-studio-audio.mjs', 'node scripts/import-studio-audio.mjs', 'node scripts/generate-audio.mjs', 'node scripts/check-audio-dist.mjs']) if (!pkg.scripts?.build?.includes(token)) failures.push(`build pipeline is missing ${token}`);
if (!pkg.scripts?.['test:audio:mock']?.includes('--audio-only')) failures.push('package scripts are missing the offline audio-only contract test.');

requireAll('Studio importer', importer, [
  "TARGET_VERSION = 'V4.16.0'", 'verifyMp3', 'syncSourceSha256', 'bareeq.audio.current.v1',
  'studio-block-timestamps', 'manifestSha256', 'textSha256', 'copyFile',
  'previousReleases', 'await rename(finalDir, backupDir)', 'await rename(tempDir, finalDir)', 'no API calls',
]);
if (importer.includes('OPENAI_API_KEY') || importer.includes('AZURE_SPEECH_KEY') || importer.includes('/v1/audio/speech')) failures.push('Studio importer must never use a synthesis key or endpoint.');
if (mapping.version !== 1 || Object.keys(mapping.imports || {}).length !== 1) failures.push('exactly one approved Studio pilot mapping is required.');
const pilot = mapping.imports?.['cultural-habits-world'];
if (!pilot || pilot.segmentIds?.length !== 21 || pilot.segmentIds?.[0] !== 'b0001' || pilot.segmentIds?.[20] !== 'b0021' || !/^[a-f0-9]{64}$/.test(pilot.syncSourceSha256 || '')) failures.push('Studio pilot mapping is incomplete or unlocked.');

const releaseRoot = path.join(root, 'audio-releases', 'cultural-habits-world');
const current = JSON.parse(await readFile(path.join(releaseRoot, 'current.json'), 'utf8'));
const studioRaw = await readFile(path.join(releaseRoot, current.manifest), 'utf8');
const studio = JSON.parse(studioRaw);
if (current.schema !== 'bareeq.audio.current.v1' || current.release_id !== '20260815T050435Z-73ce11f5') failures.push('approved atomic current pointer changed.');
if (studio.schema !== 'bareeq.audio.v1' || studio.version !== '3.0.0' || studio.target_bareeq_version !== 'V4.16.0' || studio.article?.block_count !== 21 || studio.default_voice !== 'cedar' || Object.keys(studio.voices || {}).join(',') !== 'cedar') failures.push('approved Cedar Studio manifest metadata changed.');
if (studio.voices?.cedar?.duration_seconds !== 281.088 || studio.voices?.cedar?.parts?.length !== 21 || studio.voices?.cedar?.blocks?.length !== 21) failures.push('approved Cedar duration/parts/timeline changed.');
if (studio.rollback?.fallback_provider !== 'azure' || !studio.rollback?.fallback_voices?.includes('ar-SA-HamedNeural') || !studio.rollback?.fallback_voices?.includes('ar-SA-ZariyahNeural')) failures.push('Azure fallback metadata is missing from the Studio release.');
for (const forbidden of ['OPENAI_API_KEY', 'AZURE_SPEECH_KEY', 'visibleText', 'spokenText', 'rawText', 'articleText']) if (studioRaw.includes(forbidden)) failures.push(`Studio release leaks forbidden field/token: ${forbidden}`);
if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(studioRaw)) failures.push('Studio release appears to contain an API key.');

requireAll('ReadingModes', component, ['استماع متزامن', 'data-audio-seek', 'data-audio-voice-field', 'تتبّع الفقرة', 'موضع الاستماع', 'لمدة 30 يومًا', 'الصوت مولّد بالذكاء الاصطناعي']);
if (component.includes('صوتان للاختيار') || component.includes('صوتان مع') || component.includes('المقطع 1 من') || component.includes('data-audio-part')) failures.push('reader UI exposes a false two-voice promise or internal part details.');
requireAll('audio core', audioCore, ['30 * 24 * 60 * 60 * 1000', 'isSavedProgressValid', 'resolveArticleSeek', 'formatClock']);
requireAll('article client', client, [
  'BareeqAudioCore', 'bareeq-audio-progress-v1', 'readSavedProgress', 'clearSavedProgress',
  'Number.isInteger(entry.ordinal)', "seekInput?.addEventListener('change'", 'voiceField.hidden = voices.length < 2',
  'smartScrollTo', 'nativeFallbackButton', 'audio.playbackRate',
]);
if (client.includes('speechSynthesis') || client.includes('audio.load()')) failures.push('reader reintroduced browser TTS or tablet-unsafe audio.load().');

requireAll('generator', generator, [
  'importedManifestAssets', 'studio-audio-map.json', 'studio-block-timestamps', 'BAREEQ_AUDIO_ALLOW_PARTIAL',
  'OpenAI TTS cost guard', 'OpenAI TTS safety stop', 'Azure Speech cost guard', 'Azure Speech safety stop',
  "providerVoice: 'cedar'", "providerVoice: 'marin'", "providerVoice: 'ar-SA-HamedNeural'", "providerVoice: 'ar-SA-ZariyahNeural'",
]);

const mobile900 = css.match(/@media \(max-width:900px\) \{([\s\S]*?)\n\}/)?.[1] || '';
if (!mobile900.includes('flex-wrap:wrap') || !mobile900.includes('flex:1 1 104px') || !mobile900.includes('.category-mobile-link{display:flex') || mobile900.includes('overflow-x:auto')) failures.push('five-category mobile navigation is not visibly wrapped without horizontal scrolling.');
if (categoryStrip.includes('>الكل<') || categoryStrip.includes("'الكل'")) failures.push('removed «الكل» entry returned to the top category strip.');
requireAll('mobile home design', `${homeIntro}\n${css}`, [
  'home-cta', 'ابدأ من أحدث ما نشره بريق', '.home-intro::before,.home-intro::after',
  'linear-gradient(115deg', '.home-band--latest .post-card{display:grid;grid-template-columns:112px',
]);
requireAll('responsive/print CSS', css, ['.prose iframe{width:100%;aspect-ratio:16/9}', '@media print', '.reading-modes.use-native-audio']);

requireAll('preserved launch fixes', `${postPage}\n${postsLib}\n${baseLayout}\n${middleware}\n${header}`, [
  'encodeURIComponent(decodeURI(articleUrl))',
  'const toc = headings.filter((heading) => heading.depth === 2);',
  'const relatedByIntent = sameSeries || sharedTags > 0;',
  "'@type': 'SearchAction'",
  "headers.delete('Access-Control-Allow-Origin')",
  'ticker-label-mobile',
  '/scripts/audio-core.js',
]);
if (!notFound.includes('noindex') || !notFound.includes('404')) failures.push('branded noindex 404 page is missing.');
requireAll('V4.16 README/report', `${readme}\n${testReport}`, ['V4.16.0', '4:41', '30 يومًا', '72', '8.53 دولار', '50 صفحة', '73 ملف']);
requireAll('V4.16 deployment guide', deployGuide, ['BAREEQ_AUDIO_ALLOW_PARTIAL', 'لا تضف', 'OPENAI_API_KEY', 'Rollback', 'feat: release v4.16.0 Cedar production audio pilot']);
if (!readme.startsWith('# Bareeq World v4.16.0')) failures.push('README still presents an older release as current.');

const posts = (await readdir(path.join(root, 'src', 'content', 'posts'))).filter((name) => name.endsWith('.md'));
if (posts.length !== 11) failures.push(`article inventory changed: expected 11 Markdown posts, found ${posts.length}.`);

if (failures.length) {
  console.error(`V4.16.0 release source audit found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('V4.16.0 source audit passed: approved Cedar release, atomic text-free import, seek + 30-day resume, optional voices, cost guards, wrapped five-category mobile navigation, selected mobile homepage design, print/responsive rules, and all preserved launch fixes.');
