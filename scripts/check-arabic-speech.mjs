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
  const approved = inventory.articles.filter((article) => article.bucket === 'A');
  if (approved.length !== 15 || inventory.counts?.needsReview !== 0 || inventory.counts?.highRisk !== 0) throw new Error('All 15 published Speech Scripts must remain in the approved A set.');
  if (!approved.some((article) => article.articleId === 'how-touchscreens-work') || !approved.some((article) => article.articleId === 'why-some-passports-are-stronger')) {
    throw new Error('The two contextual benchmark pilots are missing from the approved A set.');
  }
  console.log(`Arabic Speech Script QA validated ${inventory.articleCount} article inventories: ${inventory.counts.passed} text/pronunciation-reviewed article(s), ${inventory.counts.needsReview} needing review, ${inventory.counts.highRisk} high-risk; provider synthesis allowed for ${inventory.synthesisAllowed} article(s) with verified listening evidence.`);
  console.log('Speech Script approval and listening/full-synthesis approval remain separate states.');
} finally {
  await rm(inventoryFile, { force: true }).catch(() => {});
}
