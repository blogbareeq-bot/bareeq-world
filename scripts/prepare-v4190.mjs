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
  const newFn = `export function getRelatedPosts(post: Post, posts: Post[], limit = 3): Post[] {
  const ranked = posts
    .filter((candidate) => candidate.id !== post.id)
    .map((candidate) => {
      const sharedTags = candidate.data.tags.filter((tag) => post.data.tags.includes(tag)).length;
      const sameSeries = Boolean(post.data.seriesSlug && candidate.data.seriesSlug === post.data.seriesSlug);
      const sameCategory = candidate.data.categorySlug === post.data.categorySlug;
      const intentScore = (sameSeries ? 8 : 0) + (sharedTags * 3) + (sameCategory ? 1 : 0);
      return { candidate, sharedTags, sameSeries, sameCategory, intentScore };
    });
  const primary = ranked
    .filter(({ sharedTags, sameSeries }) => sameSeries || sharedTags > 0)
    .sort((a,b) => b.intentScore-a.intentScore || b.candidate.data.publishedAt.valueOf()-a.candidate.data.publishedAt.valueOf());
  const selected = primary.map(({candidate})=>candidate);
  if (selected.length < limit) {
    for (const { candidate } of ranked.filter(x=>x.sameCategory).sort((a,b)=>b.candidate.data.publishedAt.valueOf()-a.candidate.data.publishedAt.valueOf())) {
      if (!selected.some(x=>x.id===candidate.id)) selected.push(candidate);
      if (selected.length>=limit) break;
    }
  }
  if (selected.length < limit) {
    for (const { candidate } of ranked.sort((a,b)=>b.candidate.data.publishedAt.valueOf()-a.candidate.data.publishedAt.valueOf())) {
      if (!selected.some(x=>x.id===candidate.id)) selected.push(candidate);
      if (selected.length>=limit) break;
    }
  }
  return selected.slice(0,limit);
}

export function absoluteUrl`;
  if (!oldFn.test(source)) throw new Error('V4.19: getRelatedPosts patch anchor missing.');
  return source.replace(oldFn, newFn);
});

await patchFile('src/components/Header.astro', (source) => {
  if (source.includes('data-reading-list-count')) return source;
  const needle = '<div class="header-actions">';
  const add = `<div class="header-actions">
        <a class="icon-button reading-list-link" href="/saved/" aria-label="محفوظات القراءة" title="محفوظات القراءة">
          <span aria-hidden="true">🔖</span><span class="reading-list-count" data-reading-list-count hidden>0</span>
        </a>`;
  if (!source.includes(needle)) throw new Error('V4.19: Header patch anchor missing.');
  return source.replace(needle, add);
});

await patchFile('src/pages/posts/[id].astro', (source) => {
  if (!source.includes('data-save-post')) {
    const anchor = '<div class="share-box">';
    const add = `<button class="save-reading-button" type="button" data-save-post data-post-id={post.id} aria-pressed="false"><span aria-hidden="true">🔖</span> <span data-save-label>حفظ للقراءة لاحقًا</span></button>
      <div class="share-box">`;
    if (!source.includes(anchor)) throw new Error('V4.19: Article save-button anchor missing.');
    source = source.replace(anchor, add);
  }
  if (!source.includes('/scripts/reading-list.js')) {
    const anchor = '<script is:inline src="/scripts/article.js"></script>';
    if (!source.includes(anchor)) throw new Error('V4.19: Article script anchor missing.');
    source = source.replace(anchor, `${anchor}
  <script is:inline src="/scripts/reading-list.js"></script>`);
  }
  return source;
});

await patchFile('scripts/generate-audio.mjs', (source) => {
  source = source.replace("const USER_AGENT = 'Bareeq-Audio-Builder/4.18.2';", "const USER_AGENT = 'Bareeq-Audio-Builder/4.19.0';");
  if (!source.includes('BAREEQ_TTS_INCLUDE_IDS')) {
    const old = `const posts = await loadPosts();
const synthesisPosts = PROVIDER === 'gemini'
  ? posts
  : PROVIDER === 'openai'
    ? posts.filter((post) => !STUDIO_ARTICLE_IDS.has(post.id))
    : posts;`;
    const repl = `const posts = await loadPosts();
const INCLUDE_IDS = new Set((process.env.BAREEQ_TTS_INCLUDE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
const providerPosts = INCLUDE_IDS.size ? posts.filter((post) => INCLUDE_IDS.has(post.id)) : posts;
if (INCLUDE_IDS.size && providerPosts.length !== INCLUDE_IDS.size) throw new Error('BAREEQ_TTS_INCLUDE_IDS contains unknown or draft article id(s).');
const synthesisPosts = PROVIDER === 'gemini'
  ? providerPosts
  : PROVIDER === 'openai'
    ? providerPosts.filter((post) => !STUDIO_ARTICLE_IDS.has(post.id))
    : providerPosts;`;
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
    if (!source.includes("const ROOT = process.cwd();")) throw new Error('V4.19: bundled importer base marker missing.');
    source = source.replace("const ROOT = process.cwd();", "const ROOT = process.cwd();\nconst SKIP_IDS = new Set((process.env.BAREEQ_BUNDLED_SKIP_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));");
    const loop = "for (const config of lock.articles) {";
    if (!source.includes(loop)) throw new Error('V4.19: bundled importer loop anchor missing.');
    source = source.replace(loop, `${loop}
  if (SKIP_IDS.has(config.articleId)) { console.log(\`↷ \${config.articleId}: skipped stale bundled Hamed; V4.19 will regenerate matching Hamed.\`); continue; }`);
  }
  return source;
});

