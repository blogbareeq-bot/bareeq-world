import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Editorial QA + structural validation for Bareeq Window (v2).
 *
 * Walks `src/data/visual-stories/<slug>.json`, compares against the
 * published posts, and asserts:
 *  - 1:1 coverage with the 15 published articles
 *  - sourceFingerprint matches the live post file
 *  - each card passes the structural/editorial checks (delegated to the
 *    TypeScript validator by re-implementing the rules in plain JS so the
 *    script can run without a TS toolchain).
 */

const root = process.cwd();
const postsDir = resolve(root, 'src/content/posts');
const storiesDir = resolve(root, 'src/data/visual-stories');

const ARABIC_LETTER = /[\u0600-\u06FF]/;
const ENDS_INCOMPLETE = /(\.\.\.|…|،|:|؛|,|;)$/;
const STARTS_INCOMPLETE = /^(\.\.\.|…|،|:|؛)/;
const TABLE_FRAGMENT = /\|.*\|/m;
const HTML_PATTERN = /<\/?[a-z][^>]*>/i;
const FRONTMATTER_LINE = /^-{3,}$/;
const LIST_LINE = /^[-*]\s/m;
const ALLOWED_KINDS = new Set([
  'hook', 'reveal', 'question', 'example', 'contrast', 'myth',
  'evidence', 'experiment', 'reflection', 'application', 'takeaway'
]);
const ALLOWED_PATHS = new Set(['technical', 'reflective', 'books', 'world', 'simply']);
const ALLOWED_VISUALS = new Set([
  'threshold', 'rings', 'path', 'layers', 'contrast', 'pulse',
  'constellation', 'horizon', 'opening', 'seal', 'orbit',
  'wave', 'ledger', 'prism', 'compass', 'weave', 'arc', 'field', 'dawn', 'paper', 'ladder',
  'currents', 'stamps'
]);
const MIN_BODY = 96;
const MAX_BODY = 290;
const MIN_TITLE = 8;
const MAX_TITLE = 88;
const MIN_CARDS = 7;
const MAX_CARDS = 10;
const MIN_KICKER = 3;
const MAX_KICKER = 26;
const MIN_ARC = 24;

const strip = (v) => (v || '').replace(/\s+/g, ' ').trim();

const jaccard = (a, b) => {
  const A = new Set(a.split(/\s+/).filter(Boolean));
  const B = new Set(b.split(/\s+/).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  const u = A.size + B.size - inter;
  return u === 0 ? 0 : inter / u;
};

const validateStory = (story) => {
  const issues = [];
  if (!story || !story.slug) {
    issues.push({ code: 'missing-slug', message: 'slug مفقود' });
    return issues;
  }
  if (!story.arc || strip(story.arc).length < MIN_ARC) issues.push({ code: 'arc-missing', message: 'arc مفقود أو قصير' });
  if (!ALLOWED_PATHS.has(story.path)) issues.push({ code: 'arc-path', message: `path غير معروف: ${story.path}` });
  if (!story.director?.mood || story.director?.motion !== 'calm' || story.director?.palette?.length !== 4) {
    issues.push({ code: 'director', message: 'Visual Director غير مكتمل' });
  }
  if (!Array.isArray(story.cards) || story.cards.length < MIN_CARDS || story.cards.length > MAX_CARDS) {
    issues.push({ code: 'card-count', message: `عدد البطاقات خارج ${MIN_CARDS}–${MAX_CARDS}` });
    return issues;
  }
  const ids = new Set();
  const bodies = [];
  const kickers = [];
  const kinds = [];
  for (const card of story.cards) {
    if (!card.id || ids.has(card.id)) issues.push({ code: 'card-id', cardId: card.id, message: 'معرّف بطاقة مفقود أو مكرر' });
    ids.add(card.id);
    const k = strip(card.kicker);
    if (!k || k.length < MIN_KICKER || k.length > MAX_KICKER) issues.push({ code: 'kicker-len', cardId: card.id, message: `طول kicker خارج ${MIN_KICKER}–${MAX_KICKER} (${k.length})` });
    if (!ARABIC_LETTER.test(k)) issues.push({ code: 'kicker-lang', cardId: card.id, message: 'kicker لا يحتوي العربية' });
    kickers.push(k);
    const t = strip(card.title);
    if (!t || t.length < MIN_TITLE || t.length > MAX_TITLE) issues.push({ code: 'title-len', cardId: card.id, message: `طول العنوان خارج ${MIN_TITLE}–${MAX_TITLE} (${t.length})` });
    if (!ARABIC_LETTER.test(t)) issues.push({ code: 'title-lang', cardId: card.id, message: 'العنوان لا يحتوي العربية' });
    if (ENDS_INCOMPLETE.test(t)) issues.push({ code: 'title-trunc', cardId: card.id, message: 'العنوان منتهٍ بعلامة قطع/فاصلة' });
    if (STARTS_INCOMPLETE.test(t)) issues.push({ code: 'title-trunc-start', cardId: card.id, message: 'العنوان يبدأ بعلامة قطع' });
    const b = strip(card.body);
    if (!b) {
      issues.push({ code: 'body-empty', cardId: card.id, message: 'النص فارغ' });
    } else {
      if (b.length < MIN_BODY) issues.push({ code: 'body-short', cardId: card.id, message: `النص أقصر من ${MIN_BODY} حرفًا (${b.length})` });
      if (b.length > MAX_BODY) issues.push({ code: 'body-long', cardId: card.id, message: `النص أطول من ${MAX_BODY} حرفًا (${b.length})` });
      if (!ARABIC_LETTER.test(b)) issues.push({ code: 'body-lang', cardId: card.id, message: 'النص لا يحتوي العربية' });
      if (TABLE_FRAGMENT.test(b)) issues.push({ code: 'body-table', cardId: card.id, message: 'تسرب جدول Markdown' });
      if (HTML_PATTERN.test(b)) issues.push({ code: 'body-html', cardId: card.id, message: 'تسرب HTML' });
      if (ENDS_INCOMPLETE.test(b)) issues.push({ code: 'body-trunc-end', cardId: card.id, message: 'النص ينتهي بعلامة قطع (القص الميكانيكي ممنوع)' });
      if (STARTS_INCOMPLETE.test(b)) issues.push({ code: 'body-trunc-start', cardId: card.id, message: 'النص يبدأ بعلامة قطع' });
      if (FRONTMATTER_LINE.test(b)) issues.push({ code: 'body-frontmatter', cardId: card.id, message: 'تسرب frontmatter' });
      if (LIST_LINE.test(b)) issues.push({ code: 'body-list', cardId: card.id, message: 'تسرب قائمة نقطية' });
    }
    if (!ALLOWED_KINDS.has(card.kind)) issues.push({ code: 'kind-invalid', cardId: card.id, message: 'نوع البطاقة غير معروف' });
    if (!card.visual || !ALLOWED_VISUALS.has(card.visual)) issues.push({ code: 'visual-invalid', cardId: card.id, message: `قيمة visual غير معروفة: ${card.visual}` });
    kinds.push(card.kind);
    bodies.push(b);
  }
  const distinctKinds = new Set(kinds);
  if (distinctKinds.size < 3) issues.push({ code: 'kinds-monotone', message: `أنواع البطاقات متشابهة (${distinctKinds.size} فقط)` });
  const kc = new Map();
  for (const k of kickers) kc.set(k, (kc.get(k) || 0) + 1);
  for (const [k, c] of kc) if (c > 2) issues.push({ code: 'kicker-repeat', message: `kicker مكرر ${c}×: ${k}` });
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const s = jaccard(bodies[i], bodies[j]);
      if (s > 0.55) issues.push({ code: 'body-overlap', message: `تشابه بين البطاقتين ${i + 1} و ${j + 1}: ${(s * 100).toFixed(0)}%` });
    }
  }
  const first = story.cards[0];
  const last = story.cards[story.cards.length - 1];
  if (first && last && first.id?.startsWith('hook') && last.id?.startsWith('takeaway')) {
    const s = jaccard(strip(first.body), strip(last.body));
    if (s > 0.4) issues.push({ code: 'arc-bookends', message: `تشابه بين hook و takeaway: ${(s * 100).toFixed(0)}%` });
  }
  if (first && last && strip(first.title) === strip(last.title)) {
    issues.push({ code: 'arc-title-bookends', message: 'عنوان hook و takeaway متطابق' });
  }
  const ts = new Set(story.cards.map((c) => strip(c.title)));
  if (ts.size !== story.cards.length) issues.push({ code: 'title-dup', message: 'عنوان بطاقة مكرر داخل القصة' });
  return issues;
};

