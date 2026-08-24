import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const POSTS_DIR = path.join(ROOT, 'src', 'content', 'posts');
const review = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'speech-review.json'), 'utf8'));
const diacritics = /[\u064B-\u065F\u0670]/;
const failures = [];

function parsePost(source, filename) {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw new Error(`${filename}: invalid frontmatter.`);
  const frontmatter = match[1];
  const body = match[2].replace(/\r\n/g, '\n').trim();
  const title = frontmatter.match(/^title:\s*["']?(.*?)["']?\s*$/m)?.[1]?.trim();
  const draft = /^draft:\s*true\s*$/mi.test(frontmatter);
  return { title, draft, body };
}
const sha = (value) => createHash('sha256').update(value).digest('hex');

const files = (await readdir(POSTS_DIR)).filter((name) => name.endsWith('.md')).sort();
const live = [];
for (const name of files) {
  const source = await readFile(path.join(POSTS_DIR, name), 'utf8');
  const post = parsePost(source, name);
  if (post.draft) continue;
  const id = name.replace(/\.md$/, '');
  live.push({ id, ...post });
}

let speech;
const speechPlanFile = path.join(os.tmpdir(), `bareeq-speech-qa-${process.pid}.json`);
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-audio.mjs'), `--speech-qa-output=${speechPlanFile}`], {
    cwd: ROOT,
    stdio: 'ignore'
  });
  speech = JSON.parse(await readFile(speechPlanFile, 'utf8'));
} catch (error) {
  console.error('Arabic Speech QA could not obtain the speech plan.');
  throw error;
} finally {
  await rm(speechPlanFile, { force: true }).catch(() => {});
}
const speechById = new Map(speech.map((article) => [article.id, article]));
const liveIds = new Set(live.map((post) => post.id));
const approvedPrepublicationReviews = new Set(['why-some-passports-are-stronger', 'how-touchscreens-work']);
for (const id of Object.keys(review.articles || {})) {
  if (!liveIds.has(id) && !approvedPrepublicationReviews.has(id)) failures.push(`${id}: orphan speech review entry.`);
}

let totalChecks = 0;
for (const post of live) {
  const item = review.articles?.[post.id];
  if (!item) { failures.push(`${post.id}: missing speech review entry.`); continue; }
  const currentHash = sha(post.body);
  if (item.bodyHash !== currentHash) failures.push(`${post.id}: article text changed after the last speech review; review pronunciation and refresh its bodyHash.`);
  const plan = speechById.get(post.id);
  if (!plan) { failures.push(`${post.id}: missing generated speech QA plan.`); continue; }
  const visible = [post.title, ...plan.segments.map((segment) => segment.visibleText)].join('\n');
  const spoken = plan.spokenText;
  const seen = new Set();
  for (const check of item.checks || []) {
    totalChecks += 1;
    if (!check?.from || !check?.to) { failures.push(`${post.id}: malformed speech review check.`); continue; }
    if (seen.has(check.from)) failures.push(`${post.id}: duplicate speech review source phrase: ${check.from}`);
    seen.add(check.from);
    if (!visible.includes(check.from)) failures.push(`${post.id}: reviewed source phrase no longer exists: ${check.from}`);
    if (!spoken.includes(check.to)) failures.push(`${post.id}: reviewed pronunciation is not present in spoken text: ${check.to}`);
    if (!diacritics.test(check.to)) failures.push(`${post.id}: reviewed pronunciation contains no Arabic diacritics: ${check.to}`);
  }
  for (const lexeme of review.riskLexemes || []) {
    if (!visible.includes(lexeme)) continue;
    const escaped = lexeme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rawToken = new RegExp(`(^|[^\\p{L}])${escaped}($|[^\\p{L}])`, 'u');
    if (rawToken.test(spoken)) failures.push(`${post.id}: high-risk Arabic homograph remains unvocalized in spoken text: ${lexeme}`);
  }
}

if (failures.length) {
  console.error(`Arabic Speech QA found ${failures.length} failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`Arabic Speech QA passed: ${live.length}/${live.length} articles locked to reviewed text hashes; ${totalChecks} contextual pronunciation checks verified before Studio import or synthesis.`);
