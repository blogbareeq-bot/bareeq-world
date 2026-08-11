import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve('dist');
const htmlFiles = [];
const failures = [];
const indexableTitles = new Map();
const indexableCanonicals = new Map();
const pagesByPath = new Map();

async function walk(directory) {
  for (const name of await readdir(directory)) {
    const full = path.join(directory, name);
    const info = await stat(full);
    if (info.isDirectory()) await walk(full);
    else if (name.endsWith('.html')) htmlFiles.push(full);
  }
}

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function stripTags(value) {
  return value.replace(/<[^>]+>/g, '').replace(/&(?:amp|quot|#39|lt|gt);/g, ' ').replace(/\s+/g, ' ').trim();
}

function classTokenCount(html, token) {
  return [...html.matchAll(/\bclass=["']([^"']*)["']/gi)]
    .filter((match) => match[1].split(/\s+/).includes(token)).length;
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function targetExists(urlPath) {
  const clean = decode(urlPath.split('#')[0].split('?')[0]);
  if (!clean || clean === '/') return exists(path.join(root, 'index.html'));
  const relative = clean.replace(/^\/+/, '');
  const candidates = clean.endsWith('/')
    ? [path.join(root, relative, 'index.html')]
    : [path.join(root, relative), path.join(root, `${relative}.html`), path.join(root, relative, 'index.html')];
  for (const candidate of candidates) if (await exists(candidate)) return true;
  return false;
}

await walk(root);
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const relativeFile = path.relative(root, file);
  const pagePath = relativeFile === 'index.html'
    ? '/'
    : relativeFile === '404.html' ? '/404'
      : `/${relativeFile.replace(/\/index\.html$/, '/').replace(/\.html$/, '')}`;
  pagesByPath.set(decode(pagePath), { html, relativeFile });

  const attributes = [...html.matchAll(/\b(?:href|src|data-src)=["']([^"']+)["']/g)].map((match) => match[1]);
  const srcsetUrls = [...html.matchAll(/\bsrcset=["']([^"']+)["']/g)]
    .flatMap((match) => match[1].split(',').map((part) => part.trim().split(/\s+/)[0]));
  for (const value of [...attributes, ...srcsetUrls]) {
    if (!value.startsWith('/') || value.startsWith('//')) continue;
    if (!(await targetExists(value))) failures.push(`${relativeFile} -> missing internal target ${value}`);
  }

  const h1Count = (html.match(/<h1\b/gi) ?? []).length;
  if (h1Count !== 1) failures.push(`${relativeFile} -> expected exactly one H1, found ${h1Count}`);

  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length) failures.push(`${relativeFile} -> duplicate IDs: ${duplicateIds.join(', ')}`);

  const buttonsWithoutType = [...html.matchAll(/<button\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => !/\btype=["'](?:button|submit|reset)["']/i.test(tag));
  if (buttonsWithoutType.length) failures.push(`${relativeFile} -> ${buttonsWithoutType.length} button(s) missing an explicit type`);

  const missingControlledTargets = [...html.matchAll(/\baria-controls=["']([^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((id) => !ids.includes(id));
  if (missingControlledTargets.length) failures.push(`${relativeFile} -> aria-controls target(s) missing: ${missingControlledTargets.join(', ')}`);

  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const imagesWithoutAlt = images.filter((tag) => !/\balt=["'][^"']*["']/i.test(tag));
  const imagesWithoutDimensions = images.filter((tag) => !/\bwidth=["']\d+["']/i.test(tag) || !/\bheight=["']\d+["']/i.test(tag));
  if (imagesWithoutAlt.length) failures.push(`${relativeFile} -> ${imagesWithoutAlt.length} image(s) missing alt`);
  if (imagesWithoutDimensions.length) failures.push(`${relativeFile} -> ${imagesWithoutDimensions.length} image(s) missing width/height`);

  const inlineStyles = (html.match(/\sstyle=["'][^"']*["']/gi) ?? []).length;
  if (inlineStyles) failures.push(`${relativeFile} -> ${inlineStyles} inline style attribute(s) blocked by the strict CSP`);

  const consentDialogs = (html.match(/\bdata-analytics-consent(?:\s|>)/gi) ?? []).length;
  if (consentDialogs !== 1) failures.push(`${relativeFile} -> expected one analytics consent dialog, found ${consentDialogs}`);
  if (!/\bdata-measurement-id=["']G-N3NQMF7RHN["']/i.test(html)) failures.push(`${relativeFile} -> GA4 measurement ID is missing from the consent component`);
  if (/<script\b[^>]*\bsrc=["']https:\/\/www\.googletagmanager\.com/i.test(html)) failures.push(`${relativeFile} -> Google tag loads before visitor consent`);
  if (/\bdata-analytics-consent[^>]*\brole=["']dialog["']/i.test(html)) failures.push(`${relativeFile} -> non-modal analytics notice uses an incompatible dialog role`);
  if (!/<link\b[^>]*\brel=["']preload["'][^>]*\bas=["']font["'][^>]*\btype=["']font\/woff2["']/i.test(html)) failures.push(`${relativeFile} -> Cairo heading font is not preloaded`);

  const cardMediaBlocks = [...html.matchAll(/<a\b[^>]*class=["'][^"']*post-card-media[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const [, block] of cardMediaBlocks) {
    const imageTag = block.match(/<img\b[^>]*>/i)?.[0];
    if (!imageTag) continue;
    if (!/\bsrc=["']\/images\/thumbnails\//i.test(imageTag)) failures.push(`${relativeFile} -> post card does not use a dedicated thumbnail`);
    const width = Number(imageTag.match(/\bwidth=["'](\d+)["']/i)?.[1]);
    const height = Number(imageTag.match(/\bheight=["'](\d+)["']/i)?.[1]);
    if (width * 9 !== height * 16) failures.push(`${relativeFile} -> post card image dimensions are not 16:9 (${width}x${height})`);
  }

  const highPriorityImages = (html.match(/<img\b[^>]*\bfetchpriority=["']high["'][^>]*>/gi) ?? []).length;
  if (highPriorityImages > 1) failures.push(`${relativeFile} -> ${highPriorityImages} high-priority images; maximum is one`);

  const imagePreloads = [...html.matchAll(/<link\b[^>]*\brel=["']preload["'][^>]*\bas=["']image["'][^>]*>/gi)].map((match) => match[0]);
  for (const preload of imagePreloads) {
    if (!/\bimagesrcset=["'][^"']+["']/i.test(preload) || !/\bimagesizes=["'][^"']+["']/i.test(preload)) {
      failures.push(`${relativeFile} -> responsive image preload is missing imagesrcset/imagesizes`);
    }
  }

  if (/\b(?:href|src)=["'](?:|#)["']/i.test(html)) failures.push(`${relativeFile} -> empty or hash-only href/src`);

  const mainHtml = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  const headingLevels = [...mainHtml.matchAll(/<h([1-6])\b/gi)].map((match) => Number(match[1]));
  for (let index = 1; index < headingLevels.length; index += 1) {
    if (headingLevels[index] > headingLevels[index - 1] + 1) {
      failures.push(`${relativeFile} -> heading order jumps H${headingLevels[index - 1]} to H${headingLevels[index]}`);
      break;
    }
  }

  const title = stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const description = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1]?.trim() ?? '';
  const robots = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']*)["']/i)?.[1] ?? '';
  const canonical = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i)?.[1] ?? '';
  const noindex = /\bnoindex\b/i.test(robots);
  if (!title) failures.push(`${relativeFile} -> missing title`);
  if (!description) failures.push(`${relativeFile} -> missing meta description`);
  if (!canonical) failures.push(`${relativeFile} -> missing canonical URL`);
  if (!noindex) {
    if (title.length > 70) failures.push(`${relativeFile} -> indexable title is ${title.length} characters (maximum 70)`);
    if (description.length < 70 || description.length > 160) failures.push(`${relativeFile} -> indexable description is ${description.length} characters (required 70-160)`);
    if (indexableTitles.has(title)) failures.push(`${relativeFile} -> duplicate indexable title with ${indexableTitles.get(title)}`);
    else indexableTitles.set(title, relativeFile);
    if (indexableCanonicals.has(canonical)) failures.push(`${relativeFile} -> duplicate canonical with ${indexableCanonicals.get(canonical)}`);
    else indexableCanonicals.set(canonical, relativeFile);
  }

  const modifiedTime = html.match(/<meta\s+property=["']article:modified_time["']\s+content=["']([^"']+)["']/i)?.[1];
  if (modifiedTime && new Date(modifiedTime).valueOf() > Date.now() + 5 * 60 * 1000) failures.push(`${relativeFile} -> article modified time is in the future: ${modifiedTime}`);

  const executableInlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs, body]) => !/\bsrc=/i.test(attrs) && !/type=["'](?:application\/ld\+json|application\/json)["']/i.test(attrs) && body.trim());
  if (executableInlineScripts.length) failures.push(`${relativeFile} -> ${executableInlineScripts.length} executable inline script(s)`);

  if (relativeFile.startsWith(`posts${path.sep}`)) {
    // Locate the article body using its dedicated data attribute rather than
    // assuming any HTML attribute order. ReadingModes adds id/data attributes
    // to this element, and Astro may serialize attributes in a different order.
    const articleOpen = html.match(/<div\b[^>]*\bdata-article-content\b[^>]*>/i);
    let article = '';
    if (articleOpen?.index !== undefined) {
      const articleStart = articleOpen.index + articleOpen[0].length;
      const footerMatch = html.slice(articleStart).match(/<footer\b(?=[^>]*\bclass=["'][^"']*\barticle-footer\b[^"']*["'])/i);
      const articleEnd = footerMatch?.index !== undefined ? articleStart + footerMatch.index : -1;
      if (articleEnd > articleStart) article = html.slice(articleStart, articleEnd);
    }
    if (!/href=["']https?:\/\//i.test(article)) failures.push(`${relativeFile} -> published knowledge article has no clickable external source`);
    if (!/href=["']\/(?:posts|start-here)\//i.test(article)) failures.push(`${relativeFile} -> published article has no contextual internal link`);
    if (!/<a\b[^>]*class=["'][^"']*article-author[^"']*["'][^>]*href=["']\/team\/["'][^>]*rel=["']author["']/i.test(html)) {
      failures.push(`${relativeFile} -> article byline does not link to the transparent team profile`);
    }
    if (/النسخة الأولى|النسخة الثانية|شاركنا في التعليقات|اشترك في القائمة البريدية/i.test(article)) failures.push(`${relativeFile} -> contains internal/editorial or unavailable-feature copy`);
  }
}

const generatedPostPages = [...pagesByPath.keys()].filter((pagePath) => pagePath.startsWith('/posts/'));
const retiredWelcomePath = '/posts/مرحبا-بك-في-بريق-حيث-تبدا-رحلتك-نحو-المعرفه-ببساطه/';
if (pagesByPath.has(retiredWelcomePath)) failures.push(`${retiredWelcomePath} -> retired welcome article must not be generated`);

const sitemap = await readFile(path.join(root, 'sitemap.xml'), 'utf8');
for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  const pathname = decode(new URL(match[1]).pathname);
  const page = pagesByPath.get(pathname);
  if (!page) failures.push(`sitemap.xml -> missing generated page ${pathname}`);
  else if (/content=["']noindex,/i.test(page.html)) failures.push(`sitemap.xml -> includes noindex page ${pathname}`);
}

for (const stalePath of ['admin/index.html', 'images/bareeq-logo-official.png', 'images/bareeq-logo-display.png']) {
  if (await exists(path.join(root, stalePath))) failures.push(`stale launch artifact must not exist: ${stalePath}`);
}

const headers = await readFile(path.join(root, '_headers'), 'utf8');
for (const requiredHeader of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy']) {
  if (!headers.includes(requiredHeader)) failures.push(`_headers -> missing ${requiredHeader}`);
}
for (const analyticsSource of ['https://www.googletagmanager.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com']) {
  if (!headers.includes(analyticsSource)) failures.push(`_headers -> missing consented analytics CSP source ${analyticsSource}`);
}
if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test((await Promise.all(htmlFiles.map((file) => readFile(file, 'utf8')))).join(''))) {
  failures.push('external Google Fonts request remains in generated HTML');
}

const privacyHtml = pagesByPath.get('/privacy/')?.html ?? '';
if (!/id=["']google-analytics["']/i.test(privacyHtml) || !/متابعة دون قياس|سحب الموافقة/i.test(privacyHtml) || !/75%|60 ثانية/i.test(privacyHtml)) {
  failures.push('privacy page -> optional GA4 measurement and withdrawal choice are not documented');
}

const homeHtml = pagesByPath.get('/')?.html ?? '';
const homeIntroCount = classTokenCount(homeHtml, 'home-intro');
if (homeIntroCount !== 1) failures.push(`homepage -> expected one identity introduction, found ${homeIntroCount}`);
if (homeHtml.indexOf('home-intro') > homeHtml.indexOf('hero-editorial')) failures.push('homepage -> identity introduction must appear before the editorial hero');
if (/\bclosing-cta\b/i.test(homeHtml)) failures.push('homepage -> retired duplicated closing introduction remains');
if (classTokenCount(homeHtml, 'category-strip') !== 1) failures.push('homepage -> category navigation must appear exactly once in the header');
if (classTokenCount(homeHtml, 'category-article-count') !== 5) failures.push('homepage -> every desktop category dropdown must expose its published article count');
if (classTokenCount(homeHtml, 'mobile-category-count') !== 5) failures.push('homepage -> every mobile category group must expose its published article count');
const footerHtml = homeHtml.match(/<footer\b[\s\S]*?<\/footer>/i)?.[0] ?? '';
if (/href=["']\/category\//i.test(footerHtml)) failures.push('homepage -> category navigation is repeated in the footer');
for (const categoryPath of ['/category/atyaf-al-aql/', '/category/bareeq-books/', '/category/window-on-world/', '/category/future-now/', '/category/simply/']) {
  const categoryHtml = pagesByPath.get(categoryPath)?.html ?? '';
  if (classTokenCount(categoryHtml, 'category-introduction') !== 1) {
    failures.push(`${categoryPath} -> missing unique category introduction`);
  }
}

const redirectRules = await readFile(path.join(root, '_redirects'), 'utf8');
const postSourceRoot = path.resolve('src', 'content', 'posts');
const postSourceFiles = (await readdir(postSourceRoot)).filter((file) => /\.(?:md|mdx)$/i.test(file));
if (generatedPostPages.length !== postSourceFiles.length) failures.push(`posts -> expected ${postSourceFiles.length} generated article pages, found ${generatedPostPages.length}`);
for (const name of postSourceFiles) {
  const source = await readFile(path.join(postSourceRoot, name), 'utf8');
  const legacyPath = source.match(/^legacyPath:\s*["']([^"']+)["']/m)?.[1];
  if (legacyPath && !redirectRules.split(/\r?\n/).some((line) => line.trim().startsWith(`${legacyPath} `))) {
    failures.push(`_redirects -> missing Blogger legacy path ${legacyPath}`);
  }
}
if (!/^\/feeds\/posts\/default\s+\/rss\.xml\s+301\s*$/m.test(redirectRules)) failures.push('_redirects -> missing Blogger feed redirect');
if (!/^\/2026\/07\/blog-post\.html\s+\/start-here\/\s+301\s*$/m.test(redirectRules)) failures.push('_redirects -> retired Blogger welcome URL must point to /start-here/');
if (!/^\/posts\/مرحبا-بك-في-بريق-حيث-تبدا-رحلتك-نحو-المعرفه-ببساطه\/\s+\/start-here\/\s+301\s*$/m.test(redirectRules)) failures.push('_redirects -> retired welcome article URL must point to /start-here/');

const thumbnailDirectory = path.join(root, 'images', 'thumbnails');
const thumbnailFiles = (await readdir(thumbnailDirectory)).filter((name) => name.endsWith('.webp'));
const expectedThumbnailFiles = postSourceFiles.length * 4;
if (thumbnailFiles.length !== expectedThumbnailFiles) failures.push(`images/thumbnails -> expected ${expectedThumbnailFiles} generated files, found ${thumbnailFiles.length}`);
for (const name of thumbnailFiles) {
  const expectedWidth = Number(name.match(/-(320|640|960|1280)\.webp$/)?.[1]);
  const metadata = await sharp(path.join(thumbnailDirectory, name)).metadata();
  const expectedHeight = Math.round(expectedWidth * 9 / 16);
  if (!expectedWidth || metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
    failures.push(`images/thumbnails/${name} -> expected ${expectedWidth || '?'}x${expectedHeight || '?'}, found ${metadata.width}x${metadata.height}`);
  }
}

if (failures.length) {
  console.error(`Found ${failures.length} production audit failure(s):`);
  failures.slice(0, 150).forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`Checked ${htmlFiles.length} HTML files: navigation, semantics, accessibility, SEO, images, scripts, sources, sitemap, security, and stale artifacts passed.`);
