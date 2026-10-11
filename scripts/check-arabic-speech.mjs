import { execFileSync } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { liveAudioDir } from './audio-constants.mjs';

const ROOT = process.cwd();
const inventoryFile = path.join(os.tmpdir(), `bareeq-speech-script-inventory-${process.pid}.json`);
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'scripts', 'check-speech-scripts.mjs'),
    `--json-output=${inventoryFile}`,
  ], { cwd: ROOT, stdio: 'inherit' });
  const inventory = JSON.parse(await readFile(inventoryFile, 'utf8'));
  if (!Number.isInteger(inventory.articleCount) || inventory.articleCount <= 0) {
    throw new Error(`Published Speech Script inventory count is invalid: ${inventory.articleCount}.`);
  }
  const synthesisAllowedArticles = inventory.articles.filter((article) => article.ttsSynthesisAllowed);
  const invalidSynthesisAllowed = synthesisAllowedArticles.filter((article) => article.bucket !== 'A' || article.testClipPassed !== true);
  if (invalidSynthesisAllowed.length) {
    throw new Error(`Full TTS synthesis authorization requires bucket A + Test Clip Passed: ${invalidSynthesisAllowed.map((article) => article.articleId).join(', ')}.`);
  }

  const reviewed = inventory.articles.filter((article) => article.bucket === 'A');
  const pendingFirstAudio = [];
  const liveAudioReviewFailures = [];
  for (const article of inventory.articles) {
    let hasLiveAudio = true;
    try {
      await access(path.join(liveAudioDir(article.articleId, ROOT), 'manifest.json'));
    } catch {
      hasLiveAudio = false;
    }
    if (!hasLiveAudio) pendingFirstAudio.push(article);
    else if (article.bucket !== 'A') liveAudioReviewFailures.push(article);
  }

  if (liveAudioReviewFailures.length) {
    throw new Error(`Published article(s) with live audio must keep reviewed Speech Scripts in bucket A: ${liveAudioReviewFailures.map((article) => article.articleId).join(', ')}.`);
  }

  const required = ['how-touchscreens-work', 'why-some-passports-are-stronger'];
  for (const id of required) {
    if (!reviewed.some((article) => article.articleId === id)) {
      throw new Error(`Required contextual Speech Script ${id} is missing from bucket A.`);
    }
  }

  console.log(`Arabic Speech Script QA validated ${inventory.articleCount} article inventories: ${inventory.counts.passed} text/pronunciation-reviewed article(s), ${inventory.counts.needsReview} needing review, ${inventory.counts.highRisk} high-risk; full TTS synthesis authorized after passed Test Clip for ${inventory.synthesisAllowed} article(s). Publication remains a separate later gate.`);
  if (pendingFirstAudio.length) {
    console.log(`First-audio queue may remain text-published before TTS review: ${pendingFirstAudio.map((article) => `${article.articleId}[${article.bucket}]`).join(', ')}.`);
  }
  console.log('This result means Speech Script inventory integrity passed. A synthesisAllowed article has also passed its bound Test Clip review, but this does NOT mean full-candidate ASR/technical QA/final listening or publication are complete.');
} finally {
  await rm(inventoryFile, { force: true }).catch(() => {});
}
