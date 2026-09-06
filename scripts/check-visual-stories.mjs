import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd();
const postsDir = resolve(root, 'src/content/posts');
const storiesDir = resolve(root, 'src/data/visual-stories');

const ARABIC_LETTER = /[\u0600-\u06FF]/;
const ENDS_INCOMPLETE = /(\.\.\.|…|،|:|؛|,|;)$/;
const STARTS_INCOMPLETE = /^(\.\.\.|…|،|:|؛)/;
const TERMINAL_PUNCTUATION = /[.!؟!»”)]$/u;
const KNOWN_TRUNCATED_TAIL = /(?:^|\s)(?:إ|ذكا|نحاو|مطع|الهج|خا|الطوي|وال)\.$/u;
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
const MAX_BODY = 290;
const MIN_TITLE = 8;
const MAX_TITLE = 88;
const MIN_CARDS = 7;
const MAX_CARDS = 10;
const MIN_KICKER = 3;
const MAX_KICKER = 26;
const MIN_ARC = 24;

const MIN_BODY_BY_KIND = {
  hook: 70,
  question: 70,
  takeaway: 80,
  myth: 110,
  reveal: 130,
  example: 140,
  evidence: 140,
  application: 140,
  experiment: 140,
  contrast: 130,
  reflection: 130
};
const minBodyFor = (kind) => MIN_BODY_BY_KIND[kind] ?? 96;
const strip = (v) => (v || '').replace(/\s+/g, ' ').trim();
const countChar = (value, char) => [...value].filter((c) => c === char).length;

const semanticEndingIssue = (value) => {
  if (!TERMINAL_PUNCTUATION.test(value)) return 'النص لا ينتهي بعلامة ترقيم ختامية؛ راجع احتمال القص الميكانيكي';
  if (KNOWN_TRUNCATED_TAIL.test(value)) return 'النص ينتهي بكلمة مبتورة معروفة من عيب القص السابق';
  if (countChar(value, '«') !== countChar(value, '»')) return 'علامات الاقتباس «» غير متوازنة';
  if (countChar(value, '(') !== countChar(value, ')')) return 'الأقواس () غير متوازنة';
  return null;
};

