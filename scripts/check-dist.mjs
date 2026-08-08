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

  if (relativeFile.startsWith(`posts${path.sep}`) && !relativeFile.includes('مرحبا-بك-في-بريق')) {
    const article = html.match(/<div class="article-content prose"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ?? '';
    if (!/href=["']https?:\/\//i.test(article)) failures.push(`${relativeFile} -> published knowledge article has no clickable external source`);
    if (/النسخة الأولى|النسخة الثانية|شاركنا في التعليقات|اشترك في القائمة البريدية/i.test(article)) failures.push(`${relativeFile} -> contains internal/editorial or unavailable-feature copy`);
  }
}

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
if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test((await Promise.all(htmlFiles.map((file) => readFile(file, 'utf8')))).join(''))) {
  failures.push('external Google Fonts request remains in generated HTML');
}

const redirectRules = await readFile(path.join(root, '_redirects'), 'utf8');
const postSourceRoot = path.resolve('src', 'content', 'posts');
for (const name of (await readdir(postSourceRoot)).filter((file) => /\.(?:md|mdx)$/i.test(file))) {
  const source = await readFile(path.join(postSourceRoot, name), 'utf8');
  const legacyPath = source.match(/^legacyPath:\s*["']([^"']+)["']/m)?.[1];
  if (legacyPath && !redirectRules.split(/\r?\n/).some((line) => line.trim().startsWith(`${legacyPath} `))) {
    failures.push(`_redirects -> missing Blogger legacy path ${legacyPath}`);
  }
}
if (!/^\/feeds\/posts\/default\s+\/rss\.xml\s+301\s*$/m.test(redirectRules)) failures.push('_redirects -> missing Blogger feed redirect');

const thumbnailDirectory = path.join(root, 'images', 'thumbnails');
const thumbnailFiles = (await readdir(thumbnailDirectory)).filter((name) => name.endsWith('.webp'));
if (thumbnailFiles.length !== 32) failures.push(`images/thumbnails -> expected 32 generated files, found ${thumbnailFiles.length}`);
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
