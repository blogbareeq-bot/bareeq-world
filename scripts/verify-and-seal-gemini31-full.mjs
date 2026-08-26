import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { compareArabicTranscripts, ARABIC_TRANSCRIPT_COMPARISON_PROFILE } from './arabic-transcript-match.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ARTICLE_ID = 'how-touchscreens-work';
const AUDIO_KEY = 'de93f3d9f91c8b8b';
const TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const TTS_VOICE = 'Sadaltager';
const GOOGLE_ASR_MODEL = 'gemini-3.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY?.trim();
const AZURE_REGION = process.env.AZURE_SPEECH_REGION?.trim().toLowerCase() || 'eastus';
if (!GEMINI_API_KEY || !AZURE_SPEECH_KEY) throw new Error('Gemini and Azure Speech credentials are required for independent whole-article verification.');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const manifestFile = `public/audio/articles/${AUDIO_KEY}/manifest.json`;
const scriptFile = `scripts/speech-scripts/${ARTICLE_ID}.json`;
const fullAudioFile = `scripts/speech-test-evidence/${ARTICLE_ID}-gemini31-full-v1.mp3`;
const reportFile = `scripts/speech-transcript-evidence/${ARTICLE_ID}-gemini31-full-v1.json`;

const [manifestRaw, scriptRaw] = await Promise.all([readFile(manifestFile, 'utf8'), readFile(scriptFile, 'utf8')]);
const manifest = JSON.parse(manifestRaw);
const speechScript = JSON.parse(scriptRaw);
if (manifest.articleId !== ARTICLE_ID || manifest.provider !== 'Google Gemini API' || manifest.model !== TTS_MODEL || manifest.defaultVoice !== 'sadaltager') throw new Error('Full Gemini 3.1 manifest identity mismatch.');
if (!Array.isArray(manifest.parts) || !manifest.parts.length || !Array.isArray(manifest.voices) || manifest.voices.length !== 1 || manifest.voices[0]?.providerVoice !== TTS_VOICE) throw new Error('Full Gemini 3.1 manifest structure/voice mismatch.');

const expected = speechScript.segments.map((segment) => segment.spokenText).join(' ');
const partFiles = [];
let totalDurationSeconds = 0;
for (const [index, part] of manifest.parts.entries()) {
  const asset = part?.audio?.sadaltager;
  if (!asset?.src || !(asset.bytes > 100) || !(asset.durationSeconds > 0) || !/^[a-f0-9]{64}$/iu.test(asset.sha256 ?? '')) throw new Error(`Invalid Sadaltager asset in part ${index + 1}.`);
  const file = path.join('public', asset.src.replace(/^\//u, ''));
  const bytes = await readFile(file);
  const measured = mp3DurationSeconds(bytes);
  if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256 || Math.abs(measured - asset.durationSeconds) > 0.15) throw new Error(`Part integrity mismatch: ${asset.src}`);
  totalDurationSeconds += measured;
  partFiles.push({ index, file, bytes, asset, durationSeconds: measured });
}
if (!(totalDurationSeconds > 300)) throw new Error(`Implausibly short full article: ${totalDurationSeconds.toFixed(2)} seconds.`);

await mkdir(path.dirname(fullAudioFile), { recursive: true });
const listFile = `/tmp/bareeq-${ARTICLE_ID}-31-concat.txt`;
const escapeConcatPath = (value) => path.resolve(value).replace(/'/gu, `'\\''`);
await writeFile(listFile, `${partFiles.map(({ file }) => `file '${escapeConcatPath(file)}'`).join('\n')}\n`, 'utf8');
await rm(fullAudioFile, { force: true });
await new Promise((resolve, reject) => {
  const child = spawn(ffmpegInstaller.path, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-map_metadata', '-1', '-c', 'copy', '-y', fullAudioFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg concat failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 800)}`)));
});
const fullAudio = await readFile(fullAudioFile);
const assembledDurationSeconds = mp3DurationSeconds(fullAudio);
if (fullAudio.length < 10000 || Math.abs(assembledDurationSeconds - totalDurationSeconds) > Math.max(2, manifest.parts.length * 0.15)) throw new Error('Assembled full-audio integrity mismatch.');

function extractGeminiOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (typeof payload?.outputText === 'string') return payload.outputText;
  const output = [];
  for (const collection of [payload?.steps, payload?.outputs].filter(Array.isArray)) for (const item of collection) for (const block of (Array.isArray(item?.content) ? item.content : [])) if (block?.type === 'text' && typeof block.text === 'string') output.push(block.text);
  return output.join('');
}

const azureForm = new FormData();
azureForm.append('audio', new Blob([fullAudio], { type: 'audio/mpeg' }), `${ARTICLE_ID}-full.mp3`);
azureForm.append('definition', JSON.stringify({ locales: ['ar-SA'] }));
const azureEndpoint = `https://${AZURE_REGION}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15`;
const azureResponse = await fetch(azureEndpoint, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY }, body: azureForm });
const azureBody = await azureResponse.text();
if (!azureResponse.ok) throw new Error(`Azure whole-audio ASR failed (${azureResponse.status}): ${azureBody.slice(0, 700)}`);
const azurePayload = JSON.parse(azureBody);
const azureTranscript = (azurePayload.combinedPhrases || []).map((phrase) => phrase?.text || '').join(' ').trim();
if (!azureTranscript) throw new Error('Azure whole-audio ASR returned an empty transcript.');
const azureComparison = compareArabicTranscripts(expected, azureTranscript);
console.log(`AZURE_WHOLE_ASR: expected=${azureComparison.expectedWordCount} actual=${azureComparison.actualWordCount} errors=${azureComparison.wordErrorCount}`);

