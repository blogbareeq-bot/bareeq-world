# تطبيق إصلاح Bareeq V4.17.1

هذه حزمة إصلاح صغيرة تُطبّق فوق V4.17.0 الموجودة في المستودع. لا تحذف ملفات المشروع ولا تستبدل المجلد كاملًا هذه المرة.

## التطبيق

1. فك ضغط الحزمة.
2. افتح مستودع `bareeq-world` من GitHub Desktop وتأكد أن الفرع `main`.
3. اختر **Repository → Show in Explorer**.
4. انسخ **محتويات** مجلد `bareeq-world-v4.17.1-hotfix` إلى جذر المستودع ووافق على استبدال الملفات المتطابقة.
5. يجب أن يستقر الملف الرئيس في `bareeq-world\scripts\generate-audio.mjs`، لا داخل مجلد إضافي.
6. لا تغيّر متغيرات Cloudflare الحالية؛ يجب أن يبقى `BAREEQ_TTS_PROVIDER=gemini` ومفتاح `GEMINI_API_KEY` مشفرًا و`GEMINI_TTS_MIN_INTERVAL_MS=6500`.

## GitHub Desktop

### Summary

```text
feat: fix Gemini REST audio response parsing in v4.17.1
```

### Description

```text
Parse the current Gemini Interactions REST steps/model_output/audio response and pin Api-Revision 2026-05-20.
Replace the SDK-only output_audio mock with the official REST response shape and retain PCM-to-MP3 validation.
Preserve Sadaltager narration for all articles, synchronized highlighting, exact 30-day resume, bundled Cedar/Hamed rollback, and all prior launch fixes.
```

نفّذ **Commit to main** ثم **Push origin**، وراقب نشر Cloudflare حتى تظهر **Success**. لا تستخدم Retry على نشر V4.17.0 الفاشل؛ المطلوب نشر Commit الإصلاح الجديد.

## الاختبار بعد Success

ابدأ بمقال «عادات ثقافية من حول العالم»، واستمع إلى مقطع من البداية والوسط والنهاية. تحقق من مستوى الصوت، وعدم قراءة التعليمات أو المصادر، وتزامن تظليل الفقرات، ثم اختبر الجوال وسماعات الرأس.
