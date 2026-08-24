# قائمة تدقيق النشر — مقال «لماذا تفتح بعض جوازات السفر أبواب العالم أكثر من غيرها؟»

**الإصدار:** `V4.21.5`  
**معرّف المقال:** `why-some-passports-are-stronger`  
**مفتاح الصوت:** `34e34b6f4633d928`  
**الحالة المعتمدة:** المقال منشور في المصدر، ويستخدم Azure Hamed مؤقتًا إلى أن يكتمل Gemini Sadaltager.

> الإنفوجرافيك مؤجل عمدًا ولا يدخل هذا الإصدار.

## 1. قفل المتن والنطق

**bodyHash النهائي:**

`2b2999dba95bff5e6bfb8ff16d2848fa3b677ffe8f595a5b6166ca15ebf7d4c1`

أي تعديل في جسم المقال يوجب إعادة حساب البصمة، وإعادة Speech Review، وإبطال Checkpoint الصوتي المرتبط بالنص السابق.

قواعد النطق المعتمدة في `scripts/speech-overrides.json` تشمل:

- `ETA` → `إِي تِي إِيه`
- `e-Visa` → `إِي فِيزَا`
- `Arton Capital` → `أَرْتُون كَابِيتَال`
- `Passport Index` → `بَاسْبُورْت إِنْدِكْس`
- `C-181/23` → `سِي 181 شَرْطَة 23`
- `وقعت الدولتان اتفاقية` → `وَقَّعَتِ الدولتان اتفاقية`
- `عد الآن إلى مشهد المطار` → `عُدِ الآن إلى مشهد المطار`
- `يخل بالتزاماتها` → `يُخِلُّ بالتزاماتها`

## 2. سياسة الصوت المؤقتة

البناء المعتاد يبقي المسارين التاليين متوقفين:

- `BAREEQ_GEMINI_FREE_ROLLOUT=0`
- `BAREEQ_CLOUD_TTS_ACTIVATE=0`

بعد استعادة الصوت المنشور للمقالات السابقة، يطبق `scripts/run-v4211-audio.mjs` السياسة التالية على مقال الجوازات فقط:

1. يحتفظ بتسجيل Gemini Sadaltager إذا كان مكتملًا وصالحًا.
2. إذا لم يكتمل Gemini، يستعيد تسجيل Azure Hamed المطابق من الموقع.
3. إذا لم توجد نسخة مطابقة بعد، يولّد Hamed بصوت `ar-SA-HamedNeural`.
4. يفرض `BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD=1` و`BAREEQ_AZURE_HAMED_ONLY=1`.
5. يوقف النشر إذا لم يكتمل أي من التسجيلين؛ لا يُنشر صوت جزئي.

ملف Hamed الناتج يجب أن يثبت:

- `provider = Microsoft Azure AI Speech`
- `model = Neural TTS`
- `language = ar-SA`
- `defaultVoice = hamed`
- صوت واحد فقط هو `ar-SA-HamedNeural`
- 81 كتلة تزامن فريدة
- تطابق الملفات والأحجام والمدد والبصمات

## 3. Checkpoint Gemini المحفوظ

محاولة Gemini لم تضِع ما أُنجز:

- الفرع: `arena/01a03318-bareeq-world`
- التشغيل: `32721164624`
- التقدم المحفوظ: **5 من 11 جزءًا**
- سبب التوقف: `HTTP 429`
- مفتاح Cache:
  `v4215-passport-audio-602472501b3fb1e966904e61b70db32a036059ba1d678db0822a48e2ed9c4570-32721164624-1`

لا تُعد تشغيل Gemini من `main` أو فرع الإصدار؛ لأن Cache فرعي. عند تجدد الحصة، شغّل Workflow `Generate passport article audio` يدويًا مع اختيار الفرع `arena/01a03318-bareeq-world`. سيستعيد أحدث Checkpoint ويبدأ من الجزء السادس.

## 4. اكتمال Gemini والاستبدال اللاحق

التسجيل النهائي البديل يجب أن يثبت:

- `provider = Google Gemini API`
- `model = gemini-3.1-flash-tts-preview`
- `language = ar`
- `defaultVoice = sadaltager`
- 11 جزءًا و11 ملف MP3
- 81 Sync ID فريدة
- تطابق `bytes` و`sha256` و`durationSeconds`
- نجاح Arabic Speech QA

بعد اكتماله على فرع Arena:

1. راجع المصطلحات الحساسة بالاستماع.
2. انقل **مجلد الصوت المكتمل فقط** إلى فرع جديد مبني على `main`؛ لا تدمج فرع Arena كاملًا.
3. شغّل فحوص V4.21.5 كاملة.
4. ادمج استبدال الصوت؛ سيصبح Sadaltager هو الافتراضي، ويتوقف مسار Hamed تلقائيًا عن التوليد.

## 5. فحوص النشر الحالية

يجب أن ينجح الآتي:

- 14 مقالًا منشورًا و14 صفحة مقال في `dist`.
- 14 Manifest صوتيًا مكتملًا.
- `check-arabic-speech`
- `check-audio-dist`
- `check-dist`
- بوابات V4.20 حتى V4.21.5.
- responsive وcontrast وinteractions وmobile ticker.
- الصفحة، sitemap، canonical، Schema وSocial Card.
- التشغيل، Seek-to-text، وحفظ موضع الاستماع.

## 6. ممنوع

- لا نشر لملف Gemini جزئي.
- لا حذف فرع Arena أو Cache قبل اكتمال Sadaltager ونقله بأمان.
- لا إعادة توليد المقالات القديمة.
- لا تشغيل Gemini من فرع غير فرع Checkpoint.
- لا توسيع Azure لأكثر من مقال الجوازات في هذا الإصدار.
- لا إعادة الإنفوجرافيك أو الطبقات التجريبية المؤجلة.

## 7. حكم الإصدار

يصبح الإصدار `READY TO PUBLISH` عندما يكتمل بناء Cloudflare مع تسجيل Hamed المؤقت، وتجتاز الصفحة والصوت فحوص الإنتاج. اكتمال Gemini تحسين لاحق لا يمنع النشر الحالي.
