import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.version !== '4.21.3') throw new Error(`V4.21.3 preparation expected package 4.21.3, got ${pkg.version}.`);

const [header, layout, footer, css] = await Promise.all([
  readFile('src/components/Header.astro', 'utf8'),
  readFile('src/layouts/BaseLayout.astro', 'utf8'),
  readFile('src/components/Footer.astro', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
]);

const requireAll = (label, source, tokens) => {
  for (const token of tokens) if (!source.includes(token)) throw new Error(`${label} is missing V4.21.3 token: ${token}`);
};

requireAll('Header.astro', header, [
  'data-header-design="one"',
  'header-reading-list',
  'header-theme-toggle',
  'drawer-utilities',
  'data-ticker-primary',
]);
requireAll('BaseLayout.astro', layout, [
  "document.querySelectorAll('[data-theme-toggle]')",
  'stepMobileTicker',
  'syncTickerPlayback',
]);
requireAll('Footer.astro', footer, ['/saved/', 'data-theme-toggle']);
requireAll('global.css', css, [
  'التصميم الأول المرجعي',
  '.main-header::before,.main-header::after{display:block',
  '.main-header::before{z-index:1;right:-14px;width:58%;background:#fff',
  '.category-strip-inner{width:calc(100% - 24px);min-height:0;grid-template-columns:repeat(2,minmax(0,1fr))',
  '.category-nav-item:last-child{grid-column:1/-1}',
]);
if (css.includes('.main-header::before,.main-header::after{display:none}')) throw new Error('V4.21.3 must not hide the approved mobile wave.');

console.log('V4.21.3 preparation passed: the approved first header is implemented natively on desktop and mobile, while the moving ticker and accessible utilities remain available.');
