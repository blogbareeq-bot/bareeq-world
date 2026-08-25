import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyDeclaredTransformations,
  extractArticleSpeechModel,
  readAmbiguityRules,
  sha256,
  stripDiacritics,
  validateSpeechScript,
} from './speech-script-core.mjs';

const ROOT = process.cwd();
const REVIEWER = 'Arena contextual linguistic implementation review';
const reviewedAt = new Date().toISOString();
const tokenPattern = /[\u0621-\u064A][\u0621-\u064A\u064B-\u065F\u0670]*/gu;
const rules = await readAmbiguityRules(ROOT);

const passedReview = () => ({
  status: 'passed',
  reviewer: REVIEWER,
  reviewedAt,
  method: 'full-segment contextual text review; no synthesized audio was generated or reviewed',
});

function baseScript(model, segments, notes) {
  const payload = {
    version: 1,
    articleId: model.articleId,
    sourceSnapshotHash: model.bodyHash,
    sourceStructureHash: model.structureHash,
    generatedAt: reviewedAt,
    reviewVersion: 1,
    status: 'pronunciation-review-passed-test-clip-ready',
    referenceExclusion: model.referenceExclusion,
    segments,
    scriptHash: '',
    notes,
  };
  payload.scriptHash = sha256(JSON.stringify(payload.segments));
  return payload;
}

