/**
 * Contextual person-ending vocalization review (2026-08-26).
 *
 * Adds the disambiguating final-vowel diacritics to person-ambiguous verb
 * forms whose reading is fixed by context but not by the bare spelling
 * (كُنْتَ / كُنْتُ, عَرَفْتَ / عَرَفْتُ, رَأَيْتَ, قُلْتُ / أَقُلْ ...).
 * Every reading below was selected from the full segment context during the
 * pre-generation linguistic review; diacritic-stripped text is unchanged, so
 * no visible article text or meaning changes.
 *
 * After patching, the script hash is recomputed, the script is revalidated,
 * and the matching test-clip plan is rebound to the new hash with the
 * listening gate reset.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  loadPublishedArticleModels,
  readAmbiguityRules,
  sha256,
  validateSpeechScript,
} from './speech-script-core.mjs';

const ROOT = process.cwd();
const REVIEWED_AT = new Date().toISOString();
const REVIEWER = 'Arena contextual Arabic speech review — person endings (كنت class)';
const METHOD = 'full-context person-ending review: the reader-addressed forms take the fathah on the final taa (كُنْتَ/عَرَفْتَ/رَأَيْتَ), quoted self-statements take the dammah (كُنْتُ/عَرَفْتُ/قُلْتُ), and the jussive after لم takes the sukun (أَقُلْ).';

// articleId -> segmentId -> [[from, to], ...] applied in order, each must match exactly once.
const EDITS = {
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه': {
    'paragraph-765abab7e65e': [['التي كنت على وشك', 'التي كُنْتَ على وشك']],
  },
  'intuition-first-impression-decisions-signature': {
    'list-item-3790d91fd860': [['وهل كنت سأفسر', 'وهل كُنْتُ سأفسر'], ['لو كنت أتمنى', 'لو كُنْتُ أتمنى']],
    'paragraph-74adc3bc6a11': [['«كنت أعرف', '«كُنْتُ أعرف']],
    'paragraph-df4c6ece069e': [['«لاحظت إشارة» إلى «عرفت الإنسان»', '«لاحَظْتُ إشارة» إلى «عَرَفْتُ الإنسان»']],
  },
  'اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا': {
    'paragraph-f979fa2ff6cd': [['إذا كنت تختار منصة', 'إذا كُنْتَ تختار منصة']],
    'list-item-bacaf4ee9085': [['أنا لم أقل إلغاء الواجبات؛ قلت تقليل', 'أنا لم أَقُلْ إلغاء الواجبات؛ قُلْتُ تقليل']],
  },
  'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء': {
    'paragraph-876c182e70d9': [['ثم عرفت أن السلوك', 'ثم عَرَفْتَ أن السلوك']],
  },
  'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون': {
    'paragraph-c6696d6753de': [['عندما كنت مبتدئًا', 'عندما كُنْتَ مبتدئًا']],
    'paragraph-14e5412c381b': [['إذا كنت حائرًا', 'إذا كُنْتَ حائرًا']],
    'list-item-5d49747ad1e0': [['بعد أن رأيت جانبه', 'بعد أن رَأَيْتَ جانبه']],
  },
};

const rules = await readAmbiguityRules(ROOT);
const models = await loadPublishedArticleModels(ROOT);
const pendingWrites = [];
for (const [articleId, segmentEdits] of Object.entries(EDITS)) {
  const model = models.find((item) => item.articleId === articleId);
  if (!model) throw new Error(`No published model for ${articleId}.`);
  const scriptFile = path.join(ROOT, 'scripts', 'speech-scripts', `${articleId}.json`);
  const script = JSON.parse(await readFile(scriptFile, 'utf8'));
  const byId = new Map(script.segments.map((segment) => [segment.segmentId, segment]));
  for (const [segmentId, replacements] of Object.entries(segmentEdits)) {
    const segment = byId.get(segmentId);
    if (!segment) throw new Error(`${articleId}: missing segment ${segmentId}.`);
    let text = segment.spokenText;
    for (const [from, to] of replacements) {
      const occurrences = text.split(from).length - 1;
      if (occurrences !== 1) throw new Error(`${articleId}/${segmentId}: expected exactly one occurrence of "${from}", found ${occurrences}.`);
      text = text.replace(from, to);
    }
    segment.spokenText = text;
    segment.linguisticReview = { status: 'passed', reviewer: REVIEWER, reviewedAt: REVIEWED_AT, method: METHOD };
    segment.pronunciationReview = { status: 'passed', reviewer: REVIEWER, reviewedAt: REVIEWED_AT, method: METHOD };
  }
  script.reviewVersion = Number(script.reviewVersion ?? 1) + 1;
  script.generatedAt = REVIEWED_AT;
  script.scriptHash = sha256(JSON.stringify(script.segments));
  const validation = validateSpeechScript(model, script, rules, { requireReviews: true });
  if (!validation.approved) {
    const details = [...validation.errors, ...validation.segmentResults.flatMap((segment) => segment.errors.map((error) => `${segment.segmentId}: ${error}`))];
    throw new Error(`${articleId}: reviewed Speech Script failed:\n${details.join('\n')}`);
  }
  const planFile = path.join(ROOT, 'scripts', 'speech-test-clips', `${articleId}.json`);
  const plan = JSON.parse(await readFile(planFile, 'utf8'));
  plan.speechScriptHash = script.scriptHash;
  plan.status = 'ready';
  plan.testClipPassed = false;
  plan.fullSynthesisAllowed = false;
  plan.audioReview = { status: 'not-performed', reviewedBy: '', reviewedAt: '', evidence: null };
  plan.planHash = sha256(JSON.stringify({ articleId: plan.articleId, speechScriptHash: plan.speechScriptHash, selectedSegments: plan.selectedSegments, acceptance: plan.acceptance }));
  pendingWrites.push([scriptFile, `${JSON.stringify(script, null, 2)}\n`], [planFile, `${JSON.stringify(plan, null, 2)}\n`]);
  console.log(`REVIEWED ${articleId} newScriptHash=${script.scriptHash.slice(0, 16)} reviewVersion=${script.reviewVersion}`);
}
for (const [file, contents] of pendingWrites) await writeFile(file, contents, 'utf8');
console.log(`PERSON_ENDING_REVIEW_APPLIED=${pendingWrites.length / 2} article(s).`);
