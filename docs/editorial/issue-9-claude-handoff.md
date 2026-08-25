## تسجيل بدء العمل — قسم Claude (منع تكرار الجهد)

**الفرع:** `arena/01a03a20-bareeq-world`
**الالتزام:** `39f81f972911900da91335e6ed52f52228d90ebb` (مدموج فوق قمة `audio/fahed-v4220` الحالية — `fa8207f`)
**النهج المختبر:** مسار ASR بديل وفق الأولوية §3 ثم §1 من قسمي: **Azure Speech STT بالمفاتيح الموجودة أصلاً في أسرار المشروع** (`AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` — صفر حصة Gemini)، ثم **سلسلة نماذج Gemini ذات حصص مستقلة** (`3.7 → 3.6 → 2.5-flash`) كخط ثانٍ.

### ما بُني (3 ملفات)

1. **`scripts/verify-gemini-pilot-transcript-fallback.mjs`** — بوابة تحقق متعددة المزودات مبنية على نفس البوابة المقطّعة المُراجَعة:
   - التمرير 1 عبر `azure-stt` (REST `conversation/cognitiveservices/v1`، صوت فقط WAV 16kHz mono — لا يُرسل أي نص)، والتمرير 2 عبر `gemini`. **تمريران مستقلان بمحركين مختلفين فعلياً**، بدل تمريرين بنفس النموذج.
   - عند استنفاد حصة نموذج Gemini (429 quota-exceeded): ينتقل فورًا لنموذج الحصة المستقلة التالي بدل حرق المحاولات.
   - عند فشل مزوّد كامل: يسقط الممرّ للمزوّد التالي في السلسلة (pass-level failover).
   - كل ما هو ممنوع **لم يُمَس**: نفس مقارن `arabic-lexical-exact-v1`، نفس عقد عدم تسريب النص (prompt عربي/إنجليزي مختلف لكل تمرير ولا يحوي المرجع)، نفس فحوص سلامة SHA-256 للـ MP3 والنص المرجعي، نفس التقسيم عند الصمت، ونفس بوابة `0 substitutions/deletions/insertions` مع رسالة الرفض نفسها. التقرير بنفس المخطط `bareeq.audio-transcript-verification.v1` + حقول `provider` لكل تمرير، ويُكتب في `scripts/speech-transcript-evidence/how-touchscreens-work-gemini-pilot-v1.fallback.json`.
2. **`scripts/test-gemini-pilot-fallback-contract.mjs`** — عقد offline بثلاثة سيناريوهات على mock محلي:
   - A: ممرّ azure + ممرّ gemini، طلبات صوتية فقط، لا تسريب، نجاح بصفر أخطاء.
   - B: كلمة واحدة مستبدلة في التفريغ ⇒ خروج غير صفري (البوابة لا تُتجاوز).
   - C: 429 حصة على `gemini-3.7-flash` ⇒ تقدّم تلقائي إلى `gemini-3.6-flash` ونجاح التمرير.
3. **`docs/deployments/verify-gemini-pilot-fallback-now.workflow.yml`** — workflow جاهز (فحوص offline + التشغيل الحي + artifact، **بدون** خطوة approve أو commit evidence — الاعتماد والدمج يبقيان معك).

### نتائج التشغيل المحلية (بيئتي، بدون أي مفاتيح)

```
Scenario A passed: azure-stt + gemini dual-provider verification, audio-only requests, zero word errors.
Scenario B passed: a single substituted word is rejected by the zero-error gate.
Scenario C passed: gemini quota exhaustion advances to the next independent model bucket and still verifies.
Gemini pilot fallback transcript contract passed: dual-provider chain, audio-only ASR requests, quota failover, and an unbypassable zero-error comparison.
Arabic transcript matcher passed: exact lexical comparison preserves ة ...      (اختباركم الحالي — بلا انحدار)
Gemini chunked audio transcript contract passed ...                            (اختباركم الحالي — بلا انحدار)
Speech Script inventory validated: 15 article(s); ... 0 article(s) allowed to synthesize.   (البوابة ما زالت مقفلة)
```

### عائق من طرفي يحتاج قرارك

توكن بيئتي GitHub App **بلا صلاحية `workflows`**، فدفع ملف إلى `.github/workflows/` مرفوض (رفض الخادم). لذلك الـ workflow مُدار مؤقتًا في `docs/deployments/`. للتفعيل من جهتك (لك صلاحية كاملة على `audio/fahed-v4220`):

```bash
git cherry-pick 39f81f9            # على audio/fahed-v4220 أو دمج الفرع
git mv docs/deployments/verify-gemini-pilot-fallback-now.workflow.yml .github/workflows/
# عدّل trigger إلى فرعك أو استخدم workflow_dispatch ثم push
```

### ملاحظتان

- تعذّر عليّ تنزيل logs التشغيل `32883039831` من بيئتي (قطع اتصال متكرر من CDN الخاص بـ Actions)؛ لكن artifact `gemini-pilot-36-report-32883039831` محفوظ عندكم وسيظهر فيه سبب فشل 3.6 — أرجو تأكيد أنه 429 حصة أيضًا وليس خطأ عقد.
- Azure STT يستهلك من رصيد Speech نفسه للمشروع؛ التكلفة التقديرية للتحقق الكامل: ~3.5 دقيقة صوت لكل تشغيل (ممرّان × 100 ثانية). إن كان المورد F0 فالحد 5 ساعات/شهر — كافٍ لعشرات التشغيلات.

### الخطوة التالية المقترحة

بعد تفعيلك الـ workflow: إن أعطى azure ممرًّا نظيفًا 0/0/0 وممرّ gemini فشل بالحصة، فالبوابة تُنجز بـ azure للممرّين (fallback يعالج ذلك تلقائيًا) — ويبقى قرار الاعتماد و`approve-gemini-test-clip.mjs` وفتح التوليد الكامل لك وفق معيار الإغلاق.
