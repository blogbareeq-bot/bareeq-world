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
  const attributes = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map((match) => match[1]);
  for (const value of attributes) {
    if (!value.startsWith('/') || value.startsWith('//')) continue;
    if (value.startsWith('/_astro/')) continue;
    if (!(await targetExists(value))) failures.push(`${path.relative(root, file)} -> ${value}`);
  }
}

if (failures.length) {
  console.error(`Found ${failures.length} broken internal references:`);
  failures.slice(0, 100).forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`Checked ${htmlFiles.length} HTML files: no broken internal references found.`);
