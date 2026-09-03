import { mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractArticleSpeechModel } from './speech-script-core.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const FIXTURE_MD = `---
title: "اختبار الاستئناف"
draft: false
---
هذه فقرة أولى مخصصة لتقسيم الأجزاء أثناء الاختبار.

هذه فقرة ثانية مخصصة لتقسيم الأجزاء أثناء الاختبار.

هذه فقرة ثالثة مخصصة لتقسيم الأجزاء أثناء الاختبار.

هذه فقرة رابعة مخصصة لتقسيم الأجزاء أثناء الاختبار.
`;

const review = {
  status: 'passed',
  reviewer: 'fixture-reviewer',
  reviewedAt: '2026-08-29T00:00:00.000Z',
};

export async function writeApprovedFixture(dir, { articleId = 'resume-fixture', markdown = FIXTURE_MD, copyRulesFrom } = {}) {
  const posts = path.join(dir, 'src', 'content', 'posts');
  await mkdir(posts, { recursive: true });
  await writeFile(path.join(posts, `${articleId}.md`), markdown);
  const model = extractArticleSpeechModel({ articleId, source: markdown, filename: `${articleId}.md` });
  const script = {
    version: 1,
    articleId,
    sourceSnapshotHash: model.bodyHash,
    sourceStructureHash: model.structureHash,
    generatedAt: '2026-08-29T00:00:00.000Z',
    reviewVersion: 1,
    status: 'pronunciation-review-passed-test-clip-ready',
    referenceExclusion: model.referenceExclusion,
    segments: model.segments.map((segment) => ({
      segmentId: segment.segmentId,
      type: segment.type,
      sourceHash: segment.sourceHash,
      sourceText: segment.sourceText,
      spokenText: segment.sourceText,
      transformations: [],
      linguisticReview: review,
      pronunciationReview: review,
    })),
  };
  script.scriptHash = sha256(JSON.stringify(script.segments));
  const scriptsDir = path.join(dir, 'scripts', 'speech-scripts');
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(path.join(scriptsDir, `${articleId}.json`), `${JSON.stringify(script, null, 2)}\n`);
  const plan = {
    version: 1,
    articleId,
    speechScriptHash: script.scriptHash,
    status: 'ready',
    testClipPassed: false,
    fullSynthesisAllowed: false,
    expectedDurationSeconds: 60,
    selectedSegments: [],
    audioReview: { status: 'not-performed', reviewedBy: '', reviewedAt: '', evidence: null },
  };
  const clipsDir = path.join(dir, 'scripts', 'speech-test-clips');
  await mkdir(clipsDir, { recursive: true });
  await writeFile(path.join(clipsDir, `${articleId}.json`), `${JSON.stringify(plan, null, 2)}\n`);
  if (copyRulesFrom) {
    await mkdir(path.join(dir, 'scripts'), { recursive: true });
    await cp(path.join(copyRulesFrom, 'scripts', 'contextual-ambiguities.json'), path.join(dir, 'scripts', 'contextual-ambiguities.json'));
  }
  return { model, script, plan };
}
