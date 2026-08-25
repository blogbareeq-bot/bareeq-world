import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SPEECH_SCRIPT_VERSION,
  loadPublishedArticleModels,
  pathExists,
  readAmbiguityRules,
  sha256,
} from './speech-script-core.mjs';

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, 'scripts', 'speech-scripts');
const FORCE = process.argv.includes('--force');
const now = new Date().toISOString();
const rules = await readAmbiguityRules(ROOT);
const models = await loadPublishedArticleModels(ROOT);
await mkdir(OUTPUT, { recursive: true });

for (const model of models) {
  const destination = path.join(OUTPUT, `${model.articleId}.json`);
  if (!FORCE && await pathExists(destination)) {
    console.log(`↷ ${model.articleId}: existing Speech Script preserved.`);
    continue;
  }
  const script = {
    version: SPEECH_SCRIPT_VERSION,
    articleId: model.articleId,
    sourceSnapshotHash: model.bodyHash,
    sourceStructureHash: model.structureHash,
    generatedAt: now,
    reviewVersion: 1,
    status: 'needs-linguistic-review',
    referenceExclusion: model.referenceExclusion,
    segments: model.segments.map((segment) => ({
      segmentId: segment.segmentId,
      type: segment.type,
      sourceHash: segment.sourceHash,
      sourceText: segment.sourceText,
      spokenText: segment.sourceText,
      transformations: [],
      linguisticReview: { status: 'review-required', reviewer: '', reviewedAt: '' },
      pronunciationReview: { status: 'review-required', reviewer: '', reviewedAt: '' },
    })),
    scriptHash: '',
    notes: 'Generated review inventory only. Synthesis is blocked until every segment is contextually reviewed and the test clip is passed.',
  };
  script.scriptHash = sha256(JSON.stringify(script.segments));
  await writeFile(destination, `${JSON.stringify(script, null, 2)}\n`);
  const ambiguityOccurrences = model.segments.reduce((sum, segment) => sum + rules.reduce((count, rule) => count + (segment.sourceText.match(new RegExp(`(^|[^\\p{L}])${rule.lexeme}(?=$|[^\\p{L}])`, 'gu')) || []).length, 0), 0);
  console.log(`+ ${model.articleId}: ${model.segments.length} segment(s), ${model.referenceExclusion.segmentCount} excluded reference segment(s), ${ambiguityOccurrences} known ambiguity occurrence(s).`);
}
