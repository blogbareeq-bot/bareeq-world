import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { compareArabicTranscripts, ARABIC_TRANSCRIPT_COMPARISON_PROFILE } from './arabic-transcript-match.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ARTICLE_ID = 'how-touchscreens-work';
const AUDIO_KEY = 'de93f3d9f91c8b8b';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = 'Sadaltager';
const ASR_MODEL = 'gemini-3.5-flash';
const API_KEY = process.env.GEMINI_API_KEY?.trim();
if (!API_KEY) throw new Error('GEMINI_API_KEY is required for whole-article verification.');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const manifestFile = `public/audio/articles/${AUDIO_KEY}/manifest.json`;
const scriptFile = `scripts/speech-scripts/${ARTICLE_ID}.json`;
const fullAudioFile = `scripts/speech-test-evidence/${ARTICLE_ID}-gemini-25flash-full-v1.mp3`;
const reportFile = `scripts/speech-transcript-evidence/${ARTICLE_ID}-gemini-25flash-full-v1.json`;

const [manifestRaw, scriptRaw] = await Promise.all([readFile(manifestFile, 'utf8'), readFile(scriptFile, 'utf8')]);
const manifest = JSON.parse(manifestRaw);
const speechScript = JSON.parse(scriptRaw);
if (manifest.articleId !== ARTICLE_ID || manifest.provider !== 'Google Gemini API' || manifest.model !== TTS_MODEL || manifest.defaultVoice !== 'sadaltager') {
  throw new Error('Full Gemini 2.5 Flash manifest identity mismatch.');
}
if (!Array.isArray(manifest.parts) || !manifest.parts.length || !Array.isArray(manifest.voices) || manifest.voices.length !== 1 || manifest.voices[0]?.providerVoice !== TTS_VOICE) {
  throw new Error('Full Gemini 2.5 Flash manifest structure/voice mismatch.');
}

const originalExpected = speechScript.segments.map((segment) => segment.spokenText).join(' ');
const ttsExpected = originalExpected.replace(
  'مَا نُسَمِّيهِ عَادَةً «الشَّاشَة» لَيْسَ طَبَقَةً وَاحِدَة.',
  'مَا نُسَمِّيهِ عَادَةً، «الشَّاشَة»، لَيْسَ طَبَقَةً وَاحِدَة.',
);
if (ttsExpected === originalExpected) throw new Error('Full v3 punctuation-only disambiguation target disappeared.');
const lexicalEquivalence = compareArabicTranscripts(originalExpected, ttsExpected);
if (!lexicalEquivalence.exact || lexicalEquivalence.wordErrorCount !== 0) throw new Error('Full v3 punctuation transform altered lexical content.');

let totalDurationSeconds = 0;
const concatFiles = [];
for (const [index, part] of manifest.parts.entries()) {
  const asset = part?.audio?.sadaltager;
  if (!asset?.src || !(asset.bytes > 100) || !(asset.durationSeconds > 0) || !/^[a-f0-9]{64}$/iu.test(asset.sha256 ?? '')) throw new Error(`Invalid Sadaltager asset in part ${index + 1}.`);
  const file = path.join('public', asset.src.replace(/^\//u, ''));
  const bytes = await readFile(file);
  const measured = mp3DurationSeconds(bytes);
  if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256 || Math.abs(measured - asset.durationSeconds) > 0.15) throw new Error(`Part integrity mismatch: ${asset.src}`);
  if (!Number.isFinite(measured) || measured <= 0) throw new Error(`Invalid part duration: ${asset.src}`);
  totalDurationSeconds += measured;
  concatFiles.push(file);
}
if (!(totalDurationSeconds > 300)) throw new Error(`Implausibly short full article: ${totalDurationSeconds.toFixed(2)} seconds.`);

await mkdir(path.dirname(fullAudioFile), { recursive: true });
const listFile = `/tmp/bareeq-${ARTICLE_ID}-25flash-concat.txt`;
const escapeConcatPath = (value) => path.resolve(value).replace(/'/gu, `'\\''`);
await writeFile(listFile, `${concatFiles.map((file) => `file '${escapeConcatPath(file)}'`).join('\n')}\n`, 'utf8');
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
if (fullAudio.length < 10000 || Math.abs(assembledDurationSeconds - totalDurationSeconds) > Math.max(2, manifest.parts.length * 0.15)) {
  throw new Error(`Assembled full-audio integrity mismatch: ${assembledDurationSeconds.toFixed(2)} vs ${totalDurationSeconds.toFixed(2)} seconds.`);
}

const prompts = [
  'استمع إلى التسجيل الكامل المرفق وحوّل كل الكلام المسموع إلى نص عربي حرفي كامل. اكتب كل كلمة تسمعها مرة واحدة وبالترتيب نفسه من البداية إلى النهاية. لا تلخص، ولا تصحح المتحدث، ولا تضف أو تحذف شيئًا، ولا تعتمد على أي نص خارجي. لا حاجة إلى التشكيل أو الترقيم. أعد حقل transcript فقط وفق JSON المطلوب.',
  'Produce a complete verbatim Arabic transcript of the attached recording, using the audio as the only source. Include every audible word exactly once and in its original order from beginning to end. Do not infer, repair, summarize, paraphrase, omit, or add commentary. Diacritics and punctuation are optional. Return only transcript in the requested JSON schema.',
];

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (typeof payload?.outputText === 'string') return payload.outputText;
  const output = [];
  for (const collection of [payload?.steps, payload?.outputs].filter(Array.isArray)) {
    for (const item of collection) {
      for (const block of (Array.isArray(item?.content) ? item.content : [])) {
        if (block?.type === 'text' && typeof block.text === 'string') output.push(block.text);
      }
    }
  }
  return output.join('');
}

const passes = [];
for (let passIndex = 0; passIndex < 2; passIndex += 1) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'x-goog-api-key': API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Bareeq-Whole-Audio-Verifier/1.0',
    },
    body: JSON.stringify({
      model: ASR_MODEL,
      input: [
        { type: 'text', text: prompts[passIndex] },
        { type: 'audio', data: fullAudio.toString('base64'), mime_type: 'audio/mp3' },
      ],
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] },
      },
      store: false,
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Whole-article ASR pass ${passIndex + 1} failed (${response.status}): ${body.slice(0, 700)}`);
  let transcript;
  try {
    const payload = JSON.parse(body);
    const structured = JSON.parse(extractOutputText(payload).trim());
    transcript = structured.transcript?.trim();
  } catch (error) {
    throw new Error(`Whole-article ASR pass ${passIndex + 1} returned invalid structured text: ${error.message}`);
  }
  if (!transcript) throw new Error(`Whole-article ASR pass ${passIndex + 1} returned an empty transcript.`);
  const comparison = compareArabicTranscripts(originalExpected, transcript);
  console.log(`WHOLE_ASR_${passIndex + 1}: expected=${comparison.expectedWordCount} actual=${comparison.actualWordCount} errors=${comparison.wordErrorCount}`);
  passes.push({
    pass: passIndex + 1,
    model: ASR_MODEL,
    promptSha256: sha256(prompts[passIndex]),
    transcript,
    transcriptSha256: sha256(transcript),
    normalizedTranscript: comparison.actualNormalized,
    normalizedTranscriptSha256: sha256(comparison.actualNormalized),
    exact: comparison.exact,
    expectedWordCount: comparison.expectedWordCount,
    actualWordCount: comparison.actualWordCount,
    wordErrorCount: comparison.wordErrorCount,
    substitutions: comparison.substitutions,
    deletions: comparison.deletions,
    insertions: comparison.insertions,
    differences: comparison.operations.slice(0, 120),
  });
}

