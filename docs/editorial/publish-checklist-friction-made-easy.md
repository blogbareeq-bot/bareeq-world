# قائمة تجهيز ونشر — «الاحتكاك ببساطة: لماذا نؤجل العادات الجيدة وكيف نجعلها أسهل؟»

**Article ID:** `friction-made-easy`
**التصنيف:** `ببساطة…` / `simply`
**السلسلة:** لا توجد (مقال مستقل داخل القسم)
**الحالة:** `draft: true` (منشور مبدئيًا كمسودة حتى اكتمال المسار الصوتي)
**الروابط التجارية:** روابط تسويق بالعمولة عبر Amazon.sa بمعرّف مؤقت `bareeqworld-21`

## 1) قفل النص

- النص النهائي في `src/content/posts/friction-made-easy.md`.
- لا يُعدَّل المتن بعد اعتماد `bodyHash` إلا مع إعادة التدقيق وتحديث Speech Review وإبطال أي صوت مولّد للنص السابق.
- قسم «المصادر والمراجع» لا يُقرأ صوتيًا؛ `generate-audio.mjs` يحذفه قبل بناء النص الصوتي.
- `publishedAt` قيمة مرحلية (2026-09-08)؛ تُحدَّث إلى وقت النشر الحقيقي عند تحويل `draft: false`.

## 2) المصادر المعتمدة

1. BJ Fogg — `behaviormodel.org` (النموذج السلوكي: الدافع + القدرة + المحفّز).
2. James Clear — «Atomic Habits» (القاعدة الثالثة: اجعل العادة سهلة).
3. برنامج شركاء أمازون السعودية — جدول عمولة الإعلان الرسمي (لأغراض الإفصاح وبنية الروابط، لا كادعاء في المتن).

## 3) الأصول البصرية (جاهزة)

الاسم الموحد: `friction-made-easy`

- المصدر الرئيسي: `public/images/posts/friction-made-easy.webp` — 1600×900.
- مصدر المصغرة: `assets/thumbnails-source/friction-made-easy.webp` — 1600×900.
- `npm run generate:images` يولّد تلقائيًا المقاسات المستجيبة والمصغرات وبطاقة المشاركة الاجتماعية.

## 4) النطق والتوليد الصوتي (متبقٍّ)

يتبع نفس مسار المقالات السابقة:

1. توليد نموذج المقاطع الصوتية ومخطوطة الكلام: `node scripts/generate-audio.mjs --sync-plan` للتحقق من البنية.
2. إعداد ملف مراجعة النطق المشكول في `docs/editorial/` ودمج التصحيحات في `scripts/speech-overrides.json` و`scripts/speech-review.json`.
3. تشغيل خطة فقط قبل استهلاك الحصة:
   `BAREEQ_TTS_PROVIDER=gemini BAREEQ_TTS_INCLUDE_IDS=friction-made-easy node scripts/generate-audio.mjs --plan`
4. التوليد الفعلي بصوت النشر المعتمد (Azure Hamed `ar-SA-HamedNeural` عند غياب حصة Gemini)، ثم استماع يدوي فعلي.
5. التأكد من ظهور `public/audio/articles/<audioKey>/manifest.json` ببيانات صحيحة.

## 5) بوابات ما قبل النشر

- Frontmatter مطابق لـ `src/content.config.ts` (تحقق يدوي).
- العنوان والوصف وquickSummary نهائية.
- وسمان فقط `["عادات", "تنظيم"]` من دون تكرار اسم القسم.
- رابط داخلي سياقي موجود (المقالات ذات الصلة) وروابط خارجية مباشرة موجودة.
- الإفصاح التجاري ظاهر قرب الروابط.
- نجاح `node scripts/bareeq-arabic-qa.mjs --all` بعد الإضافة.

## 6) شروط النشر

1. تحديث `publishedAt` إلى وقت النشر الحقيقي.
2. تحويل `draft: false` **بعد** اكتمال الصوت والاستماع اليدوي.
3. إدخال المقال في خط التوليد الصوتي: إضافة `friction-made-easy` إلى قائمة `BASE_PENDING_CLOUD` في `scripts/cloud-tts-rollout.mjs`، وتوسيع حدود العدّادات من `[13, 14, 15]` إلى `[13, 14, 15, 16]` في: `cloud-tts-rollout.mjs` و`check-audio-dist.mjs` و`check-v4200-release.mjs` و`check-v4210-release.mjs` و`check-v4211-release.mjs` و`check-v4212-release.mjs` و`check-v4215-release.mjs` و`check-v4216-release.mjs`، وتوسيع حد `PENDING_CLOUD.length` من `[11, 12, 13]` إلى `[11, 12, 13, 14]` في `check-v4210-release.mjs` و`check-v4211-release.mjs`.
4. تشغيل `npm ci` ثم `npm run build` حتى نجاح كل البوابات.
5. فحص صفحة المقال على الجوال والتابلت وسطح المكتب، والتحقق من canonical وSchema وsitemap وSocial Card، وتشغيل الصوت وSeek-to-text وحفظ موضع الاستماع.
6. لا Merge/Deploy إلى `main` إلا بعد نجاح جميع البوابات واعتماد النشر.

## 7) ملاحظة الروابط التجارية

- قبل النشر يستبدل المعرّف المؤقت `bareeqworld-21` بمعرّف حساب شركاء أمازون السعودية الفعلي في الروابط الثلاثة (المنبّه، مشابك الكابلات، محطة Anker 675).
- يستبدل الرابط المجرد `nordpass.com` برابط الإحالة الصادر من برنامج NordPass (عبر Impact أو البرنامج المباشر) فور اعتماد الحساب.
- تُراجع صفحة سياسة التحرير لتعكس وجود الروابط التابعة بصورة صريحة (تم التحديث في هذه الحزمة).