const jaccard = (a, b) => {
  const A = new Set(a.split(/\s+/).filter(Boolean));
  const B = new Set(b.split(/\s+/).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
};

const validateStory = (story) => {
  const issues = [];
  if (!story?.slug) return [{ code: 'missing-slug', message: 'slug مفقود' }];
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

    const kicker = strip(card.kicker);
    if (!kicker || kicker.length < MIN_KICKER || kicker.length > MAX_KICKER) issues.push({ code: 'kicker-len', cardId: card.id, message: `طول kicker خارج ${MIN_KICKER}–${MAX_KICKER} (${kicker.length})` });
    if (!ARABIC_LETTER.test(kicker)) issues.push({ code: 'kicker-lang', cardId: card.id, message: 'kicker لا يحتوي العربية' });
    kickers.push(kicker);

    const title = strip(card.title);
    if (!title || title.length < MIN_TITLE || title.length > MAX_TITLE) issues.push({ code: 'title-len', cardId: card.id, message: `طول العنوان خارج ${MIN_TITLE}–${MAX_TITLE} (${title.length})` });
    if (!ARABIC_LETTER.test(title)) issues.push({ code: 'title-lang', cardId: card.id, message: 'العنوان لا يحتوي العربية' });
    if (ENDS_INCOMPLETE.test(title) || STARTS_INCOMPLETE.test(title)) issues.push({ code: 'title-trunc', cardId: card.id, message: 'العنوان يبدأ أو ينتهي بعلامة قطع/فاصلة' });

    const body = strip(card.body);
    if (!body) {
      issues.push({ code: 'body-empty', cardId: card.id, message: 'النص فارغ' });
    } else {
      const minForKind = minBodyFor(card.kind);
      if (body.length < minForKind) issues.push({ code: 'body-short', cardId: card.id, message: `النص أقصر من ${minForKind} حرفًا لنوع ${card.kind} (${body.length})` });
      if (body.length > MAX_BODY) issues.push({ code: 'body-long', cardId: card.id, message: `النص أطول من ${MAX_BODY} حرفًا (${body.length})` });
      if (!ARABIC_LETTER.test(body)) issues.push({ code: 'body-lang', cardId: card.id, message: 'النص لا يحتوي العربية' });
      if (TABLE_FRAGMENT.test(body)) issues.push({ code: 'body-table', cardId: card.id, message: 'تسرب جدول Markdown' });
      if (HTML_PATTERN.test(body)) issues.push({ code: 'body-html', cardId: card.id, message: 'تسرب HTML' });
      if (ENDS_INCOMPLETE.test(body) || STARTS_INCOMPLETE.test(body)) issues.push({ code: 'body-trunc', cardId: card.id, message: 'النص يبدأ أو ينتهي بعلامة قطع؛ القص الميكانيكي ممنوع' });
      const semanticIssue = semanticEndingIssue(body);
      if (semanticIssue) issues.push({ code: 'body-semantic-ending', cardId: card.id, message: semanticIssue });
      if (FRONTMATTER_LINE.test(body)) issues.push({ code: 'body-frontmatter', cardId: card.id, message: 'تسرب frontmatter' });
      if (LIST_LINE.test(body)) issues.push({ code: 'body-list', cardId: card.id, message: 'تسرب قائمة نقطية' });
    }

    if (!ALLOWED_KINDS.has(card.kind)) issues.push({ code: 'kind-invalid', cardId: card.id, message: 'نوع البطاقة غير معروف' });
    if (!card.visual || !ALLOWED_VISUALS.has(card.visual)) issues.push({ code: 'visual-invalid', cardId: card.id, message: `قيمة visual غير معروفة: ${card.visual}` });
    kinds.push(card.kind);
    bodies.push(body);
  }

  if (new Set(kinds).size < 3) issues.push({ code: 'kinds-monotone', message: 'تنوع أنواع البطاقات غير كافٍ' });
  const kickerCounts = new Map();
  for (const kicker of kickers) kickerCounts.set(kicker, (kickerCounts.get(kicker) || 0) + 1);
  for (const [kicker, count] of kickerCounts) if (count > 2) issues.push({ code: 'kicker-repeat', message: `kicker مكرر ${count}×: ${kicker}` });

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const similarity = jaccard(bodies[i], bodies[j]);
      if (similarity > 0.55) issues.push({ code: 'body-overlap', message: `تشابه بين البطاقتين ${i + 1} و${j + 1}: ${(similarity * 100).toFixed(0)}%` });
    }
  }

  const first = story.cards[0];
  const last = story.cards.at(-1);
  if (first?.id?.startsWith('hook') && last?.id?.startsWith('takeaway')) {
    const similarity = jaccard(strip(first.body), strip(last.body));
    if (similarity > 0.4) issues.push({ code: 'arc-bookends', message: `تشابه بين hook وtakeaway: ${(similarity * 100).toFixed(0)}%` });
  }
  if (first && last && strip(first.title) === strip(last.title)) issues.push({ code: 'arc-title-bookends', message: 'عنوان hook وtakeaway متطابق' });
  if (new Set(story.cards.map((card) => strip(card.title))).size !== story.cards.length) issues.push({ code: 'title-dup', message: 'عنوان بطاقة مكرر داخل القصة' });
  return issues;
};

const posts = (await readdir(postsDir)).filter((name) => name.endsWith('.md')).sort();
const storyFiles = (await readdir(storiesDir)).filter((name) => name.endsWith('.json') && !name.endsWith('.skeleton.json')).sort();
const slugs = new Set();
const failures = [];
const storySummaries = [];

if (storyFiles.length !== posts.length) failures.push(`التغطية ${storyFiles.length}/${posts.length}.`);

for (const file of storyFiles) {
  const slug = file.replace(/\.json$/, '');
  slugs.add(slug);
  if (!posts.includes(`${slug}.md`)) {
    failures.push(`${slug}: لا يوجد مقال مطابق.`);
    continue;
  }
  const data = JSON.parse(await readFile(resolve(storiesDir, file), 'utf8'));
  const postSource = await readFile(resolve(postsDir, `${slug}.md`), 'utf8');
  const fingerprint = createHash('sha256').update(postSource).digest('hex');
  if (data.sourceFingerprint !== fingerprint) failures.push(`${slug}: بصمة المقال تغيرت. أعد مراجعة القصة.`);
  for (const issue of validateStory(data)) failures.push(`${slug}/${issue.cardId || '-'}: [${issue.code}] ${issue.message}`);
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

if (failures.length) throw new Error(`فشل فحص نافذة بريق:\n- ${failures.join('\n- ')}`);

console.log(`نافذة بريق: ${storyFiles.length}/${posts.length} قصة، ${storySummaries.reduce((sum, story) => sum + story.cards, 0)} بطاقة، وجميع البوابات التحريرية والبنيوية ناجحة.`);
for (const story of storySummaries) console.log(`  - ${story.slug} :: ${story.path} :: ${story.cards} بطاقات`);
