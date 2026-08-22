import { readFile, writeFile } from 'node:fs/promises';

const readinessPath = 'scripts/check-launch-readiness.mjs';
const readinessBefore = await readFile(readinessPath, 'utf8');
const readinessAfter = readinessBefore
  .replace(
    "if (pkg.version !== '4.21.1') failures.push(`Expected package version 4.21.1, got ${pkg.version}`);",
    "if (!['4.21.1', '4.21.2', '4.21.3', '4.21.4'].includes(pkg.version)) failures.push(`Expected supported package version 4.21.1–4.21.4, got ${pkg.version}`);",
  )
  .replace(
    "if (!['4.21.1', '4.21.2'].includes(pkg.version)) failures.push(`Expected package version 4.21.1 or 4.21.2, got ${pkg.version}`);",
    "if (!['4.21.1', '4.21.2', '4.21.3', '4.21.4'].includes(pkg.version)) failures.push(`Expected supported package version 4.21.1–4.21.4, got ${pkg.version}`);",
  )
  .replace(
    'Launch-readiness source audit passed: V4.21.1 package identity',
    'Launch-readiness source audit passed: V4.21.3 package identity',
  )
  .replace(
    'Launch-readiness source audit passed: V4.21.2 package identity',
    'Launch-readiness source audit passed: V4.21.3 package identity',
  )
  .replace(
    "if (!['4.21.1', '4.21.2', '4.21.3'].includes(pkg.version)) failures.push(`Expected supported package version 4.21.1–4.21.3, got ${pkg.version}`);",
    "if (!['4.21.1', '4.21.2', '4.21.3', '4.21.4'].includes(pkg.version)) failures.push(`Expected supported package version 4.21.1–4.21.4, got ${pkg.version}`);",
  )
  .replace(
    'Launch-readiness source audit passed: V4.21.3 package identity',
    'Launch-readiness source audit passed: V4.21.4 package identity',
  );
if (!readinessAfter.includes("['4.21.1', '4.21.2', '4.21.3', '4.21.4'].includes(pkg.version)")) {
  throw new Error('V4.21.2: launch-readiness version gate was not updated.');
}
if (readinessAfter !== readinessBefore) await writeFile(readinessPath, readinessAfter);

const [site, startHere, article, searchPage, searchScript, saved, about, category, seriesPage] = await Promise.all([
  readFile('src/config/site.ts', 'utf8'),
  readFile('src/pages/start-here.astro', 'utf8'),
  readFile('src/pages/posts/[id].astro', 'utf8'),
  readFile('src/pages/search.astro', 'utf8'),
  readFile('public/scripts/search.js', 'utf8'),
  readFile('src/pages/saved.astro', 'utf8'),
  readFile('src/content/pages/about.md', 'utf8'),
  readFile('src/pages/category/[slug].astro', 'utf8'),
  readFile('src/pages/series/[slug].astro', 'utf8'),
]);

for (const token of ['signaturePosts', 'promise:', 'order:']) {
  if (!site.includes(token)) throw new Error(`V4.21.2: site config missing ${token}`);
}
for (const token of ['getSignaturePost', 'مقال توقيع من كل مسار', 'اقرأ أو استمع أو لخّص']) {
  if (!startHere.includes(token)) throw new Error(`V4.21.2: start-here missing ${token}`);
}
for (const token of ['bareeqAddition', 'bareeq-addition', 'series-path', 'getNextInSeries']) {
  if (article.includes(token)) throw new Error(`V4.21.2: paused article-layer experiment is active: ${token}`);
}
if (!searchPage.includes('postSearchExcerpt') || !searchScript.includes('item.excerpt')) {
  throw new Error('V4.21.2: search does not include article-body excerpts.');
}
if (!saved.includes('noindex') || saved.includes('<main ')) {
  throw new Error('V4.21.2: saved page must be noindex and must not nest a second main.');
}
if (about.includes('قراءات وملخصات')) throw new Error('V4.21.2: about page still calls book pieces summaries.');
if (!about.includes('قراءات تحريرية')) throw new Error('V4.21.2: about page is missing editorial-reading wording.');
if (!category.includes('category-signature') || !seriesPage.includes('item.promise')) {
  throw new Error('V4.21.2: category/series magazine-path markup is missing.');
}

console.log('V4.21.2 preparation passed: useful editorial navigation/search refinements remain, while intrusive article-layer experiments stay disabled.');
