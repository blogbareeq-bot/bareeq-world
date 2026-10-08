import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { audioKeyFor } from './audio-constants.mjs';
import { buildAudioPriorityQueue, evaluateGenerationPriority } from './audio-priority-guard.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'bareeq-audio-priority-'));
try {
  const posts = path.join(root, 'src', 'content', 'posts');
  await mkdir(posts, { recursive: true });

  const post = (title, date) => `---
title: "${title}"
publishedAt: "${date}"
draft: false
---
نص الاختبار.
`;

  await writeFile(path.join(posts, 'old-a.md'), post('قديم أ', '2026-01-01T00:00:00.000Z'));
  await writeFile(path.join(posts, 'new-a.md'), post('جديد أ', '2026-10-08T00:00:00.000Z'));
  await writeFile(path.join(posts, 'new-b.md'), post('جديد ب', '2026-10-09T00:00:00.000Z'));
  await writeFile(path.join(posts, 'draft.md'), `---
title: "مسودة"
draft: true
---
مسودة.
`);

  const liveDir = path.join(root, 'public', 'audio', 'articles', audioKeyFor('old-a'));
  await mkdir(liveDir, { recursive: true });
  await writeFile(path.join(liveDir, 'manifest.json'), '{"status":"published"}\n');

  const queue = await buildAudioPriorityQueue(root);
  assert.deepEqual(queue.newContent.map((row) => row.articleId), ['new-a', 'new-b']);
  assert.equal(queue.nextSynthesisTarget, 'new-a');
  assert.equal(queue.existingAudio.length, 1);

  const oldDecision = evaluateGenerationPriority(queue, 'old-a');
  assert.equal(oldDecision.allowed, false);
  assert.equal(oldDecision.nextSynthesisTarget, 'new-a');

  const newDecision = evaluateGenerationPriority(queue, 'new-a');
  assert.equal(newDecision.allowed, true);
  assert.equal(newDecision.target.priorityClass, 'new-content-no-live-audio');

  const unknown = evaluateGenerationPriority(queue, 'missing');
  assert.equal(unknown.allowed, false);

  await mkdir(path.join(root, 'public', 'audio', 'articles', audioKeyFor('new-a')), { recursive: true });
  await writeFile(path.join(root, 'public', 'audio', 'articles', audioKeyFor('new-a'), 'manifest.json'), '{}\n');
  await mkdir(path.join(root, 'public', 'audio', 'articles', audioKeyFor('new-b')), { recursive: true });
  await writeFile(path.join(root, 'public', 'audio', 'articles', audioKeyFor('new-b'), 'manifest.json'), '{}\n');

  const cleared = await buildAudioPriorityQueue(root);
  assert.equal(cleared.newContent.length, 0);
  assert.equal(evaluateGenerationPriority(cleared, 'old-a').allowed, true);

  console.log('Audio priority guard tests passed: new content blocks legacy synthesis until every published article has first live audio.');
} finally {
  await rm(root, { recursive: true, force: true });
}