const passed = passes.length === 2 && passes.every((pass) => pass.exact && pass.wordErrorCount === 0 && pass.substitutions === 0 && pass.deletions === 0 && pass.insertions === 0);
const report = {
  schema: 'bareeq.whole-article-transcript-verification.v1',
  status: passed ? 'passed' : 'failed',
  articleId: ARTICLE_ID,
  ttsProvider: 'Google Gemini API',
  ttsModel: TTS_MODEL,
  ttsVoice: TTS_VOICE,
  audioMode: 'assembled-complete-article',
  audioFile: fullAudioFile,
  audioSha256: sha256(fullAudio),
  audioBytes: fullAudio.length,
  durationSeconds: Number(assembledDurationSeconds.toFixed(3)),
  partCount: manifest.parts.length,
  expectedTranscriptSha256: sha256(originalExpected),
  expectedWordCount: passes[0]?.expectedWordCount ?? lexicalEquivalence.expectedWordCount,
  transcriptionProvider: 'Google Gemini API',
  transcriptionModel: ASR_MODEL,
  independentPasses: 2,
  wordErrorCountAcrossAllPasses: passes.reduce((sum, pass) => sum + pass.wordErrorCount, 0),
  substitutions: passes.reduce((sum, pass) => sum + pass.substitutions, 0),
  deletions: passes.reduce((sum, pass) => sum + pass.deletions, 0),
  insertions: passes.reduce((sum, pass) => sum + pass.insertions, 0),
  expectedTextDisclosure: 'ASR received only the assembled complete audio and generic transcription instructions. Expected text was used only after each response for exact comparison.',
  comparisonProfile: ARABIC_TRANSCRIPT_COMPARISON_PROFILE,
  passes,
  verifiedAt: new Date().toISOString(),
};
await mkdir(path.dirname(reportFile), { recursive: true });
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
if (!passed) throw new Error(`Whole-article exact gate rejected audio: ${JSON.stringify(passes.map((pass) => pass.differences.slice(0, 10)))}`);

const reportBytes = await readFile(reportFile);
manifest.automatedTranscriptReview = {
  status: 'passed',
  scope: 'assembled-complete-article',
  reportFile,
  reportSha256: sha256(reportBytes),
  transcriptionProvider: report.transcriptionProvider,
  transcriptionModel: report.transcriptionModel,
  transcriptionPasses: 2,
  expectedWordCount: report.expectedWordCount,
  wordErrorCountAcrossAllPasses: 0,
  substitutions: 0,
  deletions: 0,
  insertions: 0,
  fullAudioSha256: report.audioSha256,
  reviewedAt: report.verifiedAt,
};
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`WHOLE_ARTICLE_ZERO_ERROR=PASS words=${report.expectedWordCount} passes=2 parts=${report.partCount} duration=${report.durationSeconds}s`);
