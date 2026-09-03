# Run #44 diagnosis

Generated: 2026-09-03T15:10:05.910Z
Diagnosed run: 33766919807 job 100687055011
Full log lines recovered: 539

## Campaign state
generationComplete=true validationComplete=false publicationComplete=false
articles=15 validatedExact0000=3

| article | gen | validation | bound | consensus |
| --- | --- | --- | --- | --- |
| ai-agents-future-now | generated | validated | true | 0/0/0/0 |
| ai-as-coworker-future-of-human-work | generated | validated | true | 0/0/0/0 |
| altadakhom-explained-simply | generated | validated | true | 0/0/0/0 |
| how-touchscreens-work | generated | failed | true | - |
| intuition-first-impression-decisions-signature | generated | null | false | - |
| language-soft-power-politics | generated | null | false | - |
| why-some-passports-are-stronger | generated | null | false | - |
| اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا | generated | null | false | - |
| اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع | generated | null | false | - |
| اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا | generated | null | false | - |
| عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء | generated | null | false | - |
| كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار | generated | null | false | - |
| كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه | generated | null | false | - |
| لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون | generated | null | false | - |
| لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء | generated | null | false | - |

## Touchscreen checkpoint parts
- part 1: targeted=true hint=true transport="developer-interactions" completedAt=null
- part 2: targeted=true hint=true transport="developer-interactions" completedAt=null
- part 3: targeted=true hint=true transport="developer-interactions" completedAt=null
- part 4: targeted=true hint=true transport="developer-interactions" completedAt=null
- part 5: targeted=true hint=true transport="developer-interactions" completedAt=null
- part 6: targeted=true hint=true transport="developer-interactions" completedAt=null

