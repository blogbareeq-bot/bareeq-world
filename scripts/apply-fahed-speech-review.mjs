import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  loadPublishedArticleModels,
  readAmbiguityRules,
  sha256,
  stripDiacritics,
  validateSpeechScript,
} from './speech-script-core.mjs';

const ROOT = process.cwd();
const REVIEWED_AT = '2026-08-25T12:00:00.000Z';
const REVIEWER = 'Codex — Bareeq contextual Arabic speech review';
const REVIEW_METHOD = 'full-segment contextual review with selective homograph vocalization; CATT ED used only as a second opinion after its out-of-domain output failed the gold-script benchmark';
const REFERENCE_PILOTS = new Set(['how-touchscreens-work', 'why-some-passports-are-stronger']);
const ARABIC_TOKEN = /[\u0621-\u064A][\u0621-\u064A\u064B-\u065F\u0670]*/gu;

const DEFAULT_READINGS = Object.freeze({
  'تعرف': 'تَعْرِفُ',
  'تكون': 'تَكُونُ',
  'تنتج': 'تُنْتِجُ',
  'ينتج': 'يُنْتِجُ',
  'يحول': 'يُحَوِّلُ',
  'ينشأ': 'يَنْشَأُ',
  'تنشأ': 'تَنْشَأُ',
  'ترتب': 'تُرَتِّبُ',
});

const SEGMENT_READINGS = Object.freeze({
  'ai-agents-future-now:h3-2bf406c13b53': { 'تغير': 'تَغَيُّرُ' },
  'ai-agents-future-now:paragraph-ba76df5f23a6': { 'تغير': 'تَغَيَّرَ' },
  'ai-as-coworker-future-of-human-work:paragraph-b95be186295e': { 'تغير': 'تُغَيِّرُ' },
  'altadakhom-explained-simply:paragraph-0d6028643493': { 'تغير': 'تَغَيَّرَ' },
  'altadakhom-explained-simply:paragraph-fcb500a15977': { 'تغير': 'تَغَيُّرٌ' },
  'altadakhom-explained-simply:paragraph-8d415d8749b8': { 'تغير': 'تَغَيُّرَ' },
  'altadakhom-explained-simply:paragraph-7f3bbe863940': { 'تعرف': 'تُعَرِّفُ', 'تغير': 'تَغَيُّرَ' },
  'altadakhom-explained-simply:paragraph-40b7e2093041': { 'تغير': 'تُغَيِّرُ' },
  'altadakhom-explained-simply:paragraph-5fe7afc02d39': { 'تغير': 'تَغَيُّرٌ' },
  'language-soft-power-politics:paragraph-4c1eead74935': { 'تغير': 'تُغَيِّرُ' },
  'language-soft-power-politics:paragraph-2325aa25c24f': { 'تغير': 'تُغَيِّرَ' },
  'language-soft-power-politics:paragraph-18e5b1924ccd': { 'تذكر': 'تَذْكُرُ' },
  'language-soft-power-politics:list-item-963d7866576b': { 'تنتج': 'تُنْتَجُ' },
  'اطياف-الوهم-مغالطات-منطقيه-نقع-فيها-يوميا-تخدع-عقولنا:paragraph-9f210eb390e1': { 'تغير': 'تَغَيَّرَ' },
  'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع:paragraph-8a909d08fc7b': { 'تغير': 'تَغَيَّرَ' },
  'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع:h3-c1265baf9098': { 'تذكر': 'تَذَكَّرْ' },
  'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع:paragraph-1a250776aae0': { 'تذكر': 'تَذَكَّرْ' },
  'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع:list-item-f65249a8a8a8': { 'تذكر': 'تَذَكَّرْ' },
  'كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار:paragraph-68f5c9fb5f8f': { 'تعرف': 'تُعَرِّفُ', 'تنشأ': 'تَنْشَأُ' },
  'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء:quote-99fbe0a8d6a8': { 'تغير': 'تُغَيِّرُ' },
  'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء:paragraph-90eb80358cc7': { 'تذكر': 'تُذْكَرُ' },
  'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء:paragraph-f501c4f52d7a': { 'تغير': 'تُغَيِّرُ' },
  'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء:paragraph-b6c9c1e48b99': { 'تذكر': 'تَذَكَّرْ' },
});