await patchFile('scripts/import-studio-audio.mjs', (source) => {
  if (!source.includes('BAREEQ_STUDIO_SKIP_IDS')) {
    if (!source.includes("const ROOT = process.cwd();")) throw new Error('V4.19: studio importer base marker missing.');
    source = source.replace("const ROOT = process.cwd();", "const ROOT = process.cwd();\nconst SKIP_IDS = new Set((process.env.BAREEQ_STUDIO_SKIP_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));");
    const loop = "for (const [studioPathId, config] of Object.entries(mapping.imports)) {";
    if (!source.includes(loop)) throw new Error('V4.19: studio importer loop anchor missing.');
    source = source.replace(loop, `${loop}
  if (SKIP_IDS.has(config.articleId)) { console.log(\`↷ \${config.articleId}: skipped stale Studio fallback; V4.19 will regenerate matching Hamed.\`); continue; }`);
    source = source.replace("assert(importedCount > 0 || !(await exists(RELEASES_ROOT)), 'No approved Studio audio release was imported.');", "assert(importedCount > 0 || SKIP_IDS.size > 0 || !(await exists(RELEASES_ROOT)), 'No approved Studio audio release was imported.');");
  }
  return source;
});

const ovPath = 'scripts/speech-overrides.json';
const ov = JSON.parse(await readFile(ovPath, 'utf8'));
ov.articles ||= {};
ov.articles['intuition-first-impression-decisions-signature'] = [{from:'عرفت',to:'عَرَفْتَ'},{from:'كنت',to:'كُنْتَ'},{from:'شعرت',to:'شَعَرْتَ'}];
ov.articles['اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا'] = [{from:'كنت',to:'كُنْتَ'}];

const passionId = 'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون';
ov.articles[passionId] = Array.isArray(ov.articles[passionId]) ? ov.articles[passionId] : [];
ov.articles[passionId] = ov.articles[passionId].filter((item) => item?.from !== 'إذا كنت حائرًا' && item?.from !== 'كنت');
ov.articles[passionId].push({ from: 'كنت', to: 'كُنْتَ' });
await writeFile(ovPath, JSON.stringify(ov, null, 2) + '\n');

const reviewPath = 'scripts/speech-review.json';
const review = JSON.parse(await readFile(reviewPath, 'utf8')); review.articles ||= {};
for (const id of changed) {
  const source = await readFile(`src/content/posts/${id}.md`, 'utf8');
  const m = source.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
  if (!m) throw new Error(`V4.19: invalid post ${id}`);
  const body = m[1].replace(/\r\n/g, '\n').trim();
  const previous = review.articles[id] || {};
  const currentChecks = Array.isArray(previous.checks)
    ? previous.checks.filter((check) => typeof check?.from === 'string' && body.includes(check.from))
    : [];
  review.articles[id] = { bodyHash: sha(body), checks: currentChecks };
}
review.articles['intuition-first-impression-decisions-signature'].checks = [{from:'عرفت',to:'عَرَفْتَ'},{from:'كنت',to:'كُنْتَ'},{from:'شعرت',to:'شَعَرْتَ'}];
review.articles['اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا'].checks = [{from:'كنت',to:'كُنْتَ'}];

const passionReview = review.articles[passionId];
if (passionReview) {
  passionReview.checks = passionReview.checks.filter((check) => check?.from !== 'إذا كنت حائرًا' && check?.from !== 'كنت');
  passionReview.checks.push({ from: 'كنت', to: 'كُنْتَ' });
}
await writeFile(reviewPath, JSON.stringify(review, null, 2) + '\n');