## Provider probes
- openrouter-credits: ok=true http=200 balance=0.5383070419999996 pcmBytes=- respBytes=- body={"data":{"total_credits":25,"total_usage":24.461692958}}
- openrouter-speech: ok=true http=402 balance=- pcmBytes=- respBytes=- body={"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402,"metadata":{"limit_source":"openrouter_credits","remedy_hint":"Add credits at https://openr
- gemini-generate-content-tts: ok=true http=200 balance=- pcmBytes=- respBytes=154369
- gemini-interactions-tts: ok=true http=200 balance=- pcmBytes=- respBytes=162294

## Step 12 signal lines
```
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.0571970Z ^[[36;1m      echo "TARGETED_TTS article=how-touchscreens-work part=${part} transport=${transport} attempt=${attempt}"^[[0m
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.0573263Z ^[[36;1m      if BAREEQ_FORCE_TTS_PARTS="${part}" BAREEQ_TARGETED_TTS_TRANSPORT="${transport}" node scripts/audio-touchscreen-targeted-regenerate.mjs --article=how-touchscreens-work; then^[[0m
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.0576217Z ^[[36;1m    echo "TARGETED_TTS_EXHAUSTED article=how-touchscreens-work part=${part}" >&2^[[0m
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.0576667Z ^[[36;1m    exit 75^[[0m
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.0581073Z ^[[36;1mconst checkpoint = JSON.parse(fs.readFileSync(path.join('audio-candidates',articleId,fp,'checkpoint.json'),'utf8'));^[[0m
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.0582057Z ^[[36;1m  const rec = checkpoint.completedParts?.[String(index)];^[[0m
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.0582833Z ^[[36;1m  if (rec?.targetedRegeneration !== true || rec?.correctionHintApplied !== true) throw new Error(`targeted touchscreen correction missing for part ${index + 1}`);^[[0m
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.0628318Z   OPENROUTER_API_KEY: ***
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.0635348Z   BAREEQ_TTS_CORRECTION_HINTS_JSON: {"1":"Read the reviewed Arabic transcript verbatim. The remaining confirmed error in this part is «مَلَاءَمَة»: pronounce it slowly as مَ-لَا-ءَ-مَة, with a clearly audible hamza after the long alif; never say «مُلَائِمَة» or «ملائمة». Then say «لِلْمَس» exactly, without an extra lam. Keep prior corrections too: «الشَّاشَة» singular, «تَعْنِي» with ن, «كَثِيرًا» with its final an sound, and the final word «الْيَوْم». Preserve every written t
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.0734330Z TARGETED_TTS article=how-touchscreens-work part=1 transport=developer-interactions attempt=1
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:27:49.5666485Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 10.496951431s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:29:04.6135559Z TARGETED_TTS article=how-touchscreens-work part=1 transport=developer-interactions attempt=2
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:29:05.0448239Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 54.994300204s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:30:20.0897199Z TARGETED_TTS article=how-touchscreens-work part=1 transport=developer-interactions attempt=3
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:30:20.5266260Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 39.523694812s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:31:35.5722507Z TARGETED_TTS article=how-touchscreens-work part=1 transport=developer-interactions attempt=4
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:31:36.0442249Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 24.004029212s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:32:51.0900451Z TARGETED_TTS article=how-touchscreens-work part=1 transport=developer-interactions attempt=5
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:32:51.5167418Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 8.521838611s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:34:06.5618733Z TARGETED_TTS article=how-touchscreens-work part=1 transport=developer-interactions attempt=6
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:34:06.9852897Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 53.056870682s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:35:22.0305691Z TARGETED_TTS article=how-touchscreens-work part=1 transport=developer-interactions attempt=7
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:35:22.5149044Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 37.532896917s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:36:37.5211022Z TARGETED_TTS article=how-touchscreens-work part=1 transport=developer-interactions attempt=8
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:36:37.9562014Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 22.087040271s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:37:53.0029437Z TARGETED_TTS article=how-touchscreens-work part=1 transport=developer-interactions attempt=9
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:39:24.0788848Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-interactions attempt=1
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:39:24.5104747Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 35.536325789s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:40:39.5562620Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-interactions attempt=2
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:40:39.9945340Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 20.054649943s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:41:55.0392598Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-interactions attempt=3
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:41:55.5307477Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 4.519420425s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:43:10.5368195Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-interactions attempt=4
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:43:10.9944520Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 49.048517515s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:44:26.0005539Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-interactions attempt=5
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:44:26.4403901Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 33.601101549s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:45:41.4462322Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-interactions attempt=6
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:45:41.9166233Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 18.125160854s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:46:56.9616799Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-interactions attempt=7
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:46:57.4131988Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 2.629858832s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:48:12.4587006Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-interactions attempt=8
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:48:12.8785684Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 47.161725385s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:49:27.9262050Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-interactions attempt=9
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:49:28.3657288Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 31.672591316s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:50:43.4119510Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-interactions attempt=10
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:50:43.8815300Z Gemini TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 16.161209715s.","retryDelay":null,"quota":[]}
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:51:58.9281525Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-generate-content attempt=1
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:51:59.2716001Z Gemini generateContent TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 769.285408ms.","retryDelay":"0s","qu
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:53:14.3167552Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-generate-content attempt=2
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:53:14.7548154Z Gemini generateContent TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 45.28366467s.","retryDelay":"45s","q
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:54:29.7997933Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-generate-content attempt=3
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:54:30.1305600Z Gemini generateContent TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 29.910189825s.","retryDelay":"29s","
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:55:45.1761449Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-generate-content attempt=4
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:55:45.5657441Z Gemini generateContent TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 14.47190098s.","retryDelay":"14s","q
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:57:00.6164048Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-generate-content attempt=5
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:57:00.9322990Z Gemini generateContent TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 59.10290747s.","retryDelay":"59s","q
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:58:15.9764722Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-generate-content attempt=6
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:58:16.3073904Z Gemini generateContent TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 43.727813211s.","retryDelay":"43s","
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:59:31.3524525Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-generate-content attempt=7
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T14:59:31.7034237Z Gemini generateContent TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 28.341231421s.","retryDelay":"28s","
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T15:00:46.7104509Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-generate-content attempt=8
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T15:00:47.0779394Z Gemini generateContent TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 12.96215229s.","retryDelay":"12s","q
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T15:02:02.1220970Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-generate-content attempt=9
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T15:02:02.4917024Z Gemini generateContent TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 57.54796171s.","retryDelay":"57s","q
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T15:03:17.5373724Z TARGETED_TTS article=how-touchscreens-work part=2 transport=developer-generate-content attempt=10
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T15:03:17.8743628Z Gemini generateContent TTS HTTP 429: {"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts Please retry in 42.162033914s.","retryDelay":"42s","
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T15:04:32.9186841Z TARGETED_TTS_EXHAUSTED article=how-touchscreens-work part=2
verify-publish	Regenerate only touchscreen parts with confirmed fresh dual-ASR mismatches	2026-09-03T15:04:32.9202958Z ##[error]Process completed with exit code 75.
verify-publish	Save final checkpoint	﻿2026-09-03T15:04:32.9304881Z Node 20 is being deprecated. This workflow is running with Node 24 by default. If you need to temporarily use Node 20, you can set the ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true environment variable. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9306151Z ##[group]Run actions/cache/save@v4
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9306420Z with:
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9306638Z   path: audio-candidates
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9306942Z   key: bareeq-audio-final-validation-33766919807-1
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9307294Z   enableCrossOsArchive: false
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9307567Z env:
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9307847Z   BAREEQ_AUDIO_CAMPAIGN_ID: sadaltager-openrouter-20260901-v1
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9308377Z   BAREEQ_AUDIO_PUBLISHED_MARKER: docs/audio/PUBLISHED-SADALTAGER-OPENROUTER-20260901.json
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9308853Z   BAREEQ_SOURCE_RUN_ID: 33762973140
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9309207Z   BAREEQ_SOURCE_ARTIFACT: bareeq-final-validation-33762973140
verify-publish	Save final checkpoint	2026-09-03T15:04:32.9309588Z ##[endgroup]
verify-publish	Save final checkpoint	2026-09-03T15:04:33.0398904Z (node:4116) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.
verify-publish	Save final checkpoint	2026-09-03T15:04:33.0400532Z (Use `node --trace-deprecation ...` to show where the warning was created)
verify-publish	Save final checkpoint	2026-09-03T15:04:33.0556095Z [command]/usr/bin/tar --posix -cf cache.tzst --exclude cache.tzst -P -C /home/runner/work/bareeq-world/bareeq-world --files-from manifest.txt --use-compress-program zstdmt
verify-publish	Save final checkpoint	2026-09-03T15:04:34.0238834Z (node:4116) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
verify-publish	Save final checkpoint	2026-09-03T15:04:35.0121091Z Sent 36337029 of 237663621 (15.3%), 34.7 MBs/sec
verify-publish	Save final checkpoint	2026-09-03T15:04:35.4666604Z Sent 237663621 of 237663621 (100.0%), 155.8 MBs/sec
verify-publish	Save final checkpoint	2026-09-03T15:04:35.6002567Z Cache saved with key: bareeq-audio-final-validation-33766919807-1
verify-publish	Upload final evidence	2026-09-03T15:04:35.6152732Z   if-no-files-found: error
verify-publish	Upload final evidence	2026-09-03T15:04:36.4405273Z (node:4140) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
```

## Step 12 tail
```
verify-publish	Upload final evidence	2026-09-03T15:04:35.6153144Z   retention-days: 90
verify-publish	Upload final evidence	2026-09-03T15:04:35.6153718Z   compression-level: 6
verify-publish	Upload final evidence	2026-09-03T15:04:35.6154146Z   overwrite: false
verify-publish	Upload final evidence	2026-09-03T15:04:35.6154504Z   include-hidden-files: false
verify-publish	Upload final evidence	2026-09-03T15:04:35.6154893Z env:
verify-publish	Upload final evidence	2026-09-03T15:04:35.6155321Z   BAREEQ_AUDIO_CAMPAIGN_ID: sadaltager-openrouter-20260901-v1
verify-publish	Upload final evidence	2026-09-03T15:04:35.6156189Z   BAREEQ_AUDIO_PUBLISHED_MARKER: docs/audio/PUBLISHED-SADALTAGER-OPENROUTER-20260901.json
verify-publish	Upload final evidence	2026-09-03T15:04:35.6156994Z   BAREEQ_SOURCE_RUN_ID: 33762973140
verify-publish	Upload final evidence	2026-09-03T15:04:35.6157549Z   BAREEQ_SOURCE_ARTIFACT: bareeq-final-validation-33762973140
verify-publish	Upload final evidence	2026-09-03T15:04:35.6158140Z ##[endgroup]
verify-publish	Upload final evidence	2026-09-03T15:04:35.7811542Z (node:4140) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.
verify-publish	Upload final evidence	2026-09-03T15:04:35.7812446Z (Use `node --trace-deprecation ...` to show where the warning was created)
verify-publish	Upload final evidence	2026-09-03T15:04:35.8335648Z With the provided path, there will be 245 files uploaded
verify-publish	Upload final evidence	2026-09-03T15:04:35.8344019Z Artifact name is valid!
verify-publish	Upload final evidence	2026-09-03T15:04:35.8344719Z Root directory input is valid!
verify-publish	Upload final evidence	2026-09-03T15:04:36.1054309Z Beginning upload of artifact content to blob storage
verify-publish	Upload final evidence	2026-09-03T15:04:36.4405273Z (node:4140) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
verify-publish	Upload final evidence	2026-09-03T15:04:36.8539874Z Uploaded bytes 8388608
verify-publish	Upload final evidence	2026-09-03T15:04:37.1777255Z Uploaded bytes 16777216
verify-publish	Upload final evidence	2026-09-03T15:04:37.1943618Z Uploaded bytes 25165824
verify-publish	Upload final evidence	2026-09-03T15:04:37.5184612Z Uploaded bytes 33554432
verify-publish	Upload final evidence	2026-09-03T15:04:37.8877368Z Uploaded bytes 41943040
verify-publish	Upload final evidence	2026-09-03T15:04:38.1173636Z Uploaded bytes 50331648
verify-publish	Upload final evidence	2026-09-03T15:04:38.4628520Z Uploaded bytes 58720256
verify-publish	Upload final evidence	2026-09-03T15:04:38.7268457Z Uploaded bytes 67108864
verify-publish	Upload final evidence	2026-09-03T15:04:39.1251578Z Uploaded bytes 75497472
verify-publish	Upload final evidence	2026-09-03T15:04:39.3888916Z Uploaded bytes 83886080
verify-publish	Upload final evidence	2026-09-03T15:04:39.7292758Z Uploaded bytes 92274688
verify-publish	Upload final evidence	2026-09-03T15:04:39.9847407Z Uploaded bytes 100663296
verify-publish	Upload final evidence	2026-09-03T15:04:40.3070817Z Uploaded bytes 109051904
verify-publish	Upload final evidence	2026-09-03T15:04:40.6556979Z Uploaded bytes 117440512
verify-publish	Upload final evidence	2026-09-03T15:04:40.9083839Z Uploaded bytes 125829120
verify-publish	Upload final evidence	2026-09-03T15:04:41.3240733Z Uploaded bytes 134217728
verify-publish	Upload final evidence	2026-09-03T15:04:41.5351367Z Uploaded bytes 142606336
verify-publish	Upload final evidence	2026-09-03T15:04:41.8399850Z Uploaded bytes 150994944
verify-publish	Upload final evidence	2026-09-03T15:04:42.2119972Z Uploaded bytes 159383552
verify-publish	Upload final evidence	2026-09-03T15:04:42.5448035Z Uploaded bytes 167772160
verify-publish	Upload final evidence	2026-09-03T15:04:42.8633877Z Uploaded bytes 176160768
verify-publish	Upload final evidence	2026-09-03T15:04:43.2129247Z Uploaded bytes 184549376
verify-publish	Upload final evidence	2026-09-03T15:04:43.5304125Z Uploaded bytes 192937984
verify-publish	Upload final evidence	2026-09-03T15:04:43.8732165Z Uploaded bytes 201326592
verify-publish	Upload final evidence	2026-09-03T15:04:44.2825074Z Uploaded bytes 209715200
verify-publish	Upload final evidence	2026-09-03T15:04:44.5827214Z Uploaded bytes 218103808
verify-publish	Upload final evidence	2026-09-03T15:04:44.9451699Z Uploaded bytes 226492416
verify-publish	Upload final evidence	2026-09-03T15:04:45.1717452Z Uploaded bytes 234881024
verify-publish	Upload final evidence	2026-09-03T15:04:45.2314786Z Uploaded bytes 236161709
verify-publish	Upload final evidence	2026-09-03T15:04:45.2676157Z Finished uploading artifact content to blob storage!
verify-publish	Upload final evidence	2026-09-03T15:04:45.2679393Z SHA256 digest of uploaded artifact zip is 9e3ed5a4980c14345046bd37986f584f158b58cca270b73effa319ec002b469b
verify-publish	Upload final evidence	2026-09-03T15:04:45.2681913Z Finalizing artifact upload
verify-publish	Upload final evidence	2026-09-03T15:04:45.5918621Z Artifact bareeq-final-validation-33766919807.zip successfully finalized. Artifact ID 9899406539
verify-publish	Upload final evidence	2026-09-03T15:04:45.5920349Z Artifact bareeq-final-validation-33766919807 has been successfully uploaded! Final size is 236161709 bytes. Artifact ID is 9899406539
verify-publish	Upload final evidence	2026-09-03T15:04:45.5927583Z Artifact download URL: https://github.com/blogbareeq-bot/bareeq-world/actions/runs/33766919807/artifacts/9899406539
verify-publish	Post Checkout PR head	﻿2026-09-03T15:04:45.6145149Z Node 20 is being deprecated. This workflow is running with Node 24 by default. If you need to temporarily use Node 20, you can set the ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true environment variable. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.6146389Z Post job cleanup.
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7024412Z [command]/usr/bin/git version
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7065065Z git version 2.55.0
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7107090Z Temporarily overriding HOME='/home/runner/work/_temp/248b530d-5eb2-4b6a-ae23-c6e35072d3e7' before making global git config changes
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7108588Z Adding repository directory to the temporary git global config as a safe directory
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7112703Z [command]/usr/bin/git config --global --add safe.directory /home/runner/work/bareeq-world/bareeq-world
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7154310Z [command]/usr/bin/git config --local --name-only --get-regexp core\.sshCommand
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7189901Z [command]/usr/bin/git submodule foreach --recursive sh -c "git config --local --name-only --get-regexp 'core\.sshCommand' && git config --local --unset-all 'core.sshCommand' || :"
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7455588Z [command]/usr/bin/git config --local --name-only --get-regexp http\.https\:\/\/github\.com\/\.extraheader
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7482566Z http.https://github.com/.extraheader
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7495540Z [command]/usr/bin/git config --local --unset-all http.https://github.com/.extraheader
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7533068Z [command]/usr/bin/git submodule foreach --recursive sh -c "git config --local --name-only --get-regexp 'http\.https\:\/\/github\.com\/\.extraheader' && git config --local --unset-all 'http.https://github.com/.extraheader' || :"
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7816377Z [command]/usr/bin/git config --local --name-only --get-regexp ^includeIf\.gitdir:
verify-publish	Post Checkout PR head	2026-09-03T15:04:45.7860269Z [command]/usr/bin/git submodule foreach --recursive git config --local --show-origin --name-only --get-regexp remote.origin.url
verify-publish	Complete job	﻿2026-09-03T15:04:45.8332592Z Cleaning up orphan processes
verify-publish	Complete job	2026-09-03T15:04:45.8666619Z ##[warning]Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/cache/save@v4, actions/checkout@v4, actions/download-artifact@v4, actions/setup-node@v4, actions/upload-artifact@v4. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/

```