const googlePrompt = 'Produce a verbatim Arabic transcript of the attached audio using audio as the only source. Write every audible word exactly once and in order. Do not infer, repair, summarize, paraphrase, omit, or add commentary. Diacritics and punctuation are optional. Return only transcript in the requested JSON schema.';
const googleChunks = [];
for (const { index, bytes, asset } of partFiles) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Bareeq-Gemini31-Whole-Audio-Verifier/1.0' },
    body: JSON.stringify({
      model: GOOGLE_ASR_MODEL,
      input: [{ type: 'text', text: googlePrompt }, { type: 'audio', data: bytes.toString('base64'), mime_type: 'audio/mp3' }],
      response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] } },
      store: false,
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Google ASR part ${index + 1} failed (${response.status}): ${body.slice(0, 700)}`);
  let transcript;
  try { transcript = JSON.parse(extractGeminiOutputText(JSON.parse(body)).trim()).transcript?.trim(); }
  catch (error) { throw new Error(`Google ASR part ${index + 1} returned invalid structured transcript: ${error.message}`); }
  if (!transcript) throw new Error(`Google ASR part ${index + 1} returned empty transcript.`);
  googleChunks.push({ part: index + 1, audioSha256: asset.sha256, transcript, transcriptSha256: sha256(transcript) });
  console.log(`GOOGLE_ASR_PART_${index + 1}=DONE`);
}
const googleTranscript = googleChunks.map((chunk) => chunk.transcript).join(' ');
const googleComparison = compareArabicTranscripts(expected, googleTranscript);
console.log(`GOOGLE_CHUNKED_ASR: expected=${googleComparison.expectedWordCount} actual=${googleComparison.actualWordCount} errors=${googleComparison.wordErrorCount}`);

const passFromComparison = (provider, model, transcript, comparison, extra = {}) => ({
  provider, model, transcript, transcriptSha256: sha256(transcript), normalizedTranscript: comparison.actualNormalized, normalizedTranscriptSha256: sha256(comparison.actualNormalized), exact: comparison.exact, expectedWordCount: comparison.expectedWordCount, actualWordCount: comparison.actualWordCount, wordErrorCount: comparison.wordErrorCount, substitutions: comparison.substitutions, deletions: comparison.deletions, insertions: comparison.insertions, differences: comparison.operations.slice(0, 160), ...extra,
});
const passes = [
  passFromComparison('Microsoft Azure AI Speech', 'Fast Transcription 2025-10-15', azureTranscript, azureComparison, { locale: 'ar-SA' }),
  passFromComparison('Google Gemini API', GOOGLE_ASR_MODEL, googleTranscript, googleComparison, { promptSha256: sha256(googlePrompt), chunks: googleChunks }),
];
const passed = passes.every((pass) => pass.exact && pass.wordErrorCount === 0 && pass.substitutions === 0 && pass.deletions === 0 && pass.insertions === 0);
const report = {
  schema: 'bareeq.whole-article-cross-provider-transcript-verification.v1', status: passed ? 'passed' : 'failed', articleId: ARTICLE_ID, ttsProvider: 'Google Gemini API', ttsModel: TTS_MODEL, ttsVoice: TTS_VOICE, audioMode: 'assembled-complete-article', audioFile: fullAudioFile, audioSha256: sha256(fullAudio), audioBytes: fullAudio.length, durationSeconds: Number(assembledDurationSeconds.toFixed(3)), partCount: manifest.parts.length, expectedTranscriptSha256: sha256(expected), expectedWordCount: azureComparison.expectedWordCount, independentProviders: 2, wordErrorCountAcrossAllPasses: passes.reduce((sum, pass) => sum + pass.wordErrorCount, 0), substitutions: passes.reduce((sum, pass) => sum + pass.substitutions, 0), deletions: passes.reduce((sum, pass) => sum + pass.deletions, 0), insertions: passes.reduce((sum, pass) => sum + pass.insertions, 0), expectedTextDisclosure: 'Both ASR providers received audio only plus generic transcription instructions/locale. Expected text was used only after their responses for exact comparison.', comparisonProfile: ARABIC_TRANSCRIPT_COMPARISON_PROFILE, passes, verifiedAt: new Date().toISOString(),
};
await mkdir(path.dirname(reportFile), { recursive: true });
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
if (!passed) throw new Error(`Whole-article cross-provider exact gate rejected audio: ${JSON.stringify(passes.map((pass) => pass.differences.slice(0, 12)))}`);
const reportBytes = await readFile(reportFile);
manifest.automatedTranscriptReview = { status: 'passed', scope: 'assembled-complete-article', reportFile, reportSha256: sha256(reportBytes), transcriptionProviders: passes.map((pass) => pass.provider), transcriptionPasses: 2, expectedWordCount: report.expectedWordCount, wordErrorCountAcrossAllPasses: 0, substitutions: 0, deletions: 0, insertions: 0, fullAudioSha256: report.audioSha256, reviewedAt: report.verifiedAt };
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`WHOLE_ARTICLE_ZERO_ERROR=PASS words=${report.expectedWordCount} providers=2 parts=${report.partCount} duration=${report.durationSeconds}s`);
