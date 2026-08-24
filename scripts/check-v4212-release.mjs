import { readFile, readdir } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (!['4.21.2', '4.21.3', '4.21.4', '4.21.5'].includes(pkg.version)) throw new Error(`Expected package 4.21.2 through 4.21.5 successor, got ${pkg.version}.`);

const [site, postsLib, schema, startHere, article, searchPage, searchScript, saved, about, intro, header, layout, css, redirects, audioRunner, audioDist] = await Promise.all([
  readFile('src/config/site.ts', 'utf8'),
  readFile('src/lib/posts.ts', 'utf8'),
  readFile('src/content.config.ts', 'utf8'),
  readFile('src/pages/start-here.astro', 'utf8'),
  readFile('src/pages/posts/[id].astro', 'utf8'),
  readFile('src/pages/search.astro', 'utf8'),
  readFile('public/scripts/search.js', 'utf8'),
  readFile('src/pages/saved.astro', 'utf8'),
  readFile('src/content/pages/about.md', 'utf8'),
  readFile('src/components/HomeIntro.astro', 'utf8'),
  readFile('src/components/Header.astro', 'utf8'),
  readFile('src/layouts/BaseLayout.astro', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
  readFile('public/_redirects', 'utf8'),
  readFile('scripts/run-v4211-audio.mjs', 'utf8'),
  readFile('scripts/check-audio-dist.mjs', 'utf8'),
]);

const requireAll = (label, source, tokens) => {
  for (const token of tokens) if (!source.includes(token)) throw new Error(`${label} is missing V4.21.2 token: ${token}`);
};

requireAll('site.ts', site, ['signaturePosts', 'promise:', 'order:']);
requireAll('posts.ts', postsLib, ['getSignaturePost', 'getSeriesEntries', 'postSearchExcerpt']);
requireAll('start-here.astro', startHere, ['getSignaturePost', 'مقال توقيع من كل مسار']);
requireAll('search.astro', searchPage, ['excerpt: postSearchExcerpt(post)']);
requireAll('search.js', searchScript, ['item.excerpt']);
requireAll('saved.astro', saved, ['noindex']);
requireAll('HomeIntro.astro', intro, ['اقرأ بعمق، أو استمع إلى النص، أو اخرج بالخلاصة في أقل من دقيقة.']);
requireAll('Header.astro', header, ['header-design-one', 'data-header-design="one"', 'data-ticker-primary', 'ticker-copy', 'aria-hidden="true"', 'compactTickerTitle']);
requireAll('BaseLayout.astro', layout, ['stepMobileTicker', 'dataset.tickerOffset', 'translateX', 'is-manual', 'measureTicker', 'visibilitychange']);
requireAll('global.css', css, ['.ticker.is-manual .ticker-viewport{overflow-x:auto', '.ticker-set>a{display:inline-flex', '.ticker-set{gap:28px;padding-inline-end:28px']);
requireAll('_redirects', redirects, ['/tags/ذكاء%20اصطناعي/ /tags/الذكاء%20الاصطناعي/ 301']);
requireAll('run-v4211-audio.mjs', audioRunner, ['cleanTemporaryAudioRestores', '.restore-']);
requireAll('check-audio-dist.mjs', audioDist, ['Temporary audio restore directories leaked into dist']);
if (about.includes('ملخصات')) throw new Error('About page still uses summary branding for books.');
for (const token of ['bareeqAddition', 'bareeq-addition', 'series-path', 'getNextInSeries']) {
  if (schema.includes(token) || article.includes(token)) throw new Error(`Paused article-layer experiment is active: ${token}`);
}
if (css.includes('is-ticker-current') || layout.includes('is-ticker-current')) {
  throw new Error('Frozen single-title mobile ticker swap is still present.');
}

const expectedSignatures = [
  "'atyaf-al-aql': 'intuition-first-impression-decisions-signature'",
  "'bareeq-books': 'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع'",
  "'window-on-world': 'language-soft-power-politics'",
  "'future-now': 'ai-as-coworker-future-of-human-work'",
  "simply: 'altadakhom-explained-simply'",
];
for (const token of expectedSignatures) {
  if (!site.includes(token)) throw new Error(`Signature post mapping missing: ${token}`);
}
if ((site.match(/promise:/g) || []).length < 4 || (site.match(/order:/g) || []).length < 4) {
  throw new Error('Each series must keep a promise and an editorial order.');
}

const postFiles = (await readdir('src/content/posts')).filter((name) => name.endsWith('.md'));
let published = 0;
for (const file of postFiles) {
  const source = await readFile(`src/content/posts/${file}`, 'utf8');
  if (/^draft:\s*true\s*$/mi.test(source)) continue;
  published += 1;
  const summary = source.match(/^quickSummary:\s*["'](.+)["']\s*$/m)?.[1]?.trim() ?? '';
  if (summary.length < 50) throw new Error(`${file}: quickSummary is missing or too short.`);
  if (/^bareeqAddition:/m.test(source)) throw new Error(`${file}: paused bareeqAddition layer must stay disabled.`);
  if (file.startsWith('لماذا-لا-تسقط') && /خارج نطاق الجاذبية["']\s*$/m.test(source.split('---')[1])) {
    throw new Error('Satellite quickSummary still contradicts the article.');
  }
  if (file.startsWith('ai-agents') && source.includes('["ذكاء اصطناعي"')) {
    throw new Error('AI tag split remains in the agents article.');
  }
}
if (![13, 14].includes(published)) throw new Error(`V4.21.5 expects 13 RC or 14 published articles, found ${published}.`);

const satellite = await readFile('src/content/posts/لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء.md', 'utf8');
if (!satellite.includes('فيتحول السقوط إلى مدار')) throw new Error('Satellite summary was not corrected.');

const build = pkg.scripts?.build || '';
for (const token of ['prepare-v4212.mjs', 'check-v4212-release.mjs', 'run-v4211-audio.mjs', 'check-mobile-ticker-motion.mjs']) {
  if (!build.includes(token)) throw new Error(`Build pipeline is missing ${token}.`);
}
if (!build.includes('node scripts/run-v4211-audio.mjs && ASTRO_TELEMETRY_DISABLED=1 astro build')) {
  throw new Error('V4.21.1 audio runner is no longer the production audio step immediately before Astro build.');
}

console.log(`V4.21.2 compatibility gate passed inside V4.21.5: ${published} articles, useful editorial refinements, locked design-one header, measurable mobile ticker motion, preserved tag redirect, corrected summaries, clean audio output, and paused article layers.`);
