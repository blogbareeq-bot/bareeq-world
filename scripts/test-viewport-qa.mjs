#!/usr/bin/env node
/**
 * Real-browser viewport QA for Bareeq Window.
 *
 * Preconditions:
 *   1. `npm run build` has completed.
 *   2. `astro preview` is serving the built site.
 *   3. Playwright + Chromium are installed.
 *
 * This test intentionally has NO JSDOM fallback. A structural DOM simulation
 * cannot certify clipping, overflow, overlap, responsive CSS, RTL geometry or
 * real focus behaviour. If Chromium is unavailable, the gate must fail.
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  throw new Error('Playwright is required for viewport QA; install playwright and Chromium. JSDOM is not an acceptable visual PASS.');
}

const BASE_URL = (process.env.BAREEQ_PREVIEW_URL || 'http://127.0.0.1:4321').replace(/\/$/, '');
const storiesDir = resolve(process.cwd(), 'src/data/visual-stories');
const files = (await readdir(storiesDir))
  .filter((name) => name.endsWith('.json') && !name.endsWith('.skeleton.json'))
  .sort();
const stories = await Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(storiesDir, file), 'utf8'))));

const VIEWPORTS = [
  { name: '390x844 portrait', width: 390, height: 844, dpr: 3 },
  { name: '430x932 portrait', width: 430, height: 932, dpr: 3 },
  { name: '812x375 landscape', width: 812, height: 375, dpr: 2 },
  { name: '1280x800 desktop', width: 1280, height: 800, dpr: 1 }
];

const failures = [];
const fail = (story, viewport, message) => failures.push(`${story.slug} @ ${viewport.name}: ${message}`);
const overlaps = (a, b, tolerance = 1) => Boolean(a && b &&
  a.x + a.width > b.x + tolerance && b.x + b.width > a.x + tolerance &&
  a.y + a.height > b.y + tolerance && b.y + b.height > a.y + tolerance);

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.dpr,
      reducedMotion: 'reduce'
    });

    for (const story of stories) {
      const page = await context.newPage();
      const url = `${BASE_URL}${story.articlePath}`;
      try {
        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        if (!response?.ok()) {
          fail(story, viewport, `article request failed (${response?.status() ?? 'no response'})`);
          continue;
        }

        const mode = page.locator('[data-reading-mode="window"]');
        if (await mode.count() !== 1) {
          fail(story, viewport, 'window reading-mode control missing');
          continue;
        }
        await mode.click();

        const root = page.locator('[data-visual-story]');
        const dialog = page.locator('[data-visual-dialog]');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });

        const dir = await page.evaluate(() => document.documentElement.dir);
        if (dir !== 'rtl') fail(story, viewport, `document direction is ${dir || '(empty)'}, expected rtl`);

        const cardCount = await page.locator('[data-visual-card]').count();
        if (cardCount !== story.cards.length) fail(story, viewport, `card count ${cardCount}, expected ${story.cards.length}`);

        const hasHorizontalOverflow = await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        if (hasHorizontalOverflow) fail(story, viewport, 'dialog has horizontal overflow');

        const dialogBox = await dialog.boundingBox();
        if (!dialogBox) {
          fail(story, viewport, 'dialog has no measurable box');
          continue;
        }
        if (dialogBox.x < -1 || dialogBox.x + dialogBox.width > viewport.width + 1) {
          fail(story, viewport, `dialog exceeds viewport horizontally (${JSON.stringify(dialogBox)})`);
        }
        if (dialogBox.y < -1 || dialogBox.y + dialogBox.height > viewport.height + 1) {
          fail(story, viewport, `dialog exceeds viewport vertically (${JSON.stringify(dialogBox)})`);
        }

        const header = page.locator('.visual-story__header');
        const footer = page.locator('.visual-story__footer');
        const headerBox = await header.boundingBox();
        const footerBox = await footer.boundingBox();
        const next = page.locator('[data-visual-next]');
        const prev = page.locator('[data-visual-prev]');
        if (!(await next.isVisible())) fail(story, viewport, 'next control not visible');
        if (!(await prev.isVisible())) fail(story, viewport, 'previous control not visible');

        // Inspect every card in its real active state, not only the opening.
        for (let index = 0; index < story.cards.length; index += 1) {
          if (index > 0) await next.click();
          const active = page.locator('[data-visual-card].is-active');
          if (await active.count() !== 1) {
            fail(story, viewport, `expected one active card at ${index + 1}`);
            break;
          }
          const copy = active.locator('.visual-story__copy');
          const copyBox = await copy.boundingBox();
          const cardBox = await active.boundingBox();
          if (!copyBox || !cardBox) {
            fail(story, viewport, `card ${index + 1} has no measurable copy/card box`);
            continue;
          }
          const clipped = await copy.evaluate((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
          if (clipped) fail(story, viewport, `card ${index + 1} copy is clipped or internally overflowing`);
          if (copyBox.x < cardBox.x - 1 || copyBox.x + copyBox.width > cardBox.x + cardBox.width + 1) {
            fail(story, viewport, `card ${index + 1} copy escapes card horizontally`);
          }
          if (headerBox && overlaps(copyBox, headerBox)) fail(story, viewport, `card ${index + 1} copy overlaps header`);
          if (footerBox && overlaps(copyBox, footerBox)) fail(story, viewport, `card ${index + 1} copy overlaps footer`);
        }

        const position = Number(await page.locator('[data-visual-position]').textContent());
        if (position !== story.cards.length) fail(story, viewport, `last-card navigation ended at ${position}`);

        await page.keyboard.press('Home');
        const homePosition = Number(await page.locator('[data-visual-position]').textContent());
        if (homePosition !== 1) fail(story, viewport, `Home key ended at ${homePosition}`);

        await page.keyboard.press('End');
        const endPosition = Number(await page.locator('[data-visual-position]').textContent());
        if (endPosition !== story.cards.length) fail(story, viewport, `End key ended at ${endPosition}`);

        await page.keyboard.press('Escape');
        if (await root.isVisible()) fail(story, viewport, 'Escape did not close Window');
        const focusReturned = await mode.evaluate((el) => document.activeElement === el);
        if (!focusReturned) fail(story, viewport, 'focus was not restored to the Window mode control');

        const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (!reduced) fail(story, viewport, 'reduced-motion emulation not active');
      } catch (error) {
        fail(story, viewport, error instanceof Error ? error.message : String(error));
        // A screenshot is intentionally attempted only on failure; Actions
        // logs still contain the slug/viewport even when artifact upload is unavailable.
        try { await page.screenshot({ path: `/tmp/window-${encodeURIComponent(story.slug)}-${viewport.width}x${viewport.height}.png`, fullPage: true }); } catch {}
      } finally {
        await page.close();
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`[viewport-qa] FAILED with ${failures.length} issue(s):\n- ${failures.join('\n- ')}`);
  throw new Error('real-browser viewport QA failed');
}

console.log(`[viewport-qa] PASS: ${stories.length}/15 stories × ${VIEWPORTS.length} real viewports = ${stories.length * VIEWPORTS.length} production-page checks.`);
