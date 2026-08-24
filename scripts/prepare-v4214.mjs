import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (!['4.21.4', '4.21.5'].includes(pkg.version)) throw new Error(`V4.21.4 preparation expected package 4.21.4 or V4.21.5 successor, got ${pkg.version}.`);

const [header, layout, css, intro, startHere, desktopWave, mobileWave] = await Promise.all([
  readFile('src/components/Header.astro', 'utf8'),
  readFile('src/layouts/BaseLayout.astro', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
  readFile('src/components/HomeIntro.astro', 'utf8'),
  readFile('src/pages/start-here.astro', 'utf8'),
  readFile('public/images/header-design-one-desktop.svg', 'utf8'),
  readFile('public/images/header-design-one-mobile.svg', 'utf8'),
]);

const requireAll = (label, source, tokens) => {
  for (const token of tokens) if (!source.includes(token)) throw new Error(`${label} is missing V4.21.4 token: ${token}`);
};

requireAll('Header.astro', header, ['data-header-design="one"', 'data-ticker-track', 'data-ticker-primary', 'ticker-copy']);
requireAll('BaseLayout.astro', layout, ['stepMobileTicker', 'dataset.tickerOffset', 'prefers-reduced-motion']);
requireAll('global.css', css, [
  'V4.21.4 — مطابقة بصرية للتصميم الأول المعتمد',
  "url('/images/header-design-one-desktop.svg')",
  "url('/images/header-design-one-mobile.svg')",
  '.site-header.header-design-one{\n  width:100%;\n  max-width:none;',
  'height:112px',
  'width:min(288px,calc(100% - 52px))',
  '.ticker .ticker-toggle{\n  position:static;',
  '@keyframes mobileTickerLabel',
  'max-width:1280px',
]);
requireAll('desktop wave', desktopWave, ['viewBox="0 0 1440 118"', '#55a9b3', 'url(#navy)']);
requireAll('mobile wave', mobileWave, ['viewBox="0 0 390 112"', '#55a9b3', '#ffffff']);

for (const [label, source] of [['HomeIntro.astro', intro], ['start-here.astro', startHere]]) {
  if (!source.includes('استمع إلى النص') || source.includes('استمع مع النص')) {
    throw new Error(`${label} must use the approved phrase «استمع إلى النص».`);
  }
}

const articleRoot = path.resolve('public', 'audio', 'articles');
let entries = [];
try { entries = await readdir(articleRoot, { withFileTypes: true }); }
catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
for (const entry of entries) {
  if (!entry.isDirectory() || !/\.restore-\d+$/.test(entry.name)) continue;
  const target = path.join(articleRoot, entry.name);
  if (path.dirname(target) !== articleRoot) throw new Error(`Refusing to clean unexpected audio path: ${target}`);
  await rm(target, { recursive: true, force: true });
}

console.log('V4.21.4 compatibility preparation passed under V4.21.5: design-one SVG waves, framed responsive geometry, mobile ticker reveal, approved listening wording, and temporary-audio cleanup are locked.');
