import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ARABIC_TRANSCRIPT_COMPARISON_PROFILE, compareArabicTranscripts, normalizeArabicTranscript } from './arabic-transcript-match.mjs';

const ROOT = process.cwd();
const ARTICLE_ID = 'how-touchscreens-work';
const AUDIO = path.join(ROOT, 'scripts', 'speech-test-evidence', `${ARTICLE_ID}-gemini-pilot-v1.mp3`);
const META = path.join(ROOT, 'scripts', 'speech-test-evidence', `${ARTICLE_ID}-gemini-pilot-v1.json`);
const SCRIPT = path.join(ROOT, 'scripts', 'speech-scripts', `${ARTICLE_ID}.json`);
const EVIDENCE = path.join(ROOT, 'scripts', 'speech-transcript-evidence', `${ARTICLE_ID}-gemini-pilot-cross-model-v1.json`);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const [audio, metadataRaw, scriptRaw, evidenceRaw] = await Promise.all([
  readFile(AUDIO), readFile(META, 'utf8'), readFile(SCRIPT, 'utf8'), readFile(EVIDENCE, 'utf8'),
]);
const metadata = JSON.parse(metadataRaw);
const script = JSON.parse(scriptRaw);
const evidence = JSON.parse(evidenceRaw);
const records = new Map((script.segments || []).map((segment) => [segment.segmentId, segment]));
const expectedText = (metadata.selectedSegmentIds || []).map((segmentId) => {
  const segment = records.get(segmentId);
  if (!segment?.spokenText) throw new Error(`Pilot Speech Script segment missing: ${segmentId}`);
  return segment.spokenText;
}).join('\n\n');
const expectedComparison = compareArabicTranscripts(expectedText, evidence.normalizedTranscript || '');
const normalizedExpected = normalizeArabicTranscript(expectedText);
const audioSha = sha256(audio);
const expectedSha = sha256(expectedText);
const normalizedExpectedSha = sha256(normalizedExpected);

if (metadata.schema !== 'bareeq.gemini-pronunciation-sample.v1' || metadata.sampleMode !== 'six-segment-pilot' || metadata.articleId !== ARTICLE_ID) throw new Error('Pilot metadata identity mismatch.');
if (metadata.model !== 'gemini-3.1-flash-tts-preview' || metadata.voice !== 'Sadaltager' || metadata.language !== 'ar') throw new Error('Pilot TTS identity mismatch.');
if (audioSha !== 'e04466b4824db92821488b1fd2ee848e3312fded968a89ff91fdb97f1b15550e' || metadata.sha256 !== audioSha || metadata.bytes !== audio.length) throw new Error('Pilot MP3 identity/integrity mismatch.');
if (metadata.transcriptHash !== expectedSha) throw new Error('Pilot expected transcript hash changed.');
if (evidence.schema !== 'bareeq.audio-transcript-cross-model-verification.v1' || evidence.status !== 'passed' || evidence.articleId !== ARTICLE_ID || evidence.audioMode !== 'six-segment-pilot') throw new Error('Cross-model evidence identity/status mismatch.');
if (evidence.audioSha256 !== audioSha || evidence.expectedTranscriptSha256 !== expectedSha || evidence.normalizedExpectedTranscriptSha256 !== normalizedExpectedSha) throw new Error('Cross-model evidence is not bound to the current audio/text.');
if (evidence.comparisonProfile !== ARABIC_TRANSCRIPT_COMPARISON_PROFILE || evidence.expectedWordCount !== 160 || evidence.successfulIndependentPasses !== 2) throw new Error('Cross-model exact-comparison contract mismatch.');
if (!expectedComparison.exact || expectedComparison.expectedWordCount !== 160 || expectedComparison.actualWordCount !== 160 || expectedComparison.wordErrorCount !== 0) throw new Error('Stored normalized cross-model transcript is not exactly the current expected transcript.');
if (evidence.wordErrorCountAcrossSelectedPasses !== 0 || evidence.substitutions !== 0 || evidence.deletions !== 0 || evidence.insertions !== 0) throw new Error('Cross-model aggregate errors are not zero.');

const passes = evidence.passes || [];
if (passes.length !== 2) throw new Error('Exactly two successful independent passes are required.');
const models = new Set(passes.map((pass) => pass.model));
if (models.size !== 2 || !models.has('gemini-3.6-flash') || !models.has('gemini-3.5-flash')) throw new Error('Cross-model evidence does not contain the locked independent model pair.');
for (const pass of passes) {
  if (pass.provider !== 'Google Gemini API' || pass.exact !== true || pass.actualWordCount !== 160 || pass.wordErrorCount !== 0 || pass.substitutions !== 0 || pass.deletions !== 0 || pass.insertions !== 0) throw new Error(`Selected ${pass.model} pass is not exact zero-error evidence.`);
  if (pass.normalizedTranscriptSha256 !== normalizedExpectedSha) throw new Error(`Selected ${pass.model} normalized transcript hash does not match expected text.`);
  if (!/^[a-f0-9]{64}$/u.test(pass.transcriptSha256 || '') || !/^[a-f0-9]{64}$/u.test(pass.sourceReportSha256 || '')) throw new Error(`Selected ${pass.model} provenance hash is invalid.`);
  if (!(Number.isInteger(pass.sourceWorkflowRun) && pass.sourceWorkflowRun > 0 && Number.isInteger(pass.sourceArtifactId) && pass.sourceArtifactId > 0)) throw new Error(`Selected ${pass.model} source run/artifact provenance is missing.`);
}
if (passes[0].sourceWorkflowRun === passes[1].sourceWorkflowRun) throw new Error('Selected ASR passes are not independently generated runs.');

console.log(`Cross-model pilot evidence passed: SHA ${audioSha}, 160/160 words, Gemini 3.6 + Gemini 3.5, 0 substitutions, 0 deletions, 0 insertions.`);
