import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist');
const htmlFiles = [];
const failures = [];

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
  const attributes = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map((match) => match[1]);
  for (const value of attributes) {
    if (!value.startsWith('/') || value.startsWith('//')) continue;
    if (value.startsWith('/_astro/')) continue;
    if (!(await targetExists(value))) failures.push(`${relativeFile} -> ${value}`);
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

  const imagesWithoutAlt = [...html.matchAll(/<img\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => !/\balt=["'][^"']*["']/i.test(tag));
  if (imagesWithoutAlt.length) failures.push(`${relativeFile} -> ${imagesWithoutAlt.length} image(s) missing alt`);

  if (/\b(?:href|src)=["'](?:|#)["']/i.test(html)) failures.push(`${relativeFile} -> empty or hash-only href/src`);

  const mainHtml = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  const headingLevels = [...mainHtml.matchAll(/<h([1-6])\b/gi)].map((match) => Number(match[1]));
  for (let index = 1; index < headingLevels.length; index += 1) {
    if (headingLevels[index] > headingLevels[index - 1] + 1) {
      failures.push(`${relativeFile} -> heading order jumps H${headingLevels[index - 1]} to H${headingLevels[index]}`);
      break;
    }
  }
}

if (failures.length) {
  console.error(`Found ${failures.length} broken internal references:`);
  failures.slice(0, 100).forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`Checked ${htmlFiles.length} HTML files: links, headings, image alt text, IDs, buttons, ARIA targets, and empty targets passed.`);
