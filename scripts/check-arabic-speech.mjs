import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_AUDIO_BASELINE, LEGACY_AUDIO_BASELINE_SET } from './publishing-baseline.mjs';

const ROOT = process.cwd();
const inventoryFile = path.join(os.tmpdir(), `bareeq-speech-script-inventory-${process.pid}.json`);
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'scripts', 'check-speech-scripts.mjs'),
    `--json-output=${inventoryFile}`,
  ], { cwd: ROOT, stdio: 'inherit' });
  const inventory = JSON.parse(await readFile(inventoryFile, 'utf8'));
  if (inventory.articleCount < LEGACY_AUDIO_BASELINE.length) throw new Error(`Expected at least the protected ${LEGACY_AUDIO_BASELINE.length}-article Speech Script baseline, found ${inventory.articleCount}.`);
  if (inventory.synthesisAllowed !== 0) throw new Error('Provider publication/synthesisAllowed must stay 0 until later listening/ASR gates pass.');
  const byId = new Map(inventory.articles.map((article) => [article.articleId, article]));
  const missingBaseline = LEGACY_AUDIO_BASELINE.filter((id) => !byId.has(id));
  if (missingBaseline.length) throw new Error(`Protected Speech Script baseline is missing: ${missingBaseline.join(', ')}`);
  const baselineNotApproved = LEGACY_AUDIO_BASELINE.filter((id) => byId.get(id)?.bucket !== 'A');
  if (baselineNotApproved.length) throw new Error(`Protected baseline Speech Scripts must remain bucket A: ${baselineNotApproved.join(', ')}`);
  const postBaseline = inventory.articles.filter((article) => !LEGACY_AUDIO_BASELINE_SET.has(article.articleId));
  const required = ['how-touchscreens-work', 'why-some-passports-are-stronger'];
  for (const id of required) {
    if (!pilots.some((article) => article.articleId === id)) {
      throw new Error(`Required contextual Speech Script ${id} is missing from bucket A.`);
    }
  }
  console.log(`Arabic Speech Script QA validated ${inventory.articleCount} article inventories: protected ${LEGACY_AUDIO_BASELINE.length}-article baseline remains reviewed; ${postBaseline.length} post-baseline article(s) may remain pending review; A=${inventory.counts.passed}, B=${inventory.counts.needsReview}, C=${inventory.counts.highRisk}; provider publication allowed for 0 article(s).`);
  console.log('This result means Speech Script inventory integrity passed. It does NOT mean Test Clip Passed, Audio Review Passed, or Audio Ready.');
} finally {
  await rm(inventoryFile, { force: true }).catch(() => {});
}
