# Bareeq V4.19.0 — REPLACE PACKAGE

هذه هي حزمة الاستبدال المباشر فوق V4.18.2 الحالية.

## طريقة الاستخدام
1. لا تحذف مجلد bareeq-world القديم.
2. افتح هذا المجلد بعد فك الضغط.
3. حدّد جميع الملفات والمجلدات الموجودة داخله.
4. Copy.
5. افتح: C:\Users\ahalabi\Documents\GitHub\bareeq-world
6. Paste.
7. اختر Replace the files in the destination عند ظهور رسالة الاستبدال.
8. افتح GitHub Desktop وتأكد من ظهور التغييرات ثم Commit + Push.
9. Cloudflare ينفذ prepare-v4190 تلقائيًا داخل بيئة البناء؛ لا تحتاج Node محليًا.

## حماية الصوت
- المقالات الجديدة/المعدلة: Hamed/Azure أولًا من النص الجديد نفسه.
- يتم تخطي Hamed/Cedar القديم للمقالات التي تغير نصها حتى لا يحدث تعارض.
- بعد اكتمال Hamed المطابق، يحاول Gemini استعادة/توليد Sadaltager تدريجيًا.
- إذا تعذر AZURE_SPEECH_KEY أو فشل Hamed للمقالات المتغيرة، يفشل البناء قبل النشر.
- GENERATOR_VERSION لا يتغير، لذلك تظل كاشات Sadaltager الصالحة للمقالات غير المعدلة قابلة لإعادة الاستخدام.

Baseline: V4.18.2 / f2693d8a8097a30a52d8178dbcb8300c7703abd8
Changed/new article IDs: 7