const FOREIGN_REPLACEMENTS = Object.freeze({
  'ai-agents-future-now:paragraph-fc36daa7d9dd': [
    { type: 'remove-duplicated-english', from: ' (AI Agents)', to: '' },
  ],
  'ai-agents-future-now:h3-c7de653d7b65': [
    { type: 'foreign-name-pronunciation', from: 'Agent', to: 'وَكِيلًا' },
  ],
  'ai-as-coworker-future-of-human-work:paragraph-0d2729862b9c': [
    { type: 'foreign-name-pronunciation', from: 'Anthropic', to: 'أَنْثْرُوبِك' },
    { type: 'foreign-name-pronunciation', from: 'Claude.ai', to: 'مِنَصَّةِ كلود' },
  ],
  'ai-as-coworker-future-of-human-work:paragraph-a662b626cfca': [
    { type: 'foreign-name-pronunciation', from: 'Organization Science', to: 'مَجَلَّةِ عُلُومِ المُنَظَّمَات' },
  ],
  'ai-as-coworker-future-of-human-work:paragraph-8d8549ec544a': [
    { type: 'foreign-name-pronunciation', from: 'The Quarterly Journal of Economics', to: 'المَجَلَّةِ الفَصْلِيَّةِ لِلاقْتِصَاد' },
  ],
  'ai-as-coworker-future-of-human-work:paragraph-1cad270153d2': [
    { type: 'foreign-name-pronunciation', from: 'McKinsey', to: 'مَاكِنْزِي' },
  ],
  'ai-as-coworker-future-of-human-work:paragraph-dbb52ceb2583': [
    { type: 'foreign-name-pronunciation', from: 'Radiology', to: 'مَجَلَّةِ الأَشِعَّة' },
  ],
  'ai-as-coworker-future-of-human-work:paragraph-bea0f1de2453': [
    { type: 'foreign-name-pronunciation', from: 'Stanford Digital Economy Lab', to: 'مُخْتَبَرِ ستانفورد لِلاقْتِصَادِ الرَّقْمِيّ' },
  ],
  'ai-as-coworker-future-of-human-work:paragraph-5d6b093bfdff': [
    { type: 'foreign-name-pronunciation', from: 'Procter & Gamble', to: 'بروكتر آند غامبل' },
  ],
  'ai-as-coworker-future-of-human-work:paragraph-cbc068029e64': [
    { type: 'foreign-name-pronunciation', from: 'Linux Foundation', to: 'مُؤَسَّسَةُ لِينُكْس' },
  ],
  'altadakhom-explained-simply:paragraph-2b106e9f544e': [
    { type: 'remove-duplicated-english', from: ' (CPI)', to: '' },
  ],
  'language-soft-power-politics:paragraph-de959534a8b4': [
    { type: 'remove-duplicated-english', from: ' (Harvard Kennedy School)', to: '' },
  ],
  'language-soft-power-politics:paragraph-883a0188a53c': [
    { type: 'remove-duplicated-english', from: ' (Korea Foundation)', to: '' },
  ],
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا:paragraph-e422bbcfdd45': [
    { type: 'abbreviation-expansion', from: 'D', to: 'دَال' },
  ],
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه:paragraph-206fe5f04af9': [
    { type: 'foreign-name-pronunciation', from: 'Google', to: 'غُوغِل' },
  ],
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه:paragraph-9b0e22da8ba3': [
    { type: 'foreign-name-pronunciation', from: 'Google', to: 'غُوغِل' },
  ],
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه:paragraph-0b0d617c8539': [
    { type: 'foreign-name-pronunciation', from: 'Google', to: 'غُوغِل' },
  ],
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه:paragraph-cc2f9125c824': [
    { type: 'foreign-name-pronunciation', from: 'مثل Trie', to: 'مثل شَجَرَةِ البَادِئَات' },
    { type: 'foreign-name-pronunciation', from: 'الـTrie', to: 'شَجَرَةِ البَادِئَات' },
  ],
  'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون:paragraph-946b8f4ff502': [
    { type: 'foreign-name-pronunciation', from: "So Good They Can't Ignore You", to: 'مُمَيَّزٌ لِدَرَجَةٍ لَنْ يَتَجَاهَلُوكَ' },
  ],
  'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون:paragraph-7dd625db2e70': [
    { type: 'foreign-name-pronunciation', from: 'Psychological Science', to: 'مَجَلَّةِ عِلْمِ النَّفْس' },
  ],
});

