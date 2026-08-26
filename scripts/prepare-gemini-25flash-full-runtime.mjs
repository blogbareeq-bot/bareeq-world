import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const articleId = 'how-touchscreens-work';
const planFile = `scripts/speech-test-clips/${articleId}.json`;
const pilotAudioFile = `scripts/speech-test-evidence/${articleId}-gemini-25flash-pilot-v3.mp3`;
const pilotReportFile = `scripts/speech-transcript-evidence/${articleId}-gemini-25flash-pilot-v3-two-pass.json`;
const generatorFile = 'scripts/generate-audio.mjs';

const [planRaw, pilotAudio, pilotReportBytes, generatorRaw] = await Promise.all([
  readFile(planFile, 'utf8'),
  readFile(pilotAudioFile),
  readFile(pilotReportFile),
  readFile(generatorFile, 'utf8'),
]);
const plan = JSON.parse(planRaw);
const pilotReport = JSON.parse(pilotReportBytes.toString('utf8'));
if (pilotReport.status !== 'passed' || pilotReport.ttsModel !== 'gemini-2.5-flash-preview-tts' || pilotReport.ttsVoice !== 'Sadaltager' || pilotReport.wordErrorCountAcrossAllPasses !== 0) {
  throw new Error('Cannot prepare full synthesis without approved exact v3 pilot.');
}
if (pilotReport.audioSha256 !== sha256(pilotAudio) || pilotReport.audioBytes !== pilotAudio.length) throw new Error('V3 pilot audio/report integrity mismatch.');

const reviewedAt = new Date().toISOString();
plan.testClipPassed = true;
plan.fullSynthesisAllowed = true;
plan.audioReview = {
  status: 'passed',
  reviewedBy: 'Automated two-pass exact ASR — user-authorized conditional publication',
  reviewedAt,
  evidence: {
    file: pilotAudioFile,
    sha256: sha256(pilotAudio),
    bytes: pilotAudio.length,
    provider: 'Google Gemini API',
    model: 'gemini-2.5-flash-preview-tts',
    voice: 'Sadaltager',
    automatedTranscriptReport: pilotReportFile,
    automatedTranscriptReportSha256: sha256(pilotReportBytes),
    transcriptionModel: 'gemini-3.5-flash',
    transcriptionPasses: 2,
    wordErrorCount: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    humanListening: false,
    approvalBasis: 'User instructed to continue through publication if automated speech-to-text matches the original text exactly.',
  },
};
await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);

let source = generatorRaw;
const replaceOnce = (from, to, label) => {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one source match, found ${count}.`);
  source = source.replace(from, to);
};
replaceOnce(
  "const GEMINI_MODEL = 'gemini-3.1-flash-tts-preview';",
  "const GEMINI_MODEL = 'gemini-2.5-flash-preview-tts';",
  'Gemini model',
);
replaceOnce(
  'spokenText: record?.spokenText ?? segment.sourceText,',
  "spokenText: (record?.spokenText ?? segment.sourceText).replace('مَا نُسَمِّيهِ عَادَةً «الشَّاشَة» لَيْسَ طَبَقَةً وَاحِدَة.', 'مَا نُسَمِّيهِ عَادَةً، «الشَّاشَة»، لَيْسَ طَبَقَةً وَاحِدَة.'),",
  'v3 punctuation-only disambiguation',
);
replaceOnce(
  "  const tempDir = `${finalDir}.tmp-${process.pid}`;\n  await rm(tempDir, { recursive: true, force: true });\n  await mkdir(tempDir, { recursive: true });",
  "  const checkpointName = `${post.key}-${post.sourceHash.slice(0, 16)}-${MODEL.replace(/[^a-z0-9.-]+/gi, '_')}`;\n  const tempDir = PROVIDER === 'gemini' ? path.join(ROOT, 'scripts', 'gemini-checkpoints', checkpointName) : `${finalDir}.tmp-${process.pid}`;\n  if (PROVIDER !== 'gemini') await rm(tempDir, { recursive: true, force: true });\n  await mkdir(tempDir, { recursive: true });",
  'deterministic checkpoint directory',
);
replaceOnce(
  `        const audio = await synthesizeVoice(API_KEY, voice, audioPart, {\n          articleTitle: post.title,\n          partIndex: index,\n          partCount: post.audioParts.length,\n        });\n        if (audio.length < 100) throw new Error(\`${'${post.id}'}: generated MP3 ${'${filename}'} is unexpectedly small.\`);\n        const durationSeconds = mp3DurationSeconds(audio);\n        await writeFile(path.join(tempDir, filename), audio);`,
  `        const checkpointFile = path.join(tempDir, filename);\n        let audio;\n        if (PROVIDER === 'gemini' && await exists(checkpointFile)) {\n          audio = await readFile(checkpointFile);\n          if (audio.length < 100 || !(mp3DurationSeconds(audio) > 0)) throw new Error(\`${'${post.id}'}: checkpoint ${'${filename}'} is invalid.\`);\n          console.log(\`↺ ${'${post.id}'}: reusing checkpoint ${'${filename}'}\`);\n        } else {\n          audio = await synthesizeVoice(API_KEY, voice, audioPart, {\n            articleTitle: post.title,\n            partIndex: index,\n            partCount: post.audioParts.length,\n          });\n          if (audio.length < 100) throw new Error(\`${'${post.id}'}: generated MP3 ${'${filename}'} is unexpectedly small.\`);\n          await writeFile(checkpointFile, audio);\n          console.log(\`✓ ${'${post.id}'}: checkpointed ${'${filename}'}\`);\n        }\n        const durationSeconds = mp3DurationSeconds(audio);`,
  'checkpoint reuse/write',
);
replaceOnce(
  "  } catch (error) {\n    await rm(tempDir, { recursive: true, force: true });",
  "  } catch (error) {\n    if (PROVIDER !== 'gemini') await rm(tempDir, { recursive: true, force: true });\n    else console.warn(`⚠ Preserving Gemini checkpoint at ${tempDir}.`);",
  'checkpoint preservation on synthesis pause',
);
await writeFile(generatorFile, source);
console.log('GEMINI_25FLASH_FULL_RUNTIME_PREPARED=PASS');
