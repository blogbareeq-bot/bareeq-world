import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Editorial QA — runs AFTER check-visual-stories passes.
 * Protects narrative quality and prevents mechanically truncated Arabic prose.
 */
const root = process.cwd();
const storiesDir = resolve(root, 'src/data/visual-stories');
const postsDir = resolve(root, 'src/content/posts');

const STOP_WORDS = new Set(['في', 'من', 'على', 'إلى', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'الذين', 'أن', 'إن', 'كان', 'كانت', 'يكون', 'تكون', 'هو', 'هي', 'هم', 'هن', 'نحن', 'أنا', 'أنت', 'كما', 'كذلك', 'أيضًا', 'لكن', 'لكنه', 'إذا', 'إذ', 'ما', 'لا', 'لم', 'لن', 'قد', 'لقد', 'حتى', 'بين', 'عند', 'بعد', 'قبل', 'أمام', 'خلف', 'فوق', 'تحت', 'مع', 'بدون', 'كل', 'بعض', 'جميع', 'كثير', 'قليل', 'كثيرًا', 'جدًا', 'لأن', 'بسبب', 'غير', 'ليس', 'ليست', 'سوف', 'يجب', 'ينبغي', 'نحو', 'حول']);
const DANGLING_TAIL_WORDS = new Set(['حين', 'عندما', 'إذا', 'لو', 'لولا', 'لكن', 'بل', 'ثم', 'إلى', 'على', 'في', 'من', 'عن', 'أن', 'إن', 'أو', 'حتى', 'مع', 'عند', 'بعد', 'قبل', 'مثل', 'لأن', 'كي', 'لكي', 'بين', 'ضمن', 'خلال', 'نحو', 'دون', 'غير', 'كل', 'بعض', 'الذي', 'التي', 'الذين', 'حيث']);
const CLAUSE_INTRODUCERS = new Set(['حين', 'عندما', 'إذا', 'لو', 'لولا', 'لأن', 'بينما', 'لكن', 'ثم', 'حتى']);
// Exact fragments observed in the real hard-cut regression. Keep this narrow
// so ordinary short Arabic words ending a valid sentence are not rejected.
const KNOWN_CHOPPED_TOKENS = new Set(['إ', 'ذكا', 'نحاو', 'مطع', 'الهج', 'خا', 'الطوي', 'وال']);

