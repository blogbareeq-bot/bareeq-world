import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = path.resolve('dist');
const outDir = path.resolve('docs/v4214-screenshots');
const widths = [320, 360, 390, 430, 768, 1024, 1440, 1890];
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.ico': 'image/x-icon',
};

async function inflateBrotli(source, destination) {
  if (existsSync(destination)) return;
  await pipeline(createReadStream(source), createBrotliDecompress(), createWriteStream(destination));
}

async function prepareChromium() {
  const binDir = path.resolve('node_modules/@sparticuz/chromium/bin');
  const chromePath = path.join(tmpdir(), 'chromium');
  const libDir = path.join(tmpdir(), 'al2023', 'lib');
  mkdirSync(path.join(tmpdir(), 'al2023'), { recursive: true });
  await inflateBrotli(path.join(binDir, 'chromium.br'), chromePath);
  await inflateBrotli(path.join(binDir, 'al2023.tar.br'), path.join(tmpdir(), 'al2023.tar'));
  if (!existsSync(path.join(libDir, 'libnss3.so'))) {
    execFileSync('tar', ['-xf', path.join(tmpdir(), 'al2023.tar'), '-C', path.join(tmpdir(), 'al2023')]);
  }
  process.env.LD_LIBRARY_PATH = `${libDir}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`;
  return chromePath;
}

const chromePath = await prepareChromium();
const puppeteer = (await import('puppeteer-core')).default;
const chromium = (await import('@sparticuz/chromium')).default;

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  let filePath = path.join(root, decodeURIComponent(url.pathname));
  if (filePath.endsWith('/')) filePath = path.join(filePath, 'index.html');
  if (!filePath.startsWith(root)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    try {
      const body = await readFile(path.join(filePath, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'shell',
  args: puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
});
const version = await browser.version();
mkdirSync(outDir, { recursive: true });

const results = [];
for (const width of widths) {
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.setViewport({ width, height: width <= 800 ? 844 : 980, deviceScaleFactor: 1 });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.evaluate(() => document.fonts?.ready);
  await new Promise((resolve) => setTimeout(resolve, 280));

  const measured = await page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: Number(rect.x.toFixed(2)),
        y: Number(rect.y.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
        visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width >= 40 && rect.height >= 40,
      };
    };
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      geometry: {
        siteHeader: box('.site-header'),
        mainHeader: box('.main-header'),
        tickerInner: box('.ticker-inner'),
        tickerToggle: box('[data-ticker-toggle]'),
        categoryInner: box('.category-strip-inner'),
      },
    };
  });

  let tickerStart = 0;
  let tickerLater = 0;
  let tickerDelta = 0;
  if (width <= 700) {
    tickerStart = await page.evaluate(() => Number(document.querySelector('[data-ticker-track]')?.dataset.tickerOffset || '0'));
    await new Promise((resolve) => setTimeout(resolve, 900));
    tickerLater = await page.evaluate(() => Number(document.querySelector('[data-ticker-track]')?.dataset.tickerOffset || '0'));
    tickerDelta = Number(Math.abs(tickerLater - tickerStart).toFixed(2));
  }

  let menu = null;
  let pauseResume = null;
  if (width === 390) {
    await page.click('[data-menu-open]');
    const opened = await page.evaluate(() => document.querySelector('[data-mobile-drawer]')?.classList.contains('is-open') === true);
    await page.click('[data-menu-close]');
    const closed = await page.evaluate(() => document.querySelector('[data-mobile-drawer]')?.classList.contains('is-open') !== true);
    menu = { opened, closed };

    await page.click('[data-ticker-toggle]');
    const paused = await page.evaluate(() => document.querySelector('[data-ticker]')?.classList.contains('is-paused') === true);
    const pausedOffset = await page.evaluate(() => Number(document.querySelector('[data-ticker-track]')?.dataset.tickerOffset || '0'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stillPaused = await page.evaluate((expected) => Number(document.querySelector('[data-ticker-track]')?.dataset.tickerOffset || '0') === expected, pausedOffset);
    await page.click('[data-ticker-toggle]');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const resumed = await page.evaluate((expected) => {
      const ticker = document.querySelector('[data-ticker]');
      const later = Number(document.querySelector('[data-ticker-track]')?.dataset.tickerOffset || '0');
      return ticker?.classList.contains('is-paused') !== true && later !== expected;
    }, pausedOffset);
    pauseResume = { paused: paused && stillPaused, resumed };
    await page.screenshot({ path: path.join(outDir, 'header-visual-390-motion.png'), clip: { x: 0, y: 0, width, height: 280 } });
  }

  await page.screenshot({ path: path.join(outDir, `header-visual-${width}.png`), clip: { x: 0, y: 0, width, height: width <= 800 ? 280 : 260 } });
  results.push({
    width,
    pageScrollWidth: measured.pageScrollWidth,
    browserErrors,
    geometry: measured.geometry,
    tickerStart,
    tickerLater,
    tickerDelta,
    menu,
    pauseResume,
  });
  await page.close();
}

await browser.close();
server.close();

const payload = {
  generatedAt: new Date().toISOString(),
  chromium: chromePath,
  browserVersion: version,
  origin,
  results,
};
await writeFile(path.join(outDir, 'qa-metrics.json'), `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Captured ${results.length} real Chromium viewports with ${version} at ${chromePath}`);
for (const item of results) {
  const toggle = item.geometry.tickerToggle;
  console.log(`${item.width}: header=${item.geometry.mainHeader?.width}x${item.geometry.mainHeader?.height} ticker=${item.geometry.tickerInner?.width} toggle=${toggle?.width}x${toggle?.height} overflow=${item.pageScrollWidth} delta=${item.tickerDelta}`);
}
