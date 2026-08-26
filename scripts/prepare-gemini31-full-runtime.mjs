import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const articleId = 'how-touchscreens-work';
const planFile = `scripts/speech-test-clips/${articleId}.json`;
const pilotAudioFile = `scripts/speech-test-evidence/${articleId}-gemini-pilot-v1.mp3`;
const pilotMetaFile = `scripts/speech-test-evidence/${articleId}-gemini-pilot-v1.json`;
const pilotReportFile = `scripts/speech-transcript-evidence/${articleId}-gemini-pilot-cross-model-v1.json`;
const generatorFile = 'scripts/generate-audio.mjs';

const [planRaw, pilotAudio, pilotMetaRaw, pilotReportBytes, generatorRaw] = await Promise.all([
  readFile(planFile, 'utf8'), readFile(pilotAudioFile), readFile(pilotMetaFile, 'utf8'), readFile(pilotReportFile), readFile(generatorFile, 'utf8'),
]);
const plan = JSON.parse(planRaw);
const meta = JSON.parse(pilotMetaRaw);
const report = JSON.parse(pilotReportBytes.toString('utf8'));
if (meta.model !== 'gemini-3.1-flash-tts-preview' || meta.voice !== 'Sadaltager' || meta.sha256 !== sha256(pilotAudio) || meta.bytes !== pilotAudio.length) throw new Error('Gemini 3.1 pilot identity/integrity mismatch.');
if (report.status !== 'passed' || report.audioSha256 !== meta.sha256 || report.expectedTranscriptSha256 !== meta.transcriptHash || report.expectedWordCount !== 160 || report.successfulIndependentPasses !== 2 || report.wordErrorCountAcrossSelectedPasses !== 0 || report.substitutions !== 0 || report.deletions !== 0 || report.insertions !== 0) throw new Error('Gemini 3.1 pilot is not locked at exact zero errors.');
if (!Array.isArray(report.passes) || report.passes.length !== 2 || new Set(report.passes.map((p) => p.model)).size !== 2 || !report.passes.every((p) => p.exact && p.actualWordCount === 160 && p.wordErrorCount === 0 && p.substitutions === 0 && p.deletions === 0 && p.insertions === 0)) throw new Error('Gemini 3.1 pilot requires two exact passes from two distinct ASR models.');

plan.testClipPassed = true;
plan.fullSynthesisAllowed = true;
plan.audioReview = {
  status: 'passed',
  reviewedBy: 'Automated cross-model exact ASR — user-authorized conditional publication',
  reviewedAt: new Date().toISOString(),
  evidence: {
    file: pilotAudioFile,
    sha256: meta.sha256,
    bytes: meta.bytes,
    provider: 'Google Gemini API',
    model: meta.model,
    voice: meta.voice,
    automatedTranscriptReport: pilotReportFile,
    automatedTranscriptReportSha256: sha256(pilotReportBytes),
    transcriptionModels: report.passes.map((p) => p.model),
    transcriptionPasses: 2,
    wordErrorCount: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    humanListening: false,
    approvalBasis: report.approvalBasis,
  },
};
await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);

let source = generatorRaw;
const replaceOnce = (from, to, label) => {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one source match, found ${count}.`);
  source = source.replace(from, to);
};
if (!source.includes("const GEMINI_MODEL = 'gemini-3.1-flash-tts-preview';")) throw new Error('Base generator no longer targets Gemini 3.1 Flash TTS.');
replaceOnce(
  "  const tempDir = `${finalDir}.tmp-${process.pid}`;\n  await rm(tempDir, { recursive: true, force: true });\n  await mkdir(tempDir, { recursive: true });",
  "  const checkpointName = `${post.key}-${post.sourceHash.slice(0, 16)}-${MODEL.replace(/[^a-z0-9.-]+/gi, '_')}`;\n  const tempDir = PROVIDER === 'gemini' ? path.join(ROOT, 'scripts', 'gemini-checkpoints', checkpointName) : `${finalDir}.tmp-${process.pid}`;\n  if (PROVIDER !== 'gemini') await rm(tempDir, { recursive: true, force: true });\n  await mkdir(tempDir, { recursive: true });",
  'deterministic checkpoint directory',
);
replaceOnce(
  `        const audio = await synthesizeVoice(API_KEY, voice, audioPart, {\n          articleTitle: post.title,\n          partIndex: index,\n          partCount: post.audioParts.length,\n        });\n        if (audio.length < 100) throw new Error(\`${'${post.id}'}: generated MP3 ${'${filename}'} is unexpectedly small.\`);\n        const durationSeconds = mp3DurationSeconds(audio);\n        await writeFile(path.join(tempDir, filename), audio);`,
  `        const checkpointFile = path.join(tempDir, filename);\n        let audio;\n        if (PROVIDER === 'gemini' && await exists(checkpointFile)) {\n          audio = await readFile(checkpointFile);\n          if (audio.length < 100 || !(mp3DurationSeconds(audio) > 0)) throw new Error(\`${'${post.id}'}: checkpoint ${'${filename}'} is invalid.\`);\n          console.log(\`↺ ${'${post.id}'}: reusing checkpoint ${'${filename}'}\`);\n        } else {\n          audio = await synthesizeVoice(API_KEY, voice, audioPart, { articleTitle: post.title, partIndex: index, partCount: post.audioParts.length });\n          if (audio.length < 100) throw new Error(\`${'${post.id}'}: generated MP3 ${'${filename}'} is unexpectedly small.\`);\n          await writeFile(checkpointFile, audio);\n          console.log(\`✓ ${'${post.id}'}: checkpointed ${'${filename}'}\`);\n        }\n        const durationSeconds = mp3DurationSeconds(audio);`,
  'checkpoint reuse/write',
);
replaceOnce(
  "  } catch (error) {\n    await rm(tempDir, { recursive: true, force: true });",
  "  } catch (error) {\n    if (PROVIDER !== 'gemini') await rm(tempDir, { recursive: true, force: true });\n    else console.warn(`⚠ Preserving Gemini checkpoint at ${tempDir}.`);",
  'checkpoint preservation',
);
await writeFile(generatorFile, source);
console.log('GEMINI31_FULL_RUNTIME_PREPARED=PASS');