await patchFile('scripts/check-launch-readiness.mjs', (source) => {
  const oldVersion = "if (pkg.version !== '4.18.2') failures.push(`Expected package version 4.18.2, got ${pkg.version}`);";
  const newVersion = "if (pkg.version !== '4.19.0') failures.push(`Expected package version 4.19.0, got ${pkg.version}`);";
  if (source.includes(oldVersion)) source = source.replace(oldVersion, newVersion);
  else if (!source.includes(newVersion)) throw new Error('V4.19: launch-readiness package-version anchor missing.');

  const oldRelated = "if (!postsLib.includes('const relatedByIntent = sameSeries || sharedTags > 0;')) failures.push('Related-post scoring still permits category-only recommendations.');";
  const newRelated = "if (!postsLib.includes('const primary = ranked') || !postsLib.includes('sameSeries || sharedTags > 0') || !postsLib.includes('ranked.filter(x=>x.sameCategory)')) failures.push('V4.19 related-post scoring must prioritize intent matches before same-category fallback.');";
  if (source.includes(oldRelated)) source = source.replace(oldRelated, newRelated);
  else if (!source.includes(newRelated)) throw new Error('V4.19: launch-readiness related-post anchor missing.');

  return source;
});


// V4.19 Hotfix 5: publishing must not fail merely because the remaining
// Sadaltager rollout is larger than the per-build Gemini request ceiling.
// Hamed has already been generated fail-closed for changed/new articles.
// Preserve any Sadaltager restored from production, then defer new Gemini work.
await patchFile('scripts/generate-audio.mjs', (source) => {
  const hardStop = "if (missingRequests > GEMINI_REQUEST_HARD_LIMIT) throw new Error(`Gemini safety stop: ${missingRequests} new request(s) exceed BAREEQ_GEMINI_MAX_REQUESTS_PER_BUILD=${GEMINI_REQUEST_HARD_LIMIT}. Review --plan before deliberately raising the cap.`);";
  const safeDefer = "if (missingRequests > GEMINI_REQUEST_HARD_LIMIT) { console.warn(`⚠ Gemini progressive rollout deferred: ${missingRequests} new request(s) exceed the ${GEMINI_REQUEST_HARD_LIMIT}-request per-build ceiling.`); console.warn('⚠ Safe fallback: matching Hamed/Cedar audio already present in this build remains publishable; unchanged Sadaltager restored from production is preserved.'); process.exit(0); }";
  if (source.includes(hardStop)) return source.replace(hardStop, safeDefer);
  if (!source.includes('Gemini progressive rollout deferred: ${missingRequests}')) {
    throw new Error('V4.19 Hotfix 5: Gemini request-cap anchor missing.');
  }
  return source;
});

