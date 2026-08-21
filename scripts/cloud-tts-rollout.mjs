export const RETAINED_GEMINI = [
  'ai-agents-future-now',
  'ai-as-coworker-future-of-human-work',
];

export const PENDING_CLOUD = [
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

if (new Set([...RETAINED_GEMINI, ...PENDING_CLOUD]).size !== 13) {
  throw new Error('Cloud TTS rollout sets must contain exactly 13 unique published article IDs.');
}
