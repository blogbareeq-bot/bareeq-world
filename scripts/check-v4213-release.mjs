import { access, readFile } from 'node:fs/promises';

const [pkgText, lockText, header, layout, footer, css, report] = await Promise.all([
  readFile('package.json', 'utf8'),
  readFile('package-lock.json', 'utf8'),
  readFile('src/components/Header.astro', 'utf8'),
  readFile('src/layouts/BaseLayout.astro', 'utf8'),
  readFile('src/components/Footer.astro', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
  readFile('docs/V4.21.3-HEADER-REBUILD.md', 'utf8'),
]);
const pkg = JSON.parse(pkgText);
const lock = JSON.parse(lockText);
const supportedPkg = ['4.21.3', '4.21.4', '4.21.5'].includes(pkg.version);
const lockMatches = lock.version === pkg.version && lock.packages?.['']?.version === pkg.version;
const rcMetadataOnly = pkg.version === '4.21.5' && lock.version === '4.21.4' && lock.packages?.['']?.version === '4.21.4';
if (!supportedPkg || (!lockMatches && !rcMetadataOnly)) {
  throw new Error('package.json/package-lock must identify V4.21.3/V4.21.4 or the V4.21.5 RC with unchanged dependency lock metadata.');
}

const requireAll = (label, source, tokens) => {
  for (const token of tokens) if (!source.includes(token)) throw new Error(`${label} is missing release token: ${token}`);
};
requireAll('Header', header, ['header-design-one', 'drawer-utilities', 'data-ticker-primary', 'ticker-copy']);
requireAll('Layout', layout, ['themeToggles.forEach', 'stepMobileTicker', 'measureTicker', 'visibilitychange']);
requireAll('Footer', footer, ['/saved/', 'data-theme-toggle']);
requireAll('CSS', css, [
  'min-height:118px',
  'background:linear-gradient(112deg,#071d39 0%,#0a3857 58%,#087277 100%)',
  'border-bottom-left-radius:92% 100%',
  'grid-template-columns:repeat(5,minmax(0,1fr))',
  'grid-template-columns:repeat(2,minmax(0,1fr))',
]);
requireAll('Visual report', report, ['320', '360', '390', '430', '768', '1024', '1440', 'PASS']);
for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
  await access(`docs/v4213-screenshots/header-reference-${width}.png`);
}
if (css.includes('.main-header::before,.main-header::after{display:none}')) throw new Error('Rejected simplified white mobile header returned.');
if (!pkg.scripts?.build?.includes('prepare-v4213.mjs') || !pkg.scripts?.build?.includes('check-v4213-release.mjs')) {
  throw new Error('V4.21.3 build gates are not wired into the production build.');
}

console.log('V4.21.3 compatibility gate passed inside V4.21.5: approved first header, real mobile wave, separate category cards, moving ticker, preserved utilities, and seven viewport screenshots are locked.');
