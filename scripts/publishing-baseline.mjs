export const LEGACY_AUDIO_BASELINE = Object.freeze([
  'ai-agents-future-now',
  'ai-as-coworker-future-of-human-work',
  'altadakhom-explained-simply',
  'how-touchscreens-work',
  'intuition-first-impression-decisions-signature',
  'language-soft-power-politics',
  'why-some-passports-are-stronger',
  'اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا',
  'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع',
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا',
  'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء',
  'كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار',
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه',
  'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون',
  'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء',
]);

export const LEGACY_AUDIO_BASELINE_SET = new Set(LEGACY_AUDIO_BASELINE);

export function assertLegacyBaselinePublished(publishedIds, label = 'publication gate') {
  const ids = new Set(publishedIds);
  const missing = LEGACY_AUDIO_BASELINE.filter((id) => !ids.has(id));
  if (missing.length) {
    throw new Error(`${label}: protected 15-article baseline is missing: ${missing.join(', ')}`);
  }
}

export function isPostBaselineArticle(articleId) {
  return !LEGACY_AUDIO_BASELINE_SET.has(articleId);
}
