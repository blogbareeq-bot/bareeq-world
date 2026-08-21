# Bareeq V4.21.1 — FULL SOURCE REPLACE

هذه حزمة مصدر كاملة مبنية على آخر إصدار مستقر. تحتوي التصميم الأول المعتمد ومسار Gemini المجاني التدريجي، ولا تحتوي مفتاح API أو تسجيلًا جديدًا مأخوذًا من حسابك.

لا تحذف مجلد المستودع ولا مجلد `.git`.

## طريقة التطبيق

1. فك ضغط الحزمة.
2. افتح مجلد `bareeq-world-main` داخلها.
3. انسخ **كل محتوياته**.
4. الصقها داخل مجلد المشروع الحالي `bareeq-world`.
5. اختر **Replace files in the destination** عند الطلب؛ لا تحذف الملفات غير المعروضة يدويًا ولا تستبدل مجلد المستودع نفسه.
6. افتح GitHub Desktop وتأكد من أن الإصدار الظاهر في `package.json` هو `4.21.1`.
7. نفّذ Commit ثم Push مرة واحدة.
8. اترك Cloudflare يبدأ Deployment تلقائيًا، ولا تشغّل عدة عمليات Redeploy متزامنة.

## إعدادات Cloudflare قبل Push

- تأكد فقط من وجود `GEMINI_API_KEY` ضمن **Production Secrets**. لا ترسل قيمة المفتاح ولا تضعها في ملف أو Commit.
- لا يلزم إضافة متغير جديد لبدء المسار؛ `BAREEQ_GEMINI_FREE_ROLLOUT` يساوي `1` افتراضيًا.
- يمكن تثبيت الحد صراحةً عند الحاجة: `BAREEQ_GEMINI_FREE_ARTICLES_PER_BUILD=1`، ولا ترفعه.
- أبقِ `BAREEQ_CLOUD_TTS_ACTIVATE=0`؛ هذا هو مسار Google Cloud المدفوع المؤجل إلى ما بعد CNTXT.

## ماذا يحدث في كل نشر؟

1. تُستعاد تسجيلات Sadaltager المكتملة من الموقع الحي بلا إعادة توليد.
2. تُستعاد تسجيلات حامد/سيدر للمقالات التي لم يكتمل تحويلها.
3. إن كان مفتاح Gemini موجودًا، يُختار أقصر مقال غير مكتمل وتُجرى محاولة واحدة للمقال كله.
4. لا يُنشر التسجيل الجديد إلا إذا اكتملت كل أجزائه.
5. إذا ظهرت 429 أو انتهى وقت التوليد، يبقى الصوت السابق ويكتمل النشر بلا ملف جزئي.
6. في يوم لاحق، يكفي Redeploy واحد أو Push لاحق كي يحاول المقال التالي.

## بيانات GitHub Desktop

Summary:

`feat: release V4.21.1 progressive Gemini audio and design-one header`

Description:

`Release Bareeq V4.21.1 with the approved design-one header, a shortest-first one-article Gemini free-tier rollout, atomic 429-safe fallback preservation, protected Cloudflare email links, and updated local-storage privacy disclosure. Paid Cloud TTS remains locked pending CNTXT.`

## الإصدار

Bareeq V4.21.1 — Design One & Progressive Gemini Free-Tier Audio
