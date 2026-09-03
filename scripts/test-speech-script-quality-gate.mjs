import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractArticleSpeechModel,
  isReferenceHeading,
  loadPublishedArticleModels,
  normalizeArabicForComparison,
  readAmbiguityRules,
  readSpeechScript,
  sha256,
  validateSpeechScript,
} from './speech-script-core.mjs';
import { buildGeminiPrompt } from './speech-prompt.mjs';
import { evaluateSynthesisReadiness } from './speech-synthesis-gate.mjs';

const ROOT = process.cwd();
const rules = await readAmbiguityRules(ROOT);
const review = { status: 'passed', reviewer: 'quality-gate-test', reviewedAt: '2026-08-25T00:00:00.000Z' };

function approvedScript(model, spokenById = new Map()) {
  const segments = model.segments.map((segment) => ({
    segmentId: segment.segmentId,
    type: segment.type,
    sourceHash: segment.sourceHash,
    sourceText: segment.sourceText,
    spokenText: spokenById.get(segment.segmentId) ?? segment.sourceText,
    transformations: spokenById.has(segment.segmentId) ? [{ type: 'arabic-diacritization' }, { type: 'contextual-disambiguation' }] : [],
    linguisticReview: review,
    pronunciationReview: review,
  }));
  return {
    version: 1,
    articleId: model.articleId,
    sourceSnapshotHash: model.bodyHash,
    sourceStructureHash: model.structureHash,
    referenceExclusion: model.referenceExclusion,
    segments,
    scriptHash: sha256(JSON.stringify(segments)),
  };
}

// Reference headings: every real Bareeq variant must be recognized, while a real
// content heading that merely contains the word "مصادر" must remain spoken.
for (const heading of ['المصادر', 'المراجع', 'المصادر والمراجع', 'المصادر والتحقق', 'المصادر والقراءة الإضافية', 'مصادر للتوسع', 'References']) {
  assert.equal(isReferenceHeading(heading), true, `reference heading was not recognized: ${heading}`);
  const source = `---\ntitle: "اختبار"\ndraft: false\n---\n## مقدمة\nمحتوى حقيقي قبل المراجع.\n\n## ${heading}\n- [مرجع](https://example.com)`;
  const model = extractArticleSpeechModel({ articleId: 'reference-test', source });
  assert(model.segments.some((segment) => segment.sourceText.includes('محتوى حقيقي')), 'real content was removed with references');
  assert(!model.segments.some((segment) => /مرجع|example/.test(segment.sourceText)), 'reference content leaked into spoken segments');
  assert(model.referenceExclusion.segmentCount >= 2, 'excluded reference segments were not counted');
}
assert.equal(isReferenceHeading('مصادر الطاقة المتجددة'), false, 'real article heading was mistaken for a reference appendix');
{
  const source = '---\ntitle: "مصادر الطاقة"\ndraft: false\n---\n## مصادر الطاقة المتجددة\nهذا محتوى المقال الحقيقي.';
  const model = extractArticleSpeechModel({ articleId: 'content-heading-test', source });
  assert(model.segments.some((segment) => segment.type === 'h2' && segment.sourceText === 'مصادر الطاقة المتجددة'));
  assert(model.segments.some((segment) => segment.sourceText === 'هذا محتوى المقال الحقيقي.'));
}

// Titles, headings, lists, quotes and paragraphs all enter the segment inventory.
const fixtureSource = `---\ntitle: "كيف تعرف النتيجة؟"\ndraft: false\n---\n## عنوان فرعي\nالفقرة الأولى تعرف الجواب.\n\n- عنصر قائمة\n\n> اقتباس مهم\n\nالفقرة الثانية ثابتة.\n\n## المصادر والمراجع\n- مرجع`;
const fixture = extractArticleSpeechModel({ articleId: 'fixture', source: fixtureSource });
assert.deepEqual(fixture.segments.map((segment) => segment.type), ['title', 'h2', 'paragraph', 'list-item', 'quote', 'paragraph']);
assert.equal(fixture.referenceExclusion.segmentCount, 2);
const ambiguousSegment = fixture.segments.find((segment) => segment.sourceText.includes('تعرف الجواب'));
const fixtureTitle = fixture.segments.find((segment) => segment.type === 'title');
const script = approvedScript(fixture, new Map([
  [fixtureTitle.segmentId, 'كَيْفَ تَعْرِفُ النَّتِيجَةَ؟'],
  [ambiguousSegment.segmentId, 'الفِقْرَةُ الأُولَى تَعْرِفُ الجَوَابَ.'],
]));
assert.equal(validateSpeechScript(fixture, script, rules, { requireReviews: true }).approved, true);

