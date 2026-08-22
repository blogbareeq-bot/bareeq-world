import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';

const cssRoot = path.resolve('dist', '_astro');
const cssFiles = (await readdir(cssRoot)).filter((name) => name.endsWith('.css')).sort();
const candidates = [];
const footerTargetCandidates = [];
const roots = [];
let order = 0;

function mediaApplies(params, width) {
  const max = [
    ...[...params.matchAll(/max-width\s*:\s*([\d.]+)px/gi)].map((match) => Number(match[1])),
    ...[...params.matchAll(/width\s*<=\s*([\d.]+)px/gi)].map((match) => Number(match[1]))
  ];
  const min = [
    ...[...params.matchAll(/min-width\s*:\s*([\d.]+)px/gi)].map((match) => Number(match[1])),
    ...[...params.matchAll(/width\s*>=\s*([\d.]+)px/gi)].map((match) => Number(match[1]))
  ];
  return max.every((value) => width <= value) && min.every((value) => width >= value);
}

for (const name of cssFiles) {
  const root = postcss.parse(await readFile(path.join(cssRoot, name), 'utf8'));
  roots.push(root);
  root.walkRules((rule) => {
    if (!rule.selectors?.some((selector) => selector.trim() === '.footer-grid')) return;
    const declaration = [...rule.nodes].reverse().find((node) => node.type === 'decl' && node.prop === 'grid-template-columns');
    if (!declaration) return;
    const media = [];
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule' && parent.name === 'media') media.push(parent.params);
    }
    candidates.push({ value: declaration.value, media, order: order++ });
  });
  root.walkRules((rule) => {
    if (!rule.selectors?.some((selector) => selector.includes('.footer-section li a') || selector.includes('.footer-contact>a'))) return;
    const declaration = [...rule.nodes].reverse().find((node) => node.type === 'decl' && node.prop === 'min-height');
    if (!declaration) return;
    const media = [];
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule' && parent.name === 'media') media.push(parent.params);
    }
    footerTargetCandidates.push({ value: declaration.value, media, order: order++ });
  });
}


function flexBasisMatches(value, expectedBasis) {
  if (!value) return false;
  const normalized = value.trim().replace(/\s+/g, ' ');
  // CSS minifiers may legally reduce `flex: 1 1 104px` to `flex: 104px`.
  // Both resolve to grow=1, shrink=1 and the same flex-basis.
  return normalized === expectedBasis || normalized === `1 1 ${expectedBasis}`;
}

function resolvedValue(width) {
  return candidates
    .filter((candidate) => candidate.media.every((params) => mediaApplies(params, width)))
    .sort((a, b) => a.order - b.order)
    .at(-1)?.value;
}

function resolvedDeclaration(selector, property, width) {
  const matches = [];
  let declarationOrder = 0;
  for (const root of roots) {
    root.walkRules((rule) => {
      if (!rule.selectors?.some((candidate) => candidate.trim() === selector)) return;
      const declaration = [...rule.nodes].reverse().find((node) => node.type === 'decl' && node.prop === property);
      if (!declaration) return;
      const media = [];
      for (let parent = rule.parent; parent; parent = parent.parent) {
        if (parent.type === 'atrule' && parent.name === 'media') media.push(parent.params);
      }
      matches.push({ value: declaration.value, media, order: declarationOrder++ });
    });
  }
  return matches
    .filter((candidate) => candidate.media.every((params) => mediaApplies(params, width)))
    .sort((a, b) => a.order - b.order)
    .at(-1)?.value;
}

const expectations = [
  { width: 320, test: (value) => value === 'minmax(0,1fr)', label: 'عمود واحد' },
  { width: 390, test: (value) => value === 'minmax(0,1fr)', label: 'عمود واحد' },
  { width: 700, test: (value) => value === 'minmax(0,1fr)', label: 'عمود واحد' },
  { width: 768, test: (value) => value?.includes('repeat(2'), label: 'عمودان' },
  { width: 1024, test: (value) => value?.includes('1.05fr') && value?.includes('1.2fr'), label: 'ثلاثة أعمدة متوازنة' }
];

const failures = expectations.filter(({ width, test }) => !test(resolvedValue(width)));
const footerTargetAt390 = footerTargetCandidates
  .filter((candidate) => candidate.media.every((params) => mediaApplies(params, 390)))
  .sort((a, b) => a.order - b.order)
  .at(-1)?.value;
