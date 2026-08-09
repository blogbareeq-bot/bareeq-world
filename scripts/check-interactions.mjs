import { JSDOM } from 'jsdom';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist');
const failures = [];
const astroScripts = (await readdir(path.join(root, '_astro'))).filter((name) => name.endsWith('.js'));
const baseScriptName = astroScripts.find((name) => name.startsWith('BaseLayout'));
if (!baseScriptName) throw new Error('Base layout browser script was not generated.');
const baseScript = await readFile(path.join(root, '_astro', baseScriptName), 'utf8');
const articleScript = await readFile(path.join(root, 'scripts', 'article.js'), 'utf8');
const articlesScript = await readFile(path.join(root, 'scripts', 'articles.js'), 'utf8');
const searchScript = await readFile(path.join(root, 'scripts', 'search.js'), 'utf8');
const analyticsConsentScript = await readFile(path.join(root, 'scripts', 'analytics-consent.js'), 'utf8');

function createDom(html, width) {
  const dom = new JSDOM(html, { url: 'https://bareeqworld.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
  window.scrollTo = (options) => { window.scrollY = typeof options === 'object' ? options.top ?? 0 : 0; };
  window.requestAnimationFrame = (callback) => { callback(Date.now()); return 1; };
  window.cancelAnimationFrame = () => {};
  window.matchMedia = (query) => {
    const max = query.match(/max-width:\s*(\d+)px/)?.[1];
    const min = query.match(/min-width:\s*(\d+)px/)?.[1];
    const matches = query.includes('hover:hover') ? width >= 1024
      : query.includes('prefers-reduced-motion') ? false
        : (!max || width <= Number(max)) && (!min || width >= Number(min));
    return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return true; } };
  };
  window.eval(baseScript);
  return dom;
}

const homeHtml = await readFile(path.join(root, 'index.html'), 'utf8');

{
  const dom = createDom(homeHtml, 1440);
  const { window } = dom;
  const trigger = window.document.querySelector('[data-category-menu-trigger]');
  const menuRoot = trigger?.closest('[data-category-menu-root]');
  menuRoot?.dispatchEvent(new window.Event('pointerenter', { bubbles: false }));
  trigger?.click();
  if (trigger?.getAttribute('aria-expanded') !== 'true' || !menuRoot?.classList.contains('is-open')) failures.push('desktop category pointerenter + click closes the menu');
  if (menuRoot?.querySelector('img[data-src]')) failures.push('category images were not promoted from data-src when opened');
  window.document.querySelector('main')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  if (trigger?.getAttribute('aria-expanded') !== 'false') failures.push('outside click does not close desktop category menu');
  trigger?.focus();
  trigger?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 240));
  if (!window.document.activeElement?.closest('[data-category-menu]')) failures.push('ArrowDown does not move focus into category dropdown');
  window.document.activeElement?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (window.document.activeElement !== trigger || trigger?.getAttribute('aria-expanded') !== 'false') failures.push('Escape does not close category dropdown and return focus');
  const themeButton = window.document.querySelector('[data-theme-toggle]');
  themeButton?.click();
  if (window.document.documentElement.dataset.theme !== 'dark' || themeButton?.getAttribute('aria-pressed') !== 'true') failures.push('theme toggle state is not synchronized');
  const ticker = window.document.querySelector('[data-ticker]');
  window.document.querySelector('[data-ticker-toggle]')?.click();
  if (!ticker?.classList.contains('is-paused')) failures.push('ticker pause control does not pause motion');
  if ([...window.document.querySelectorAll('[data-footer-details]')].some((node) => !node.open)) failures.push('desktop footer detail groups are not open');
  dom.window.close();
}

{
  const dom = createDom(homeHtml, 390);
  const { window } = dom;
  const open = window.document.querySelector('[data-menu-open]');
  const drawer = window.document.querySelector('[data-mobile-drawer]');
  open?.click();
  if (drawer?.getAttribute('aria-hidden') !== 'false' || drawer?.inert || open?.getAttribute('aria-expanded') !== 'true') failures.push('mobile drawer open state is incorrect');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (drawer?.getAttribute('aria-hidden') !== 'true' || !drawer?.inert || open?.getAttribute('aria-expanded') !== 'false') failures.push('mobile drawer close/inert state is incorrect');
  if ([...window.document.querySelectorAll('[data-footer-details]')].some((node) => node.open)) failures.push('mobile footer accordions do not start collapsed');
  dom.window.close();
}

