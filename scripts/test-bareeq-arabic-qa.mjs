import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  compareProtectedTokens,
  parseFrontmatter,
  scanArticle,
  summarize,
  toPlainText
} from './bareeq-arabic-qa-core.mjs';

const config = JSON.parse(await readFile(new URL('../config/bareeq-arabic-qa.json', import.meta.url), 'utf8'));

const good = `---
title: "كيف تعمل الأشياء الصغيرة من حولنا كل يوم؟"
description: "وصف تحريري واضح وطويل بما يكفي لشرح الفكرة للقارئ قبل دخوله إلى المقال من دون مبالغة."
publishedAt: "2026-09-06T12:00:00.000Z"
category: "ببساطة…"
categorySlug: "simply"
author: "فريق بريق"
image: "/images/posts/example.webp"
imageAlt: "مشهد توضيحي واضح يشرح الفكرة التقنية الرئيسية للمقال"
thumbnail: "/images/thumbnails/example.webp"
thumbnailAlt: "صورة مصغرة توضيحية للمقال"
quickSummary: "خلاصة موجزة تشرح الفكرة الأساسية للمقال بلغة عربية واضحة ومباشرة وتحافظ على المعنى من دون اختزال مخل."
---

تبدأ الفكرة من ملاحظة بسيطة نكررها كل يوم، ثم تتضح عندما نفصل بين ما نراه وما يحدث فعليًا خلف السطح.

## الفكرة الأساسية

عندما نقرأ الظاهرة خطوة خطوة يصبح تفسيرها أكثر وضوحًا، ونستطيع التمييز بين التشبيه المبسط والحقيقة التقنية الدقيقة.
`;

{
  const parsed = parseFrontmatter(good);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.metadata.categorySlug, 'simply');
}

{
  const findings = scanArticle({ file: 'good.md', source: good, config });
  const summary = summarize(findings, 1);
  assert.equal(summary.counts.error, 0, JSON.stringify(findings, null, 2));
  assert.equal(summary.passed, true);
}

{
  const badTypo = good.replace('تبدأ الفكرة', 'لاكن تبدأ الفكرة');
  const findings = scanArticle({ file: 'typo.md', source: badTypo, config });
  assert.ok(findings.some((item) => item.ruleId === 'BQA-LEX-001' && item.severity === 'error'));
}

{
  const suppressed = good.replace('تبدأ الفكرة', '<!-- bareeq-qa-disable BQA-LEX-001 -->\n\nلاكن تبدأ الفكرة');
  const findings = scanArticle({ file: 'suppressed.md', source: suppressed, config });
  assert.ok(!findings.some((item) => item.ruleId === 'BQA-LEX-001'));
}

{
  const placeholder = good.replace('تبدأ الفكرة', 'TODO: تبدأ الفكرة');
  const findings = scanArticle({ file: 'todo.md', source: placeholder, config });
  assert.ok(findings.some((item) => item.ruleId === 'BQA-DOC-005' && item.severity === 'error'));
}

{
  const invisible = good.replace('تبدأ الفكرة', `تبدأ\u202E الفكرة`);
  const findings = scanArticle({ file: 'invisible.md', source: invisible, config });
  assert.ok(findings.some((item) => item.ruleId === 'BQA-DOC-006' && item.severity === 'error'));
}

{
  const unclosedFence = `${good}\n\`\`\`js\nconst x = 1;\n`;
  const findings = scanArticle({ file: 'fence.md', source: unclosedFence, config });
  assert.ok(findings.some((item) => item.ruleId === 'BQA-MD-003' && item.severity === 'error'));
}

{
  const punctuation = good.replace('تبدأ الفكرة', 'هل تبدأ الفكرة? تبدأ الفكرة');
  const findings = scanArticle({ file: 'punctuation.md', source: punctuation, config });
  assert.ok(findings.some((item) => item.ruleId === 'BQA-PUNC-003' && item.severity === 'warning'));
  assert.ok(!findings.some((item) => item.severity === 'error'));
}

{
  const styleOnly = good.replace('تبدأ الفكرة', 'في عالمنا المتسارع، من الجدير بالذكر أن الفكرة تبدأ هنا. في نهاية المطاف، تبدأ الفكرة');
  const findings = scanArticle({ file: 'style.md', source: styleOnly, config });
  assert.ok(findings.some((item) => item.ruleId === 'BQA-STYLE-004'));
  assert.ok(!findings.some((item) => item.severity === 'error'));
}

{
  const baseSource = `${good}\nالمصدر: https://example.com/report والقيمة 42%، والمختصر OLED.\n`;
  const headSource = `${good}\nالمصدر: https://example.com/new-report والقيمة 47%، والمختصر LCD.\n`;
  const advisory = compareProtectedTokens({ file: 'semantic.md', baseSource, headSource, strict: false });
  assert.ok(advisory.length >= 3);
  assert.ok(advisory.every((item) => item.severity === 'warning'));
  const strict = compareProtectedTokens({ file: 'semantic.md', baseSource, headSource, strict: true });
  assert.ok(strict.every((item) => item.severity === 'error'));
}

{
  const plain = toPlainText('## عنوان\n\nاقرأ [المصدر](https://example.com) ثم `const x = 1`.');
  assert.ok(plain.includes('اقرأ المصدر'));
  assert.ok(!plain.includes('https://example.com'));
  assert.ok(!plain.includes('const x = 1'));
}

console.log('Bareeq Arabic QA tests passed.');
