import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';

const SOURCE = 'scripts/check-audio-dist.mjs';
const TARGET = 'scripts/.v4215-check-audio-dist.mjs';
let source = await readFile(SOURCE, 'utf8');

function replaceOnce(from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one locked source block, found ${count}.`);
  source = source.replace(from, to);
}

replaceOnce(
  "'4.21.4'].includes(pkg.version)",
  "'4.21.4', '4.21.5'].includes(pkg.version)",
  'audio-dist package version',
);
replaceOnce(
  "['4.21.1', '4.21.2', '4.21.3', '4.21.4'].includes(pkg.version)",
  "['4.21.1', '4.21.2', '4.21.3', '4.21.4', '4.21.5'].includes(pkg.version)",
  'audio-dist free rollout versions',
);
replaceOnce(
  "if (published.length !== 13) throw new Error(`V4.20 audio-dist audit expected 13 published articles, found ${published.length}.`);",
  "if (![13, 14].includes(published.length)) throw new Error(`V4.21.5 audio-dist audit expected 13 RC or 14 published articles, found ${published.length}.`);",
  'audio-dist published count',
);
replaceOnce(
  "if (checkedArticles !== 13) throw new Error(`V4.20 audio-dist audit expected 13 complete audio articles, checked ${checkedArticles}.`);",
  "if (checkedArticles !== published.length) throw new Error(`V4.21.5 audio-dist audit expected ${published.length} complete audio articles, checked ${checkedArticles}.`);",
  'audio-dist checked count',
);
replaceOnce(
  "if (cloudActivated && (providerCounts.get('Cloud TTS Sadaltager') !== 11 || providerCounts.get('Gemini Sadaltager') !== 2)) throw new Error('Activated rollout must publish exactly 11 Cloud TTS + 2 retained Gemini articles.');",
  "if (cloudActivated && (providerCounts.get('Cloud TTS Sadaltager') !== PENDING_CLOUD.length || providerCounts.get('Gemini Sadaltager') !== RETAINED_GEMINI.length)) throw new Error(`Activated rollout must publish exactly ${PENDING_CLOUD.length} Cloud TTS + ${RETAINED_GEMINI.length} retained Gemini articles.`);",
  'audio-dist provider count',
);

await writeFile(TARGET, source, 'utf8');
const result = spawnSync(process.execPath, [TARGET], { stdio: 'inherit', env: process.env });
await rm(TARGET, { force: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`V4.21.5 audio-dist compatibility audit failed with status ${result.status ?? 'unknown'}.`);
console.log('V4.21.5 audio-dist compatibility wrapper passed.');
