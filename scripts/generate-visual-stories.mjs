import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const POSTS_DIR = resolve(ROOT, 'src/content/posts');
const OUTPUT = resolve(ROOT, 'src/data/visual-stories.json');
const CHECK = process.argv.includes('--check');

const directors = [
  ['editorial-dawn', 'بزوغ تحريري', 'dawn', ['#061b34', '#087f76', '#f5efe2', '#c79a43']],
  ['human-ledger', 'دفتر الإنسان', 'ledger', ['#11253c', '#287f8c', '#f7f1e5', '#bd8d3c']],
  ['market-ripples', 'تموّجات السوق', 'ripples', ['#132a44', '#b76b35', '#f3ead9', '#22918a']],
  ['electric-field', 'حقل كهربائي', 'field', ['#071d35', '#00a8a0', '#e9f0eb', '#d2a94e']],
  ['inner-compass', 'بوصلة داخلية', 'compass', ['#17233d', '#7b6b9c', '#f4eddf', '#d0a04a']],
  ['language-currents', 'تيارات اللغة', 'currents', ['#09223b', '#147d83', '#f2eadc', '#b88743']],
  ['border-stamps', 'أختام العبور', 'stamps', ['#102844', '#376f8d', '#f4ecdc', '#c49042']],
  ['logic-prism', 'موشور الحُجّة', 'prism', ['#131f39', '#6f65a8', '#f5edde', '#c79a43']],
  ['literary-dawn', 'صباح ورقي', 'paper', ['#08213a', '#2b8b83', '#f6efe1', '#c89a45']],
  ['steady-pulse', 'نبض متّزن', 'pulse', ['#10263e', '#3d8b73', '#f4eddf', '#bd8a3f']],
  ['culture-weave', 'نسيج الثقافات', 'weave', ['#10283f', '#a05d53', '#f6eedf', '#2e8984']],
  ['decision-path', 'مسار القرار', 'path', ['#0b253c', '#21897e', '#f5ede0', '#c69a47']],
  ['search-constellation', 'كوكبة الاحتمالات', 'constellation', ['#071f38', '#16889a', '#eef1e9', '#cda24d']],
  ['craft-ladder', 'سُلّم الصنعة', 'ladder', ['#12253c', '#477c72', '#f4ecdf', '#c49243']],
  ['orbital-arc', 'قوس المدار', 'orbit', ['#061c34', '#1c8297', '#edf1ea', '#c89d47']],
];

const cleanInline = (value = '') => value
  .replace(/<!--.*?-->/gs, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[*_`>#|]/g, ' ')
  .replace(/^[-+\d.)\s]+/, '')
  .replace(/\s+/g, ' ')
  .trim();

const sentence = (value, max = 245) => {
  const text = cleanInline(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const boundary = Math.max(cut.lastIndexOf('،'), cut.lastIndexOf('.'), cut.lastIndexOf(' '));
  return `${cut.slice(0, boundary > max * .62 ? boundary : max).trim()}…`;
};

const frontmatterValue = (frontmatter, key) => {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
  return match?.[1]?.replace(/^['"]|['"]$/g, '').trim() || '';
};

const parsePost = (fileName, source, index) => {
  const parts = source.split(/^---\s*$/m);
  const frontmatter = parts[1] || '';
  const body = parts.slice(2).join('---').trim();
  const slug = fileName.replace(/\.md$/, '');
  const title = frontmatterValue(frontmatter, 'title');
  const summary = frontmatterValue(frontmatter, 'quickSummary') || frontmatterValue(frontmatter, 'description');
  const category = frontmatterValue(frontmatter, 'category');
  const image = frontmatterValue(frontmatter, 'image');
  const sections = [];
  const matches = [...body.matchAll(/^##\s+(.+)$/gm)];
  for (let i = 0; i < matches.length; i += 1) {
    const sectionTitle = cleanInline(matches[i][1]);
    if (/^(?:المصادر|المراجع|أسئلة شائعة)|مصادر|مراجع|قراءة إضافية|^ماذا يحدث عندما تكتب حرفًا واحدًا؟$/i.test(sectionTitle)) continue;
    const start = matches[i].index + matches[i][0].length;
    const end = matches[i + 1]?.index ?? body.length;
    const chunk = body.slice(start, end)
      .split(/\n\s*\n/)
      .map(cleanInline)
      .find((paragraph) => paragraph.length >= 48 && !paragraph.startsWith('المصادر'));
    if (chunk) sections.push({ title: sectionTitle, body: sentence(chunk) });
  }
  if (sections.length < 6) throw new Error(`${slug}: نافذة المقال تحتاج ستة محاور صالحة على الأقل.`);

  const closing = sections.at(-1);
  const narrativeSections = sections.slice(0, -1);
  const desired = Math.min(7, narrativeSections.length);
  const selected = [];
  for (let i = 0; i < desired; i += 1) {
    const sectionIndex = desired === 1 ? 0 : Math.round(i * (narrativeSections.length - 1) / (desired - 1));
    if (!selected.includes(narrativeSections[sectionIndex])) selected.push(narrativeSections[sectionIndex]);
  }
  const [mood, label, grammar, palette] = directors[index % directors.length];
  const visuals = ['threshold', 'rings', 'path', 'layers', 'contrast', 'pulse', 'constellation', 'horizon'];
  const cards = [
    { id: 'opening', kicker: category, title, body: sentence(summary, 270), visual: 'opening' },
    ...selected.map((section, cardIndex) => ({
      id: `idea-${cardIndex + 1}`,
      kicker: `الفكرة ${cardIndex + 1}`,
      title: section.title,
      body: section.body,
      visual: visuals[(cardIndex + index) % visuals.length],
    })),
    {
      id: 'takeaway',
      kicker: 'ومضة بريق',
      title: closing?.title || 'ما الذي يستحق أن يبقى؟',
      body: sentence(closing?.body || summary, 270),
      visual: 'seal',
    },
  ];

  return {
    slug,
    title,
    articlePath: `/posts/${slug}/`,
    image,
    sourceFingerprint: createHash('sha256').update(source).digest('hex'),
    director: { mood, label, grammar, density: 'airy', motion: 'calm', palette },
    cards,
  };
};

const files = (await readdir(POSTS_DIR)).filter((file) => file.endsWith('.md')).sort();
const stories = [];
for (const [index, file] of files.entries()) {
  stories.push(parsePost(file, await readFile(resolve(POSTS_DIR, file), 'utf8'), index));
}

const payload = `${JSON.stringify({ schemaVersion: 1, generatedFrom: 'src/content/posts', stories }, null, 2)}\n`;
if (CHECK) {
  const current = await readFile(OUTPUT, 'utf8').catch(() => '');
  if (current !== payload) throw new Error('src/data/visual-stories.json غير محدث. شغّل npm run window:generate.');
  console.log(`نافذة بريق: ${stories.length}/${files.length} قصة مرتبطة ببصمات النصوص.`);
} else {
  await writeFile(OUTPUT, payload);
  console.log(`تم إنشاء ${stories.length} قصة نافذة بريق في ${OUTPUT}.`);
}