const posts = (await readdir(postsDir)).filter((n) => n.endsWith('.md')).sort();
const storyFiles = (await readdir(storiesDir)).filter((n) => n.endsWith('.json') && !n.endsWith('.skeleton.json')).sort();
const slugs = new Set();

const failures = [];
if (storyFiles.length !== posts.length) failures.push(`التغطية ${storyFiles.length}/${posts.length}.`);

const storySummaries = [];
for (const file of storyFiles) {
  const slug = file.replace(/\.json$/, '');
  slugs.add(slug);
  const storyPath = resolve(storiesDir, file);
  const postPath = resolve(postsDir, `${slug}.md`);
  if (!posts.includes(`${slug}.md`)) {
    failures.push(`${slug}: لا يوجد مقال مطابق.`);
    continue;
  }
  const data = JSON.parse(await readFile(storyPath, 'utf8'));
  const postSource = await readFile(postPath, 'utf8');
  const fingerprint = createHash('sha256').update(postSource).digest('hex');
  if (data.sourceFingerprint !== fingerprint) failures.push(`${slug}: بصمة المقال تغيرت. أعد توليد القصة.`);
  const issues = validateStory(data);
  if (issues.length) {
    for (const issue of issues) failures.push(`${slug}/${issue.cardId || '-'}: [${issue.code}] ${issue.message}`);
  }
  storySummaries.push({ slug, cards: data.cards.length, path: data.path });
}

for (const post of posts) {
  const slug = post.replace(/\.md$/, '');
  if (!slugs.has(slug)) failures.push(`${slug}: لا يملك نافذة بريق.`);
}

const titles = new Set();
for (const file of storyFiles) {
  const data = JSON.parse(await readFile(resolve(storiesDir, file), 'utf8'));
  if (titles.has(data.title)) failures.push(`${data.slug}: عنوان القصة مكرر: ${data.title}`);
  titles.add(data.title);
}

if (failures.length) {
  throw new Error(`فشل فحص نافذة بريق:\n- ${failures.join('\n- ')}`);
}

console.log(`نافذة بريق: ${storyFiles.length}/${posts.length} قصة، ${storySummaries.reduce((a, s) => a + s.cards, 0)} بطاقة، وجميع البوابات التحريرية والبنيوية ناجحة.`);
console.log('الأنواع السردية:');
for (const s of storySummaries) console.log(`  - ${s.slug} :: ${s.path} :: ${s.cards} بطاقات`);
