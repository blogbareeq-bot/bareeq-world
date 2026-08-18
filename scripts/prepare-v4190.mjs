import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const changed = ["intuition-first-impression-decisions-signature", "اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا", "كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار", "عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء", "كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه", "اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا", "لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون"];
const changedCsv = changed.join(',');

async function patchFile(file, mutate) {
  const before = await readFile(file, 'utf8');
  const after = mutate(before);
  if (after === before) return false;
  await writeFile(file, after);
  return true;
}

await patchFile('public/_redirects', (source) => {
  const rules = [
    '/posts/%D8%A7%D9%84%D8%AA%D8%B6%D8%AE%D9%85-%D8%A7%D9%84%D9%85%D8%A7%D9%84%D9%8A-%D8%A8%D8%A8%D8%B3%D8%A7%D8%B7%D8%A9/ /posts/altadakhom-explained-simply/ 301!',
    '/posts/%D8%A7%D9%84%D9%84%D8%BA%D8%A9-%D9%86%D9%81%D9%88%D8%B0-%D8%AC%D9%8A%D9%88%D8%B3%D9%8A%D8%A7%D8%B3%D9%8A/ /posts/language-soft-power-politics/ 301!'
  ];
  for (const rule of rules) if (!source.includes(rule)) source = `# V4.19.0 canonical post redirects\n${rule}\n${source}`;
  return source;
});

await patchFile('src/lib/posts.ts', (source) => {
  if (source.includes('const primary = ranked')) return source;
  const oldFn = /export function getRelatedPosts\([\s\S]*?\n}\n\nexport function absoluteUrl/;
  const newFn = `export function getRelatedPosts(post: Post, posts: Post[], limit = 3): Post[] {\n  const ranked = posts\n    .filter((candidate) => candidate.id !== post.id)\n    .map((candidate) => {\n      const sharedTags = candidate.data.tags.filter((tag) => post.data.tags.includes(tag)).length;\n      const sameSeries = Boolean(post.data.seriesSlug && candidate.data.seriesSlug === post.data.seriesSlug);\n      const sameCategory = candidate.data.categorySlug === post.data.categorySlug;\n      const intentScore = (sameSeries ? 8 : 0) + (sharedTags * 3) + (sameCategory ? 1 : 0);\n      return { candidate, sharedTags, sameSeries, sameCategory, intentScore };\n    });\n  const primary = ranked\n    .filter(({ sharedTags, sameSeries }) => sameSeries || sharedTags > 0)\n    .sort((a,b) => b.intentScore-a.intentScore || b.candidate.data.publishedAt.valueOf()-a.candidate.data.publishedAt.valueOf());\n  const selected = primary.map(({candidate})=>candidate);\n  if (selected.length < limit) {\n    for (const { candidate } of ranked.filter(x=>x.sameCategory).sort((a,b)=>b.candidate.data.publishedAt.valueOf()-a.candidate.data.publishedAt.valueOf())) {\n      if (!selected.some(x=>x.id===candidate.id)) selected.push(candidate);\n      if (selected.length>=limit) break;\n    }\n  }\n  if (selected.length < limit) {\n    for (const { candidate } of ranked.sort((a,b)=>b.candidate.data.publishedAt.valueOf()-a.candidate.data.publishedAt.valueOf())) {\n      if (!selected.some(x=>x.id===candidate.id)) selected.push(candidate);\n      if (selected.length>=limit) break;\n    }\n  }\n  return selected.slice(0,limit);\n}\n\nexport function absoluteUrl`;
  if (!oldFn.test(source)) throw new Error('V4.19: getRelatedPosts patch anchor missing.');
  return source.replace(oldFn, newFn);
});

await patchFile('src/components/Header.astro', (source) => {
  if (source.includes('data-reading-list-count')) return source;
  const needle = '<div class="header-actions">';
  const add = `<div class="header-actions">\n        <a class="icon-button reading-list-link" href="/saved/" aria-label="محفوظات القراءة" title="محفوظات القراءة">\n          <span aria-hidden="true">🔖</span><span class="reading-list-count" data-reading-list-count hidden>0</span>\n        </a>`;
  if (!source.includes(needle)) throw new Error('V4.19: Header patch anchor missing.');
  return source.replace(needle, add);
});

await patchFile('src/pages/posts/[id].astro', (source) => {
  if (!source.includes('data-save-post')) {
    const anchor = '<div class="share-box">';
    const add = `<button class="save-reading-button" type="button" data-save-post data-post-id={post.id} aria-pressed="false"><span aria-hidden="true">🔖</span> <span data-save-label>حفظ للقراءة لاحقًا</span></button>\n      <div class="share-box">`;
    if (!source.includes(anchor)) throw new Error('V4.19: Article save-button anchor missing.');
    source = source.replace(anchor, add);
  }
  if (!source.includes('/scripts/reading-list.js')) {
    const anchor = '<script is:inline src="/scripts/article.js"></script>';
    if (!source.includes(anchor)) throw new Error('V4.19: Article script anchor missing.');
    source = source.replace(anchor, `${anchor}\n  <script is:inline src="/scripts/reading-list.js"></script>`);
  }
  return source;
});

