import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preserveRejectedTrialEvidence } from './audio-progressive-repair.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'bareeq-rejected-evidence-'));
try {
  const baselineDir = path.join(root, 'baseline-source');
  const trialDir = path.join(root, 'trial-source');
  await Promise.all([
    import('node:fs/promises').then(({ mkdir }) => mkdir(baselineDir, { recursive: true })),
    import('node:fs/promises').then(({ mkdir }) => mkdir(trialDir, { recursive: true })),
  ]);
  await writeFile(path.join(baselineDir, 'full.mp3'), Buffer.from('baseline-audio'));
  await writeFile(path.join(trialDir, 'full.mp3'), Buffer.from('trial-audio'));
  await writeFile(path.join(trialDir, 'reports.json'), JSON.stringify({ score: 4 }));

  const out = await preserveRejectedTrialEvidence({
    articleId: 'article-x',
    fingerprint: 'fp-x',
    baselineDir,
    trialDir,
    replacementAudio: Buffer.from('replacement-audio'),
    metadata: { baselineScore: 1, trialScore: 4, part: 2 },
    runId: 'run-123',
    root,
  });

  assert.equal(await readFile(path.join(out, 'baseline', 'full.mp3'), 'utf8'), 'baseline-audio');
  assert.equal(await readFile(path.join(out, 'trial', 'full.mp3'), 'utf8'), 'trial-audio');
  assert.equal(await readFile(path.join(out, 'replacement.mp3'), 'utf8'), 'replacement-audio');

  const metadata = JSON.parse(await readFile(path.join(out, 'metadata.json'), 'utf8'));
  assert.equal(metadata.schema, 'bareeq.audio-rejected-trial-evidence.v1');
  assert.equal(metadata.runId, 'run-123');
  assert.equal(metadata.articleId, 'article-x');
  assert.equal(metadata.fingerprint, 'fp-x');
  assert.equal(metadata.baselineScore, 1);
  assert.equal(metadata.trialScore, 4);
  assert.equal(metadata.hasReplacementAudio, true);

  console.log('Rejected-trial evidence preservation passed: baseline, trial, replacement, and metadata survive rollback staging.');
} finally {
  await rm(root, { recursive: true, force: true });
}
