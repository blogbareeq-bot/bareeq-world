# Bareeq V4.17.2 — Gemini One-Article Pilot Hotfix

هذه حزمة إصلاح صغيرة تُطبّق فوق مستودع `bareeq-world` الحالي بعد V4.17.1. لا تحذف المشروع ولا تفك الحزمة بمجلد متداخل داخله.

## التطبيق

1. فك الحزمة في مجلد مستقل.
2. افتح المجلد `bareeq-world-v4.17.2-gemini-one-article-pilot-hotfix`.
3. حدد كل محتوياته، ثم انسخها فوق جذر مستودع `bareeq-world` الذي يحتوي `.git`.
4. وافق على استبدال الملفات. لا تحذف أي ملف أو مجلد من المستودع.
5. في GitHub Desktop راجع التغييرات، ثم Commit وPush إلى `main`.

## النتيجة المتوقعة

- Gemini + Sadaltager: مقال «عادات ثقافية مدهشة من حول العالم» فقط.
- خطة التوليد: 3 طلبات، 2,914 حرفًا.
- بقية المقالات: عشرة مقالات بصوت Hamed المدمج.
- لا تُغيّر متغيرات Cloudflare الحالية.

إذا عرض سجل Cloudflare خطة `70 new request(s)`، أوقف البناء؛ فهذا يعني أن الحزمة لم تُنسخ فوق جذر المستودع بشكل صحيح.

## GitHub Desktop

### Summary

```text
feat: limit Gemini TTS to one pilot article in v4.17.2
```

### Description

```text
Generate Sadaltager audio only for the cultural-habits article using three Gemini REST requests.
Keep bundled Azure Hamed audio for the other ten articles and enforce the pilot boundary in production audits.
Preserve PCM-to-MP3 conversion, synchronized highlighting, exact 30-day resume, and instant bundled rollback.
```

### اسم الإصدار

```text
V4.17.2 — Gemini One-Article Pilot
```

للتفاصيل راجع `docs/دليل-النشر-والرجوع-v4.17.2.md`.
