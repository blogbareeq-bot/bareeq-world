import { readFile } from 'node:fs/promises';

const [header, logo, css] = await Promise.all([
  readFile('src/components/Header.astro', 'utf8'),
  readFile('src/components/Logo.astro', 'utf8'),
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
  'data-theme-toggle',
  'data-reading-list-count',
  'data-ticker',
  '<CategoryStrip posts={allPosts} />',
]);
requireAll('Logo', logo, [
  'class="brand-mark"',
  '{site.brand}',
  '{site.tagline}',
  'aria-label={`${site.name} — الرئيسية`}',
]);
requireAll('Desktop design-one CSS', css, [
  'التصميم الأول المعتمد',
  '.main-header::after{z-index:0;right:clamp(255px,20vw,390px)',
  '.main-header::before{z-index:1;right:clamp(270px,21vw,410px)',
  'background:linear-gradient(115deg,#0a2342 0%,#0b4260 58%,#075675 100%)',
  '.main-header>.brand-logo{width:clamp(240px,19vw,360px)',
  '.main-header>.brand-logo .brand-mark{width:58px;height:58px',
  '.desktop-nav a{position:relative;min-height:48px',
  'color:#e7eef5',
  '.ticker{overflow:hidden;color:var(--navy-900);border-bottom:1px solid #d6e0e9;background:#f8fafc}',
  '.category-strip{position:sticky;top:104px',
]);

const tablet = css.match(/@media \(min-width:801px\) and \(max-width:1100px\) \{([\s\S]*?)\n\}/)?.[1] || '';
requireAll('Tablet design-one CSS', tablet, [
  '.main-header>.brand-logo{width:190px',
  '.desktop-nav a{padding-inline:9px',
]);
const mobile = css.match(/@media \(max-width:800px\) \{([\s\S]*?)\n\}/)?.[1] || '';
requireAll('Mobile design-one CSS', mobile, [
  '.desktop-nav{display:none}',
  '.mobile-menu-button{display:inline-grid}',
  '.main-header::before,.main-header::after{display:none}',
  '.main-header>.brand-logo{width:auto',
  '.main-header .icon-button,.main-header .header-search-link{color:var(--text-muted)}',
]);

if (/7fdc29cf|\.png["']/.test(header)) failures.push('Header embeds the concept screenshot instead of the native responsive logo/components.');

if (failures.length) {
  console.error(`V4.21.1 header design audit found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('V4.21.1 design-one header audit passed: native high-clarity logo panel, navy/teal wave, accessible navigation/search/actions, light ticker, floating categories, tablet compression, and simplified mobile fallback.');
