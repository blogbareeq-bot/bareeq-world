# Bareeq V4.21.0 — FULL SOURCE REPLACE

هذه حزمة مصدر كاملة مبنية على آخر حزمة مستقرة مرفقة، وليست ملفات صوت مولّدة حديثًا.

لا تحذف مجلد المشروع، ولا تستبدل المستودع كاملًا.

## طريقة التطبيق
1. فك ضغط الحزمة.
2. افتح مجلد `bareeq-world-main`.
3. انسخ **كل محتوياته**.
4. الصقها داخل مجلد المشروع الحالي `bareeq-world`.
5. اختر **Replace files in the destination** عند الطلب.
6. افتح GitHub Desktop وتأكد من ظهور الملفات المعدلة/الجديدة فقط.
7. نفّذ Commit ثم Push مرة واحدة.
8. اترك Cloudflare يبدأ Deployment تلقائيًا؛ لا تضغط Redeploy عدة مرات.

## سياسة الصوت في V4.21.0 قبل CNTXT

- اترك `BAREEQ_CLOUD_TTS_ACTIVATE=0` أو لا تضفه؛ عندها تبقى سياسة V4.20 الحالية كما هي ولا يرسل البناء أي طلب Cloud TTS.
- لا تضف بيانات اعتماد قبل ربط CNTXT Billing بالمشروع `bareeq-tts` والتحقق من API وIAM.
- بعد التفعيل المتعمد فقط: يحتفظ البناء بمقالي Sadaltager المكتملين من Production Cache ويولّد/يستعيد 11 مقالًا عبر Cloud Text-to-Speech، ويفشل مغلقًا إذا لم يكتمل أي مقال.
- لا تنفّذ Push متكررًا ولا Redeploy متزامنًا أثناء التوليد الأول.

## الإصدار
Bareeq V4.21.0 — Audio UX & Pre-CNTXT Cloud TTS Readiness
