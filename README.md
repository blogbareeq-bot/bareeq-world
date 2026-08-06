# عالم بريق — مشروع Astro الجاهز لـ Cloudflare Pages

هذه حزمة موقع عربية كاملة بصيغة **Astro 6**، مصممة لهوية «بريق — نافذتك إلى المعرفة» ومهيأة للنشر المجاني على Cloudflare Pages.

## المزايا

- واجهة عربية RTL متجاوبة للكمبيوتر والجوال.
- الصفحة الرئيسية: مقال رئيسي + 3 مقالات مساندة + قيم بريق + أحدث المقالات.
- الأقسام الخمسة وصفحات مستقلة لكل قسم.
- صفحات المقالات مع جدول محتويات، تقدم القراءة، مشاركة، ومقالات ذات صلة.
- البحث المحلي السريع دون قاعدة بيانات.
- وضع داكن يدوي محفوظ في المتصفح.
- RSS وSitemap وRobots ووسوم SEO وOpen Graph.
- لا توجد قاعدة بيانات، ولا إضافات مدفوعة، ولا JavaScript ثقيل.

## رفع الحزمة إلى GitHub

1. فك ضغط ملف `bareeq-world-astro.zip` على جهازك.
2. افتح مجلد `bareeq-world-astro`.
3. حدّد **كل ما داخل المجلد**، وليس المجلد الخارجي نفسه.
4. اسحب العناصر إلى صفحة GitHub الخاصة برفع الملفات.
5. يجب أن تظهر في جذر المستودع عناصر مثل:
   - `src/`
   - `public/`
   - `package.json`
   - `astro.config.mjs`
   - `tsconfig.json`
6. اكتب رسالة الحفظ: `Initial Bareeq Astro website`
7. اضغط **Commit changes**.

> قد لا يسمح رفع GitHub من المتصفح برفع المجلدات الفارغة، وهذا طبيعي؛ المشروع لا يعتمد على مجلدات فارغة.

## إعداد Cloudflare Pages

بعد رفع الملفات:

- Production branch: `main`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: اتركها فارغة
- Environment variables: لا توجد متغيرات مطلوبة

## إضافة مقال جديد

أنشئ ملف Markdown داخل:

`src/content/posts/`

واستخدم هذا النموذج:

```md
---
title: "عنوان المقال"
description: "وصف مختصر للمقال"
publishedAt: 2026-08-06
category: "ببساطة…"
categorySlug: "simply"
image: "/images/example.webp"
imageAlt: "وصف الصورة"
featured: false
draft: false
readingMinutes: 6
tags: ["معرفة", "تبسيط"]
---

محتوى المقال هنا.
```

التصنيفات المقبولة:

| التصنيف | categorySlug |
|---|---|
| أطياف العقل | `atyaf-al-aql` |
| بريق الكتب | `bareeq-books` |
| نافذة على العالم | `window-on-world` |
| المستقبل الآن | `future-now` |
| ببساطة… | `simply` |

## تغيير بيانات الموقع

عدّل الملف:

`src/config/site.ts`

لتغيير الاسم والوصف والبريد والدومين.

## لوحة النشر

المسار `/admin/` موجود كصفحة مؤقتة فقط. تفعيل لوحة Decap CMS يحتاج إعداد GitHub OAuth مستقل على Cloudflare Worker، ولذلك لم نضمّن إعدادًا ناقصًا أو غير آمن في نسخة الإطلاق.
