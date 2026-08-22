import { readFile } from 'node:fs/promises';

const [header, logo, layout, css] = await Promise.all([
  readFile('src/components/Header.astro', 'utf8'),
  readFile('src/components/Logo.astro', 'utf8'),
  readFile('src/layouts/BaseLayout.astro', 'utf8'),
  readFile('src/styles/global.css', 'utf8'),
]);

const failures = [];
const requireAll = (label, source, tokens) => {
  for (const token of tokens) if (!source.includes(token)) failures.push(`${label}: missing ${token}`);
};

requireAll('Header', header, [
  'header-design-one',
  'data-header-design="one"',
  '<Logo />',
  'aria-label="التنقل الرئيسي"',
  'class="header-search-link"',
  'header-reading-list',
  'header-theme-toggle',
  'drawer-utilities',
  'data-ticker',
  '<CategoryStrip posts={allPosts} />',
]);
if ((header.match(/data-theme-toggle/g) || []).length < 2) failures.push('Header: desktop and drawer theme controls are both required.');
requireAll('Theme controller', layout, [
  "const themeToggles = [...document.querySelectorAll('[data-theme-toggle]')]",
  'themeToggles.forEach((themeToggle)',
]);
requireAll('Logo', logo, [
  'class="brand-mark"',
  '{site.brand}',
  '{site.tagline}',
  'aria-label={`${site.name} — الرئيسية`}',
]);
requireAll('Desktop reference CSS', css, [
  'التصميم الأول المرجعي',
  '.main-header{position:relative;isolation:isolate;min-height:118px',
  '.main-header::after{z-index:0;right:clamp(286px,21.5vw,410px)',
  '.main-header::before{z-index:1;right:clamp(304px,22.7vw,434px)',
  'background:linear-gradient(112deg,#071d39 0%,#0a3857 58%,#087277 100%)',
  '.main-header>.brand-logo{width:clamp(284px,22vw,410px)',
  '.main-header>.brand-logo .brand-mark{width:68px;height:68px',
  '.category-strip-inner{max-width:1360px;min-height:66px;display:grid;grid-template-columns:repeat(5,minmax(0,1fr))',
  '.category-nav-trigger,.category-mobile-link{width:100%;min-height:66px',
]);

const mobile = css.match(/@media \(max-width:800px\) \{([\s\S]*?)\n\}/)?.[1] || '';
requireAll('Mobile reference CSS', mobile, [
  '.desktop-nav{display:none}',
  '.mobile-menu-button{display:inline-grid}',
  'background:linear-gradient(112deg,#071d39 0%,#0a3857 58%,#087277 100%)',
  '.main-header::before,.main-header::after{display:block',
  '.main-header::after{z-index:0;right:-14px;width:62%',
  '.main-header::before{z-index:1;right:-14px;width:58%;background:#fff',
  '.main-header>.brand-logo{width:58%;min-height:92px',
  '.header-reading-list,.header-theme-toggle{display:none}',
  'color:#fff;border:1px solid rgba(213,230,239,.72)',
]);
if (mobile.includes('.main-header::before,.main-header::after{display:none}')) failures.push('Mobile reference CSS still deletes the approved navy/teal wave.');

const compact = css.match(/@media \(max-width:700px\) \{([\s\S]*?)\n\}/)?.[1] || '';
requireAll('Compact reference CSS', compact, [
  '.category-strip-inner{width:calc(100% - 24px);min-height:0;grid-template-columns:repeat(2,minmax(0,1fr))',
  '.category-nav-item:last-child{grid-column:1/-1}',
  '.ticker-label-full,.ticker-title-mobile{display:inline}',
  '.ticker-label-mobile,.ticker-title-full{display:none}',
]);

if (/7fdc29cf|\.png["']/.test(header)) failures.push('Header embeds a concept screenshot instead of native responsive components.');

if (failures.length) {
  console.error(`Header reference audit found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Header reference audit passed: approved desktop wave/logo panel, mobile navy wave, accessible utilities, moving ticker, and separate category cards are present.');
