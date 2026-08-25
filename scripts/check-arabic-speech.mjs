import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const inventoryFile = path.join(os.tmpdir(), `bareeq-speech-script-inventory-${process.pid}.json`);
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'scripts', 'check-speech-scripts.mjs'),
    `--json-output=${inventoryFile}`,
  ], { cwd: ROOT, stdio: 'inherit' });
  const inventory = JSON.parse(await readFile(inventoryFile, 'utf8'));
  if (inventory.articleCount !== 15) throw new Error(`Expected 15 published Speech Script inventories, found ${inventory.articleCount}.`);
  if (inventory.synthesisAllowed !== 0) throw new Error('This no-audio migration must leave every provider synthesis gate closed until a real test clip is reviewed.');
  const pilots = inventory.articles.filter((article) => article.bucket === 'A');
  if (pilots.length !== 2 || !pilots.some((article) => article.articleId === 'how-touchscreens-work') || !pilots.some((article) => article.articleId === 'why-some-passports-are-stronger')) {
    throw new Error('The two required contextual Speech Script pilots are not the exact approved A set.');
  }
  console.log(`Arabic Speech Script QA validated ${inventory.articleCount} article inventories: ${inventory.counts.passed} text/pronunciation-reviewed pilot(s), ${inventory.counts.needsReview} needing review, ${inventory.counts.highRisk} high-risk; provider synthesis allowed for 0 article(s).`);
  console.log('This result means Speech Script inventory integrity passed. It does NOT mean Test Clip Passed, Audio Review Passed, or Audio Ready.');
} finally {
  await rm(inventoryFile, { force: true }).catch(() => {});
}
