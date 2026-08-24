# قائمة تجهيز ونشر — «كيف تعرف شاشة هاتفك أين وضعت إصبعك؟»

**Article ID:** `how-touchscreens-work`  
**التصنيف:** `ببساطة…` / `simply`  
**السلسلة:** `technology-simply`  
**الحالة:** `draft: true`  
**bodyHash المعتمد وفق خوارزمية `check-arabic-speech.mjs`:** `ee0b9101dc6d37f9df4173aad732a993e884ecc1c2f062bba8ce3766f70c1208`  
**Audio key:** `de93f3d9f91c8b8b`

## 1) قفل النص

- النص النهائي محفوظ في `src/content/posts/how-touchscreens-work.md`.
- لا يُعدّل المتن بعد اعتماد `bodyHash` إلا مع إعادة التدقيق وتحديث Speech Review وإبطال أي صوت مولد للنص السابق.
- المراجع لا تُقرأ صوتيًا لأن `generate-audio.mjs` يحذف قسم المصادر قبل بناء النص الصوتي.
- `publishedAt` قيمة مرحلية فقط؛ تُحدّث إلى وقت النشر الحقيقي عند تحويل `draft:false`.

## 2) المصادر المعتمدة

1. Microchip — TB3064: مرجع مباشر لنظرية Projected Capacitive Touch.
2. Texas Instruments — CapTIvate Capacitive Sensing Basics: مرجع مباشر لـ self/mutual capacitance وTx/Rx.
3. Texas Instruments — CapTIvate Design Guide: مرجع مباشر لتأثير الرطوبة وطرق moisture/spill rejection.
4. Wacom — Key Technologies: مرجع مباشر لـ EMR وActive ES والقلم غير المحتاج إلى بطارية.

تم استبعاد الروابط العامة والعناوين غير المتحقق من وجودها.

## 3) الأصول البصرية المطلوبة

الاسم الموحد: `how-touchscreens-work`

- المصدر الرئيسي: `public/images/posts/how-touchscreens-work.webp` — 1600×900.
- مصدر المصغرة: `assets/thumbnails-source/how-touchscreens-work.webp` — يفضّل 1600×900.
- `npm run generate:images` يولد تلقائيًا:
  - Hero responsive: 320 / 640 / 960 / 1280 WebP.
  - Thumbnails: 320 / 640 / 960 / 1280 WebP بنسبة 16:9.
  - Social card: 1200×630 JPG.

### التوجيه البصري

مشهد تقني نظيف وغير مزدحم: هاتف حديث في منظور مقطعي رقيق، إصبع يقترب من الزجاج، وتحت السطح شبكة Tx/Rx شفافة تتقاطع مع تمثيل لطيف للمجال الكهربائي حول نقطة اللمس. هوية بريق: كحلي/تركوازي مع لمسة ضوء دافئة، واقعية تحريرية راقية، بلا نص داخل الصورة وبلا واجهات أو شعارات شركات.

## 4) النطق والتوليد الصوتي

- ملف المراجعة المشكول: `docs/editorial/how-touchscreens-work.tts-ar.md`.
- قواعد النطق الجاهزة: `docs/editorial/how-touchscreens-work.production.json`.
- قبل التوليد تُدمج `speechOverrides` في `scripts/speech-overrides.json`.
- قبل `draft:false` تُدمج `speechReview` في `scripts/speech-review.json` ويُسمح بالمراجعة قبل النشر إذا كان المقال سيولد وهو Draft.
- صوت النشر الحالي عند عدم توفر حصة Gemini: Microsoft Azure AI Speech / `ar-SA-HamedNeural` / `ar-SA`.
- يبقى Gemini Sadaltager هدف الاستبدال اللاحق فقط؛ أي أجزاء مكتملة تُحفظ في Checkpoint ولا تُنشر جزئيًا.
- لا يتوقف نشر المقال انتظارًا لتجدد الحصة: يُستخدم حامد مباشرة، ثم يُستبدل ذريًا بعد اكتمال Gemini كاملًا.
- لا يُخلط مزودان داخل المقال نفسه.

## 5) بوابات ما قبل الصوت

- Frontmatter مطابق لـ `src/content.config.ts`.
- العنوان والوصف وquickSummary نهائية.
- لا توجد طبقة «فكرة تبقى معك» أو أي طبقات تجريبية مؤجلة.
- المصادر مباشرة ومحددة.
- `node scripts/check-arabic-speech.mjs` يجب أن ينجح بعد دمج مراجعة النطق.
- تشغيل خطة فقط قبل استهلاك الحصة:
  `BAREEQ_TTS_PROVIDER=gemini BAREEQ_TTS_INCLUDE_IDS=how-touchscreens-work node scripts/generate-audio.mjs --plan`

## 6) شروط AUDIO READY

يجب أن يظهر:
`public/audio/articles/de93f3d9f91c8b8b/manifest.json`

ثم التحقق من:
- `articleId = how-touchscreens-work`
- provider/model/language/voice الصحيحة
- جميع الأجزاء وملفات MP3 موجودة
- `bytes` و`sha256` و`durationSeconds` صحيحة
- Sync IDs فريدة وكاملة
- نجاح Arabic Speech QA
- استماع يدوي فعلي للمصطلحات الأجنبية والجمل الحساسة

## 7) النشر

بعد اكتمال الصورة والصوت والاستماع:
1. تحديث `publishedAt` إلى وقت النشر الحقيقي.
2. تحويل `draft:false`.
3. تشغيل `npm ci` ثم `npm run build`.
4. نجاح `check-audio-dist`, `check-dist`, responsive, contrast, interactions, mobile ticker, tablet audio, launch readiness وبوابات الإصدار.
5. فحص صفحة المقال على الجوال/التابلت/سطح المكتب.
6. التحقق من canonical وSchema وsitemap وSocial Card.
7. التحقق من التشغيل، Seek-to-text، حفظ موضع الاستماع.
8. لا Merge/Deploy إلى `main` إلا بعد نجاح جميع البوابات واعتماد النشر.
