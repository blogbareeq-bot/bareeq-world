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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required for whole-article verification.');
const prompts = [
  'استمع إلى التسجيل المرفق وحوّل الكلام المسموع إلى نص عربي حرفي كامل. اكتب الكلمات التي تسمعها فقط وبالترتيب نفسه. لا تلخص ولا تصحح ولا تضف شيئًا ولا تعتمد على نص خارجي. لا حاجة إلى التشكيل أو الترقيم. أعد حقل transcript فقط وفق JSON المطلوب.',
  'Produce a verbatim Arabic transcript of the attached audio using audio as the only source. Write every audible word once and in order. Do not infer, repair, summarize, paraphrase, omit, or add commentary. Diacritics and punctuation are optional. Return only transcript in the requested JSON schema.',
];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const manifestFile = `public/audio/articles/${AUDIO_KEY}/manifest.json`;
const scriptFile = `scripts/speech-scripts/${ARTICLE_ID}.json`;
const fullAudioFile = `scripts/speech-test-evidence/${ARTICLE_ID}-gemini25flash-full-v1.mp3`;
const reportFile = `scripts/speech-transcript-evidence/${ARTICLE_ID}-gemini25flash-full-v1.json`;

function extractText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (typeof payload?.outputText === 'string') return payload.outputText;
  const output = [];
  for (const collection of [payload?.steps, payload?.outputs].filter(Array.isArray)) for (const item of collection) for (const block of (Array.isArray(item?.content) ? item.content : [])) if (block?.type === 'text' && typeof block.text === 'string') output.push(block.text);
  return output.join('');
}

async function transcribe(prompt, bytes, pass, partNumber) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Bareeq-Gemini25-Full-ASR/1.0' },
    body: JSON.stringify({ model: ASR_MODEL, input: [{ type: 'text', text: prompt }, { type: 'audio', data: bytes.toString('base64'), mime_type: 'audio/mp3' }], response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] } }, store: false }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`ASR pass ${pass} part ${partNumber} failed (${response.status}): ${body.slice(0, 900)}`);
  let transcript;
  try { transcript = JSON.parse(extractText(JSON.parse(body)).trim()).transcript?.trim(); }
  catch (error) { throw new Error(`ASR pass ${pass} part ${partNumber} returned invalid JSON: ${error.message}`); }
  if (!transcript) throw new Error(`ASR pass ${pass} part ${partNumber} returned empty transcript.`);
  return transcript;
}

