import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compareArabicTranscripts } from './arabic-transcript-match.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const articleId = 'how-touchscreens-work';
const base = `${articleId}-gemini-25flash-pilot-v3`;
const audioFile = `scripts/speech-test-evidence/${base}.mp3`;
const metadataFile = `scripts/speech-test-evidence/${base}.json`;
const reportFile = `scripts/speech-transcript-evidence/${base}-two-pass.json`;
const scriptFile = `scripts/speech-scripts/${articleId}.json`;

const [audio, metadataRaw, reportRaw, scriptRaw] = await Promise.all([
  readFile(audioFile),
  readFile(metadataFile, 'utf8'),
  readFile(reportFile, 'utf8'),
  readFile(scriptFile, 'utf8'),
]);
const metadata = JSON.parse(metadataRaw);
const report = JSON.parse(reportRaw);
const script = JSON.parse(scriptRaw);

if (metadata.schema !== 'bareeq.gemini-pronunciation-sample.v1' || metadata.articleId !== articleId || metadata.sampleMode !== 'six-segment-pilot') throw new Error('V3 metadata identity mismatch.');
if (metadata.model !== 'gemini-2.5-flash-preview-tts' || metadata.voice !== 'Sadaltager') throw new Error('V3 TTS model/voice mismatch.');
if (metadata.sha256 !== sha256(audio) || metadata.bytes !== audio.length) throw new Error('V3 audio integrity mismatch.');
if (!Array.isArray(metadata.selectedSegmentIds) || metadata.selectedSegmentIds.length !== 6) throw new Error('V3 selected-segment contract mismatch.');

const records = new Map(script.segments.map((segment) => [segment.segmentId, segment]));
const expectedOriginal = metadata.selectedSegmentIds.map((id) => {
  const segment = records.get(id);
  if (!segment?.spokenText) throw new Error(`V3 selected speech segment missing: ${id}`);
  return segment.spokenText;
}).join('\n\n');
const expectedTts = expectedOriginal.replace(
  'مَا نُسَمِّيهِ عَادَةً «الشَّاشَة» لَيْسَ طَبَقَةً وَاحِدَة.',
  'مَا نُسَمِّيهِ عَادَةً، «الشَّاشَة»، لَيْسَ طَبَقَةً وَاحِدَة.',
);
if (expectedTts === expectedOriginal) throw new Error('V3 punctuation-only target disappeared from reviewed script.');
if (metadata.transcriptHash !== sha256(expectedTts)) throw new Error('V3 TTS transcript hash mismatch.');
const lexical = compareArabicTranscripts(expectedOriginal, expectedTts);
if (!lexical.exact || lexical.expectedWordCount !== 160 || lexical.wordErrorCount !== 0) throw new Error('V3 punctuation-only transform changed lexical content.');

if (report.schema !== 'bareeq.two-pass-tts-pilot-verification.v1' || report.status !== 'passed' || report.articleId !== articleId) throw new Error('V3 verification report identity/status mismatch.');
if (report.ttsModel !== metadata.model || report.ttsVoice !== metadata.voice || report.audioSha256 !== metadata.sha256 || report.audioBytes !== metadata.bytes) throw new Error('V3 report is not bound to the locked audio.');
if (report.expectedTranscriptSha256 !== sha256(expectedOriginal) || report.expectedWordCount !== 160 || report.independentPasses !== 2) throw new Error('V3 expected-text/two-pass contract mismatch.');
if (report.wordErrorCountAcrossAllPasses !== 0 || report.substitutions !== 0 || report.deletions !== 0 || report.insertions !== 0) throw new Error('V3 aggregate error count is not zero.');
if (!Array.isArray(report.passes) || report.passes.length !== 2) throw new Error('V3 report must contain exactly two passes.');
for (const [index, pass] of report.passes.entries()) {
  const comparison = compareArabicTranscripts(expectedOriginal, pass.transcript ?? '');
  if (!pass.exact || pass.expectedWordCount !== 160 || pass.actualWordCount !== 160 || pass.wordErrorCount !== 0 || pass.substitutions !== 0 || pass.deletions !== 0 || pass.insertions !== 0 || !comparison.exact) {
    throw new Error(`V3 ASR pass ${index + 1} is not independently exact.`);
  }
}

console.log(`V3_PILOT_ZERO_ERROR=PASS audio=${metadata.sha256} words=160 passes=2 model=${metadata.model}`);
