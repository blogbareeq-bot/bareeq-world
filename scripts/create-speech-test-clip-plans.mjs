import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  detectContextualAmbiguities,
  findForeignTerms,
  loadPublishedArticleModels,
  readAmbiguityRules,
  readSpeechScript,
  sha256,
} from './speech-script-core.mjs';

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, 'scripts', 'speech-test-clips');
const rules = await readAmbiguityRules(ROOT);
const models = await loadPublishedArticleModels(ROOT);
await mkdir(OUTPUT, { recursive: true });

const pilotChallenges = {
  'how-touchscreens-work': [
    { contains: 'كيف تعرف شاشة هاتفك', challenges: ['تَعْرِفُ', 'المخاطب', 'عنوان المقال'] },
    { contains: 'كانت هذه التقنية تعرف باسم', challenges: ['تُعْرَفُ', 'المبني للمجهول'] },
    { contains: 'تكوّن مجالات كهربائية', challenges: ['تُكَوِّنُ', 'الفعل المتعدي'] },
    { contains: 'التي تنتج الصورة', challenges: ['تُنْتِجُ', 'يَنْتُجُ', 'اختصارات OLED/LCD'] },
    { contains: 'فينشأ نمطان منفصلان', challenges: ['يَنْشَأُ', 'المثنى'] },
    { contains: 'كيف تعرف الشاشة أنك تستخدم إصبعين', challenges: ['تَعْرِفُ', 'إِصْبَعَيْنِ', 'عنوان فرعي'] },
  ],
  'why-some-passports-are-stronger': [
    { contains: 'ولهذا تعدها منهجية مؤشر هينلي', challenges: ['تَعُدُّهَا', 'تَحْسِبُ', 'e-Visa'] },
    { contains: 'غالبًا سترد الدولة', challenges: ['سَتَرُدُّ', 'المعاملة بالمثل'] },
    { contains: 'هذه الحرية لم تولد', challenges: ['تُولَدْ', 'المبني للمجهول'] },
    { contains: 'وتذكر بيانات المؤشر التاريخية', challenges: ['تَذْكُرُ', 'الفاعل المؤخر'] },
    { contains: 'لأنه يحول اكتساب الجنسية', challenges: ['يُحَوِّلُ', 'C-181/23'] },
  ],
};

for (const model of models) {
  const script = await readSpeechScript(model.articleId, ROOT);
  const byId = new Map((script?.segments ?? []).map((segment) => [segment.segmentId, segment]));
  const selected = [];
  if (pilotChallenges[model.articleId]) {
    for (const challenge of pilotChallenges[model.articleId]) {
      const segment = model.segments.find((item) => item.sourceText.includes(challenge.contains));
      if (!segment) throw new Error(`${model.articleId}: test clip challenge segment not found: ${challenge.contains}`);
      selected.push({ segmentId: segment.segmentId, challenges: challenge.challenges });
    }
  } else {
    const scored = model.segments.map((segment) => {
      const spoken = byId.get(segment.segmentId)?.spokenText ?? segment.sourceText;
      const ambiguityCount = detectContextualAmbiguities(segment.sourceText, spoken, rules).reduce((sum, item) => sum + item.occurrences, 0);
      const foreignCount = findForeignTerms(segment.sourceText).length;
      const heading = segment.type === 'title' || /^h\d$/.test(segment.type) ? 1 : 0;
      return { segmentId: segment.segmentId, ambiguityCount, foreignCount, score: ambiguityCount * 10 + foreignCount * 6 + heading * 2 + Math.min(3, segment.sourceText.length / 200) };
    }).sort((left, right) => right.score - left.score || left.segmentId.localeCompare(right.segmentId));
    for (const item of scored.slice(0, 5)) {
      selected.push({
        segmentId: item.segmentId,
        challenges: [
          ...(item.ambiguityCount ? [`${item.ambiguityCount} contextual ambiguity occurrence(s)`] : []),
          ...(item.foreignCount ? [`${item.foreignCount} foreign term(s)`] : []),
          ...(!item.ambiguityCount && !item.foreignCount ? ['title/structure/natural pause control'] : []),
        ],
      });
    }
  }
  const selectedChars = selected.reduce((sum, item) => sum + (byId.get(item.segmentId)?.spokenText?.length ?? model.segments.find((segment) => segment.segmentId === item.segmentId)?.sourceText.length ?? 0), 0);
  const pilot = Boolean(pilotChallenges[model.articleId]);
  const plan = {
    version: 1,
    articleId: model.articleId,
    speechScriptHash: script?.scriptHash ?? null,
    status: pilot ? 'ready' : 'draft-needs-speech-review',
    testClipPassed: false,
    fullSynthesisAllowed: false,
    expectedDurationSeconds: Math.max(30, Math.min(60, Math.round(selectedChars / 13))),
    selectedSegments: selected,
    acceptance: [
      'Every written Arabic diacritic is respected.',
      'No approved word is reinterpreted to another contextual reading.',
      'No word is added or omitted.',
      'Foreign terms and abbreviations follow the approved pronunciation policy.',
      'Performance remains natural Modern Standard Arabic and does not pronounce pause endings mechanically.',
    ],
    audioReview: { status: 'not-performed', reviewedBy: '', reviewedAt: '', evidence: null },
    planHash: '',
  };
  plan.planHash = sha256(JSON.stringify({ articleId: plan.articleId, speechScriptHash: plan.speechScriptHash, selectedSegments: plan.selectedSegments, acceptance: plan.acceptance }));
  await writeFile(path.join(OUTPUT, `${model.articleId}.json`), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`+ ${model.articleId}: test clip plan ${plan.status}, ${selected.length} segment(s), expected ${plan.expectedDurationSeconds}s; no audio generated.`);
}
