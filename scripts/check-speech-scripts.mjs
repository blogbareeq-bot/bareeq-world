import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deriveInventoryStatus,
  detectContextualAmbiguities,
  findForeignTerms,
  loadPublishedArticleModels,
  readAmbiguityRules,
  readSpeechScript,
  readTestClipPlan,
  sha256,
  validateSpeechScript,
  verifyTestClipEvidence,
} from './speech-script-core.mjs';

const ROOT = process.cwd();
const outputArg = process.argv.find((argument) => argument.startsWith('--json-output='));
const outputFile = outputArg ? path.resolve(ROOT, outputArg.slice('--json-output='.length)) : null;
const rules = await readAmbiguityRules(ROOT);
const models = await loadPublishedArticleModels(ROOT);
const failures = [];
const inventory = [];

const benchmarkPhrases = {
  'how-touchscreens-work': [
    'كَيْفَ تَعْرِفُ شَاشَةُ هَاتِفِكَ أَيْنَ وَضَعْتَ إِصْبَعَكَ',
    'تُعْرَفُ بِاسْمِ',
    'تُكَوِّنُ مَجَالَاتٍ كَهْرَبَائِيَّةً',
    'تُرَتَّبُ الأَقْطَابُ',
    'تُنْتِجُ الصُّورَةَ',
    'وَيَنْتُجُ عَنْ ذَلِكَ تَغَيُّرٌ',
    'قَدْ تُنْتِجُ الرُّطُوبَةُ نَمَطًا',
    'شَيْئًا مَا تَغَيَّرَ',
    'فَيَنْشَأُ نَمَطَانِ مُنْفَصِلَانِ',
    'يَكُونُ مُوَصِّلَانِ قَرِيبَيْنِ',
    'تُوَلِّدُهُ طَبَقَةُ الاسْتِشْعَارِ',
    'حَوَّلَتِ الإِلِكْتْرُونِيَّاتُ ذَلِكَ التَّغَيُّرَ',
    'كَيْفَ تَعْرِفُ الشَّاشَةُ أَنَّكَ تَسْتَخْدِمُ إِصْبَعَيْنِ',
  ],
  'why-some-passports-are-stronger': [
    'وَلِهَذَا تَعُدُّهَا مَنْهَجِيَّةُ مُؤَشِّرِ هِينْلِي',
    'بَيْنَمَا تَحْسِبُ التَّصْرِيحَ الإِلِكْتُرُونِيَّ',
    'غَالِبًا سَتَرُدُّ الدَّوْلَةُ',
    'لَا قَاعِدَةَ تَصْدُقُ فِي كُلِّ حَالَةٍ',
    'جَوَازَاتٍ تَصْدُرُ عَبْرَ أَنْظِمَةِ تَحَقُّقٍ',
    'تُنَظِّمُهُ عَادَةً اتِّفَاقِيَّاتٌ',
    'قَدْ تُعَلِّقُ دُوَلٌ أُخْرَى إِعْفَاءَاتِهَا',
    'تُشَدِّدُ اشْتِرَاطَاتِهَا',
    'هَذِهِ الحُرِّيَّةُ لَمْ تُولَدْ مِنْ قَرَارٍ سِيَاسِيٍّ',
    'وَتَذْكُرُ بَيَانَاتُ المُؤَشِّرِ التَّارِيخِيَّةُ',
    'إِذَا كَانَتْ تَصْدُرُ خِلَالَ ثَلَاثَةِ أَيَّامٍ',
    'لِأَنَّهُ يُحَوِّلُ اكْتِسَابَ الجِنْسِيَّةِ',
  ],
};

