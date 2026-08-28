import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareExactSpokenText } from './audio-exact-match.mjs';
import { INDEPENDENT_ASR_MODELS } from './audio-lifecycle.mjs';

const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--execute');
const audioArg = process.argv.find((arg) => arg.startsWith('--audio='))?.slice('--audio='.length);
const expectedArg = process.argv.find((arg) => arg.startsWith('--expected='))?.slice('--expected='.length);
const modelArg = process.argv.find((arg) => arg.startsWith('--model='))?.slice('--model='.length);
const outputArg = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'docs/audio/asr-last.json';

if (!INDEPENDENT_ASR_MODELS.includes(modelArg)) {
  throw new Error(`ASR model must be one of ${INDEPENDENT_ASR_MODELS.join(', ')}. Same-model dual ASR is forbidden.`);
}

const report = {
  schema: 'bareeq.audio-asr.v1',
  generatedAt: new Date().toISOString(),
  model: modelArg,
  audio: audioArg || null,
  mode: DRY_RUN ? 'dry-run' : 'execute-requested',
  independentModels: INDEPENDENT_ASR_MODELS,
};

if (DRY_RUN) {
  report.status = 'not-run';
  report.note = 'Dry-run only. No audio bytes were uploaded and no transcription API was called.';
  await mkdir(path.dirname(outputArg), { recursive: true });
  await writeFile(outputArg, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`ASR dry-run for ${modelArg}: 1 expected request, 0 sent.`);
  process.exit(0);
}

if (!process.env.GEMINI_API_KEY?.trim()) {
  console.error('ASR execute aborted: GEMINI_API_KEY is absent. No transcription request was sent.');
  process.exit(78);
}
if (!audioArg || !expectedArg) {
  throw new Error('--audio and --expected are required for execute mode.');
}

const audio = await readFile(audioArg);
const expected = await readFile(expectedArg, 'utf8');
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelArg)}:generateContent`;
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
  body: JSON.stringify({
    contents: [{
      parts: [
        { text: 'Transcribe this Arabic audio verbatim. Return only the spoken words. Do not add commentary.' },
        { inline_data: { mime_type: 'audio/mpeg', data: audio.toString('base64') } },
      ],
    }],
  }),
});
const body = await response.text();
if (response.status === 404) {
  console.error(`ASR model ${modelArg} is not available on this project (HTTP 404). Dual independent ASR cannot be completed with a substitute model.`);
  process.exit(78);
}
if (response.status === 429) {
  console.error(`ASR quota exhausted for ${modelArg} (HTTP 429). Resume later with the same command.`);
  process.exit(75);
}
if (!response.ok) {
  throw new Error(`ASR ${modelArg} failed (${response.status}): ${body.slice(0, 700)}`);
}
let payload;
try { payload = JSON.parse(body); } catch { throw new Error('ASR response is not JSON.'); }
const transcript = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join('\n') || '';
const comparison = compareExactSpokenText(expected, transcript);
const result = {
  ...report,
  status: comparison.passed ? 'passed' : 'failed',
  substitutions: comparison.substitutions,
  deletions: comparison.deletions,
  insertions: comparison.insertions,
  transcript,
  differences: comparison.differences,
};
await mkdir(path.dirname(outputArg), { recursive: true });
await writeFile(outputArg, `${JSON.stringify(result, null, 2)}\n`);
if (!comparison.passed) {
  console.error(`ASR ${modelArg} failed exact match: S=${comparison.substitutions} D=${comparison.deletions} I=${comparison.insertions}`);
  process.exit(1);
}
console.log(`ASR ${modelArg} exact match 0/0/0.`);