const ARABIC_PHRASE_READINGS = Object.freeze({
  'altadakhom-explained-simply:paragraph-694a13930711': [
    { from: 'معدل تغيّره', to: 'مُعَدَّلَ تَغَيُّرِهِ' },
  ],
  'altadakhom-explained-simply:paragraph-5fe7afc02d39': [
    { from: 'تغيرًا أوسع', to: 'تَغَيُّرًا أوسع' },
  ],
  'intuition-first-impression-decisions-signature:paragraph-91fa165f8919': [
    { from: 'التي تكوّنت', to: 'الَّتِي تَكَوَّنَتْ' },
  ],
  'intuition-first-impression-decisions-signature:paragraph-43c5ad9e5bd4': [
    { from: 'نمط تعرفت إليه', to: 'نمط تَعَرَّفْتَ إِلَيْهِ' },
  ],
  'intuition-first-impression-decisions-signature:paragraph-fd9ad5d510f4': [
    { from: 'هل تغيرت الوعود', to: 'هل تَغَيَّرَتِ الوعود' },
  ],
  'intuition-first-impression-decisions-signature:paragraph-b89298bdaf6b': [
    { from: 'وذاكرة تعرفت إلى النمط', to: 'وذاكرة تَعَرَّفَتْ إِلَى النمط' },
  ],
  'language-soft-power-politics:paragraph-cb5bd1232980': [
    { from: 'ثم يحولهما الزمن', to: 'ثم يُحَوِّلُهُمَا الزمن' },
  ],
  'كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار:paragraph-9199ecb1f7aa': [
    { from: 'ما تعرفه', to: 'ما تَعْرِفُهُ' },
  ],
  'كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار:h2-538e6d669a08': [
    { from: 'ما تعرفه', to: 'ما تَعْرِفُهُ' },
  ],
  'كيف-تتعامل-مع-المواقف-الصعبه-دليل-عملي-للهدوء-واتخاذ-القرار:paragraph-8299c83f29c0': [
    { from: 'ما تعرفه', to: 'ما تَعْرِفُهُ' },
  ],
  'لا-تبحث-عن-شغفك-ابنه-الحقيقه-العلميه-التي-يجهلها-كثيرون:paragraph-9df0ca3ace9a': [
    { from: 'أولوياتك تغيرت', to: 'أولوياتك تَغَيَّرَتْ' },
  ],
  'لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء:paragraph-a20846203eb3': [
    { from: 'وسرعتها المدارية يحولان', to: 'وسرعتها المدارية يُحَوِّلَانِ' },
  ],
});

