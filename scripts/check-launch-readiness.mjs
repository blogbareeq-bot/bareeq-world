import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const failures = [];
const read = (file) => readFile(path.join(root, file), 'utf8');

const [pkgText, home, intro, postPage, postsLib, sitemap, seriesPage, siteConfig, baseLayout, css, middleware, manifestText] = await Promise.all([
  read('package.json'),
  read('src/pages/index.astro'),
  read('src/components/HomeIntro.astro'),
  read('src/pages/posts/[id].astro'),
  read('src/lib/posts.ts'),
  read('src/pages/sitemap.xml.ts'),
  read('src/pages/series/[slug].astro'),
  read('src/config/site.ts'),
  read('src/layouts/BaseLayout.astro'),
  read('src/styles/global.css'),
  read('functions/_middleware.js'),
  read('public/manifest.webmanifest')
]);

const pkg = JSON.parse(pkgText);
/*
V4.19 preparation compatibility marker.
prepare-v4190.mjs is still part of the V4.20 build because it applies the
V4.19 baseline transformations before prepare-v4200.mjs. This exact inert
source marker lets that idempotent preparer recognize an already-newer gate:
if (pkg.version !== '4.19.0') failures.push(`Expected package version 4.19.0, got ${pkg.version}`);
*/
if (!['4.21.1', '4.21.2', '4.21.3', '4.21.4', '4.21.5', '4.21.6'].includes(pkg.version)) failures.push(`Expected supported package version 4.21.1–4.21.6, got ${pkg.version}`);

// Homepage identity/heading hierarchy.
if (!/<h1\b[^>]*>عالم بريق — نافذتك إلى المعرفة<\/h1>/u.test(intro)) failures.push('Homepage identity H1 is missing or does not use the canonical brand promise.');
if (/<h2\b[^>]*id=["']home-intro-title/u.test(intro)) failures.push('Homepage identity still uses H2 instead of H1.');
if (!/<h2>\{featured\.data\.title\}<\/h2>/u.test(home)) failures.push('Homepage latest-article hero must be H2 under the brand H1.');
if (/<h1>\{featured\.data\.title\}<\/h1>/u.test(home)) failures.push('Homepage article hero still owns the page H1.');
if (!home.includes('post.id !== featured?.id')) failures.push('Homepage secondary grids must exclude the current hero article.');

// Social sharing regression: Arabic URL must be encoded once, not a percent-encoded URL encoded again.
if (!postPage.includes('encodeURIComponent(decodeURI(articleUrl))')) failures.push('Arabic social share URL is not normalized before query encoding.');
if (/const shareUrl\s*=\s*encodeURIComponent\(articleUrl\)/.test(postPage)) failures.push('Broken double-encoding share pattern remains.');

// Breadcrumb + TOC scope.
if (!postPage.includes('const toc = headings.filter((heading) => heading.depth === 2);')) failures.push('Article TOC must be limited to H2 headings.');
if (!postPage.includes('class="breadcrumb-current"') || postPage.includes('aria-current="page">المقال</span>')) failures.push('Visible article breadcrumb must end with a compact form of the real article title.');

// Related content must have topic evidence, not category-only fallback.
if (!postsLib.includes('const primary = ranked') || !postsLib.includes('sameSeries || sharedTags > 0') || !postsLib.includes('ranked.filter(x=>x.sameCategory)')) failures.push('V4.19 related-post scoring must prioritize intent matches before same-category fallback.');

// Series sitemap/indexing policy.
if (!siteConfig.includes('minPostsToIndexSeries: 2')) failures.push('Separate series indexing threshold is missing.');
if (!seriesPage.includes('archivePolicy.minPostsToIndexSeries')) failures.push('Series pages do not use the dedicated indexing threshold.');
if (!sitemap.includes('archivePolicy.minPostsToIndexSeries')) failures.push('Sitemap generator does not use the dedicated series indexing threshold.');

// Search/branding structured data and body font stability.
for (const token of ["'@type': 'SearchAction'", 'search/?q={search_term_string}', "'query-input': 'required name=search_term_string'"]) {
  if (!baseLayout.includes(token)) failures.push(`Website SearchAction missing token: ${token}`);
}
if (!baseLayout.includes('ibmBodyFont') || !baseLayout.includes('href={ibmBodyFont}')) failures.push('IBM Plex Arabic 400 body font is not preloaded.');

// Responsive launch fixes.
const mobile900 = css.match(/@media \(max-width:900px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
const mobile700 = css.match(/@media \(max-width:700px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
const mobile420 = css.match(/@media \(max-width:420px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
const mobile800 = css.match(/@media \(max-width:800px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
if (!mobile900.includes('.category-strip{position:relative;top:auto;')) failures.push('Category strip remains sticky on tablet/mobile.');
if (!mobile900.includes('.category-strip-inner{display:grid') || !mobile900.includes('grid-template-columns:repeat(5,minmax(0,1fr))') || mobile900.includes('overflow-x:auto')) failures.push('Category navigation is not the approved five-card non-scrolling layout at <=900px.');
if (!mobile700.includes('grid-template-columns:repeat(2,minmax(0,1fr))') || !mobile700.includes('.category-nav-item:last-child{grid-column:1/-1}')) failures.push('Phone category navigation is not the approved two-column layout with the final full-width card.');
if (!mobile900.includes('.category-mobile-link{display:flex')) failures.push('Category mobile links are hidden at <=900px.');
if (!mobile800.includes('.desktop-nav{display:none}')) failures.push('Desktop navigation breakpoint was not moved to <=800px.');
if (css.match(/@media \(max-width:1000px\) \{([\s\S]*?)\n\}/)?.[1]?.includes('.desktop-nav{display:none}')) failures.push('Desktop nav still disappears prematurely at <=1000px.');
if (!mobile420.includes('-webkit-line-clamp:1') || mobile420.includes('.hero-content p{display:none}')) failures.push('Hero description must remain as a compact one-line excerpt on small phones.');

// HTML CORS hardening.
if (!middleware.includes("contentType.includes('text/html')") || !middleware.includes("headers.delete('Access-Control-Allow-Origin')")) failures.push('HTML wildcard CORS cleanup is missing from middleware.');

// PWA icon completeness.
const manifest = JSON.parse(manifestText);
for (const size of [192, 512]) {
  const item = manifest.icons?.find((icon) => icon.sizes === `${size}x${size}` && icon.type === 'image/png');
  if (!item) failures.push(`PWA manifest is missing ${size}x${size} PNG icon.`);
  else {
    try { await stat(path.join(root, 'public', item.src.replace(/^\//, ''))); }
    catch { failures.push(`PWA icon file is missing: ${item.src}`); }
  }
}

if (failures.length) {
  console.error(`Launch-readiness source audit found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Launch-readiness source audit passed: V4.21.6 package identity, heading identity, single-encoded Arabic sharing, H2-only TOC, real breadcrumbs, intent-based related posts, complete series sitemap policy, SearchAction, body-font preload, visible wrapped mobile categories, HTML CORS hardening, and PWA icons.');