if (!footerTargetAt390 || Number.parseFloat(footerTargetAt390) < 44) failures.push({ width: 390, label: 'أهداف لمس التذييل 44px', actual: footerTargetAt390 });
if (resolvedDeclaration('.footer-section ul', 'grid-template-columns', 390) !== 'minmax(0,1fr)') {
  failures.push({ width: 390, label: 'روابط تذييل أحادية العمود', actual: resolvedDeclaration('.footer-section ul', 'grid-template-columns', 390) });
}
if (!resolvedDeclaration('.footer-section ul', 'grid-template-columns', 768)?.includes('repeat(2')) {
  failures.push({ width: 768, label: 'روابط تذييل موزعة على عمودين', actual: resolvedDeclaration('.footer-section ul', 'grid-template-columns', 768) });
}
if (!resolvedDeclaration('.footer-section ul', 'grid-template-columns', 1440)?.includes('repeat(3')) {
  failures.push({ width: 1440, label: 'روابط تذييل موزعة على ثلاثة أعمدة', actual: resolvedDeclaration('.footer-section ul', 'grid-template-columns', 1440) });
}
if (resolvedDeclaration('.site-footer .footer-grid', 'max-width', 1440) !== '1320px') {
  failures.push({ width: 1440, label: 'حد عرض متوازن للتذييل', actual: resolvedDeclaration('.site-footer .footer-grid', 'max-width', 1440) });
}
const categoryDropdownWidth = resolvedDeclaration('.category-dropdown', 'width', 1440);
if (!categoryDropdownWidth?.startsWith('min(520px,') || !categoryDropdownWidth.includes('100vw - 32px')) {
  failures.push({ width: 1440, label: 'قائمة أقسام أوسع بلا تجاوز للشاشة', actual: categoryDropdownWidth });
}
if (resolvedDeclaration('.category-strip-inner', 'max-width', 1440) !== '1360px') {
  failures.push({ width: 1440, label: 'شريط أقسام عائم موسّع ومحدود', actual: resolvedDeclaration('.category-strip-inner', 'max-width', 1440) });
}
if (resolvedDeclaration('.header-search-link span', 'display', 1024) !== 'none') {
  failures.push({ width: 1024, label: 'اختصار البحث إلى أيقونة على الأجهزة المتوسطة', actual: resolvedDeclaration('.header-search-link span', 'display', 1024) });
}
if (resolvedDeclaration('.ticker-track', 'display', 390) !== 'flex' || resolvedDeclaration('.ticker-track', 'animation', 390) !== 'none') {
  failures.push({ width: 390, label: 'مسار تيكَر أفقي مستمر على الجوال', actual: `${resolvedDeclaration('.ticker-track', 'display', 390)}/${resolvedDeclaration('.ticker-track', 'animation', 390)}` });
}
if (resolvedDeclaration('.ticker-set', 'display', 390) !== 'flex' || resolvedDeclaration('.ticker-set', 'gap', 390) !== '28px' || resolvedDeclaration('.ticker-set', 'padding-inline-end', 390) !== '28px') {
  failures.push({ width: 390, label: 'مجموعتا التيكَر متطابقتان لحلقة بلا قفزة', actual: `${resolvedDeclaration('.ticker-set', 'display', 390)}/${resolvedDeclaration('.ticker-set', 'gap', 390)}/${resolvedDeclaration('.ticker-set', 'padding-inline-end', 390)}` });
}
if (resolvedDeclaration('.ticker-set>a', 'display', 390) !== 'inline-flex') {
  failures.push({ width: 390, label: 'عناوين التيكَر ظاهرة جنبًا إلى جنب', actual: resolvedDeclaration('.ticker-set>a', 'display', 390) });
}
if (resolvedDeclaration('.ticker-viewport', 'overflow', 390) !== 'hidden') {
  failures.push({ width: 390, label: 'نافذة التيكَر تقطع العرض دون تمرير الصفحة', actual: resolvedDeclaration('.ticker-viewport', 'overflow', 390) });
}
if (resolvedDeclaration('.ticker.is-manual .ticker-viewport', 'overflow-x', 390) !== 'auto') {
  failures.push({ width: 390, label: 'تمرير يدوي عند تقليل الحركة', actual: resolvedDeclaration('.ticker.is-manual .ticker-viewport', 'overflow-x', 390) });
}
if (resolvedDeclaration('.category-strip-inner', 'display', 768) !== 'flex' || resolvedDeclaration('.category-strip-inner', 'flex-wrap', 768) !== 'wrap' || resolvedDeclaration('.category-strip-inner', 'overflow', 768) !== 'visible') {
  failures.push({ width: 768, label: 'أقسام ملتفة بلا تمرير أفقي', actual: `${resolvedDeclaration('.category-strip-inner', 'display', 768)}/${resolvedDeclaration('.category-strip-inner', 'flex-wrap', 768)}/${resolvedDeclaration('.category-strip-inner', 'overflow', 768)}` });
}
const categoryFlex390 = resolvedDeclaration('.category-nav-item', 'flex', 390);
if (!flexBasisMatches(categoryFlex390, '104px')) {
  failures.push({ width: 390, label: 'توزيع Adaptive متوازن للأقسام', actual: categoryFlex390 });
}
if (resolvedDeclaration('.category-strip', 'position', 390) !== 'relative' || resolvedDeclaration('.category-strip', 'top', 390) !== 'auto') {
  failures.push({ width: 390, label: 'شريط أقسام غير لاصق على الجوال', actual: `${resolvedDeclaration('.category-strip', 'position', 390)}/${resolvedDeclaration('.category-strip', 'top', 390)}` });
}
if (resolvedDeclaration('.category-strip', 'position', 768) !== 'relative' || resolvedDeclaration('.category-strip', 'top', 768) !== 'auto') {
  failures.push({ width: 768, label: 'شريط أقسام غير لاصق على التابلت', actual: `${resolvedDeclaration('.category-strip', 'position', 768)}/${resolvedDeclaration('.category-strip', 'top', 768)}` });
}
if (resolvedDeclaration('.desktop-nav', 'display', 820) !== 'flex' || resolvedDeclaration('.desktop-nav', 'display', 800) !== 'none') {
  failures.push({ width: '800/820', label: 'نقطة انتقال التنقل إلى الهامبرغر عند 800px', actual: `${resolvedDeclaration('.desktop-nav', 'display', 800)}/${resolvedDeclaration('.desktop-nav', 'display', 820)}` });
}
if (resolvedDeclaration('.category-mobile-link', 'display', 390) !== 'flex' || resolvedDeclaration('.category-mobile-link', 'display', 768) !== 'flex') {
  failures.push({ width: '390/768', label: 'روابط الأقسام ظاهرة فعليًا على الجوال والتابلت', actual: `${resolvedDeclaration('.category-mobile-link', 'display', 390)}/${resolvedDeclaration('.category-mobile-link', 'display', 768)}` });
}
if (resolvedDeclaration('.category-mobile-link', 'white-space', 390) !== 'normal') {
  failures.push({ width: 390, label: 'أسماء أقسام كاملة قابلة للالتفاف', actual: resolvedDeclaration('.category-mobile-link', 'white-space', 390) });
}
if (resolvedDeclaration('.home-intro-inner', 'flex-direction', 390) !== 'column') {
  failures.push({ width: 390, label: 'نبذة رئيسية عمودية على الجوال', actual: resolvedDeclaration('.home-intro-inner', 'flex-direction', 390) });
}
if (resolvedDeclaration('.home-intro-actions', 'display', 390) !== 'grid') {
  failures.push({ width: 390, label: 'أزرار نبذة بلا تجاوز أفقي', actual: resolvedDeclaration('.home-intro-actions', 'display', 390) });
}
if (resolvedDeclaration('.category-introduction', 'grid-template-columns', 700) !== 'minmax(0,1fr)') {
  failures.push({ width: 700, label: 'مقدمة قسم أحادية العمود', actual: resolvedDeclaration('.category-introduction', 'grid-template-columns', 700) });
}
const shellWide = roots.flatMap((root) => {
  const values = [];
  root.walkRules(':root', (rule) => rule.walkDecls('--shell-wide', (declaration) => values.push(declaration.value)));
  return values;
}).at(-1);
if (shellWide !== '1920px') failures.push({ width: 'wide shell', label: 'عرض 1920px', actual: shellWide });
for (const root of roots) {
  root.walkRules((rule) => {
    if (!rule.selectors?.some((selector) => ['html', 'body'].includes(selector.trim()))) return;
    rule.walkDecls('overflow-x', (declaration) => {
      if (['hidden', 'clip'].includes(declaration.value)) failures.push({ width: rule.selector, label: 'عدم إخفاء الانهيار الأفقي', actual: declaration.value });
    });
  });
}
if (failures.length) {
  failures.forEach(({ width, label, actual }) => console.error(`${width}: required ${label}; got: ${actual ?? resolvedValue(width) ?? 'none'}`));
  process.exit(1);
}

console.log('Responsive CSS passed: design-one header, continuously moving mobile article ticker without page-level overflow, adaptive non-sticky category bar, compact mobile headline, mobile home/category layouts, visible overflow diagnostics, 44px footer targets, and balanced footer layout from 320px through wide desktop.');
