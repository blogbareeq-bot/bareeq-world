import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ARTICLE_ID, inspectArtifact } from './audio-forensics-37284619084.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'bareeq-forensics-'));
const fp = 'fixture-fingerprint';
const candidate = path.join(root, 'audio-candidates', ARTICLE_ID, fp);
await mkdir(path.join(root, 'docs', 'audio'), { recursive: true });
await mkdir(path.join(candidate, 'reports'), { recursive: true });
await writeFile(path.join(root, 'docs', 'audio', 'PROGRESSIVE-STATUS.json'), JSON.stringify({
  rows: [{ articleId: ARTICLE_ID, fingerprint: fp, exact: false, publishedExact: false, baselineScore: 1, rejectedScore: 4 }],
}));
await writeFile(path.join(root, 'docs', 'audio', 'ENGINE-STRATEGY-STATE.json'), JSON.stringify({
  exactBaseline: 7, successfulTtsSinceLastNewExact: 29, threshold: 30,
}));
await writeFile(path.join(candidate, 'full.mp3'), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(256, 1)]));
await writeFile(path.join(candidate, 'reports', 'asr-adjudication.json'), JSON.stringify({ consensus: { substitutions: 1 } }));
await writeFile(path.join(candidate, 'request-log.json'), JSON.stringify({ entries: [{ action: 'resume-skip', providerCalls: 0 }] }));

try {
  const missingTrial = await inspectArtifact(root);
  assert.equal(missingTrial.classification, 'INSUFFICIENT_EVIDENCE');
  assert.equal(missingTrial.evidence.fullAudio.length, 1);
  assert.equal(missingTrial.evidence.trialAudio.length, 0);

  await writeFile(path.join(candidate, 'rejected-trial.mp3'), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(256, 2)]));
  const withTrial = await inspectArtifact(root);
  assert.equal(withTrial.classification, 'EVIDENCE_AVAILABLE_FOR_DIFFERENTIAL');
  assert.equal(withTrial.evidence.trialAudio.length, 1);

  console.log('Forensics inventory tests passed: baseline-only artifacts are insufficient; retained rejected audio unlocks differential analysis.');
} finally {
  await rm(root, { recursive: true, force: true });
}