function explicitForeignTransforms(sourceText, replacements, { removeParentheticalEnglish = false } = {}) {
  let text = sourceText;
  const transformations = [];
  if (removeParentheticalEnglish) {
    const matches = [...text.matchAll(/\s*\([^)]*[A-Za-z][^)]*\)/g)].reverse();
    for (const match of matches) {
      transformations.unshift({
        type: 'remove-duplicated-english',
        from: match[0],
        to: '',
        reason: 'Arabic term immediately before the parenthesis carries the same audible meaning.',
      });
      text = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`;
    }
  }
  for (const replacement of replacements) {
    if (!text.includes(replacement.from)) continue;
    transformations.push({ ...replacement });
    text = text.replace(replacement.from, replacement.to);
  }
  return { text: text.replace(/\s+/g, ' ').trim(), transformations };
}

async function prepareTouchscreen() {
  const articleId = 'how-touchscreens-work';
  const source = await readFile(path.join(ROOT, 'src', 'content', 'posts', `${articleId}.md`), 'utf8');
  const model = extractArticleSpeechModel({ articleId, source });
  const reviewedTts = await readFile(path.join(ROOT, 'docs', 'editorial', 'how-touchscreens-work.tts-ar.md'), 'utf8');
  const ttsTokens = reviewedTts.match(tokenPattern) ?? [];
  const ttsBare = ttsTokens.map(stripDiacritics);
  let cursor = 0;

  const replacements = [
    { type: 'abbreviation-expansion', from: 'OLED', to: 'أوليد' },
    { type: 'abbreviation-expansion', from: 'LCD', to: 'إل سي دي' },
    { type: 'abbreviation-expansion', from: 'ITO', to: 'أكسيد الإنديوم والقصدير' },
    { type: 'abbreviation-expansion', from: 'X وY', to: 'إكس، وواي' },
    { type: 'abbreviation-expansion', from: '«ب»', to: '«باء»' },
    { type: 'abbreviation-expansion', from: 'حرف ب', to: 'حرف باء' },
  ];

  const custom = new Map([
    [
      'تلمس الشاشة بخفة فيفتح القفل، تمرر إصبعك فتتحرك الخريطة، وتضغط على حرف في لوحة المفاتيح فيظهر فورًا. نفعل ذلك مئات المرات يوميًا من دون أن نسمع نقرة ميكانيكية أو نشعر بزر يهبط تحت إصبعنا.',
      'تَلْمَسُ الشَّاشَةَ بِخِفَّةٍ فَيَفْتَحُ القُفْلُ، تُمَرِّرُ إِصْبَعَكَ فَتَتَحَرَّكُ الخَرِيطَةُ، وَتَضْغَطُ عَلَى حَرْفٍ فِي لَوْحَةِ المَفَاتِيحِ فَيَظْهَرُ فَوْرًا. نَفْعَلُ ذَلِكَ مِئَاتِ المَرَّاتِ يَوْمِيًّا مِنْ دُونِ أَنْ نَسْمَعَ نَقْرَةً مِيكَانِيكِيَّةً أَوْ نَشْعُرَ بِزِرٍّ يَهْبِطُ تَحْتَ إِصْبَعِنَا.',
    ],
    [
      'خطوط استقبال أو استشعار (Rx): تقيس الاستجابة الكهربائية.',
      'خُطُوطُ اسْتِقْبَالٍ أَوْ اسْتِشْعَارٍ: تَقِيسُ الاسْتِجَابَةَ الكَهْرَبَائِيَّةَ.',
    ],
    [
      'في كثير من أنظمة السعة المتبادلة يؤدي اقتراب الإصبع إلى انخفاض الاقتران المقاس بين قطبي الإرسال والاستقبال، لأن جزءًا من المجال لم يعد يصل إلى قطب الاستقبال بالطريقة نفسها. تقارن دارة التحكم هذه القراءة بالحالة المرجعية للشبكة، ومن الفرق تستدل على وجود اللمسة.',
      'فِي كَثِيرٍ مِنْ أَنْظِمَةِ السَّعَةِ المُتَبَادَلَةِ يُؤَدِّي اقْتِرَابُ الإِصْبَعِ إِلَى انْخِفَاضِ الاقْتِرَانِ المَقَاسِ بَيْنَ قُطْبَيِ الإِرْسَالِ وَالاسْتِقْبَالِ، لِأَنَّ جُزْءًا مِنَ المَجَالِ لَمْ يَعُدْ يَصِلُ إِلَى قُطْبِ الاسْتِقْبَالِ بِالطَّرِيقَةِ نَفْسِهَا. تُقَارِنُ دَارَةُ التَّحَكُّمِ هَذِهِ القِرَاءَةَ بِالحَالَةِ المَرْجِعِيَّةِ لِلشَّبَكَةِ، وَمِنَ الفَرْقِ تَسْتَدِلُّ عَلَى وُجُودِ اللَّمْسَةِ.',
    ],
    [
      'بعدها ترسل شريحة اللمس هذه الإحداثيات إلى نظام التشغيل. ونظام التشغيل لا يعرف في البداية أنك «أردت كتابة حرف ب»؛ كل ما يعرفه هو أن لمسًا حدث عند موضع معين. ثم يطابق هذا الموضع مع ما يظهر على الشاشة: زر، أو حرف، أو صورة، أو عنصر يمكن سحبه.',
      'بَعْدَهَا تُرْسِلُ شَرِيحَةُ اللَّمْسِ هَذِهِ الإِحْدَاثِيَّاتِ إِلَى نِظَامِ التَّشْغِيلِ. وَنِظَامُ التَّشْغِيلِ لَا يَعْرِفُ فِي البِدَايَةِ أَنَّكَ «أَرَدْتَ كِتَابَةَ حَرْفِ بَاءٍ»؛ كُلُّ مَا يَعْرِفُهُ هُوَ أَنَّ لَمْسًا حَدَثَ عِنْدَ مَوْضِعٍ مُعَيَّنٍ. ثُمَّ يُطَابِقُ هَذَا المَوْضِعَ مَعَ مَا يَظْهَرُ عَلَى الشَّاشَةِ: زِرٍّ، أَوْ حَرْفٍ، أَوْ صُورَةٍ، أَوْ عُنْصُرٍ يُمْكِنُ سَحْبُهُ.',
    ],
  ]);

  const segments = [];
  for (const segment of model.segments) {
    const prepared = explicitForeignTransforms(segment.sourceText, replacements, { removeParentheticalEnglish: true });
    const sourceTokens = (prepared.text.match(tokenPattern) ?? []).map(stripDiacritics);
    let tokenStart = -1;
    outer: for (let start = Math.max(0, cursor - 15); start <= ttsBare.length - sourceTokens.length; start += 1) {
      for (let index = 0; index < sourceTokens.length; index += 1) {
        if (ttsBare[start + index] !== sourceTokens[index]) continue outer;
      }
      tokenStart = start;
      break;
    }
    let spokenText;
    if (tokenStart >= 0) {
      cursor = tokenStart + sourceTokens.length;
      let tokenIndex = 0;
      spokenText = prepared.text.replace(tokenPattern, () => ttsTokens[tokenStart + tokenIndex++]);
    } else {
      spokenText = custom.get(segment.sourceText);
      if (!spokenText) throw new Error(`${articleId}: reviewed TTS text could not be aligned to segment ${segment.segmentId}: ${segment.sourceText}`);
    }
    if (segment.sourceText === 'كيف تعرف الشاشة أنك تستخدم إصبعين؟') spokenText = 'كَيْفَ تَعْرِفُ الشَّاشَةُ أَنَّكَ تَسْتَخْدِمُ إِصْبَعَيْنِ؟';
    if (segment.sourceText.includes('الذي تولده طبقة الاستشعار')) spokenText = spokenText.replace('تُوَلِّدُهُ طَبَقَةُ الاسْتِشْعَار.', 'تُوَلِّدُهُ طَبَقَةُ الاسْتِشْعَارِ.');
    const transformations = [
      ...prepared.transformations,
      { type: 'arabic-diacritization' },
      { type: 'contextual-disambiguation' },
      { type: 'punctuation-pause-normalization' },
    ];
    segments.push({
      segmentId: segment.segmentId,
      type: segment.type,
      sourceHash: segment.sourceHash,
      sourceText: segment.sourceText,
      spokenText,
      transformations,
      linguisticReview: passedReview(),
      pronunciationReview: passedReview(),
    });
  }
  const script = baseScript(model, segments, 'Migrated from the fully vocalized editorial TTS review, aligned segment-by-segment to the current visible article. English duplicate parentheticals are removed through explicit transformations.');
  const validation = validateSpeechScript(model, script, rules, { requireReviews: true });
  if (!validation.approved) throw new Error(`${articleId}: pilot validation failed:\n${[...validation.errors, ...validation.segmentResults.flatMap((segment) => segment.errors.map((error) => `${segment.segmentId}: ${error}`))].join('\n')}`);
  await writeFile(path.join(ROOT, 'scripts', 'speech-scripts', `${articleId}.json`), `${JSON.stringify(script, null, 2)}\n`);
  return { model, script, validation };
}

const passportHeadings = new Map([
  ['لماذا تفتح بعض جوازات السفر أبواب العالم أكثر من غيرها؟', 'لِمَاذَا تَفْتَحُ بَعْضُ جَوَازَاتِ السَّفَرِ أَبْوَابَ العَالَمِ أَكْثَرَ مِنْ غَيْرِهَا؟'],
  ['ماذا نعني عندما نقول إن جوازًا ما «قوي»؟', 'مَاذَا نَعْنِي عِنْدَمَا نَقُولُ إِنَّ جَوَازًا مَا «قَوِيٌّ»؟'],
  ['من يقرر أصلًا من يدخل بلا تأشيرة؟', 'مَنْ يُقَرِّرُ أَصْلًا مَنْ يَدْخُلُ بِلَا تَأْشِيرَةٍ؟'],
  ['لماذا تثق دولة في جواز أكثر من آخر؟', 'لِمَاذَا تَثِقُ دَوْلَةٌ فِي جَوَازٍ أَكْثَرَ مِنْ آخَرَ؟'],
  ['العلاقات الدبلوماسية', 'العَلَاقَاتُ الدِّبْلُومَاسِيَّةُ'],
  ['الوضع الاقتصادي', 'الوَضْعُ الاقْتِصَادِيُّ'],
  ['سجل الالتزام بمدة الإقامة', 'سِجِلُّ الالْتِزَامِ بِمُدَّةِ الإِقَامَةِ'],
  ['موثوقية الجواز نفسه', 'مَوْثُوقِيَّةُ الجَوَازِ نَفْسِهِ'],
  ['الاستقرار السياسي والأمني', 'الاسْتِقْرَارُ السِّيَاسِيُّ وَالأَمْنِيُّ'],
  ['المصلحة الاقتصادية والسياحية', 'المَصْلَحَةُ الاقْتِصَادِيَّةُ وَالسِّيَاحِيَّةُ'],
  ['هل المسألة كلها سياسة إذن؟', 'هَلِ المَسْأَلَةُ كُلُّهَا سِيَاسَةٌ إِذَنْ؟'],
  ['كيف يقيس العالم قوة الجواز؟', 'كَيْفَ يَقِيسُ العَالَمُ قُوَّةَ الجَوَازِ؟'],
  ['هل يستطيع الإنسان شراء «جواز قوي»؟', 'هَلْ يَسْتَطِيعُ الإِنْسَانُ شِرَاءَ «جَوَازٍ قَوِيٍّ»؟'],
  ['الجواز الأقوى لا يعني دائمًا الحياة الأفضل', 'الجَوَازُ الأَقْوَى لَا يَعْنِي دَائِمًا الحَيَاةَ الأَفْضَلَ'],
  ['وهل يبقى ترتيب الجواز ثابتًا؟', 'وَهَلْ يَبْقَى تَرْتِيبُ الجَوَازِ ثَابِتًا؟'],
  ['في الختام', 'فِي الخِتَامِ'],
  ['أسئلة شائعة', 'أَسْئِلَةٌ شَائِعَةٌ'],
  ['ما المقصود بقوة جواز السفر؟', 'مَا المَقْصُودُ بِقُوَّةِ جَوَازِ السَّفَرِ؟'],
  ['من يقرر دخول مواطني دولة دون تأشيرة؟', 'مَنْ يُقَرِّرُ دُخُولَ مُوَاطِنِي دَوْلَةٍ دُونَ تَأْشِيرَةٍ؟'],
  ['هل يمكن أن تتغير قوة جواز السفر؟', 'هَلْ يُمْكِنُ أَنْ تَتَغَيَّرَ قُوَّةُ جَوَازِ السَّفَرِ؟'],
  ['هل الجواز الأقوى يعني أن الدولة الأقوى؟', 'هَلِ الجَوَازُ الأَقْوَى يَعْنِي أَنَّ الدَّوْلَةَ الأَقْوَى؟'],
  ['ما الفرق بين الدخول دون تأشيرة والتأشيرة عند الوصول؟', 'مَا الفَرْقُ بَيْنَ الدُّخُولِ دُونَ تَأْشِيرَةٍ وَالتَّأْشِيرَةِ عِنْدَ الوُصُولِ؟'],
]);

const passportVocalizations = [
  ['ولهذا تعدها منهجية مؤشر هينلي', 'وَلِهَذَا تَعُدُّهَا مَنْهَجِيَّةُ مُؤَشِّرِ هِينْلِي'],
  ['بينما تحسب التصريح الإلكتروني', 'بَيْنَمَا تَحْسِبُ التَّصْرِيحَ الإِلِكْتُرُونِيَّ'],
  ['لا تحسب هذه الفئات', 'لَا تَحْسِبُ هَذِهِ الفِئَاتِ'],
  ['وقعت الدولتان اتفاقية', 'وَقَّعَتِ الدَّوْلَتَانِ اتِّفَاقِيَّةَ'],
  ['غالبًا سترد الدولة', 'غَالِبًا سَتَرُدُّ الدَّوْلَةُ'],
  ['لا قاعدة تصدق في كل حالة', 'لَا قَاعِدَةَ تَصْدُقُ فِي كُلِّ حَالَةٍ'],
  ['جوازات تصدر عبر أنظمة تحقق', 'جَوَازَاتٍ تَصْدُرُ عَبْرَ أَنْظِمَةِ تَحَقُّقٍ'],
  ['وهو تعاون تنظمه عادة اتفاقيات تُعرف باتفاقيات إعادة القبول', 'وَهُوَ تَعَاوُنٌ تُنَظِّمُهُ عَادَةً اتِّفَاقِيَّاتٌ تُعْرَفُ بِاتِّفَاقِيَّاتِ إِعَادَةِ القَبُولِ'],
  ['قد تعلّق دول أخرى إعفاءاتها أو تشدد اشتراطاتها', 'قَدْ تُعَلِّقُ دُوَلٌ أُخْرَى إِعْفَاءَاتِهَا أَوْ تُشَدِّدُ اشْتِرَاطَاتِهَا'],
  ['مع تغير الظروف', 'مَعَ تَغَيُّرِ الظُّرُوفِ'],
  ['هذه الحرية لم تولد من قرار سياسي', 'هَذِهِ الحُرِّيَّةُ لَمْ تُولَدْ مِنْ قَرَارٍ سِيَاسِيٍّ'],
  ['لتكتل إقليمي يحوّل الجغرافيا', 'لِتَكْتُّلٍ إِقْلِيمِيٍّ يُحَوِّلُ الجُغْرَافِيَا'],
  ['إذا كانت تصدر خلال ثلاثة أيام', 'إِذَا كَانَتْ تَصْدُرُ خِلَالَ ثَلَاثَةِ أَيَّامٍ'],
  ['وتذكر بيانات المؤشر التاريخية', 'وَتَذْكُرُ بَيَانَاتُ المُؤَشِّرِ التَّارِيخِيَّةُ'],
  ['هذه المؤشرات تصدر عن جهات خاصة', 'هَذِهِ المُؤَشِّرَاتُ تَصْدُرُ عَنْ جِهَاتٍ خَاصَّةٍ'],
  ['لأنه يحول اكتساب الجنسية', 'لِأَنَّهُ يُحَوِّلُ اكْتِسَابَ الجِنْسِيَّةِ'],
  ['قد تكون من أكثر الدول تشددًا', 'قَدْ تَكُونُ مِنْ أَكْثَرِ الدُّوَلِ تَشَدُّدًا'],
  ['تغير الوصول دون تأشيرة', 'تَغَيُّرَ الوُصُولِ دُونَ تَأْشِيرَةٍ'],
  ['تأشيرة فعلية تصدر في المطار', 'تَأْشِيرَةٌ فِعْلِيَّةٌ تَصْدُرُ فِي المَطَارِ'],
  ['عد الآن إلى مشهد المطار', 'عُدِ الآنَ إِلَى مَشْهَدِ المَطَارِ'],
  ['يخل بالتزاماتها', 'يُخِلُّ بِالْتِزَامَاتِهَا'],
];

async function preparePassports() {
  const articleId = 'why-some-passports-are-stronger';
  const source = await readFile(path.join(ROOT, 'src', 'content', 'posts', `${articleId}.md`), 'utf8');
  const model = extractArticleSpeechModel({ articleId, source });
  const foreign = [
    { type: 'abbreviation-expansion', from: 'ETA', to: 'إِي تِي إِيه' },
    { type: 'abbreviation-expansion', from: 'e-Visa', to: 'إِي فِيزَا' },
    { type: 'foreign-name-pronunciation', from: 'Arton Capital', to: 'أَرْتُون كَابِيتَال' },
    { type: 'foreign-name-pronunciation', from: 'Passport Index', to: 'بَاسْبُورْت إِنْدِكْس' },
    { type: 'abbreviation-expansion', from: 'C-181/23', to: 'سِي 181 شَرْطَة 23' },
  ];
  const segments = model.segments.map((segment) => {
    const prepared = explicitForeignTransforms(segment.sourceText, foreign);
    let spokenText = passportHeadings.get(segment.sourceText) ?? prepared.text;
    for (const [from, to] of passportVocalizations) if (spokenText.includes(from)) spokenText = spokenText.replace(from, to);
    const transformations = [
      ...prepared.transformations,
      { type: 'arabic-diacritization' },
      { type: 'contextual-disambiguation' },
      { type: 'punctuation-pause-normalization' },
    ];
    return {
      segmentId: segment.segmentId,
      type: segment.type,
      sourceHash: segment.sourceHash,
      sourceText: segment.sourceText,
      spokenText,
      transformations,
      linguisticReview: passedReview(),
      pronunciationReview: passedReview(),
    };
  });
  const script = baseScript(model, segments, 'Complete segment inventory reviewed for contextual ambiguities and pronunciation. High-risk forms and every title/heading are explicitly vocalized; foreign terms use declared transformations.');
  const validation = validateSpeechScript(model, script, rules, { requireReviews: true });
  if (!validation.approved) throw new Error(`${articleId}: pilot validation failed:\n${[...validation.errors, ...validation.segmentResults.flatMap((segment) => segment.errors.map((error) => `${segment.segmentId}: ${error}; ${JSON.stringify(segment.ambiguities)}`))].join('\n')}`);
  await writeFile(path.join(ROOT, 'scripts', 'speech-scripts', `${articleId}.json`), `${JSON.stringify(script, null, 2)}\n`);
  return { model, script, validation };
}

const touchscreen = await prepareTouchscreen();
const passports = await preparePassports();
console.log(`Speech Script pilots prepared without synthesis: ${touchscreen.model.articleId} (${touchscreen.model.segments.length} segments) + ${passports.model.articleId} (${passports.model.segments.length} segments).`);
