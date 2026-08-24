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

const versionSupported = ['4.21.4', '4.21.5', '4.21.6'].includes(pkg.version);
const lockMatches = lock.version === pkg.version && lock.packages?.['']?.version === pkg.version;
const rcMetadataOnly = pkg.version === '4.21.5' && lock.version === '4.21.4' && lock.packages?.['']?.version === '4.21.4';
if (!versionSupported || (!lockMatches && !rcMetadataOnly)) {
  throw new Error('package.json/package-lock must identify V4.21.4 or a supported V4.21.5/V4.21.6 successor with matching dependency metadata.');
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

const expectedWidths = [320, 360, 390, 430, 768, 1024, 1440, 1890];
if (!Array.isArray(metrics.results) || metrics.results.map((item) => item.width).join(',') !== expectedWidths.join(',')) {
  throw new Error('QA metrics must contain the eight approved viewport widths in order.');
}
if (!metrics.chromium || !metrics.browserVersion) {
  throw new Error('QA metrics must record the real Chromium path and browser version.');
}
for (const item of metrics.results) {
  if (item.pageScrollWidth > item.width) throw new Error(`Horizontal overflow at ${item.width}px: ${item.pageScrollWidth}px.`);
  if (item.browserErrors?.length) throw new Error(`Browser errors at ${item.width}px: ${item.browserErrors.join(' | ')}`);
  const toggle = item.geometry?.tickerToggle;
  if (!toggle || toggle.width < 40 || toggle.height < 40 || toggle.visible === false) {
    throw new Error(`Ticker pause/play must be a visible 44px-class control at ${item.width}px: ${JSON.stringify(toggle)}.`);
  }
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
if (wide.geometry.siteHeader.width < 1880) throw new Error(`Desktop header must span the viewport, got ${wide.geometry.siteHeader.width}px.`);

console.log('V4.21.4 visual-parity gate passed under V4.21.6: eight real-browser viewports, visible ticker pause/play, zero overflow/errors, exact 390px geometry, full-bleed desktop header, and moving mobile ticker remain verified.');
