# نافذة بريق — Atlas (نموذج تجريبي)

نموذج منافس مستقل لنافذة بريق، مبني على قصة **«كيف تعرف شاشة هاتفك أين وضعت إصبعك؟»**.
لا يمسّ الإنتاج: كل شيء داخل `prototypes/nafidha-atlas/` وملفات ثابتة بلا اعتماديات.

## التشغيل

```bash
python3 -m http.server 4173 --directory prototypes/nafidha-atlas
```

- التجربة: `/index.html`
- فحص Responsive بإطارات حقيقية: `/responsive.html`

## البنية

```
story.json                 ← نفس نصوص main حرفيًا (بعد حذف arc، وهو حقل داخلي)
scripts/scenes.js          ← Semantic Scene Renderer: وحدات مشاهد + Resolver
scripts/atlas.js           ← Runtime: تحميل القصة، مقياس العمق، إيقاع الضوء/الظلام
styles/atlas.css           ← نظام الطباعة والمشاهد، RTL منطقي بالكامل
```

العلاقة:

```
Story JSON → resolve(card) → Scene module {tone, build(), mount()} → <section class="scene">
```

`resolve` يختار حسب `visual` أولًا، ثم `kind`، ثم مشهد احتياطي.
لا توجد صفحة خاصة بمقال، ولا يُعرض أي حقل تحريري داخلي (`arc` / `kind` / `visual` / `sourceFingerprint`) للقارئ.

## المشاهد التسعة

| # | الوظيفة | المشهد | الهندسة | النغمة |
|---|---|---|---|---|
| 1 | hook | Overture | مدخل سينمائي: ماضٍ وحاضر جنبًا إلى جنب | داكن |
| 2 | reveal/layers | Cross-section | رسم لاصق (sticky) + نص يمشي بجواره | عاجي |
| 3 | evidence | Diagram | رسم مشروح في المنتصف، النص تعليق | ورقي |
| 4 | reveal/wave | Field probe | الشبكة تستجيب لمؤشر القارئ فعليًا | داكن |
| 5 | application | Diptych | وجهان متقابلان يفصلهما خيط | عاجي |
| 6 | reveal/constellation | Pinch | مقبضان يسحبهما القارئ (فأرة/لمس/لوحة مفاتيح) | داكن |
| 7 | experiment | Lab | متحكم + لوح حي + ملاحظة مختبر | عاجي |
| 8 | reveal/horizon | Quiet | أقصى فراغ، مقياس يرفض التحرك | ورقي |
| 9 | takeaway | Closing | سلسلة من ثلاث + خاتمة وتوقيع | داكن |

إيقاع النغمة: `داكن → عاجي → ورقي → داكن → عاجي → داكن → عاجي → ورقي → داكن`.

## إضافة مقال جديد

1. ضع `story.json` جديدًا بالبنية نفسها.
2. إن احتاج `visual` جديد، أضف وحدة مشهد واحدة إلى `BY_VISUAL`.
3. لا تعديل على HTML ولا على الـ runtime.