// A one-paragraph edit invalidates only that segment; unchanged segment approvals survive.
const changedSource = fixtureSource.replace('الفقرة الثانية ثابتة.', 'الفقرة الثانية تغيّرت وحدها.');
const changedModel = extractArticleSpeechModel({ articleId: 'fixture', source: changedSource });
const changedValidation = validateSpeechScript(changedModel, script, rules, { requireReviews: true });
assert.equal(changedValidation.approved, false);
assert.equal(changedValidation.missingSegmentIds.length, 1);
assert.equal(changedValidation.staleSegmentIds.length, 1);
const unchangedIds = new Set(fixture.segments.filter((segment) => segment.sourceText !== 'الفقرة الثانية ثابتة.').map((segment) => segment.segmentId));
assert(changedValidation.segmentResults.filter((segment) => unchangedIds.has(segment.segmentId)).every((segment) => segment.linguisticPassed && segment.pronunciationPassed), 'unchanged segment approvals were lost');
assert.equal(changedValidation.structuralChange, true, 'structural extraction change was not detected');

// Unresolved ambiguity is a hard review failure.
const unresolved = approvedScript(fixture);
const unresolvedValidation = validateSpeechScript(fixture, unresolved, rules, { requireReviews: true });
assert.equal(unresolvedValidation.approved, false);
assert(unresolvedValidation.segmentResults.some((segment) => segment.errors.some((error) => error.startsWith('unresolved contextual ambiguity'))));

// Meaning changes and undeclared/unknown transformations fail.
const meaningChange = structuredClone(script);
meaningChange.segments[0].spokenText = 'عنوان مختلف تمامًا';
meaningChange.scriptHash = sha256(JSON.stringify(meaningChange.segments));
assert(validateSpeechScript(fixture, meaningChange, rules).segmentResults[0].errors.some((error) => error.includes('changes source meaning')));
const unknown = structuredClone(script);
unknown.segments[0].transformations = [{ type: 'free-rewrite' }];
unknown.scriptHash = sha256(JSON.stringify(unknown.segments));
assert(validateSpeechScript(fixture, unknown, rules).segmentResults[0].errors.some((error) => error.includes('Unknown speech transformation')));

// A duplicated English parenthetical may be removed only by an explicit transform.
const englishSource = '---\ntitle: "اختبار"\ndraft: false\n---\nالشاشات المقاومية (Resistive Touchscreens) مفيدة.';
const englishModel = extractArticleSpeechModel({ articleId: 'english', source: englishSource });
const englishRecord = approvedScript(englishModel);
const englishSegment = englishRecord.segments.find((segment) => segment.type === 'paragraph');
englishSegment.spokenText = 'الشاشات المقاومية مفيدة.';
englishRecord.scriptHash = sha256(JSON.stringify(englishRecord.segments));
assert(validateSpeechScript(englishModel, englishRecord, rules).segmentResults.find((segment) => segment.type === 'paragraph').errors.some((error) => error.includes('changes source meaning')));
englishSegment.transformations = [{ type: 'remove-duplicated-english', from: ' (Resistive Touchscreens)', to: '' }];
englishRecord.scriptHash = sha256(JSON.stringify(englishRecord.segments));
assert.equal(validateSpeechScript(englishModel, englishRecord, rules, { requireReviews: true }).approved, true);

// Arabic phonetic tokens may not begin with sukun.
const sukunRecord = approvedScript(englishModel);
const sukunSegment = sukunRecord.segments.find((segment) => segment.type === 'paragraph');
sukunSegment.spokenText = 'الشاشات المقاومية بْرُوجِكْتِد مفيدة.';
sukunSegment.transformations = [{ type: 'foreign-name-pronunciation', from: '(Resistive Touchscreens)', to: 'بْرُوجِكْتِد' }];
sukunRecord.scriptHash = sha256(JSON.stringify(sukunRecord.segments));
assert(validateSpeechScript(englishModel, sukunRecord, rules).segmentResults.find((segment) => segment.type === 'paragraph').errors.some((error) => error.includes('starts with sukun')));

// Hash mismatch is detected independently from review state.
const hashMismatch = structuredClone(script);
hashMismatch.segments[0].sourceHash = '0'.repeat(64);
hashMismatch.scriptHash = sha256(JSON.stringify(hashMismatch.segments));
assert(validateSpeechScript(fixture, hashMismatch, rules).segmentResults[0].errors.includes('sourceHash mismatch'));

