import { readFile } from 'node:fs/promises';

export const RETAINED_GEMINI = [
  'ai-agents-future-now',
  'ai-as-coworker-future-of-human-work',
];

const BASE_PENDING_CLOUD = [
  'altadakhom-explained-simply',
  'intuition-first-impression-decisions-signature',
  'language-soft-power-politics',
  'اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا',
  'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع',
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا',
  'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء',
  'كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار',
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه',
  'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون',
  'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء',
];

export const RELEASE_CANDIDATE_ARTICLE = 'why-some-passports-are-stronger';
const candidateSource = await readFile(`src/content/posts/${RELEASE_CANDIDATE_ARTICLE}.md`, 'utf8');
export const RELEASE_CANDIDATE_PUBLISHED = !/^draft:\s*true\s*$/mi.test(candidateSource);

export const PENDING_CLOUD = [
  ...BASE_PENDING_CLOUD,
  ...(RELEASE_CANDIDATE_PUBLISHED ? [RELEASE_CANDIDATE_ARTICLE] : []),
];

export const EXPECTED_PENDING_CLOUD = PENDING_CLOUD.length;
export const EXPECTED_PUBLISHED_ARTICLES = RETAINED_GEMINI.length + PENDING_CLOUD.length;

const unique = new Set([...RETAINED_GEMINI, ...PENDING_CLOUD]);
if (unique.size !== EXPECTED_PUBLISHED_ARTICLES) {
  throw new Error('Cloud TTS rollout IDs must stay unique.');
}
if (![13, 14].includes(EXPECTED_PUBLISHED_ARTICLES)) {
  throw new Error('V4.21.5 expects 13 live articles during RC or 14 after the passport article is published.');
}