{
  const dom = createDom(homeHtml, 390);
  const { window } = dom;
  window.eval(analyticsConsentScript);
  const banner = window.document.querySelector('[data-analytics-consent]');
  if (banner?.hidden || !window.document.body.classList.contains('analytics-consent-open')) failures.push('first visit does not expose the optional analytics choice');
  if (window.document.querySelector('script[data-bareeq-analytics]')) failures.push('Google Analytics loads before consent');
  window.document.querySelector('[data-analytics-accept]')?.click();
  const googleTag = window.document.querySelector('script[data-bareeq-analytics]');
  if (window.localStorage.getItem('bareeq-analytics-consent-v1') !== 'granted' || !banner?.hidden) failures.push('analytics acceptance is not saved or does not close the notice');
  if (!googleTag?.src.includes('G-N3NQMF7RHN') || !window.__bareeqAnalyticsLoaded) failures.push('analytics acceptance does not load the configured Google tag');
  window.document.querySelector('[data-analytics-settings]')?.click();
  if (banner?.hidden || window.document.activeElement?.id !== 'analytics-consent-title') failures.push('footer privacy control does not reopen and focus the analytics choice');
  window.document.querySelector('[data-analytics-reject]')?.click();
  if (window.localStorage.getItem('bareeq-analytics-consent-v1') !== 'denied' || !banner?.hidden) failures.push('analytics withdrawal is not saved or does not close the notice');
  dom.window.close();
}

{
  const articleDirectory = path.join(root, 'posts', 'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء');
  const html = await readFile(path.join(articleDirectory, 'index.html'), 'utf8');
  const dom = createDom(html, 390);
  const { window } = dom;
  const analyticsEvents = [];
  window.__bareeqAnalyticsLoaded = true;
  window.gtag = (...args) => analyticsEvents.push(args);
  const content = window.document.querySelector('[data-article-content]');
  Object.defineProperty(content, 'scrollHeight', { value: 3600, configurable: true });
  content.getBoundingClientRect = () => ({ top: -900, bottom: 2700, left: 0, right: 390, width: 390, height: 3600, x: 0, y: -900, toJSON() { return this; } });
  window.scrollY = 1200;
  window.eval(articleScript);
  const progress = Number(window.document.querySelector('[data-reading-progress]')?.getAttribute('aria-valuenow'));
  if (!(progress > 0 && progress <= 100)) failures.push(`article progress is invalid: ${progress}`);
  content.getBoundingClientRect = () => ({ top: -3000, bottom: 600, left: 0, right: 390, width: 390, height: 3600, x: 0, y: -3000, toJSON() { return this; } });
  window.scrollY = 3000;
  window.dispatchEvent(new window.Event('scroll'));
  if (!analyticsEvents.some(([command, name]) => command === 'event' && name === 'article_read_75')) failures.push('75% article reading event is not emitted after consent');
  const tocToggle = window.document.querySelector('[data-toc-toggle]');
  tocToggle?.click();
  if (tocToggle?.getAttribute('aria-expanded') !== 'true' || !window.document.querySelector('[data-article-toc]')?.classList.contains('is-open')) failures.push('mobile article TOC does not open');
  dom.window.close();
}

{
  const html = await readFile(path.join(root, 'articles', 'index.html'), 'utf8');
  const dom = createDom(html, 390);
  dom.window.eval(articlesScript);
  dom.window.document.querySelector('[data-filter="simply"]')?.click();
  const cards = [...dom.window.document.querySelectorAll('[data-archive-grid] [data-post-card]')];
  if (!cards.some((card) => !card.hidden) || cards.some((card) => !card.hidden && card.dataset.category !== 'simply')) failures.push('article category filter exposes incorrect cards');
  dom.window.close();
}

{
  const html = await readFile(path.join(root, 'search', 'index.html'), 'utf8');
  const dom = createDom(html, 390);
  dom.window.eval(searchScript);
  const input = dom.window.document.querySelector('[data-search-input]');
  input.value = 'مدار';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  if (!dom.window.document.querySelector('.search-result-card')) failures.push('search index returns no result for مدار');
  dom.window.close();
}

if (failures.length) {
  console.error(`Interaction audit found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Interaction audit passed: menus, keyboard, drawer, theme, ticker, footer accordions, analytics consent, article TOC/progress, filters, and search.');
