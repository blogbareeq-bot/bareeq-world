import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd();
const postsDir = resolve(root, 'src/content/posts');
const data = JSON.parse(await readFile(resolve(root, 'src/data/visual-stories.json'), 'utf8'));
const posts = (await readdir(postsDir)).filter((name) => name.endsWith('.md')).sort();
const failures = [];
const slugs = new Set();

if (data.schemaVersion !== 1) failures.push('إصدار مخطط نافذة غير مدعوم.');
if (data.stories.length !== posts.length) failures.push(`التغطية ${data.stories.length}/${posts.length}.`);

for (const story of data.stories) {
  if (slugs.has(story.slug)) failures.push(`${story.slug}: slug مكرر.`);
  slugs.add(story.slug);
  if (!posts.includes(`${story.slug}.md`)) failures.push(`${story.slug}: لا يوجد مقال مطابق.`);
  if (!Array.isArray(story.cards) || story.cards.length < 7 || story.cards.length > 12) failures.push(`${story.slug}: عدد البطاقات خارج 7–12.`);
  const ids = new Set();
  for (const card of story.cards || []) {
    if (!card.id || ids.has(card.id)) failures.push(`${story.slug}: معرّف بطاقة مفقود أو مكرر.`);
    ids.add(card.id);
    if (!card.title || !card.body || card.body.length > 290) failures.push(`${story.slug}/${card.id}: محتوى غير صالح.`);
  }
  if (!story.director?.mood || story.director?.motion !== 'calm' || story.director?.palette?.length !== 4) failures.push(`${story.slug}: Visual Director غير مكتمل.`);
  try {
    const source = await readFile(resolve(postsDir, `${story.slug}.md`), 'utf8');
    const fingerprint = createHash('sha256').update(source).digest('hex');
    if (fingerprint !== story.sourceFingerprint) failures.push(`${story.slug}: بصمة المقال تغيرت.`);
  } catch { /* reported above */ }
}

for (const post of posts) if (!slugs.has(post.replace(/\.md$/, ''))) failures.push(`${post}: لا يملك نافذة.`);
if (failures.length) throw new Error(`فشل فحص نافذة بريق:\n- ${failures.join('\n- ')}`);
console.log(`نافذة بريق: ${data.stories.length}/${posts.length} قصة، ${data.stories.reduce((sum, story) => sum + story.cards.length, 0)} بطاقة، وجميع البوابات البنيوية ناجحة.`);