// Gemini prompt contains only the approved part transcript in TRANSCRIPT and
// makes written diacritics authoritative without making a request.
const approvedTranscript = 'كَيْفَ تَعْرِفُ الشَّاشَةُ؟';
const prompt = buildGeminiPrompt({ text: approvedTranscript }, { articleTitle: 'اختبار', partIndex: 0, partCount: 1 });
assert(prompt.endsWith(`### TRANSCRIPT\n${approvedTranscript}`));
assert(prompt.includes('Every written Arabic diacritic is binding'));
assert(prompt.includes('Do not add, omit, paraphrase, or reorder any word'));

// Generation may proceed from a reviewed Speech Script. Listening evidence is a
// later publication gate and must not circularly block the first TTS request.
const fakePost = {
  speechApproval: {
    validation: { valid: true, approved: true },
    script: { scriptHash: 'abc' },
    testClipPlan: { speechScriptHash: 'abc', testClipPassed: true, fullSynthesisAllowed: true, audioReview: { status: 'not-performed' } },
    testClipEvidenceVerified: false,
  },
};
const fakeReadiness = evaluateSynthesisReadiness(fakePost);
assert.equal(fakeReadiness.generationAuthorized, true, 'reviewed text should authorize generation');
assert.equal(fakeReadiness.audioEvidencePassed, false, 'missing listening evidence must stay visible');
assert.equal(fakeReadiness.publishable, false, 'publication must remain blocked without later gates');

// Every current article source snapshot is represented without modifying source.
const currentModels = await loadPublishedArticleModels(ROOT);
for (const model of currentModels) {
  const currentScript = await readSpeechScript(model.articleId, ROOT);
  assert(currentScript, `${model.articleId}: current Speech Script is missing`);
  assert.equal(currentScript.sourceSnapshotHash, model.bodyHash, `${model.articleId}: source snapshot hash is stale`);
}

// Integration proof: an unapproved article with a valid-looking key and a local
// mock endpoint fails before any provider POST and produces no audio file.
let providerPosts = 0;
const server = createServer(async (request, response) => {
  if (request.method === 'POST') providerPosts += 1;
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end('{}');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'bareeq-speech-gate-'));
try {
  await mkdir(path.join(fixtureRoot, 'src', 'content', 'posts'), { recursive: true });
  await mkdir(path.join(fixtureRoot, 'public'), { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(path.join(ROOT, 'scripts'), path.join(fixtureRoot, 'scripts'), linkType);
  await writeFile(path.join(fixtureRoot, 'src', 'content', 'posts', 'gate-block-fixture.md'), `---\ntitle: \"مقال حاجز التوليد\"\ndraft: false\n---\nفقرة واحدة غير مراجعة تُستخدم فقط لإثبات أن البوابة تمنع الوصول إلى المزود.\n`);
  await symlink(path.join(ROOT, 'node_modules'), path.join(fixtureRoot, 'node_modules'), linkType);
  const endpoint = `http://127.0.0.1:${address.port}`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/generate-audio.mjs'], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        BAREEQ_TTS_PROVIDER: 'gemini',
        BAREEQ_TTS_INCLUDE_IDS: 'gate-block-fixture',
        BAREEQ_TTS_CONTRACT_TEST: '1',
        GEMINI_API_KEY: 'local-key-that-must-never-be-used',
        GEMINI_TTS_ENDPOINT: `${endpoint}/v1beta/interactions`,
        BAREEQ_AUDIO_CACHE_ORIGIN: endpoint,
        BAREEQ_TTS_MAX_RETRIES: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
  assert.notEqual(result.code, 0, 'unapproved article unexpectedly reached synthesis');
  assert.match(`${result.stdout}\n${result.stderr}`, /Speech synthesis blocked before provider access/);
  assert.equal(providerPosts, 0, 'provider endpoint received a POST despite failed Speech Script gate');
  const outputFiles = await readdir(path.join(fixtureRoot, 'public'), { recursive: true });
  assert(!outputFiles.some((name) => name.endsWith('.mp3') || name.endsWith('.wav')), 'quality gate test generated an audio file');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(fixtureRoot, { recursive: true, force: true });
}

assert.equal(normalizeArabicForComparison('تَعْرِفُ'), normalizeArabicForComparison('تعرف'));
console.log('Speech Script quality-gate tests passed: references, stable segment review invalidation, parity, transformations, contextual ambiguity, sukun, hashes, authoritative Gemini prompt, audio-state honesty, source immutability, and zero provider calls/audio files on rejection.');
