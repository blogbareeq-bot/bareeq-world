import { createHash } from 'node:crypto';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const ARTICLE_ID = 'why-some-passports-are-stronger';
const ARTICLE_FILE = `src/content/posts/${ARTICLE_ID}.md`;
const EXPECTED_BODY_HASH = '2b2999dba95bff5e6bfb8ff16d2848fa3b677ffe8f595a5b6166ca15ebf7d4c1';
const EXPECTED_AUDIO_KEY = '34e34b6f4633d928';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.version !== '4.21.5') throw new Error(`V4.21.5 preparation expected package 4.21.5, got ${pkg.version}.`);

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

console.log(`V4.21.5 preparation passed: V4.21.4 UX preserved, infographic deferred, passport bodyHash locked, article ${isDraft ? 'remains draft' : 'has production audio'}, and temporary audio output is clean.`);
