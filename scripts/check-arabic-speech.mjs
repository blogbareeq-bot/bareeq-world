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
  if (inventory.articleCount < 15) throw new Error(`Expected at least the established 15 published Speech Script inventories, found ${inventory.articleCount}.`);
  if (inventory.synthesisAllowed !== 0) throw new Error('Provider publication/synthesisAllowed must stay 0 until later listening/ASR gates pass.');
  const pilots = inventory.articles.filter((article) => article.bucket === 'A');
  if (pilots.length < 15) {
    throw new Error(`The established 15 reviewed Speech Scripts must remain in bucket A; found ${pilots.length}.`);
  }
  const accounted = (inventory.counts?.passed ?? 0) + (inventory.counts?.needsReview ?? 0) + (inventory.counts?.highRisk ?? 0);
  if (accounted !== inventory.articleCount) {
    throw new Error(`Speech Script inventory accounting mismatch: ${accounted}/${inventory.articleCount}.`);
  }
  const required = ['how-touchscreens-work', 'why-some-passports-are-stronger'];
  for (const id of required) {
    if (!pilots.some((article) => article.articleId === id)) {
      throw new Error(`Required contextual Speech Script ${id} is missing from bucket A.`);
    }
  }
  console.log(`Arabic Speech Script QA validated ${inventory.articleCount} article inventories: ${inventory.counts.passed} text/pronunciation-reviewed article(s), ${inventory.counts.needsReview} needing review, ${inventory.counts.highRisk} high-risk; provider publication allowed for 0 article(s).`);
  console.log('This result means Speech Script inventory integrity passed. It does NOT mean Test Clip Passed, Audio Review Passed, or Audio Ready.');
} finally {
  await rm(inventoryFile, { force: true }).catch(() => {});
}