for (const model of models) {
  const script = await readSpeechScript(model.articleId, ROOT);
  const validation = validateSpeechScript(model, script, rules, { requireReviews: false });
  const structuralErrors = [...validation.errors];
  for (const segment of validation.segmentResults) {
    for (const error of segment.errors) {
      if (!error.startsWith('unresolved contextual ambiguity')) structuralErrors.push(`${segment.segmentId}: ${error}`);
    }
  }
  if (!script) structuralErrors.push('Speech Script file is missing');
  if (script && script.scriptHash !== sha256(JSON.stringify(script.segments))) structuralErrors.push('scriptHash mismatch');
  if (structuralErrors.length) failures.push(...structuralErrors.map((error) => `${model.articleId}: ${error}`));

  const plan = await readTestClipPlan(model.articleId, ROOT);
  const planErrors = [];
  if (!plan) planErrors.push('test clip plan is missing');
  else {
    if (plan.articleId !== model.articleId) planErrors.push('test clip articleId mismatch');
    if (plan.speechScriptHash !== script?.scriptHash) planErrors.push('test clip speechScriptHash mismatch');
    const ids = new Set(model.segments.map((segment) => segment.segmentId));
    if (!Array.isArray(plan.selectedSegments) || !plan.selectedSegments.length) planErrors.push('test clip has no selected segments');
    for (const selected of plan.selectedSegments ?? []) if (!ids.has(selected.segmentId)) planErrors.push(`test clip references unknown segment ${selected.segmentId}`);
    const expectedPlanHash = sha256(JSON.stringify({ articleId: plan.articleId, speechScriptHash: plan.speechScriptHash, selectedSegments: plan.selectedSegments, acceptance: plan.acceptance }));
    if (plan.planHash !== expectedPlanHash) planErrors.push('test clip planHash mismatch');
    const testClipEvidenceVerified = await verifyTestClipEvidence(plan, ROOT);
    const audioEvidencePassed = plan.audioReview?.status === 'passed' && plan.audioReview?.reviewedBy && plan.audioReview?.reviewedAt && testClipEvidenceVerified;
    if (plan.testClipPassed && !audioEvidencePassed) planErrors.push('testClipPassed requires an existing audio evidence file, matching SHA-256, reviewer, and review date');
    if (plan.fullSynthesisAllowed !== Boolean(validation.approved && plan.testClipPassed && audioEvidencePassed)) planErrors.push('fullSynthesisAllowed is inconsistent with reviews/test clip evidence');
  }
  if (planErrors.length) failures.push(...planErrors.map((error) => `${model.articleId}: ${error}`));

  const benchmark = benchmarkPhrases[model.articleId] ?? [];
  const fullSpokenText = (script?.segments ?? []).map((segment) => segment.spokenText).join('\n');
  const missingBenchmarks = benchmark.filter((phrase) => !fullSpokenText.includes(phrase));
  if (missingBenchmarks.length) failures.push(...missingBenchmarks.map((phrase) => `${model.articleId}: required benchmark vocalization is missing: ${phrase}`));
  if (benchmark.length && !validation.approved) failures.push(`${model.articleId}: reference pilot is not fully approved.`);
  if (benchmark.length && plan?.status !== 'ready') failures.push(`${model.articleId}: reference pilot test clip plan is not ready.`);
  if (benchmark.length && (plan?.testClipPassed || plan?.fullSynthesisAllowed)) failures.push(`${model.articleId}: no test clip was generated/reviewed in this task; passed/synthesis state is forbidden.`);

  const ambiguityFindings = model.segments.flatMap((segment) => {
    const record = script?.segments?.find((item) => item.segmentId === segment.segmentId);
    return detectContextualAmbiguities(segment.sourceText, record?.spokenText ?? segment.sourceText, rules).map((finding) => ({ segmentId: segment.segmentId, ...finding }));
  });
  const ambiguityOccurrences = ambiguityFindings.reduce((sum, finding) => sum + finding.occurrences, 0);
  const unresolvedAmbiguities = ambiguityFindings.reduce((sum, finding) => sum + finding.unresolved, 0);
  const sourceForeignTerms = [...new Set(model.segments.flatMap((segment) => findForeignTerms(segment.sourceText)))];
  const spokenForeignTerms = [...new Set((script?.segments ?? []).flatMap((segment) => findForeignTerms(segment.spokenText)))];
  const classification = deriveInventoryStatus(validation, model);
  inventory.push({
    articleId: model.articleId,
    title: model.title,
    segments: model.segments.length,
    ambiguities: ambiguityOccurrences,
    unresolvedAmbiguities,
    foreignTerms: sourceForeignTerms.length,
    foreignTermValues: sourceForeignTerms,
    unresolvedForeignTerms: spokenForeignTerms.length,
    unresolvedForeignTermValues: spokenForeignTerms,
    excludedReferenceSegments: model.referenceExclusion.segmentCount,
    referenceHeading: model.referenceExclusion.heading,
    reviewedSegments: validation.segmentResults.filter((segment) => segment.linguisticPassed && segment.pronunciationPassed).length,
    reviewStatus: classification.status,
    bucket: classification.bucket,
    riskLevel: classification.riskLevel,
    speechScriptApproved: validation.approved,
    testClipStatus: plan?.status ?? 'missing',
    testClipPassed: Boolean(plan?.testClipPassed),
    ttsSynthesisAllowed: Boolean(plan?.fullSynthesisAllowed),
    missingBenchmarks,
  });
}

const counts = Object.fromEntries(['A', 'B', 'C'].map((bucket) => [bucket, inventory.filter((item) => item.bucket === bucket).length]));
const report = {
  schema: 'bareeq.speech-script-inventory.v1',
  generatedAt: new Date().toISOString(),
  articleCount: inventory.length,
  counts: { passed: counts.A, needsReview: counts.B, highRisk: counts.C },
  synthesisAllowed: inventory.filter((item) => item.ttsSynthesisAllowed).length,
  articles: inventory,
};
if (outputFile) await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);

if (failures.length) {
  console.error(`Speech Script quality gate found ${failures.length} structural/benchmark failure(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`Speech Script inventory validated: ${inventory.length} article(s); A=${counts.A}, B=${counts.B}, C=${counts.C}; ${report.synthesisAllowed} article(s) allowed to synthesize.`);
console.log('Reference pilots: linguistic + pronunciation text review passed; test clips are READY but NOT GENERATED and NOT PASSED.');