await patchFile('scripts/generate-audio.mjs', (source) => {
  source = source.replace("const USER_AGENT = 'Bareeq-Audio-Builder/4.18.2';", "const USER_AGENT = 'Bareeq-Audio-Builder/4.19.0';");
  if (!source.includes('BAREEQ_TTS_INCLUDE_IDS')) {
    const old = `const posts = await loadPosts();\nconst synthesisPosts = PROVIDER === 'gemini'\n  ? posts\n  : PROVIDER === 'openai'\n    ? posts.filter((post) => !STUDIO_ARTICLE_IDS.has(post.id))\n    : posts;`;
    const repl = `const posts = await loadPosts();\nconst INCLUDE_IDS = new Set((process.env.BAREEQ_TTS_INCLUDE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));\nconst providerPosts = INCLUDE_IDS.size ? posts.filter((post) => INCLUDE_IDS.has(post.id)) : posts;\nif (INCLUDE_IDS.size && providerPosts.length !== INCLUDE_IDS.size) throw new Error('BAREEQ_TTS_INCLUDE_IDS contains unknown or draft article id(s).');\nconst synthesisPosts = PROVIDER === 'gemini'\n  ? providerPosts\n  : PROVIDER === 'openai'\n    ? providerPosts.filter((post) => !STUDIO_ARTICLE_IDS.has(post.id))\n    : providerPosts;`;
    if (!source.includes(old)) throw new Error('V4.19: audio selector patch anchor missing.');
    source = source.replace(old, repl);
  }
  if (!source.includes('BAREEQ_AZURE_HAMED_ONLY')) {
    const old = "const resolvedVoices = PROVIDER === 'azure' ? await resolveAzureVoices(API_KEY) : VOICES;";
    const repl = "const resolvedVoices = PROVIDER === 'azure'\n  ? (process.env.BAREEQ_AZURE_HAMED_ONLY === '1' ? (await resolveAzureVoices(API_KEY)).filter((voice) => voice.id === 'hamed') : await resolveAzureVoices(API_KEY))\n  : VOICES;";
    if (!source.includes(old)) throw new Error('V4.19: Azure Hamed-only patch anchor missing.');
    source = source.replace(old, repl);
  }
  return source;
});

await patchFile('scripts/import-bundled-azure-audio.mjs', (source) => {
  if (!source.includes('BAREEQ_BUNDLED_SKIP_IDS')) {
    const anchor = "const BUNDLED"; // marker only to force failure on a radically different file
    if (!source.includes("const ROOT = process.cwd();")) throw new Error('V4.19: bundled importer base marker missing.');
    source = source.replace("const ROOT = process.cwd();", "const ROOT = process.cwd();\nconst SKIP_IDS = new Set((process.env.BAREEQ_BUNDLED_SKIP_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));");
    const loop = "for (const config of lock.articles) {";
    if (!source.includes(loop)) throw new Error('V4.19: bundled importer loop anchor missing.');
    source = source.replace(loop, `${loop}\n  if (SKIP_IDS.has(config.articleId)) { console.log(\`↷ ${'${config.articleId}'}: skipped stale bundled Hamed; V4.19 will regenerate matching Hamed.\`); continue; }`);
  }
  return source;
});

await patchFile('scripts/import-studio-audio.mjs', (source) => {
  if (!source.includes('BAREEQ_STUDIO_SKIP_IDS')) {
    if (!source.includes("const ROOT = process.cwd();")) throw new Error('V4.19: studio importer base marker missing.');
    source = source.replace("const ROOT = process.cwd();", "const ROOT = process.cwd();\nconst SKIP_IDS = new Set((process.env.BAREEQ_STUDIO_SKIP_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));");
    const loop = "for (const [studioPathId, config] of Object.entries(mapping.imports)) {";
    if (!source.includes(loop)) throw new Error('V4.19: studio importer loop anchor missing.');
    source = source.replace(loop, `${loop}\n  if (SKIP_IDS.has(config.articleId)) { console.log(\`↷ ${'${config.articleId}'}: skipped stale Studio fallback; V4.19 will regenerate matching Hamed.\`); continue; }`);
    source = source.replace("assert(importedCount > 0 || !(await exists(RELEASES_ROOT)), 'No approved Studio audio release was imported.');", "assert(importedCount > 0 || SKIP_IDS.size > 0 || !(await exists(RELEASES_ROOT)), 'No approved Studio audio release was imported.');");
  }
  return source;
});

const ovPath = 'scripts/speech-overrides.json';
const ov = JSON.parse(await readFile(ovPath, 'utf8'));
ov.articles ||= {};
ov.articles['intuition-first-impression-decisions-signature'] = [{from:'عرفت',to:'عَرَفْتَ'},{from:'كنت',to:'كُنْتَ'},{from:'شعرت',to:'شَعَرْتَ'}];
ov.articles['اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا'] = [{from:'كنت',to:'كُنْتَ'}];
await writeFile(ovPath, JSON.stringify(ov, null, 2) + '\n');

const reviewPath = 'scripts/speech-review.json';
const review = JSON.parse(await readFile(reviewPath, 'utf8')); review.articles ||= {};
for (const id of changed) {
  const source = await readFile(`src/content/posts/${id}.md`, 'utf8');
  const m = source.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
  if (!m) throw new Error(`V4.19: invalid post ${id}`);
  const body = m[1].replace(/\r\n/g, '\n').trim();
  const previous = review.articles[id] || {};
  review.articles[id] = { bodyHash: sha(body), checks: Array.isArray(previous.checks) ? previous.checks : [] };
}
review.articles['intuition-first-impression-decisions-signature'].checks = [{from:'عرفت',to:'عَرَفْتَ'},{from:'كنت',to:'كُنْتَ'},{from:'شعرت',to:'شَعَرْتَ'}];
review.articles['اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا'].checks = [{from:'كنت',to:'كُنْتَ'}];
await writeFile(reviewPath, JSON.stringify(review, null, 2) + '\n');

console.log(`V4.19.0 preparation passed: ${changed.length} changed/new article(s), stale fallback imports excluded, Hamed-first hybrid audio enabled.`);
