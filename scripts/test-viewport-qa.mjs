#!/usr/bin/env node
/**
 * Real-browser viewport QA for Bareeq Window.
 * Supports legacy V2 cards and the approved V3 Atlas Refined scene renderer.
 * There is deliberately no JSDOM fallback.
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { throw new Error('Playwright + Chromium are required for viewport QA.'); }

const BASE_URL = (process.env.BAREEQ_PREVIEW_URL || 'http://127.0.0.1:4321').replace(/\/$/, '');
const storiesDir = resolve(process.cwd(), 'src/data/visual-stories');
const artifactDir = resolve(process.cwd(), 'artifacts/window-viewport');
await mkdir(artifactDir, { recursive: true });
const files = (await readdir(storiesDir)).filter((name) => name.endsWith('.json') && !name.endsWith('.skeleton.json')).sort();
const stories = await Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(storiesDir, file), 'utf8'))));
const VIEWPORTS = [
  { name: '390x844 portrait', width: 390, height: 844, dpr: 3 },
  { name: '430x932 portrait', width: 430, height: 932, dpr: 3 },
  { name: '812x375 landscape', width: 812, height: 375, dpr: 2 },
  { name: '1280x800 desktop', width: 1280, height: 800, dpr: 1 }
];

const failures = [];
const fail = (story, viewport, message) => {
  const item = `${story.slug} @ ${viewport.name}: ${message}`;
  failures.push(item);
  console.error(`::error title=Bareeq Window viewport QA::${item}`);
};
const overlaps = (a, b, tolerance = 1) => Boolean(a && b &&
  a.x + a.width > b.x + tolerance && b.x + b.width > a.x + tolerance &&
  a.y + a.height > b.y + tolerance && b.y + b.height > a.y + tolerance);
const safeName = (value) => value.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120);

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.dpr, reducedMotion: 'reduce' });
    for (const story of stories) {
      const page = await context.newPage();
      const startFailureCount = failures.length;
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message || String(error)));
      try {
        const response = await page.goto(`${BASE_URL}${story.articlePath}`, { waitUntil: 'networkidle', timeout: 30000 });
        if (!response?.ok()) { fail(story, viewport, `article request failed (${response?.status() ?? 'no response'})`); continue; }

        const mode = page.locator('[data-reading-mode="window"]');
        if (await mode.count() !== 1) { fail(story, viewport, 'window reading-mode control missing'); continue; }
        await mode.click();

        const isV3 = story.slug === 'how-touchscreens-work';
        const root = page.locator(isV3 ? '[data-window-v3-root]' : '[data-visual-story]');
        const dialog = root.locator('[data-visual-dialog]');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });
        if (isV3 && await page.locator('[data-visual-story]').count()) fail(story, viewport, 'legacy Window root unexpectedly rendered for V3 pilot');

        const dir = await page.evaluate(() => document.documentElement.dir);
        if (dir !== 'rtl') fail(story, viewport, `document direction is ${dir || '(empty)'}, expected rtl`);
        const cardCount = await page.locator('[data-visual-card]').count();
        if (cardCount !== story.cards.length) fail(story, viewport, `card count ${cardCount}, expected ${story.cards.length}`);
        if (await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1)) fail(story, viewport, 'dialog has horizontal overflow');

        const dialogBox = await dialog.boundingBox();
        if (!dialogBox) { fail(story, viewport, 'dialog has no measurable box'); continue; }
        if (dialogBox.x < -1 || dialogBox.x + dialogBox.width > viewport.width + 1) fail(story, viewport, `dialog exceeds viewport horizontally (${JSON.stringify(dialogBox)})`);
        if (dialogBox.y < -1 || dialogBox.y + dialogBox.height > viewport.height + 1) fail(story, viewport, `dialog exceeds viewport vertically (${JSON.stringify(dialogBox)})`);

        const header = page.locator(isV3 ? '.visual-story-v3__header' : '.visual-story__header');
        const footer = page.locator(isV3 ? '.visual-story-v3__nav' : '.visual-story__footer');
        const headerBox = await header.boundingBox();
        const footerBox = await footer.boundingBox();
        const next = page.locator('[data-visual-next]');
        const prev = page.locator('[data-visual-prev]');
        if (!(await next.isVisible())) fail(story, viewport, 'next control not visible');
        if (!(await prev.isVisible())) fail(story, viewport, 'previous control not visible');

        for (let index = 0; index < story.cards.length; index += 1) {
          if (index > 0) await next.click();
          const active = page.locator('[data-visual-card].is-active');
          if (await active.count() !== 1) { fail(story, viewport, `expected one active card/scene at ${index + 1}`); break; }
          const copy = active.locator(isV3 ? '[data-visual-copy]' : '.visual-story__copy');
          const copyBox = await copy.boundingBox();
          const cardBox = await active.boundingBox();
          if (!copyBox || !cardBox) { fail(story, viewport, `card ${index + 1} has no measurable copy/card box`); continue; }
          if (await copy.evaluate((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) fail(story, viewport, `card ${index + 1} copy is clipped or internally overflowing`);
          if (copyBox.x < cardBox.x - 1 || copyBox.x + copyBox.width > cardBox.x + cardBox.width + 1) fail(story, viewport, `card ${index + 1} copy escapes card horizontally`);
          if (copyBox.y < cardBox.y - 1 || copyBox.y + copyBox.height > cardBox.y + cardBox.height + 1) fail(story, viewport, `card ${index + 1} copy escapes card vertically`);
          if (headerBox && overlaps(copyBox, headerBox)) fail(story, viewport, `card ${index + 1} copy overlaps header`);
          if (footerBox && overlaps(copyBox, footerBox)) fail(story, viewport, `card ${index + 1} copy overlaps footer`);
          if (isV3 && await active.evaluate((el) => el.scrollWidth > el.clientWidth + 1)) fail(story, viewport, `scene ${index + 1} has horizontal overflow`);
        }

        const position = Number(await page.locator('[data-visual-position]').textContent());
        if (position !== story.cards.length) fail(story, viewport, `last-card navigation ended at ${position}`);
        await page.keyboard.press('Home');
        if (Number(await page.locator('[data-visual-position]').textContent()) !== 1) fail(story, viewport, 'Home key did not return to card 1');
        await page.keyboard.press('End');
        if (Number(await page.locator('[data-visual-position]').textContent()) !== story.cards.length) fail(story, viewport, 'End key did not reach last card');

        if (isV3) {
          if (story.slug !== 'how-touchscreens-work') fail(story, viewport, 'V3 renderer enabled outside the approved pilot article');
          if (await page.locator('[data-v3-home]').count() !== 1) fail(story, viewport, 'V3 home navigation missing');
          if (await page.locator('[data-v3-motion]').count() !== 1) fail(story, viewport, 'V3 reduced-motion control missing');
          if (viewport.height > 520) {
            await page.keyboard.press('Home');
            for (let n = 0; n < 3; n += 1) await next.click();
            const probe = page.locator('[data-v3-probe]');
            if (await probe.isVisible()) {
              await probe.hover({ position: { x: 90, y: 90 } });
              const out = (await page.locator('[data-v3-probe-output]').textContent())?.trim() || '';
              if (!out || out === 'محاكاة بصرية نوعية') fail(story, viewport, 'V3 field probe did not react to pointer input');
            }
          }
        }

        if (pageErrors.length) fail(story, viewport, `runtime page error: ${pageErrors.join(' | ')}`);
        await page.keyboard.press('Escape');
        if (await root.isVisible()) fail(story, viewport, 'Escape did not close Window');
        if (!(await mode.evaluate((el) => document.activeElement === el))) fail(story, viewport, 'focus was not restored to the Window mode control');
        if (!(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches))) fail(story, viewport, 'reduced-motion emulation not active');
      } catch (error) {
        fail(story, viewport, error instanceof Error ? error.message : String(error));
      } finally {
        if (failures.length > startFailureCount) {
          try { await page.screenshot({ path: resolve(artifactDir, `${safeName(story.slug)}-${viewport.width}x${viewport.height}.png`), fullPage: true }); } catch {}
        }
        await page.close();
      }
    }
    await context.close();
  }
} finally { await browser.close(); }

if (failures.length) {
  await writeFile(resolve(artifactDir, 'failures.txt'), `${failures.join('\n')}\n`, 'utf8');
  throw new Error(`[viewport-qa] ${failures.length} real-browser issue(s); see artifacts/window-viewport/failures.txt`);
}
await writeFile(resolve(artifactDir, 'PASS.txt'), `${stories.length}/15 stories × ${VIEWPORTS.length} viewports = ${stories.length * VIEWPORTS.length} production-page checks passed.\n`, 'utf8');
console.log(`[viewport-qa] PASS: ${stories.length}/15 stories × ${VIEWPORTS.length} real viewports = ${stories.length * VIEWPORTS.length} production-page checks.`);
