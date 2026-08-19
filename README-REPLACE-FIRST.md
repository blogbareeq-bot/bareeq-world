# Bareeq V4.20.0 — FINAL REPLACE PATCH

هذه **حزمة Patch/Replace** فوق النسخة الحالية الناجحة في Cloudflare عند commit:
`77306a99b8483f8c9656d2b4b9d409e94c26da30`

لا تحذف مجلد المشروع، ولا تستبدل المستودع كاملًا.

## طريقة التطبيق
1. فك ضغط الحزمة.
2. افتح مجلد `BAREEQ_V4.20.0_FINAL`.
3. انسخ **كل محتوياته**.
4. الصقها داخل مجلد المشروع الحالي `bareeq-world`.
5. اختر **Replace files in the destination** عند الطلب.
6. افتح GitHub Desktop وتأكد من ظهور الملفات المعدلة/الجديدة فقط.
7. نفّذ Commit ثم Push مرة واحدة.
8. اترك Cloudflare يبدأ Deployment تلقائيًا؛ لا تضغط Redeploy عدة مرات.

## سياسة الصوت في V4.20.0

### المقالات القديمة
- المقالات السبعة التي تغيرت في V4.19: **Production Cache فقط**.
- لا يُسمح بإعادة توليد Azure لها في هذا الإصدار.
- تم إصلاح توافق استعادة manifests ذات Hamed-only التي نتجت في V4.19.
- مقال `ai-agents-future-now` ذو Sadaltager: استعادة Gemini من Production Cache فقط.

### المقال الجديد «الزميل»
الترتيب الإلزامي:

`Production Cache → Gemini Sadaltager → Azure Hamed fallback → Safety Stop`

- Gemini يستهدف المقال الجديد فقط.
- إذا وجد Gemini تسجيلًا مطابقًا في Production Cache يعاد استخدامه بلا API.
- إذا لم يوجد، يحاول Sadaltager.
- إذا فشل Gemini أو توقف بسبب 429/الحصة/المفتاح/الميزانية/الاستجابة، ينتقل تلقائيًا إلى Azure Hamed **للمقال الجديد وحده**.
- Azure يحاول كاش الإنتاج أولًا قبل أي توليد جديد.
- إذا فشل الاثنان، يفشل البناء ولا ينشر مقالًا بلا صوت متوافق.

## الإصدار
Bareeq V4.20.0 — Coworker Article & Safe Gemini→Azure Fallback