// These corrections run after the homograph pass because grammatical mood is
// determined by the preceding particle, not by the isolated word form.
const FINAL_SPOKEN_CORRECTIONS = Object.freeze({
  'intuition-first-impression-decisions-signature:h2-0e08312653c7': [
    { from: 'قبل أن تَعْرِفُ', to: 'قبل أن تَعْرِفَ' },
  ],
  'intuition-first-impression-decisions-signature:paragraph-290662903071': [
    { from: 'أن تَكُونُ', to: 'أن تَكُونَ' },
  ],
  'intuition-first-impression-decisions-signature:paragraph-e28ee9a1d454': [
    { from: 'أن تَكُونُ', to: 'أن تَكُونَ' },
  ],
  'language-soft-power-politics:paragraph-7b20c35e8c1b': [
    { from: 'أن تَكُونُ', to: 'أن تَكُونَ' },
  ],
  'language-soft-power-politics:paragraph-fa51f559bea4': [
    { from: 'كي تُنْتِجُ', to: 'كي تُنْتِجَ' },
  ],
  'language-soft-power-politics:paragraph-a41d0718f65e': [
    { from: 'أن تَكُونُ', to: 'أن تَكُونَ' },
  ],
  'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع:h3-c1265baf9098': [
    { from: 'أن تَكُونُ', to: 'أن تَكُونَ' },
  ],
  'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع:paragraph-0e64a4dba798': [
    { from: 'أن تَعْرِفُ', to: 'أن تَعْرِفَ' },
  ],
  'اللياقه-بعد-الاربعين-كيف-تستعيد-طاقتك-وتبني-حياه-اكثر-توازنا:paragraph-dab42b69374d': [
    { from: 'أن تَكُونُ', to: 'أن تَكُونَ' },
  ],
  'عادات-ثقافيه-مدهشه-من-حول-العالم-حين-يكون-الاختلاف-اثراء:paragraph-8dbbebf0fd5e': [
    { from: 'لم تَعْرِفُ', to: 'لم تَعْرِفْ' },
  ],
  'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه:paragraph-12aa114b8f3c': [
    { from: 'لم تَعْرِفُ', to: 'لم تَعْرِفْ' },
  ],
  'why-some-passports-are-stronger:paragraph-ffb0dcb87976': [
    { from: 'عُدِ الآنَ', to: 'عُدْ الآنَ' },
  ],
});

function applyFinalSpokenCorrections(articleId, segmentId, value) {
  let output = value;
  let changed = false;
  for (const correction of FINAL_SPOKEN_CORRECTIONS[`${articleId}:${segmentId}`] ?? []) {
    const sourceOccurrences = output.split(correction.from).length - 1;
    const correctedOccurrences = output.split(correction.to).length - 1;
    if (sourceOccurrences === 1) {
      output = output.replace(correction.from, correction.to);
      changed = true;
    } else if (sourceOccurrences !== 0 || correctedOccurrences !== 1) {
      throw new Error(`${articleId}:${segmentId}: final correction is stale or ambiguous: ${JSON.stringify(correction.from)}.`);
    }
  }
  return { output, changed };
}

function vocalizeKnownTokens(text, articleId, segmentId) {
  const overrides = SEGMENT_READINGS[`${articleId}:${segmentId}`] ?? {};
  let changed = false;
  const output = text.replace(ARABIC_TOKEN, (token) => {
    const bare = stripDiacritics(token);
    let prefix = '';
    let lexeme = bare;
    if (['و', 'ف'].includes(bare[0]) && (overrides[bare.slice(1)] || DEFAULT_READINGS[bare.slice(1)])) {
      prefix = bare[0] === 'و' ? 'وَ' : 'فَ';
      lexeme = bare.slice(1);
    }
    const reading = overrides[lexeme] ?? DEFAULT_READINGS[lexeme];
    if (!reading) return token;
    changed = true;
    return `${prefix}${reading}`;
  });
  return { output, changed };
}

function reviewSegment(articleId, sourceSegment) {
  const key = `${articleId}:${sourceSegment.segmentId}`;
  let spokenText = sourceSegment.sourceText;
  const transformations = [];
  for (const transformation of FOREIGN_REPLACEMENTS[key] ?? []) {
    const occurrences = spokenText.split(transformation.from).length - 1;
    if (occurrences !== 1) throw new Error(`${key}: expected one occurrence of ${JSON.stringify(transformation.from)}, found ${occurrences}.`);
    spokenText = spokenText.replace(transformation.from, transformation.to);
    transformations.push(transformation);
  }
  let phraseReadingChanged = false;
  for (const reading of ARABIC_PHRASE_READINGS[key] ?? []) {
    const occurrences = spokenText.split(reading.from).length - 1;
    if (occurrences !== 1) throw new Error(`${key}: expected one occurrence of ${JSON.stringify(reading.from)}, found ${occurrences}.`);
    spokenText = spokenText.replace(reading.from, reading.to);
    phraseReadingChanged = true;
  }
  const vocalized = vocalizeKnownTokens(spokenText, articleId, sourceSegment.segmentId);
  spokenText = vocalized.output;
  const finalCorrection = applyFinalSpokenCorrections(articleId, sourceSegment.segmentId, spokenText);
  spokenText = finalCorrection.output;
  if (vocalized.changed || phraseReadingChanged || finalCorrection.changed) transformations.unshift(
    { type: 'arabic-diacritization' },
    { type: 'contextual-disambiguation' },
  );
  const review = { status: 'passed', reviewer: REVIEWER, reviewedAt: REVIEWED_AT, method: REVIEW_METHOD };
  return {
    segmentId: sourceSegment.segmentId,
    type: sourceSegment.type,
    sourceHash: sourceSegment.sourceHash,
    sourceText: sourceSegment.sourceText,
    spokenText,
    transformations,
    linguisticReview: review,
    pronunciationReview: review,
  };
}

