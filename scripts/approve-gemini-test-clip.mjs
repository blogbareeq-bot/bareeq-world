import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARABIC_TRANSCRIPT_COMPARISON_PROFILE, compareArabicTranscripts } from './arabic-transcript-match.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { readSpeechScript, sha256 } from './speech-script-core.mjs';

const ROOT = process.cwd();
const ARTICLE_ID = process.argv.find((argument) => argument.startsWith('--article='))?.slice('--article='.length);
const REVIEWED_BY = process.argv.find((argument) => argument.startsWith('--reviewed-by='))?.slice('--reviewed-by='.length)?.trim();
const CONFIRMATION = process.env.BAREEQ_GEMINI_LISTENING_REVIEW;

if (!ARTICLE_ID || !REVIEWED_BY) throw new Error('Pass --article=<article-id> and --reviewed-by=<listener>.');
if (CONFIRMATION !== 'I_LISTENED_TO_THE_EXACT_CLIP_AND_APPROVE_FULL_SYNTHESIS') {
  throw new Error('Listening approval was not recorded. Set BAREEQ_GEMINI_LISTENING_REVIEW=I_LISTENED_TO_THE_EXACT_CLIP_AND_APPROVE_FULL_SYNTHESIS only after hearing the complete exact clip.');
}

const basename = `${ARTICLE_ID}-gemini-pilot-v1`;
const relativeAudioFile = path.posix.join('scripts', 'speech-test-evidence', `${basename}.mp3`);
const audioFile = path.join(ROOT, relativeAudioFile);
const metadataFile = path.join(ROOT, 'scripts', 'speech-test-evidence', `${basename}.json`);
const planFile = path.join(ROOT, 'scripts', 'speech-test-clips', `${ARTICLE_ID}.json`);
const [audio, metadataRaw, planRaw, script] = await Promise.all([
  readFile(audioFile),
  readFile(metadataFile, 'utf8'),
  readFile(planFile, 'utf8'),
  readSpeechScript(ARTICLE_ID, ROOT),
]);
const metadata = JSON.parse(metadataRaw);
const plan = JSON.parse(planRaw);
const audioSha256 = createHash('sha256').update(audio).digest('hex');
const durationSeconds = mp3DurationSeconds(audio);

if (!script || metadata.schema !== 'bareeq.gemini-pronunciation-sample.v1' || metadata.sampleMode !== 'six-segment-pilot' || metadata.articleId !== ARTICLE_ID || plan.articleId !== ARTICLE_ID) throw new Error('Gemini evidence identity mismatch.');
if (metadata.model !== 'gemini-3.1-flash-tts-preview' || metadata.voice !== 'Sadaltager' || metadata.language !== 'ar') throw new Error('Gemini evidence voice contract mismatch.');
if (metadata.speechScriptHash !== script.scriptHash || plan.speechScriptHash !== script.scriptHash) throw new Error('Gemini evidence targets a stale Speech Script.');
if (metadata.planHash !== plan.planHash) throw new Error('Gemini evidence targets a stale test plan.');
const plannedSegmentIds = (plan.selectedSegments || []).map((segment) => segment.segmentId);
if (JSON.stringify(metadata.selectedSegmentIds) !== JSON.stringify(plannedSegmentIds)) throw new Error('Gemini evidence segment selection does not match the immutable listening plan.');
if (metadata.sha256 !== audioSha256 || metadata.bytes !== audio.length || Math.abs(metadata.durationSeconds - durationSeconds) > 0.1) throw new Error('Gemini evidence MP3 integrity mismatch.');

const automated = metadata.automatedTranscriptReview;
if (automated?.schema !== 'bareeq.audio-transcript-verification.v1' || automated.status !== 'passed') throw new Error('The Gemini pilot has not passed the automated audio-to-text gate.');
if (automated.transcriptionProvider !== 'Google Gemini API' || automated.transcriptionModel !== 'gemini-3.7-flash' || automated.transcriptionPassesPerPart !== 2) throw new Error('The Gemini automated transcription contract is not the locked two-pass contract.');
if (automated.comparisonProfile !== ARABIC_TRANSCRIPT_COMPARISON_PROFILE || automated.partCount !== 1 || automated.wordErrorCountAcrossAllPasses !== 0 || automated.substitutions !== 0 || automated.deletions !== 0 || automated.insertions !== 0) throw new Error('The Gemini automated transcript comparison is not a zero-error result.');
const reportFile = path.join(ROOT, automated.reportFile);
const reportBytes = await readFile(reportFile);
if (sha256(reportBytes) !== automated.reportSha256) throw new Error('Gemini automated transcript report hash mismatch.');
const report = JSON.parse(reportBytes.toString('utf8'));
if (report.status !== 'passed' || report.articleId !== ARTICLE_ID || report.audioMode !== 'six-segment-pilot' || report.partCount !== 1 || report.wordErrorCountAcrossAllPasses !== 0) throw new Error('Gemini automated transcript report identity/result mismatch.');
const records = new Map((script.segments || []).map((segment) => [segment.segmentId, segment]));
const expectedTranscript = (metadata.selectedSegmentIds || []).map((segmentId) => records.get(segmentId)?.spokenText || '').join('\n\n');
if (!expectedTranscript || sha256(expectedTranscript) !== metadata.transcriptHash || report.parts[0]?.expectedTranscriptSha256 !== metadata.transcriptHash) throw new Error('Gemini automated transcript report expected-text hash mismatch.');
if (report.parts[0]?.audioSha256 !== audioSha256 || report.parts[0]?.passes?.length !== 2) throw new Error('Gemini automated transcript report audio/pass mismatch.');
for (const pass of report.parts[0].passes) {
  const recomputed = compareArabicTranscripts(expectedTranscript, pass.transcript);
  if (!pass.exact || !recomputed.exact || recomputed.wordErrorCount !== 0) throw new Error(`Gemini automated transcript pass ${pass.pass} is not an exact zero-error match.`);
}

const expectedPlanHash = sha256(JSON.stringify({ articleId: plan.articleId, speechScriptHash: plan.speechScriptHash, selectedSegments: plan.selectedSegments, acceptance: plan.acceptance }));
if (plan.planHash !== expectedPlanHash) throw new Error('Gemini test plan hash is invalid.');
const reviewedAt = new Date().toISOString();
plan.testClipPassed = true;
plan.fullSynthesisAllowed = true;
plan.audioReview = {
  status: 'passed',
  reviewedBy: REVIEWED_BY,
  reviewedAt,
  evidence: {
    file: relativeAudioFile,
    sha256: audioSha256,
    bytes: audio.length,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    provider: 'Google Gemini API',
    model: 'gemini-3.1-flash-tts-preview',
    voice: 'Sadaltager',
    automatedTranscriptReport: automated.reportFile,
    automatedTranscriptReportSha256: automated.reportSha256,
    wordErrorCount: 0,
  },
};
metadata.listeningReview = { status: 'passed', reviewedBy: REVIEWED_BY, reviewedAt, approvedFullSynthesis: true };

await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
console.log(`Gemini listening evidence and two-pass automated transcript evidence approved for ${ARTICLE_ID}; full synthesis is now allowed for this article only.`);
