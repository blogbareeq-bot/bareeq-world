# AGENTS.md — تعليمات العمل في مستودع «عالم بريق»

هذا الملف يوحّد تعليمات العمل على مصنع الصوت والنشر. أُنشئ في 2026-08-26 لأنه لم يكن موجودًا قبل ذلك.

## حدود عامة

- لا تعدّل تصميم الموقع أو صور المقالات أو النص الظاهر للزائر أثناء مهام الصوت.
- المسموح تعديله في مهام الصوت: النص المنطوق وتشكيله (Speech Scripts)، ملفات الصوت، manifests المزامنة، سكربتات المصنع والتحقق، وإعدادات النشر المرتبطة بالمهمة.
- لا تُحذف الأصوات المنشورة المعتمدة؛ تبقى كنسخة رجوع (bundled lock + production cache) حتى تثبت النسخة الجديدة في الإنتاج.
- Google Cloud TTS المدفوع معطل دائمًا (`BAREEQ_CLOUD_TTS_ACTIVATE=0`). لا تُضف مزودًا مدفوعًا أو تكلفة جديدة.
- لا تُطبع مفاتيح أو أسرار؛ فحص وجود الأسرار يكون بـ PRESENT/ABSENT فقط.

## مسارات الصوت الأساسية

- `src/content/posts/` — المقالات (المصدر الوحيد للنص).
- `scripts/speech-scripts/<articleId>.json` — النص المنطوق المعتمد + `scriptHash = sha256(JSON.stringify(segments))` + سجلات المراجعة لكل مقطع.
- `scripts/speech-test-clips/<articleId>.json` — خطة مقطع الاختبار السداسي/الخماسي + بوابة الاستماع (`testClipPassed`, `fullSynthesisAllowed`) مرتبطة بـ `speechScriptHash`.
- `scripts/contextual-ambiguities.json` — قواعد الكلمات متعددة القراءات؛ أي occurrence غير مشكَّل بتشكيل قراءة معتمدة = خطأ بوابة.
- `scripts/generate-audio.mjs` — المولّد (gemini / azure / azure-fahed / openai / google-cloud / bundled) مع بوابة `speech-synthesis-gate.mjs`.
- `scripts/gemini-checkpoints/<key>-<hash>-<model>/` — نقاط استئناف التوليد عبر التشغيلات.
- `public/audio/articles/<audioKey>/` — الصوت النهائي + manifest؛ `audioKey = sha256(articleId).slice(0,16)`.
- `audio-releases/azure-hamed-live-20260815/` — قفل Hamed القديم (10 مقالات) للرجوع.
- `audio-releases/cultural-habits-world/` — إصدار OpenAI Cedar لمقال العادات (رجوع).
- `scripts/speech-transcript-evidence/` — أدلة ASR (لا يُنشر شيء بدون دليل صفر أخطاء).
- `scripts/audio-candidates/` — مرشحون لم يجتازوا البوابة (لا تُستورد إلى public/ أبدًا).
- `scripts/audio-queue/current.json` — طابور التوليد (مقال واحد لكل دورة).
- `scripts/provider-probes/` — أدلة استكشاف المزودين والنماذج.

## ترتيب المزودين المعتمد

1. إعادة استخدام أي صوت مخزن اجتاز الجودة كاملًا.
2. Gemini TTS `gemini-3.1-flash-tts-preview` بصوت `Sadaltager` (المسار الأساسي؛ نموذج واحد لكل مقال).
3. نماذج Gemini TTS الأخرى فقط بعد إثبات توفرها للنموذج الحالي بنجاح عينة فعلية (يُوثق في provider-probes).
4. بعد استنفاد Gemini: مسار Microsoft — القرار الأساسي للمستخدم صوت `ar-KW-FahedNeural` (فهد)؛ لا يُستبدل بـ `ar-SA-HamedNeural` إلا بقرار موثق. Fahed رُفض في مراجعة استماع 2026-08-25 (بتر تاء مربوطة) وبقي البديل المعلّق؛ Hamed فشل في بوابة صفر الأخطاء للمقال الكامل (2026-08-26).

## بوابة الجودة الإلزامية قبل النشر

1. تقني: `node scripts/check-audio-technical.mjs <articleId>` — فك ترميز كامل، بلا clipping، اتساق مستوى، صمت طبيعي.
2. مطابقة نصية: `node scripts/verify-article-full.mjs` — نموذجا ASR مستقلان (gemini-3.6-flash + gemini-3.5-flash) بصفر حذف/إضافة/استبدال، + Whisper large-v3 كدليل ثانٍ، + فحص مشكَّل للكلمات عالية الخطورة.
3. المزامنة: manifest يُبنى من الملفات النهائية فقط؛ بوابات dist (`check-audio-dist.mjs` داخل `npm run build`).
4. الذرية: الصوت + manifest + أدلة QA في التزام واحد؛ لا تُنشر ملفات صوت دون manifest.
5. عند أي فشل: يبقى الصوت السابق منشورًا، ويُحفظ المرشح في `scripts/audio-candidates/` مع سبب الرفض.

## النشر

- الفرع الآمن للدفع هو فرع الجلسة؛ الدمج إلى `main` عبر PR فقط بعد نجاح CI (`build-check-v4221.yml` يشغّل `npm run build` الكامل).
- Cloudflare Pages يبني من `main` تلقائيًا؛ التحقق النهائي من `https://bareeqworld.com` (manifest + mp3 + headers) وليس من نجاح Workflow فقط.
- البناء الإنتاجي يعيد الصوت من Production Cache؛ أي صوت مُلتزم في المستودع يجب أن يكون كاملًا ومطابقًا للعقد حتى لا يُستبدل.

## أوامر تحقق سريعة

```bash
npm run audit:audio        # بوابات النص الصوتي والعقود
npm run audit:v4216        # بوابات الإصدار
node scripts/check-speech-scripts.mjs
node scripts/create-audio-inventory.mjs [--production --json out.json]
```
