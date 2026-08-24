import { createHash } from 'node:crypto';
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ARTICLE_ID = 'why-some-passports-are-stronger';
const ARTICLE_FILE = `src/content/posts/${ARTICLE_ID}.md`;
const EXPECTED_BODY_HASH = '2b2999dba95bff5e6bfb8ff16d2848fa3b677ffe8f595a5b6166ca15ebf7d4c1';
const EXPECTED_AUDIO_KEY = '34e34b6f4633d928';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.version !== '4.21.5') throw new Error(`V4.21.5 preparation expected package 4.21.5, got ${pkg.version}.`);

async function patchFile(file, mutate) {
  const before = await readFile(file, 'utf8');
  const after = mutate(before);
  if (after === before) return false;
  await writeFile(file, after, 'utf8');
  return true;
}

// Keep dependency graph unchanged but align package-lock release metadata.
await patchFile('package-lock.json', (source) => {
  const lock = JSON.parse(source);
  lock.version = '4.21.5';
  if (!lock.packages?.['']) throw new Error('V4.21.5 package-lock root metadata is missing.');
  lock.packages[''].version = '4.21.5';
  return JSON.stringify(lock, null, 2) + '\n';
});

const [article, header, layout, css, intro, startHere] = await Promise.all([
  readFile(ARTICLE_FILE, 'utf8'),
  readFile('src/components/Header.astro', 'utf8'),
  readFile('src/layouts/BaseLayout.astro', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
  readFile('src/components/HomeIntro.astro', 'utf8'),
  readFile('src/pages/start-here.astro', 'utf8'),
]);

const match = article.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
if (!match) throw new Error('Passport article frontmatter/body could not be parsed.');
const body = match[1].replace(/\r\n/g, '\n').trim();
const bodyHash = createHash('sha256').update(body).digest('hex');
if (bodyHash !== EXPECTED_BODY_HASH) throw new Error(`Passport article bodyHash drifted: ${bodyHash}.`);

// Commit the article speech-review lock directly; publish-day patches are no longer needed.
await patchFile('scripts/speech-review.json', (source) => {
  const review = JSON.parse(source);
  review.articles ||= {};
  const next = {
    bodyHash: EXPECTED_BODY_HASH,
    checks: [
      { from: 'ETA', to: 'إِي تِي إِيه' },
      { from: 'e-Visa', to: 'إِي فِيزَا' },
      { from: 'Arton Capital', to: 'أَرْتُون كَابِيتَال' },
      { from: 'Passport Index', to: 'بَاسْبُورْت إِنْدِكْس' },
      { from: 'C-181/23', to: 'سِي 181 شَرْطَة 23' },
      { from: 'وقعت الدولتان اتفاقية', to: 'وَقَّعَتِ الدولتان اتفاقية' },
      { from: 'عد الآن إلى مشهد المطار', to: 'عُدِ الآن إلى مشهد المطار' },
      { from: 'يخل بالتزاماتها', to: 'يُخِلُّ بالتزاماتها' },
    ],
  };
  const current = review.articles[ARTICLE_ID];
  if (current?.bodyHash && current.bodyHash !== EXPECTED_BODY_HASH) throw new Error('Conflicting passport speech-review bodyHash.');
  review.articles[ARTICLE_ID] = next;
  return JSON.stringify(review, null, 2) + '\n';
});

// Upgrade the large audio-dist audit deterministically without duplicating it in source.
await patchFile('scripts/check-audio-dist.mjs', (source) => {
  if (!source.includes("'4.21.5'].includes(pkg.version)")) {
    source = source.replace("'4.21.4'].includes(pkg.version)", "'4.21.4', '4.21.5'].includes(pkg.version)");
  }
  if (!source.includes("'4.21.4', '4.21.5'].includes(pkg.version) && process.env.BAREEQ_GEMINI_FREE_ROLLOUT")) {
    source = source.replace("['4.21.1', '4.21.2', '4.21.3', '4.21.4'].includes(pkg.version)", "['4.21.1', '4.21.2', '4.21.3', '4.21.4', '4.21.5'].includes(pkg.version)");
  }
  source = source.replace(
    "if (published.length !== 13) throw new Error(`V4.20 audio-dist audit expected 13 published articles, found ${published.length}.`);",
    "if (![13, 14].includes(published.length)) throw new Error(`V4.21.5 audio-dist audit expected 13 RC or 14 published articles, found ${published.length}.`);",
  );
  source = source.replace(
    "if (checkedArticles !== 13) throw new Error(`V4.20 audio-dist audit expected 13 complete audio articles, checked ${checkedArticles}.`);",
    "if (checkedArticles !== published.length) throw new Error(`V4.21.5 audio-dist audit expected ${published.length} complete audio articles, checked ${checkedArticles}.`);",
  );
  source = source.replace(
    "if (cloudActivated && (providerCounts.get('Cloud TTS Sadaltager') !== 11 || providerCounts.get('Gemini Sadaltager') !== 2)) throw new Error('Activated rollout must publish exactly 11 Cloud TTS + 2 retained Gemini articles.');",
    "if (cloudActivated && (providerCounts.get('Cloud TTS Sadaltager') !== PENDING_CLOUD.length || providerCounts.get('Gemini Sadaltager') !== RETAINED_GEMINI.length)) throw new Error(`Activated rollout must publish exactly ${PENDING_CLOUD.length} Cloud TTS + ${RETAINED_GEMINI.length} retained Gemini articles.`);",
  );
  return source;
});

for (const [label, source, tokens] of [
  ['Header', header, ['header-design-one', 'data-header-design="one"', 'data-ticker-primary', 'ticker-copy']],
  ['Layout', layout, ['stepMobileTicker', 'dataset.tickerOffset', 'prefers-reduced-motion']],
  ['CSS', css, ['header-design-one-desktop.svg', 'header-design-one-mobile.svg', 'mobileTickerLabel', 'max-width:1280px']],
]) {
  for (const token of tokens) if (!source.includes(token)) throw new Error(`${label} lost V4.21.4 compatibility token: ${token}`);
}
for (const [label, source] of [['HomeIntro', intro], ['start-here', startHere]]) {
  if (!source.includes('استمع إلى النص') || source.includes('استمع مع النص')) throw new Error(`${label} lost the approved listening wording.`);
}

if (/إنفوجرافيك|infographic/i.test([header, layout, intro, startHere].join('\n'))) {
  throw new Error('Infographic UI is intentionally deferred and must not enter V4.21.5.');
}

const isDraft = /^draft:\s*true\s*$/mi.test(article);
if (!isDraft) {
  await access(path.join('public', 'audio', 'articles', EXPECTED_AUDIO_KEY, 'manifest.json'));
}

const articleRoot = path.resolve('public', 'audio', 'articles');
let entries = [];
try { entries = await readdir(articleRoot, { withFileTypes: true }); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
for (const entry of entries) {
  if (!entry.isDirectory() || !(/\.restore-\d+$/.test(entry.name) || /\.tmp-\d+$/.test(entry.name))) continue;
  const target = path.join(articleRoot, entry.name);
  if (path.dirname(target) !== articleRoot) throw new Error(`Refusing to clean unexpected audio path: ${target}`);
  await rm(target, { recursive: true, force: true });
}

console.log(`V4.21.5 preparation passed: V4.21.4 UX preserved, infographic deferred, passport bodyHash/speech review locked, dependency metadata aligned, article ${isDraft ? 'remains draft' : 'has production audio'}, and temporary audio output is clean.`);
