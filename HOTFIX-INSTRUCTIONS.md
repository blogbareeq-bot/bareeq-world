# V4.17.2 Hotfix A — Mixed-Audio Interaction Audit

هذا الإصلاح يُطبّق فوق إصدار **V4.17.2** الحالي، ولا يغيّر إعدادات Cloudflare أو مفتاح Gemini.

## التطبيق

1. افتح مجلد `bareeq-world` الموجود داخل هذه الحزمة.
2. انسخ **محتويات المجلد الداخلي** إلى مجلد `bareeq-world` المحلي ووافق على استبدال الملفين الموجودين.
3. تأكد في GitHub Desktop أن التغييرات هي:
   - `scripts/check-interactions.mjs`
   - `scripts/check-v4172-release.mjs`
4. أنشئ الالتزام بالبيانات أدناه، ثم اضغط **Push origin**.
5. انتظر النشر التلقائي الجديد في Cloudflare Pages. لا تستخدم **Retry deployment** للبناء السابق.

## GitHub Desktop

**Summary**

`fix: align interaction audit with mixed audio pilot`

**Description**

```text
Validate the cultural-habits player from its inline Sadaltager manifest instead of assuming Cedar.
Treat the other ten articles as bundled Hamed fallbacks when Gemini pilot mode is active.
Preserve manifest-driven seek, synchronization, 30-day resume, and all V4.17.2 production safeguards.
```

## اسم الإصدار

`V4.17.2 Hotfix A — Mixed-Audio Interaction Audit`

## النتيجة المتوقعة

يبني Gemini ثلاث قطع صوتية لمقال العادات الثقافية بصوت Sadaltager، وتبقى المقالات العشرة الأخرى على Hamed، ثم يمر فحص التفاعل المعتمد على البيان وينجح النشر.