const [manifestRaw, scriptRaw] = await Promise.all([readFile(manifestFile, 'utf8'), readFile(scriptFile, 'utf8')]);
const manifest = JSON.parse(manifestRaw), script = JSON.parse(scriptRaw);
if (manifest.articleId !== ARTICLE_ID || manifest.provider !== 'Google Gemini API' || manifest.model !== TTS_MODEL || manifest.defaultVoice !== 'sadaltager') throw new Error('Full Gemini 2.5 Flash manifest identity mismatch.');
if (!Array.isArray(manifest.parts) || !manifest.parts.length || manifest.voices?.length !== 1 || manifest.voices[0]?.providerVoice !== TTS_VOICE) throw new Error('Full manifest structure/voice mismatch.');
const originalExpected = script.segments.map((segment) => segment.spokenText).join(' ');
const expected = originalExpected.replace('مَا نُسَمِّيهِ عَادَةً «الشَّاشَة» لَيْسَ طَبَقَةً وَاحِدَة.', 'مَا نُسَمِّيهِ عَادَةً، «الشَّاشَة»، لَيْسَ طَبَقَةً وَاحِدَة.');
if (!compareArabicTranscripts(originalExpected, expected).exact) throw new Error('v3 punctuation altered lexical expected text.');
const parts = [];
let duration = 0;
for (const [index, part] of manifest.parts.entries()) {
  const asset = part?.audio?.sadaltager;
  if (!asset?.src || !(asset.bytes > 100) || !(asset.durationSeconds > 0) || !/^[a-f0-9]{64}$/iu.test(asset.sha256 ?? '')) throw new Error(`Invalid audio asset part ${index + 1}`);
  const file = path.join('public', asset.src.replace(/^\//u, ''));
  const bytes = await readFile(file);
  const measured = mp3DurationSeconds(bytes);
  if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256 || Math.abs(measured - asset.durationSeconds) > 0.15) throw new Error(`Integrity mismatch part ${index + 1}`);
  duration += measured;
  parts.push({ index, file, bytes, asset });
}
if (!(duration > 300)) throw new Error(`Implausibly short complete article: ${duration.toFixed(2)}s`);
await mkdir(path.dirname(fullAudioFile), { recursive: true });
const listFile = `/tmp/${ARTICLE_ID}-25flash-concat.txt`;
const esc = (value) => path.resolve(value).replace(/'/gu, `'\\''`);
await writeFile(listFile, `${parts.map(({ file }) => `file '${esc(file)}'`).join('\n')}\n`);
await rm(fullAudioFile, { force: true });
await new Promise((resolve, reject) => {
  const child = spawn(ffmpegInstaller.path, ['-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',listFile,'-map_metadata','-1','-c','copy','-y',fullAudioFile], { stdio:['ignore','ignore','pipe'] });
  const err=[]; child.stderr.on('data',(c)=>err.push(c)); child.once('error',reject); child.once('close',(code)=>code===0?resolve():reject(new Error(`ffmpeg concat failed ${code}: ${Buffer.concat(err).toString('utf8').slice(0,800)}`)));
});
const fullAudio = await readFile(fullAudioFile);
const fullDuration = mp3DurationSeconds(fullAudio);
if (fullAudio.length < 10000 || Math.abs(fullDuration - duration) > Math.max(2, parts.length * 0.15)) throw new Error('Assembled complete-audio integrity mismatch.');

const passes=[];
for (let passIndex=0; passIndex<2; passIndex += 1) {
  const chunks=[];
  for (const {index,bytes,asset} of parts) {
    const transcript=await transcribe(prompts[passIndex],bytes,passIndex+1,index+1);
    chunks.push({part:index+1,audioSha256:asset.sha256,transcript,transcriptSha256:sha256(transcript)});
    console.log(`ASR_PASS_${passIndex+1}_PART_${index+1}=DONE`);
  }
  const transcript=chunks.map((chunk)=>chunk.transcript).join(' ');
  const c=compareArabicTranscripts(expected,transcript);
  console.log(`ASR_PASS_${passIndex+1}: expected=${c.expectedWordCount} actual=${c.actualWordCount} errors=${c.wordErrorCount}`);
  passes.push({pass:passIndex+1,provider:'Google Gemini API',model:ASR_MODEL,promptSha256:sha256(prompts[passIndex]),transcript,transcriptSha256:sha256(transcript),normalizedTranscript:c.actualNormalized,normalizedTranscriptSha256:sha256(c.actualNormalized),exact:c.exact,expectedWordCount:c.expectedWordCount,actualWordCount:c.actualWordCount,wordErrorCount:c.wordErrorCount,substitutions:c.substitutions,deletions:c.deletions,insertions:c.insertions,differences:c.operations.slice(0,200),chunks});
}
const passed=passes.length===2&&passes.every((p)=>p.exact&&p.wordErrorCount===0&&p.substitutions===0&&p.deletions===0&&p.insertions===0);
const report={schema:'bareeq.whole-article-two-pass-transcript-verification.v1',status:passed?'passed':'failed',articleId:ARTICLE_ID,ttsProvider:'Google Gemini API',ttsModel:TTS_MODEL,ttsVoice:TTS_VOICE,audioMode:'assembled-complete-article',audioFile:fullAudioFile,audioSha256:sha256(fullAudio),audioBytes:fullAudio.length,durationSeconds:Number(fullDuration.toFixed(3)),partCount:parts.length,expectedTranscriptSha256:sha256(expected),expectedWordCount:passes[0]?.expectedWordCount??0,independentPasses:2,transcriptionModel:ASR_MODEL,wordErrorCountAcrossAllPasses:passes.reduce((s,p)=>s+p.wordErrorCount,0),substitutions:passes.reduce((s,p)=>s+p.substitutions,0),deletions:passes.reduce((s,p)=>s+p.deletions,0),insertions:passes.reduce((s,p)=>s+p.insertions,0),expectedTextDisclosure:'Both ASR passes received immutable audio parts plus generic transcription instructions only; expected text was used only after responses.',comparisonProfile:ARABIC_TRANSCRIPT_COMPARISON_PROFILE,passes,verifiedAt:new Date().toISOString()};
await mkdir(path.dirname(reportFile),{recursive:true}); await writeFile(reportFile,`${JSON.stringify(report,null,2)}\n`);
if(!passed) throw new Error(`Whole-article exact gate rejected audio: ${JSON.stringify(passes.map((p)=>p.differences.slice(0,20)))}`);
const reportBytes=await readFile(reportFile);
manifest.automatedTranscriptReview={status:'passed',scope:'assembled-complete-article',reportFile,reportSha256:sha256(reportBytes),transcriptionProvider:'Google Gemini API',transcriptionModels:[ASR_MODEL,ASR_MODEL],transcriptionPasses:2,expectedWordCount:report.expectedWordCount,wordErrorCountAcrossAllPasses:0,substitutions:0,deletions:0,insertions:0,fullAudioSha256:report.audioSha256,reviewedAt:report.verifiedAt};
await writeFile(manifestFile,`${JSON.stringify(manifest,null,2)}\n`);
console.log(`WHOLE_ARTICLE_ZERO_ERROR=PASS words=${report.expectedWordCount} passes=2 parts=${report.partCount} duration=${report.durationSeconds}s`);
