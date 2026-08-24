import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const ARTICLE_ID = 'how-touchscreens-work';
const articleFile = path.join(ROOT, 'src', 'content', 'posts', `${ARTICLE_ID}.md`);
const productionFile = path.join(ROOT, 'docs', 'editorial', `${ARTICLE_ID}.production.json`);
const overridesFile = path.join(ROOT, 'scripts', 'speech-overrides.json');
const reviewFile = path.join(ROOT, 'scripts', 'speech-review.json');

const sha = (value) => createHash('sha256').update(value).digest('hex');
const source = (await readFile(articleFile, 'utf8')).replace(/\r\n/g, '\n');
const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
if (!match) throw new Error('Invalid touchscreen article frontmatter.');
const body = match[2].trim();
const production = JSON.parse(await readFile(productionFile, 'utf8'));
if (production.articleId !== ARTICLE_ID) throw new Error('Production metadata articleId mismatch.');
const bodyHash = sha(body);
if (bodyHash !== production.bodyHash) {
  throw new Error(`Touchscreen body hash changed: expected ${production.bodyHash}, got ${bodyHash}. Re-review the article before synthesis.`);
}

const overrides = JSON.parse(await readFile(overridesFile, 'utf8'));
overrides.articles ||= {};
overrides.articles[ARTICLE_ID] = production.speechOverrides;
await writeFile(overridesFile, `${JSON.stringify(overrides, null, 2)}\n`);

const review = JSON.parse(await readFile(reviewFile, 'utf8'));
review.articles ||= {};
review.articles[ARTICLE_ID] = production.speechReview;
await writeFile(reviewFile, `${JSON.stringify(review, null, 2)}\n`);

console.log(`Prepared ${ARTICLE_ID} speech metadata at locked bodyHash ${bodyHash}.`);
