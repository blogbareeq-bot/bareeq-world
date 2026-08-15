import { JSDOM } from 'jsdom';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist');
const failures = [];
const astroScripts = (await readdir(path.join(root, '_astro'))).filter((name) => name.endsWith('.js'));
const baseScriptName = astroScripts.find((name) => name.startsWith('BaseLayout'));
if (!baseScriptName) throw new Error('Base layout browser script was not generated.');
const baseScript = await readFile(path.join(root, '_astro', baseScriptName), 'utf8');
const audioCoreScript = await readFile(path.join(root, 'scripts', 'audio-core.js'), 'utf8');
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
  const headerSearch = window.document.querySelector('.header-search-link');
  if (headerSearch?.getAttribute('href') !== '/search/' || !headerSearch.textContent?.includes('ابحث في بريق')) failures.push('desktop header search field is missing or points to the wrong page');
  if ([...window.document.querySelectorAll('[data-category-menu-trigger]')].some((node) => node.querySelector('.category-article-count'))) failures.push('article counts leaked into top-level category triggers');
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
  const importedArticleId = 'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء';
  const articleDirectory = path.join(root, 'posts', importedArticleId);
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
  const articleAudio = window.document.querySelector('[data-article-audio]');
  if (articleAudio) {
    Object.defineProperty(articleAudio, 'duration', { value: 281.088, configurable: true });
    Object.defineProperty(articleAudio, 'currentTime', { value: 0, writable: true, configurable: true });
  }
  window.eval(audioCoreScript);
  window.eval(articleScript);
  const voiceSelect = window.document.querySelector('[data-audio-voice]');
  const voiceField = window.document.querySelector('[data-audio-voice-field]');
  const seek = window.document.querySelector('[data-audio-seek]');
  if (!voiceSelect?.disabled || voiceSelect?.options.length !== 1 || voiceSelect?.value !== 'cedar' || !voiceField?.hidden || !articleAudio?.src.includes('/releases/20260815T050435Z-73ce11f5/cedar-article-')) failures.push('approved Studio player does not initialize with the single Cedar production release');
  if (seek?.disabled || window.document.querySelectorAll('[data-audio-sync-id]').length !== 21) failures.push('Studio player seek/synchronization controls are not ready for all 21 blocks');
  if (articleAudio) {
    articleAudio.currentTime = 28.5;
    articleAudio.dispatchEvent(new window.Event('timeupdate'));
    if (!(Number(seek?.value) > 90) || !window.document.querySelector('[data-audio-current="true"]')) failures.push('Studio timeline does not update seek progress and the active text block');
  }
  if (seek && articleAudio) {
    seek.value = '500';
    seek.dispatchEvent(new window.Event('change', { bubbles: true }));
    if (Math.abs(articleAudio.currentTime - 140.544) > 1) failures.push(`seeking to 50% did not move to the expected article time: ${articleAudio.currentTime}`);
    articleAudio.dispatchEvent(new window.Event('timeupdate'));
    const saved = JSON.parse(window.localStorage.getItem(`bareeq-audio-progress-v1:${importedArticleId}`) || 'null');
    if (saved?.voiceId !== 'cedar' || Math.abs(saved?.time - articleAudio.currentTime) > 0.1) failures.push('Cedar listening position is not saved with the selected voice');
  }
  const progress = Number(window.document.querySelector('[data-reading-progress]')?.getAttribute('aria-valuenow'));
  if (!(progress > 0 && progress <= 100)) failures.push(`article progress is invalid: ${progress}`);
  content.getBoundingClientRect = () => ({ top: -3000, bottom: 600, left: 0, right: 390, width: 390, height: 3600, x: 0, y: -3000, toJSON() { return this; } });
  window.scrollY = 3000;
  window.dispatchEvent(new window.Event('scroll'));
  if (!analyticsEvents.some(([command, name]) => command === 'event' && name === 'article_read_75')) failures.push('75% article reading event is not emitted after consent');
  const tocToggle = window.document.querySelector('[data-toc-toggle]');
  tocToggle?.click();
  if (tocToggle?.getAttribute('aria-expanded') !== 'true' || !window.document.querySelector('[data-article-toc]')?.classList.contains('is-open')) failures.push('mobile article TOC does not open');
  window.document.querySelector('[data-audio-stop]')?.click();
  if (window.localStorage.getItem(`bareeq-audio-progress-v1:${importedArticleId}`)) failures.push('explicit audio stop does not clear saved listening progress');
  dom.window.close();

  const resumeDom = createDom(html, 390);
  const resumeAudio = resumeDom.window.document.querySelector('[data-article-audio]');
  if (resumeAudio) {
    Object.defineProperty(resumeAudio, 'duration', { value: 281.088, configurable: true });
    Object.defineProperty(resumeAudio, 'currentTime', { value: 0, writable: true, configurable: true });
  }
  resumeDom.window.localStorage.setItem(`bareeq-audio-progress-v1:${importedArticleId}`, JSON.stringify({ voiceId: 'cedar', partIndex: 0, time: 42.25, updatedAt: Date.now() }));
  resumeDom.window.eval(audioCoreScript);
  resumeDom.window.eval(articleScript);
  resumeAudio?.dispatchEvent(new resumeDom.window.Event('loadedmetadata'));
  if (resumeDom.window.document.querySelector('[data-audio-voice]')?.value !== 'cedar' || Math.abs((resumeAudio?.currentTime || 0) - 42.25) > 0.1 || resumeDom.window.document.querySelector('[data-audio-play-label]')?.textContent !== 'متابعة الاستماع') failures.push('saved Cedar choice and listening position are not restored on a new page session');
  resumeDom.window.close();

  const expiredDom = createDom(html, 390);
  expiredDom.window.localStorage.setItem(`bareeq-audio-progress-v1:${importedArticleId}`, JSON.stringify({ voiceId: 'cedar', partIndex: 0, time: 88, updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 }));
  expiredDom.window.eval(audioCoreScript);
  expiredDom.window.eval(articleScript);
  if (expiredDom.window.localStorage.getItem(`bareeq-audio-progress-v1:${importedArticleId}`) || expiredDom.window.document.querySelector('[data-audio-play-label]')?.textContent !== 'ابدأ الاستماع') failures.push('listening progress older than 30 days is not expired and removed');
  expiredDom.window.close();
}

