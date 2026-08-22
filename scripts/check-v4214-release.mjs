import { access, readFile } from 'node:fs/promises';

const [pkgText, lockText, css, header, reportText, metricsText] = await Promise.all([
  readFile('package.json', 'utf8'),
  readFile('package-lock.json', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
  readFile('src/components/Header.astro', 'utf8'),
  readFile('docs/V4.21.4-VISUAL-PARITY.md', 'utf8'),
  readFile('docs/v4214-screenshots/qa-metrics.json', 'utf8'),
]);
const pkg = JSON.parse(pkgText);
const lock = JSON.parse(lockText);
const metrics = JSON.parse(metricsText);

if (pkg.version !== '4.21.4' || lock.version !== '4.21.4' || lock.packages?.['']?.version !== '4.21.4') {
  throw new Error('package.json and package-lock.json must both identify V4.21.4.');
}
for (const token of ['header-design-one', 'data-ticker-track', 'ticker-copy']) {
  if (!header.includes(token)) throw new Error(`Header is missing release token: ${token}`);
}
for (const token of ['header-design-one-desktop.svg', 'header-design-one-mobile.svg', 'mobileTickerLabel', 'max-width:1280px']) {
  if (!css.includes(token)) throw new Error(`CSS is missing visual-parity token: ${token}`);
}
for (const token of ['320', '360', '390', '768', '1024', '1440', '1890', 'PASS']) {
  if (!reportText.includes(token)) throw new Error(`Visual report is missing token: ${token}`);
}

const expectedWidths = [320, 360, 390, 768, 1024, 1440, 1890];
if (!Array.isArray(metrics.results) || metrics.results.map((item) => item.width).join(',') !== expectedWidths.join(',')) {
  throw new Error('QA metrics must contain the seven approved viewport widths in order.');
}
for (const item of metrics.results) {
  if (item.pageScrollWidth > item.width) throw new Error(`Horizontal overflow at ${item.width}px: ${item.pageScrollWidth}px.`);
  if (item.browserErrors?.length) throw new Error(`Browser errors at ${item.width}px: ${item.browserErrors.join(' | ')}`);
  await access(`docs/v4214-screenshots/header-visual-${item.width}.png`);
}
for (const width of [320, 360, 390]) {
  const item = metrics.results.find((entry) => entry.width === width);
  if (!(item?.tickerDelta > 10)) throw new Error(`Mobile ticker motion was not proven at ${width}px.`);
}
const phone = metrics.results.find((item) => item.width === 390);
if (Math.abs(phone.geometry.mainHeader.width - 364) > 2 || Math.abs(phone.geometry.mainHeader.height - 112) > 2) {
  throw new Error(`390px header geometry drifted: ${JSON.stringify(phone.geometry.mainHeader)}.`);
}
if (Math.abs(phone.geometry.tickerInner.width - 288) > 2 || Math.abs(phone.geometry.categoryInner.width - 340) > 2) {
  throw new Error(`390px ticker/category geometry drifted: ${JSON.stringify(phone.geometry)}.`);
}
const wide = metrics.results.find((item) => item.width === 1890);
if (Math.abs(wide.geometry.siteHeader.width - 1440) > 2) throw new Error(`Desktop header cap drifted: ${wide.geometry.siteHeader.width}px.`);

console.log('V4.21.4 release gate passed: seven real-browser viewports, zero overflow/errors, exact 390px geometry, 1440px desktop cap, and moving mobile ticker are verified.');
