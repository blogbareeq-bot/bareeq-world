import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const canonicalPath = path.join(ROOT, 'scripts/speech-transcript-evidence/how-touchscreens-work-hamed-final-production-v3.json');
const gemini35Path = path.join(ROOT, 'scripts/speech-transcript-evidence/how-touchscreens-work-hamed-final-production-v3-gemini35-checkpoint.json');
const manifestPath = path.join(ROOT, 'public/audio/articles/de93f3d9f91c8b8b/manifest.json');
const metaPath = path.join(ROOT, 'scripts/speech-test-evidence/how-touchscreens-work-hamed-final-production-v3.json');
const REQUIRED_MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash'];
const EXPECTED_AUDIO_SHA = 'c46d1426210c595562aeda5d3acc40e82f98475d712d9ca3ba7caf7632d9f1ce';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const canonical = JSON.parse(await readFile(canonicalPath, 'utf8'));
const isolated = JSON.parse(await readFile(gemini35Path, 'utf8'));
if (canonical.audioSha256 !== EXPECTED_AUDIO_SHA || isolated.audioSha256 !== EXPECTED_AUDIO_SHA) throw new Error('Checkpoint audio SHA mismatch.');
if (canonical.partCount !== 10 || isolated.partCount !== 10) throw new Error('Checkpoint part count mismatch.');

for (const sourcePart of isolated.parts || []) {
  let targetPart = canonical.parts.find((part) => part.part === sourcePart.part && part.audioSha256 === sourcePart.audioSha256);
  if (!targetPart) {
    targetPart = { part: sourcePart.part, audioSha256: sourcePart.audioSha256, expectedWordCount: sourcePart.expectedWordCount, models: [] };
    canonical.parts.push(targetPart);
  }
  for (const sourceModel of sourcePart.models || []) {
    if (!REQUIRED_MODELS.includes(sourceModel.model)) continue;
    let targetModel = targetPart.models.find((model) => model.model === sourceModel.model);
    if (!targetModel) {
      targetModel = { model: sourceModel.model, status: 'pending', selectedAttempt: null, attempts: [] };
      targetPart.models.push(targetModel);
    }
    const seen = new Set(targetModel.attempts.map((attempt) => `${attempt.promptSha256}:${attempt.transcriptSha256}`));
    for (const attempt of sourceModel.attempts || []) {
      const key = `${attempt.promptSha256}:${attempt.transcriptSha256}`;
      if (!seen.has(key)) {
        targetModel.attempts.push({ ...attempt, attempt: targetModel.attempts.length + 1 });
        seen.add(key);
      }
    }
    const exact = targetModel.attempts.find((attempt) => attempt.exact === true);
    targetModel.status = exact ? 'passed' : 'pending';
    targetModel.selectedAttempt = exact?.attempt ?? null;
  }
}

canonical.parts.sort((a, b) => a.part - b.part);
for (const part of canonical.parts) part.models.sort((a, b) => REQUIRED_MODELS.indexOf(a.model) - REQUIRED_MODELS.indexOf(b.model));
const selectedExactPasses = canonical.parts.reduce((sum, part) => sum + REQUIRED_MODELS.filter((model) => part.models.some((entry) => entry.model === model && entry.status === 'passed')).length, 0);
const allPassed = canonical.parts.length === 10 && canonical.parts.every((part) => REQUIRED_MODELS.every((model) => part.models.some((entry) => entry.model === model && entry.status === 'passed' && entry.attempts.some((attempt) => attempt.attempt === entry.selectedAttempt && attempt.exact === true))));
canonical.requiredModels = REQUIRED_MODELS;
canonical.requiredExactPasses = 20;
canonical.selectedExactPasses = selectedExactPasses;
canonical.progressPercent = Number(((selectedExactPasses / 20) * 100).toFixed(1));
canonical.pendingModelParts = Array.from({ length: 10 }, (_, index) => index + 1).flatMap((partNumber) => REQUIRED_MODELS.filter((model) => !canonical.parts.find((part) => part.part === partNumber)?.models.some((entry) => entry.model === model && entry.status === 'passed')).map((model) => ({ part: partNumber, model })));
canonical.status = allPassed ? 'passed' : 'pending';
canonical.verifiedAt = allPassed ? new Date().toISOString() : null;
canonical.mergedAt = new Date().toISOString();
await writeFile(canonicalPath, `${JSON.stringify(canonical, null, 2)}\n`);

if (allPassed) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  manifest.verifiedStaticAudio = true;
  manifest.automatedTranscriptReview = {
    status: 'passed',
    scope: 'complete-article-all-ten-immutable-parts',
    verificationMode: 'ten-immutable-production-parts-two-distinct-models-exact-checkpointed',
    reportFile: path.relative(ROOT, canonicalPath).replaceAll('\\', '/'),
    reportSha256: sha256(await readFile(canonicalPath)),
    transcriptionProvider: 'Google Gemini API',
    transcriptionModels: REQUIRED_MODELS,
    exactModelPassesPerPart: 2,
    partCount: 10,
    expectedWordCount: canonical.expectedWordCount,
    selectedWordErrorCount: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    fullAudioSha256: EXPECTED_AUDIO_SHA,
    humanListening: false,
    reviewedAt: canonical.verifiedAt,
  };
  meta.qaStatus = 'passed';
  meta.qaReport = path.relative(ROOT, canonicalPath).replaceAll('\\', '/');
  meta.qaReportSha256 = manifest.automatedTranscriptReview.reportSha256;
  meta.verifiedAt = canonical.verifiedAt;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}
console.log(`HAMED_QA_MERGED exact=${selectedExactPasses}/20 progress=${canonical.progressPercent}% status=${canonical.status}`);
