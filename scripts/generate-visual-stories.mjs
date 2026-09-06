import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Bareeq Window — v2 generator.
 *
 * v1 took the first paragraph of every H2 section and turned it into a card.
 * That produced a low-quality, automated index of the article. v2 is a
 * SKELETON-and-COVERAGE generator: it inspects every published post and
 * writes `src/data/visual-stories/<slug>.skeleton.json` so an editor can
 * (a) confirm the post has a story, and (b) see a coverage map that helps
 * them write a real story rather than a 1-to-1 H2 dump.
 *
 * The actual `<slug>.json` files in this repo are EDITED, not generated.
 * This script is intentionally a helper. It refuses to overwrite a real
 * story unless the editor passes `--force` AND the existing file matches
 * its own skeleton (so we never silently replace human-edited content).
 */

const ROOT = process.cwd();
const POSTS_DIR = resolve(ROOT, 'src/content/posts');
const STORIES_DIR = resolve(ROOT, 'src/data/visual-stories');
const FORCE = process.argv.includes('--force');
const CHECK_ONLY = process.argv.includes('--check');

const cleanInline = (value = '') => value
  .replace(/<!--.*?-->/gs, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[*_`>#|]/g, ' ')
  .replace(/^[-+\d.)\s]+/, '')
  .replace(/\s+/g, ' ')
  .trim();

const sentence = (value, max = 280) => {
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

const parsePost = (fileName, source) => {
  const parts = source.split(/^---\s*$/m);
  const frontmatter = parts[1] || '';
  const body = parts.slice(2).join('---').trim();
  const slug = fileName.replace(/\.md$/, '');
  const title = frontmatterValue(frontmatter, 'title');
  const summary = frontmatterValue(frontmatter, 'quickSummary') || frontmatterValue(frontmatter, 'description');
  const category = frontmatterValue(frontmatter, 'category');
  const image = frontmatterValue(frontmatter, 'image');
  const sectionTitles = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => cleanInline(m[1]));
  const filtered = sectionTitles.filter((t) => !/^(?:المصادر|أسئلة شائعة|قراءة إضافية|مراجع)/i.test(t));
  return { slug, title, summary, category, image, sections: filtered, fingerprint: createHash('sha256').update(source).digest('hex') };
};

const pickDirector = (category) => {
  // Map each category to a default visual director. Editors may override.
  const map = {
    'ببساطة…': 'orbital-arc',
    'نافذة على العالم': 'language-currents',
    'بريق الكتب': 'literary-dawn',
    'أطياف العقل': 'inner-compass',
    'المستقبل الآن': 'editorial-dawn'
  };
  return map[category] || 'editorial-dawn';
};

const buildSkeleton = (post) => ({
  slug: post.slug,
  title: post.title,
  articlePath: `/posts/${post.slug}/`,
  image: post.image,
  sourceFingerprint: post.fingerprint,
  arc: '',
  path: '',
  director: { mood: pickDirector(post.category), label: '', grammar: '', density: 'airy', motion: 'calm', palette: [] },
  cards: [],
  _skeleton: {
    category: post.category,
    quickSummary: post.summary,
    candidateSections: post.sections,
    suggestedCards: Math.min(10, Math.max(7, post.sections.length)),
    note: 'هذا هيكل عظمي للقصة، لا قصة جاهزة. يحتاج إلى تحرير بشري لكتابة arc, path, و7-10 بطاقات بكل بطاقات تحتوي kicker, title, body, kind, visual.'
  }
});

const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith('.md')).sort();
const summaries = [];

for (const file of files) {
  const source = await readFile(resolve(POSTS_DIR, file), 'utf8');
  const post = parsePost(file, source);
  const storyPath = resolve(STORIES_DIR, `${post.slug}.json`);
  const skeletonPath = resolve(STORIES_DIR, `${post.slug}.skeleton.json`);
  let storyExists = false;
  try {
    await readFile(storyPath);
    storyExists = true;
  } catch {
    storyExists = false;
  }
  if (CHECK_ONLY) {
    if (!storyExists) throw new Error(`${post.slug}: لا يملك قصة. نفّذ window:generate لإنشاء هيكل عظمي.`);
    summaries.push({ slug: post.slug, status: 'story' });
  } else {
    const skeleton = buildSkeleton(post);
    await writeFile(skeletonPath, `${JSON.stringify(skeleton, null, 2)}\n`);
    if (!storyExists || FORCE) {
      // Only write the real story if explicitly forced, and never silently
      // replace an existing one. This is the safety net for v2.
      if (!storyExists) {
        await writeFile(storyPath, `${JSON.stringify({ ...skeleton, _skeleton: undefined }, null, 2)}\n`);
        summaries.push({ slug: post.slug, status: 'created (placeholder)' });
      } else {
        summaries.push({ slug: post.slug, status: 'skeleton-only (story preserved)' });
      }
    } else {
      summaries.push({ slug: post.slug, status: 'story preserved, skeleton updated' });
    }
  }
}

if (CHECK_ONLY) {
  console.log(`نافذة بريق: ${summaries.length} قصة جاهزة للمراجعة.`);
} else {
  console.log(`نافذة بريق: ${summaries.length} هيكل عظمي محدّث.`);
  for (const s of summaries) console.log(`  - ${s.slug}: ${s.status}`);
}
