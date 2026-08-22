import { JSDOM } from 'jsdom';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist');
const failures = [];
const homeHtml = await readFile(path.join(root, 'index.html'), 'utf8');
const astroScripts = (await readdir(path.join(root, '_astro'))).filter((name) => name.endsWith('.js'));
const baseScriptName = astroScripts.find((name) => name.startsWith('BaseLayout'));
if (!baseScriptName) throw new Error('Base layout browser script was not generated.');
const baseScript = await readFile(path.join(root, '_astro', baseScriptName), 'utf8');

if (!homeHtml.includes('data-ticker-track') || !homeHtml.includes('data-ticker-primary') || !homeHtml.includes('ticker-copy') || !homeHtml.includes('aria-hidden="true"')) {
  failures.push('homepage ticker is missing the cloned loop marked hidden from assistive tech');
}
const structureDom = new JSDOM(homeHtml);
const primaryTitles = [...structureDom.window.document.querySelectorAll('[data-ticker-primary] > a')].map((link) => link.textContent?.trim());
const clonedTitles = [...structureDom.window.document.querySelectorAll('.ticker-copy > a')].map((link) => link.textContent?.trim());
if (primaryTitles.length < 2) failures.push(`ticker has too few live titles to loop: ${primaryTitles.length}`);
if (JSON.stringify(primaryTitles) !== JSON.stringify(clonedTitles)) failures.push('ticker clone does not exactly match the live title sequence');
structureDom.window.close();
if (!baseScript.includes('dataset.tickerOffset') || !baseScript.includes('translateX') || !baseScript.includes('is-manual')) {
  failures.push('BaseLayout no longer drives a measurable mobile ticker transform');
}

function createTickerDom(width, { reducedMotion = false } = {}) {
  const dom = new JSDOM(homeHtml, { url: 'https://bareeqworld.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return this.hasAttribute?.('data-ticker-track') ? 960 : 120;
    },
  });
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const widthValue = this.hasAttribute?.('data-ticker-primary') || this.classList?.contains('ticker-copy') ? 960 : 120;
    return { x: 0, y: 0, width: widthValue, height: 40, top: 0, right: widthValue, bottom: 40, left: 0, toJSON() {} };
  };
  const rafQueue = new Map();
  let rafId = 0;
  window.requestAnimationFrame = (callback) => {
    const id = ++rafId;
    rafQueue.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => { rafQueue.delete(id); };
  window.__bareeqFlushRaf = (now) => {
    const pending = [...rafQueue.entries()];
    rafQueue.clear();
    pending.forEach(([, callback]) => callback(now));
  };
  window.matchMedia = (query) => {
    const max = query.match(/max-width:\s*(\d+)px/)?.[1];
    const min = query.match(/min-width:\s*(\d+)px/)?.[1];
    const matches = query.includes('prefers-reduced-motion')
      ? reducedMotion
      : (!max || width <= Number(max)) && (!min || width >= Number(min));
    return {
      matches,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return true; },
    };
  };
  window.eval(baseScript);
  return { window, flush: window.__bareeqFlushRaf };
}

for (const width of [320, 360, 390, 430]) {
  const { window, flush } = createTickerDom(width, { reducedMotion: false });
  const ticker = window.document.querySelector('[data-ticker]');
  const track = window.document.querySelector('[data-ticker-track]');
  const copy = window.document.querySelector('.ticker-copy');
  const first = Number(track?.dataset.tickerOffset || '0');
  flush(16);
  flush(64);
  flush(160);
  flush(320);
  const moved = Number(track?.dataset.tickerOffset || '0');
  const transform = track?.style.transform || '';
  if (!(moved > first) || !transform.includes('translateX')) {
    failures.push(`mobile ticker did not change position over time at ${width}px; start=${first} later=${moved} transform=${transform}`);
  }
  if (ticker?.classList.contains('is-manual')) failures.push(`auto-moving ticker was marked manual at ${width}px`);
  if (copy?.getAttribute('aria-hidden') !== 'true') failures.push('ticker clone is not hidden from assistive tech');
  const liveLinks = [...window.document.querySelectorAll('[data-ticker-primary] > a')];
  if (liveLinks.some((link) => !link.getAttribute('href')?.startsWith('/posts/'))) failures.push('ticker titles are not tappable article links');

  window.document.querySelector('[data-ticker-toggle]')?.click();
  const pausedAt = Number(track?.dataset.tickerOffset || '0');
  flush(500);
  flush(900);
  if (Number(track?.dataset.tickerOffset || '0') !== pausedAt) failures.push(`pause control did not stop the ticker at ${width}px`);
  window.document.querySelector('[data-ticker-toggle]')?.click();
  flush(1000);
  flush(1120);
  if (!(Number(track?.dataset.tickerOffset || '0') > pausedAt)) failures.push(`resume control did not restart the ticker at ${width}px`);
  window.close();
}

{
  const { window, flush } = createTickerDom(390, { reducedMotion: true });
  const ticker = window.document.querySelector('[data-ticker]');
  const track = window.document.querySelector('[data-ticker-track]');
  flush(16);
  flush(240);
  if (!ticker?.classList.contains('is-manual')) failures.push('reduced motion did not switch the ticker to manual scroll');
  if (Number(track?.dataset.tickerOffset || '-1') !== 0 || track?.style.transform) {
    failures.push(`reduced motion still auto-moved the ticker: offset=${track?.dataset.tickerOffset} transform=${track?.style.transform}`);
  }
  window.close();
}

{
  const { window, flush } = createTickerDom(1440, { reducedMotion: false });
  const track = window.document.querySelector('[data-ticker-track]');
  flush(16);
  flush(240);
  if (Number(track?.dataset.tickerOffset || '-1') !== 0 || track?.style.transform) {
    failures.push('desktop ticker should keep CSS animation and not apply a JS transform');
  }
  window.close();
}

if (failures.length) {
  console.error(`Mobile ticker motion audit found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Mobile ticker motion passed at 320/360/390/430px: position changes over time, pause stops the frame loop, resume restarts it, the clone matches and stays hidden from AT, reduced-motion keeps manual scrolling, and desktop remains CSS-driven.');