// The production audio audit must recognize freshly generated Azure Hamed as
// an approved progressive fallback while the global rollout mode is Gemini.
// Validation remains strict: version/model/language/format/voice metadata must
// match the V4.19 Hamed contract exactly.
await patchFile('scripts/check-audio-dist.mjs', (source) => {
  if (!source.includes('let generatedAzureFallbackArticles = 0;')) {
    const counterAnchor = 'let generatedArticles = 0;';
    if (!source.includes(counterAnchor)) throw new Error('V4.19 Hotfix 5: audio-audit counter anchor missing.');
    source = source.replace(counterAnchor, `${counterAnchor}\nlet generatedAzureFallbackArticles = 0;`);
  }

  if (!source.includes("const generatedAzureFallback = provider === 'gemini'")) {
    const oldBlock = `  } else {
    if (!expected) throw new Error(\`\${id}: zero-cost bundled mode may not contain generated audio.\`);
    // Gemini production may generate Sadaltager for any published article in V4.18.2.
    if (manifest.version !== 3 || manifest.generatorVersion !== 8 || manifest.provider !== expected.name || manifest.model !== expected.model || manifest.language !== expected.language || manifest.outputFormat !== expected.format || manifest.syncVersion !== 1 || manifest.syncMethod !== 'paragraph-weighted') throw new Error(\`\${id}: generated audio metadata does not match \${expected.name}.\`);
    if (Boolean(manifest.contractTest) !== (process.env.BAREEQ_TTS_CONTRACT_TEST === '1')) throw new Error(\`\${id}: contract-test audio escaped its explicit test boundary.\`);
    if (manifest.defaultVoice !== expected.voices[0][0] || !Array.isArray(manifest.voices) || manifest.voices.length !== expected.voices.length) throw new Error(\`\${id}: generated audio requires exactly \${expected.voices.length} ordered listening choice(s).\`);
    expected.voices.forEach(([voiceId, providerVoice], index) => {
      const voice = manifest.voices[index];
      if (voice?.id !== voiceId || voice?.providerVoice !== providerVoice || typeof voice?.label !== 'string' || !(voice.totalDurationSeconds > 0)) throw new Error(\`\${id}: invalid generated voice metadata for \${voiceId}.\`);
    });
    generatedArticles += 1;
  }`;

    const newBlock = `  } else {
    const generatedAzureFallback = provider === 'gemini'
      && manifest.version === 3
      && manifest.generatorVersion === 8
      && manifest.provider === 'Microsoft Azure AI Speech'
      && manifest.model === 'Neural TTS'
      && manifest.language === 'ar-SA'
      && manifest.outputFormat === 'audio-48khz-96kbitrate-mono-mp3'
      && manifest.syncVersion === 1
      && manifest.syncMethod === 'paragraph-weighted';

    if (generatedAzureFallback) {
      if (manifest.contractTest) throw new Error(\`\${id}: contract-test Azure fallback escaped its explicit test boundary.\`);
      if (manifest.defaultVoice !== 'hamed' || !Array.isArray(manifest.voices) || manifest.voices.length !== 1) throw new Error(\`\${id}: V4.19 Azure fallback must contain exactly one Hamed voice.\`);
      const voice = manifest.voices[0];
      if (voice?.id !== 'hamed' || voice?.providerVoice !== 'ar-SA-HamedNeural' || typeof voice?.label !== 'string' || !(voice.totalDurationSeconds > 0)) throw new Error(\`\${id}: invalid generated Azure Hamed fallback metadata.\`);
      generatedAzureFallbackArticles += 1;
    } else {
      if (!expected) throw new Error(\`\${id}: zero-cost bundled mode may not contain generated audio.\`);
      if (manifest.version !== 3 || manifest.generatorVersion !== 8 || manifest.provider !== expected.name || manifest.model !== expected.model || manifest.language !== expected.language || manifest.outputFormat !== expected.format || manifest.syncVersion !== 1 || manifest.syncMethod !== 'paragraph-weighted') throw new Error(\`\${id}: generated audio metadata does not match \${expected.name}.\`);
      if (Boolean(manifest.contractTest) !== (process.env.BAREEQ_TTS_CONTRACT_TEST === '1')) throw new Error(\`\${id}: contract-test audio escaped its explicit test boundary.\`);
      if (manifest.defaultVoice !== expected.voices[0][0] || !Array.isArray(manifest.voices) || manifest.voices.length !== expected.voices.length) throw new Error(\`\${id}: generated audio requires exactly \${expected.voices.length} ordered listening choice(s).\`);
      expected.voices.forEach(([voiceId, providerVoice], index) => {
        const voice = manifest.voices[index];
        if (voice?.id !== voiceId || voice?.providerVoice !== providerVoice || typeof voice?.label !== 'string' || !(voice.totalDurationSeconds > 0)) throw new Error(\`\${id}: invalid generated voice metadata for \${voiceId}.\`);
      });
      generatedArticles += 1;
    }
  }`;

    if (!source.includes(oldBlock)) throw new Error('V4.19 Hotfix 5: generated-audio audit block anchor missing.');
    source = source.replace(oldBlock, newBlock);
  }

  const oldCoverage = 'const progressiveCoverage = generatedArticles + importedArticles + bundledArticles;';
  const newCoverage = 'const progressiveCoverage = generatedArticles + generatedAzureFallbackArticles + importedArticles + bundledArticles;';
  if (source.includes(oldCoverage)) source = source.replace(oldCoverage, newCoverage);
  else if (!source.includes(newCoverage)) throw new Error('V4.19 Hotfix 5: progressive coverage anchor missing.');

  const oldSummary = '`${checkedArticles} article(s), ${generatedArticles} generated provider article(s), ${importedArticles} approved Studio import(s), ${bundledArticles} bundled Azure Hamed article(s), ${totalParts} synchronized track(s), ${totalFiles} timed MP3 file(s), no text/key leakage.`';
  const newSummary = '`${checkedArticles} article(s), ${generatedArticles} generated provider article(s), ${generatedAzureFallbackArticles} generated Azure Hamed fallback article(s), ${importedArticles} approved Studio import(s), ${bundledArticles} bundled Azure Hamed article(s), ${totalParts} synchronized track(s), ${totalFiles} timed MP3 file(s), no text/key leakage.`';
  if (source.includes(oldSummary)) source = source.replace(oldSummary, newSummary);

  return source;
});

console.log(`V4.19.0 preparation passed: ${changed.length} changed/new article(s), stale fallback imports excluded, Hamed-first hybrid audio enabled.`);
