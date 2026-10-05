import { readFile } from 'node:fs/promises';
import { INDEPENDENT_ASR_MODELS, sha256 } from './audio-constants.mjs';
import { assertIndependentAsrModels, compareExactSpokenText } from './audio-exact-match.mjs';
import { uploadAudioFile, transcribeFullAudio } from './audio-asr-transcribe.mjs';
import { deleteUploadedFile } from './audio-files-api.mjs';

export function verifyMicroCutTranscript(expectedText, transcript, failedLocalIndices = []) {
  const comparison = compareExactSpokenText(expectedText, transcript);
  const allowed = new Set(failedLocalIndices);
  // Only the known substitutions may differ. Extra/missing words or other
  // substitutions reject the boundary, before any TTS request is sent.
  return comparison.deletions === 0 && comparison.insertions === 0
    && comparison.differences.every((diff) => diff.type === 'substitution' && allowed.has(diff.expectedIndex));
}

export async function verifyMicroCut({
  audioPath, repair, models = INDEPENDENT_ASR_MODELS,
  apiKey = process.env.GEMINI_API_KEY, fetchImpl = globalThis.fetch,
}) {
  assertIndependentAsrModels(models);
  if (models.length !== 2) throw new Error('Micro cut requires exactly two independent ASR models');
  const bytes = await readFile(audioPath);
  const fullSha256 = sha256(bytes);
  const failedLocalIndices = repair.failedIndices.map((index) => index - repair.tokenStart);
  const uploaded = await uploadAudioFile({ apiKey, bytes, displayName: 'bareeq-micro-cut-preflight.mp3', fetchImpl });
  const reports = [];
  try {
    for (const model of models) {
      let report;
      try {
        report = await transcribeFullAudio({
          model, audioPath, expectedText: repair.text, apiKey, fetchImpl,
          fullSha256, file: uploaded, skipUpload: true,
        });
      } catch (error) {
        if (error.result?.httpStatus !== 200 || !error.result?.transcript) throw error;
        report = error.result;
      }
      reports.push(report);
      if (!verifyMicroCutTranscript(repair.text, report.transcript, failedLocalIndices)) {
        return { passed: false, fullSha256, reports };
      }
    }
    return { passed: reports.length === 2, fullSha256, reports };
  } finally {
    await deleteUploadedFile({ apiKey, name: uploaded.name, fetchImpl });
  }
}
