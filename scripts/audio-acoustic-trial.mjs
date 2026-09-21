import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { synthesizeGeminiPart } from './audio-gemini-tts.mjs';
import { transcribeDualAsr } from './audio-asr-transcribe.mjs';
import { sha256 } from './audio-constants.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const arg = (name, fallback = null) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const mode = arg('mode', 'gemini');
const outDir = path.resolve(arg('out', 'acoustic-artifacts'));
const inputDir = arg('input-dir') ? path.resolve(arg('input-dir')) : null;
const samplesPath = path.resolve(arg('samples', 'docs/audio/ACOUSTIC-TRIAL-SAMPLES.json'));
const apiKey = process.env.GEMINI_API_KEY || '';
const samples = JSON.parse(await readFile(samplesPath, 'utf8'));

await mkdir(outDir, { recursive: true });

if (!apiKey.trim()) {
  const report = {
    schema: 'bareeq.audio-acoustic-trial.v1',
    status: 'blocked',
    reason: 'GEMINI_API_KEY is unavailable to this workflow',
    mode,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(outDir, 'trial-summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.error(report.reason);
  process.exit(78);
}

const results = [];
let anyFailed = false;

for (const [index, sample] of samples.entries()) {
  const sampleDir = path.join(outDir, sample.id);
  await mkdir(sampleDir, { recursive: true });
  const audioPath = path.join(sampleDir, `${sample.id}.mp3`);

  let audio;
  let transport = mode;
  try {
    if (mode === 'gemini') {
      audio = await synthesizeGeminiPart({
        apiKey,
        part: { text: sample.text, partIndex: index },
        context: {
          articleTitle: 'Bareeq Audio Engine V2 acoustic acceptance',
          partIndex: index,
          partCount: samples.length,
        },
      });
      await writeFile(audioPath, audio);
      transport = 'gemini-sadaltager';
    } else if (mode === 'external') {
      if (!inputDir) throw new Error('--input-dir is required for external mode');
      audio = await readFile(path.join(inputDir, `${sample.id}.mp3`));
      await writeFile(audioPath, audio);
      transport = arg('engine', 'external');
    } else {
      throw new Error(`Unsupported mode: ${mode}`);
    }

    const digest = sha256(audio);
    const fingerprint = sha256(Buffer.from(`acoustic-v1\n${sample.id}\n${sample.text}\n${transport}`));
    const reportsDir = path.join(sampleDir, 'asr');
    await mkdir(reportsDir, { recursive: true });

    let dual = null;
    let asrError = null;
    try {
      dual = await transcribeDualAsr({
        audioPath,
        expectedText: sample.text,
        apiKey,
        reportsDir,
        fingerprint,
        fullSha256: digest,
        article: {
          articleId: `acoustic-${sample.id}`,
          title: sample.title,
          speechScriptHash: sha256(Buffer.from(sample.text)),
        },
      });
    } catch (error) {
      dual = error.dual || null;
      asrError = error.message;
      anyFailed = true;
    }

    const asrReports = dual?.asrReports || [];
    const exact = asrReports.length === 2 && asrReports.every((item) =>
      item.status === 'passed'
      && item.substitutions === 0
      && item.deletions === 0
      && item.insertions === 0
    );

    if (!exact) anyFailed = true;

    results.push({
      id: sample.id,
      title: sample.title,
      engine: transport,
      status: exact ? 'passed' : 'failed',
      audioFile: path.relative(outDir, audioPath),
      sha256: digest,
      bytes: audio.length,
      durationSeconds: mp3DurationSeconds(audio),
      dualAsrExact000: exact,
      asrError,
      asr: asrReports.map((item) => ({
        model: item.requestedModel || item.model,
        status: item.status,
        substitutions: item.substitutions,
        deletions: item.deletions,
        insertions: item.insertions,
        actualResponseModel: item.actualResponseModel || null,
      })),
    });
  } catch (error) {
    anyFailed = true;
    results.push({
      id: sample.id,
      title: sample.title,
      engine: transport,
      status: 'error',
      error: error.message,
    });
  }
}

const summary = {
  schema: 'bareeq.audio-acoustic-trial.v1',
  mode,
  engine: mode === 'gemini' ? 'gemini-sadaltager' : arg('engine', 'external'),
  status: anyFailed ? 'failed' : 'passed',
  policy: 'all samples require two independent ASR passes at 0 substitutions / 0 deletions / 0 insertions',
  sampleCount: samples.length,
  passedCount: results.filter((item) => item.status === 'passed').length,
  failedCount: results.filter((item) => item.status !== 'passed').length,
  generatedAt: new Date().toISOString(),
  results,
};

await writeFile(path.join(outDir, 'trial-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exit(anyFailed ? 1 : 0);