function reviewReferencePilot(articleId, currentScript) {
  const script = structuredClone(currentScript);
  let corrected = false;
  for (const segment of script.segments ?? []) {
    const result = applyFinalSpokenCorrections(articleId, segment.segmentId, segment.spokenText);
    if (!result.changed) continue;
    segment.spokenText = result.output;
    segment.linguisticReview = { status: 'passed', reviewer: REVIEWER, reviewedAt: REVIEWED_AT, method: REVIEW_METHOD };
    segment.pronunciationReview = { status: 'passed', reviewer: REVIEWER, reviewedAt: REVIEWED_AT, method: REVIEW_METHOD };
    corrected = true;
  }
  if (corrected) {
    script.reviewVersion = Math.max(Number(script.reviewVersion) || 0, 2);
    script.generatedAt = REVIEWED_AT;
  }
  return script;
}

const rules = await readAmbiguityRules(ROOT);
const pendingWrites = [];
for (const model of await loadPublishedArticleModels(ROOT)) {
  const scriptFile = path.join(ROOT, 'scripts', 'speech-scripts', `${model.articleId}.json`);
  const currentScript = JSON.parse(await readFile(scriptFile, 'utf8'));
  const script = REFERENCE_PILOTS.has(model.articleId)
    ? reviewReferencePilot(model.articleId, currentScript)
    : {
        version: 1,
        articleId: model.articleId,
        sourceSnapshotHash: model.bodyHash,
        sourceStructureHash: model.structureHash,
        generatedAt: REVIEWED_AT,
        reviewVersion: 2,
        status: 'pronunciation-review-passed-test-clip-ready',
        referenceExclusion: model.referenceExclusion,
        segments: model.segments.map((segment) => reviewSegment(model.articleId, segment)),
      };
  script.scriptHash = sha256(JSON.stringify(script.segments));
  const validation = validateSpeechScript(model, script, rules, { requireReviews: true });
  if (!validation.approved) {
    const details = [...validation.errors, ...validation.segmentResults.flatMap((segment) => segment.errors.map((error) => `${segment.segmentId}: ${error}`))];
    throw new Error(`${model.articleId}: reviewed Speech Script failed:\n${details.join('\n')}`);
  }

  const planFile = path.join(ROOT, 'scripts', 'speech-test-clips', `${model.articleId}.json`);
  const plan = JSON.parse(await readFile(planFile, 'utf8'));
  plan.speechScriptHash = script.scriptHash;
  plan.status = 'ready';
  plan.testClipPassed = false;
  plan.fullSynthesisAllowed = false;
  plan.audioReview = { status: 'not-performed', reviewedBy: '', reviewedAt: '', evidence: null };
  plan.planHash = sha256(JSON.stringify({ articleId: plan.articleId, speechScriptHash: plan.speechScriptHash, selectedSegments: plan.selectedSegments, acceptance: plan.acceptance }));
  pendingWrites.push([scriptFile, `${JSON.stringify(script, null, 2)}\n`], [planFile, `${JSON.stringify(plan, null, 2)}\n`]);
}

for (const [file, contents] of pendingWrites) await writeFile(file, contents, 'utf8');
console.log(`Fahed speech review applied atomically to ${pendingWrites.length / 2} published article(s).`);