const frontmatterValue = (fm, key) => {
  const m = fm.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
  return m?.[1]?.replace(/^['"]|['"]$/g, '').trim() || '';
};
const normalizeTail = (body) => body.trim().replace(/[.!؟?!؛،,:]+$/g, '').trim();
const lastWord = (body) => normalizeTail(body).split(/\s+/).at(-1)?.replace(/[«»"'()\[\]{}]/g, '') || '';
const hasBalancedArabicQuotes = (text) => [...text].filter((c) => c === '«').length === [...text].filter((c) => c === '»').length;
const hasSuspiciousChoppedToken = (body) => /[.]\s*$/.test(body.trim()) && KNOWN_CHOPPED_TOKENS.has(lastWord(body));

const danglingShortFinalClause = (body) => {
  const stripped = body.trim().replace(/[.!؟?!]+$/g, '').trim();
  const parts = stripped.split(/[.!؟?!]+/).map((p) => p.trim()).filter(Boolean);
  const fragment = parts.at(-1) || stripped;
  const words = fragment.replace(/[،؛,:]/g, ' ').split(/\s+/).filter(Boolean);
  const first = words[0]?.replace(/[«»"'()\[\]{}]/g, '') || '';
  return CLAUSE_INTRODUCERS.has(first) && words.length <= 7 ? fragment : '';
};

const semanticTailIssue = (body) => {
  const tail = lastWord(body);
  if (DANGLING_TAIL_WORDS.has(tail)) return `ينتهي برابط غير مكتمل: «${tail}»`;
  if (hasSuspiciousChoppedToken(body)) return `ينتهي بكلمة مبتورة معروفة من عيب القص السابق: «${tail}»`;
  const danglingClause = danglingShortFinalClause(body);
  if (danglingClause) return `ينتهي بجملة تابعة قصيرة بلا تتمة: «${danglingClause}»`;
  if (!hasBalancedArabicQuotes(body)) return 'علامات الاقتباس العربية « » غير متوازنة';
  return '';
};

const NEGATIVE_FIXTURES = [
  'حين يقترب الإصبع',
  'وقد يتسع المعروض أكثر من قدرة الاقتصاد على إ.',
  'ما المشكلة التي نحاو.',
  'قُدّم لهم على أنه ذكا.',
  'في مطعم نودلز غير رسمي قد لا يكون قاعدة لكل وجبة أو مطع.',
  'لا تستنتج أن النظام قرأ ملفًا خا.',
  '«أنا لم أقل إلغاء الواجبات'
];
for (const fixture of NEGATIVE_FIXTURES) {
  if (!semanticTailIssue(fixture)) throw new Error(`semantic-tail fixture escaped detection: ${fixture}`);
}

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
  return words.length ? contentWords(s).length / words.length : 0;
};

for (const s of stories) {
  if (s.arc.length < 60) failures.push(`${s.slug}: arc قصير جدًا (${s.arc.length} حرفًا). اكتب ملخصًا سرديًا للقصة.`);
  if (!/،/.test(s.arc)) failures.push(`${s.slug}: arc يحتاج إلى تركيب سردي أوضح يتضمن فاصلة.`);

  const CATEGORY_EXPECTED = {
    'ببساطة…': new Set(['simply', 'technical']),
    'أطياف العقل': new Set(['reflective', 'books']),
    'بريق الكتب': new Set(['books', 'reflective']),
    'نافذة على العالم': new Set(['world', 'reflective']),
    'المستقبل الآن': new Set(['technical', 'reflective'])
  };
  const expected = CATEGORY_EXPECTED[s._category];
  if (expected && !expected.has(s.path)) failures.push(`${s.slug}: path=${s.path} لا يطابق القسم الفعلي "${s._category}". المتوقع: ${[...expected].join(', ')}.`);

  const uniqueKickers = new Set(s.cards.map((c) => c.kicker));
  if (uniqueKickers.size < 5) failures.push(`${s.slug}: فقط ${uniqueKickers.size} kicker فريد. نوّع أكثر.`);
  if (s.cards[0].title.trim() === s.cards.at(-1).title.trim()) failures.push(`${s.slug}: عنوان hook و takeaway متطابق.`);

  for (const c of s.cards) {
    const ratio = contentRatio(c.body);
    if (ratio < 0.4) failures.push(`${s.slug}/${c.id}: كثرة كلمات وظيفية (${(ratio * 100).toFixed(0)}% محتوى فعلي).`);
    const tailIssue = semanticTailIssue(c.body);
    if (tailIssue) failures.push(`${s.slug}/${c.id}: ${tailIssue}. أعد صياغة البطاقة؛ يمنع القص الميكانيكي.`);
  }

  if (s._summary) {
    const summaryWords = new Set(s._summary.split(/\s+/).filter((w) => w.length > 4));
    const overlap = s.cards[0].body.split(/\s+/).filter((w) => w.length > 4 && summaryWords.has(w)).length;
    if (overlap > 10) failures.push(`${s.slug}: بطاقة الافتتاح تكرّر ملخص المقال حرفيًا (${overlap} كلمة مشتركة).`);
  }
  if (s.cards.at(-1).body.length < s.cards[0].body.length - 40) failures.push(`${s.slug}: الخاتمة أقصر من الافتتاح بكثير. أعطها نفس العمق.`);

  const kinds = new Set(s.cards.map((c) => c.kind));
  if (kinds.size < 4) failures.push(`${s.slug}: تنوع الأنواع محدود (${kinds.size}). استعمل ${[...kinds].join(',')}.`);
  const grounded = new Set(['example', 'experiment', 'evidence', 'application']);
  if (!s.cards.some((c) => grounded.has(c.kind))) failures.push(`${s.slug}: لا توجد بطاقة «مرتكزة» (مثال/تجربة/دليل/تطبيق). القصة ستبدو مجردة.`);
}

if (failures.length) {
  console.error(`فشل التحرير في نافذة بريق:\n- ${failures.join('\n- ')}`);
  throw new Error('editorial-qa failed');
}

console.log(`نافذة بريق: ${stories.length} قصة اجتازت التحرير المستقل، بما فيه فحص اكتمال النهايات ومنع القص الميكانيكي.`);
for (const s of stories) {
  const kinds = [...new Set(s.cards.map((c) => c.kind))].join(',');
  console.log(`  - ${s.slug} :: ${s.path} :: ${s.cards.length} بطاقة :: ${kinds}`);
}
