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

function resolvedValue(width) {
  return candidates
    .filter((candidate) => candidate.media.every((params) => mediaApplies(params, width)))
    .sort((a, b) => a.order - b.order)
    .at(-1)?.value;
}

const expectations = [
  { width: 320, test: (value) => value === 'minmax(0,1fr)', label: 'عمود واحد' },
  { width: 390, test: (value) => value === 'minmax(0,1fr)', label: 'عمود واحد' },
  { width: 700, test: (value) => value === 'minmax(0,1fr)', label: 'عمود واحد' },
  { width: 768, test: (value) => value?.includes('repeat(2'), label: 'عمودان' },
  { width: 1024, test: (value) => value?.includes('1.35fr') && value?.includes('.75fr'), label: 'ثلاثة أعمدة' }
];

const failures = expectations.filter(({ width, test }) => !test(resolvedValue(width)));
const footerTargetAt390 = footerTargetCandidates
  .filter((candidate) => candidate.media.every((params) => mediaApplies(params, 390)))
  .sort((a, b) => a.order - b.order)
  .at(-1)?.value;
if (!footerTargetAt390 || Number.parseFloat(footerTargetAt390) < 44) failures.push({ width: 390, label: 'أهداف لمس التذييل 44px', actual: footerTargetAt390 });
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

console.log('Responsive CSS passed: full-width shell, visible overflow diagnostics, 44px footer targets, and footer layout at 320, 390, 700, 768, and 1024px.');
