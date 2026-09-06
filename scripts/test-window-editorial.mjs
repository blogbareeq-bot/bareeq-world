import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Editorial QA — runs AFTER check-visual-stories passes.
 *
 * This is the second pass. The first pass enforces structure (lengths,
 * kind, fingerprint, etc.). This pass enforces EDITORIAL value:
 *  - each card stands alone (a reader who has not read the article can
 *    understand it)
 *  - the arc is more than a vague sentence
 *  - kickers are varied and editorial
 *  - bodies are not just the article's quickSummary re-cut
 *  - the takeaway does not simply restate the hook
 *  - no card is dominated by stop-words
 *  - the path label matches the article's category
 */

const root = process.cwd();
const storiesDir = resolve(root, 'src/data/visual-stories');
const postsDir = resolve(root, 'src/content/posts');
const CATEGORY_PATH = {
  'ببساطة…': 'simply',
  'أطياف العقل': 'reflective',
  'بريق الكتب': 'books',
  'نافذة على العالم': 'world',
  'المستقبل الآن': 'technical'
};

const STOP_WORDS = new Set(['في', 'من', 'على', 'إلى', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'الذين', 'أن', 'إن', 'كان', 'كانت', 'يكون', 'تكون', 'هو', 'هي', 'هم', 'هن', 'نحن', 'أنا', 'أنت', 'كما', 'كذلك', 'أيضًا', 'لكن', 'لكنه', 'إذا', 'إذ', 'ما', 'لا', 'لم', 'لن', 'قد', 'لقد', 'حتى', 'بين', 'عند', 'بعد', 'قبل', 'أمام', 'خلف', 'فوق', 'تحت', 'مع', 'بدون', 'كل', 'بعض', 'جميع', 'كثير', 'قليل', 'كثيرًا', 'جدًا', 'لأن', 'بسبب', 'غير', 'ليس', 'ليست', 'سوف', 'يجب', 'ينبغي', 'يكون', 'نحو', 'حول']);

const frontmatterValue = (fm, key) => {
  const m = fm.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
  return m?.[1]?.replace(/^['"]|['"]$/g, '').trim() || '';
};

const stories = [];
const files = (await readdir(storiesDir)).filter((n) => n.endsWith('.json') && !n.endsWith('.skeleton.json')).sort();
for (const file of files) {
  const data = JSON.parse(await readFile(resolve(storiesDir, file), 'utf8'));
  const postSource = await readFile(resolve(postsDir, `${data.slug}.md`), 'utf8');
  const fm = postSource.split(/^---\s*$/m)[1] || '';
  stories.push({ ...data, _category: frontmatterValue(fm, 'category'), _summary: frontmatterValue(fm, 'quickSummary') || frontmatterValue(fm, 'description') });
}

const failures = [];

const contentWords = (s) => s.split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
const contentRatio = (s) => {
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const nonStop = contentWords(s);
  return nonStop.length / words.length;
};

for (const s of stories) {
  // 1. Arc must read like a story description, not a topic.
  if (s.arc.length < 60) failures.push(`${s.slug}: arc قصير جدًا (${s.arc.length} حرفًا). اكتب ملخصًا سرديًا للقصة.`);
  if (!/،/.test(s.arc)) failures.push(`${s.slug}: arc يحتاج إلى أكثر من جملة واحدة (ليست فاصلة).`);

  // 2. Path must match the article's editorial shape, not its category.
  //    An article under "بريق الكتب" may carry path=reflective if the
  //    review is conceptual rather than a book summary. We only warn when
  //    the mismatch is jarring (e.g. books article with path=simply).
  const CATEGORY_EXPECTED = {
    'ببساطة…': new Set(['simply', 'technical']),
    'أطياف العقل': new Set(['reflective', 'books']),
    'بريق الكتب': new Set(['books', 'reflective']),
    'نافذة على العالم': new Set(['world', 'reflective']),
    'المستقبل الآن': new Set(['technical', 'reflective'])
  };
  const expected = CATEGORY_EXPECTED[s._category];
  if (expected && !expected.has(s.path)) {
    failures.push(`${s.slug}: path=${s.path} لا يطابق القسم الفعلي "${s._category}". المتوقع: ${[...expected].join(', ')}.`);
  }

  // 3. Kicker variety: at least 5 distinct kickers per story.
  const uniqueKickers = new Set(s.cards.map((c) => c.kicker));
  if (uniqueKickers.size < 5) failures.push(`${s.slug}: فقط ${uniqueKickers.size} kicker فريد. نوّع أكثر.`);

  // 4. First and last titles must differ.
  const first = s.cards[0].title.trim();
  const last = s.cards.at(-1).title.trim();
  if (first === last) failures.push(`${s.slug}: عنوان hook و takeaway متطابق.`);

  // 5. Each body must be content-rich (at least 40% non-stop words).
  for (const c of s.cards) {
    const ratio = contentRatio(c.body);
    if (ratio < 0.4) failures.push(`${s.slug}/${c.id}: كثرة كلمات وظيفية (${(ratio * 100).toFixed(0)}% محتوى فعلي).`);
  }

  // 6. Body should not be a direct excerpt of the quickSummary.
  if (s._summary) {
    const summaryWords = new Set(s._summary.split(/\s+/).filter((w) => w.length > 4));
    const hookBody = s.cards[0].body;
    const overlap = hookBody.split(/\s+/).filter((w) => w.length > 4 && summaryWords.has(w)).length;
    if (overlap > 10) {
      failures.push(`${s.slug}: بطاقة الافتتاح تكرّر ملخص المقال حرفيًا (${overlap} كلمة مشتركة).`);
    }
  }

  // 7. Takeaway should not be shorter than hook — the closing is the
  //    strongest statement, not a tag line.
  if (s.cards.at(-1).body.length < s.cards[0].body.length - 40) {
    failures.push(`${s.slug}: الخاتمة أقصر من الافتتاح بكثير. أعطها نفس العمق.`);
  }

  // 8. At least 4 distinct kinds (not just hook/reveal/takeaway).
  const kinds = new Set(s.cards.map((c) => c.kind));
  if (kinds.size < 4) failures.push(`${s.slug}: تنوع الأنواع محدود (${kinds.size}). استعمل ${[...kinds].join(',')}.`);

  // 9. Every story should include at least one of: example, experiment, evidence, application
  const grounded = new Set(['example', 'experiment', 'evidence', 'application']);
  const hasGrounded = s.cards.some((c) => grounded.has(c.kind));
  if (!hasGrounded) failures.push(`${s.slug}: لا توجد بطاقة «مرتكزة» (مثال/تجربة/دليل/تطبيق). القصة ستبدو مجردة.`);
}

if (failures.length) {
  console.error(`فشل التحرير في نافذة بريق:\n- ${failures.join('\n- ')}`);
  throw new Error('editorial-qa failed');
}

console.log(`نافذة بريق: ${stories.length} قصة اجتازت التحرير المستقل (hook ≠ takeaway, تنوع kickers, ربط بالقسم, إلخ).`);
for (const s of stories) {
  const kinds = [...new Set(s.cards.map((c) => c.kind))].join(',');
  console.log(`  - ${s.slug} :: ${s.path} :: ${s.cards.length} بطاقة :: ${kinds}`);
}