{
  const generatedArticleId = 'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء';
  const html = await readFile(path.join(root, 'posts', generatedArticleId, 'index.html'), 'utf8');
  const dom = createDom(html, 390);
  const listenButton = dom.window.document.querySelector('[data-reading-mode="listen"]');
  if (!listenButton?.disabled) {
    dom.window.eval(audioCoreScript);
    dom.window.eval(articleScript);
    const voiceSelect = dom.window.document.querySelector('[data-audio-voice]');
    const articleAudio = dom.window.document.querySelector('[data-article-audio]');
    if (voiceSelect?.disabled || voiceSelect?.options.length !== 2 || voiceSelect?.value !== 'cedar' || !articleAudio?.src.includes('cedar-part-')) failures.push('generated dual-voice player does not initialize with Cedar and Marin');
    if (articleAudio) Object.defineProperty(articleAudio, 'currentTime', { value: 2.5, writable: true, configurable: true });
    if (voiceSelect) {
      voiceSelect.value = 'marin';
      voiceSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      if (!articleAudio?.src.includes('marin-part-')) failures.push('switching to Marin does not change the generated MP3 source');
      if (dom.window.localStorage.getItem('bareeq-audio-voice-v1:openai') !== 'marin') failures.push('selected Marin voice is not saved in localStorage');
    }
  }
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

console.log('Interaction audit passed: header/search, menus, keyboard, drawer, theme, ticker, footer, analytics, article progress, Studio Cedar synchronization/seek, 30-day resume expiry, optional Cedar/Marin switching, filters, and search.');
