import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './audio-constants.mjs';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { assertFfmpeg, runCommand } from './audio-ffmpeg.mjs';
import { decodePcm } from './audio-merge.mjs';
import {
  PRODUCTION_LOUDNESS,
  edgeSilenceMs,
  longestInternalSilenceSeconds,
  measureLoudness,
  probeAudio,
} from './audio-technical-qa.mjs';
import { transcribeDualAsr } from './audio-asr-transcribe.mjs';

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function peak(pcm) {
  let max = 0;
  for (let index = 0; index + 1 < pcm.length; index += 2) {
    max = Math.max(max, Math.abs(pcm.readInt16LE(index)));
  }
  return max / 32768;
}

async function findRaw(caseDir, engine) {
  const names = await readdir(caseDir);
  const name = names.find((item) => item.startsWith(`raw-${engine}.`));
  return name ? path.join(caseDir, name) : null;
}

async function normalizeCandidate({ caseDir, engine, ffmpeg }) {
  const source = await findRaw(caseDir, engine);
  if (!source) return null;
  const output = path.join(caseDir, `${engine}.mp3`);
  const result = await runCommand(ffmpeg, [
    '-v', 'error',
    '-i', source,
    '-ac', '1',
    '-ar', '48000',
    '-c:a', 'libmp3lame',
    '-b:a', '96k',
    '-y', output,
  ]);
  if (result.code !== 0) throw new Error(`ffmpeg normalization failed for ${engine}: ${result.stderr}`);
  return output;
}

async function technicalAssessment(file) {
  const bytes = await readFile(file);
  const durationSeconds = mp3DurationSeconds(bytes);
  const probe = await probeAudio(file);
  const loudness = await measureLoudness(file);
  const pcm = await decodePcm(file);
  const peakRatio = peak(pcm);
  const internalSilenceSeconds = longestInternalSilenceSeconds(pcm);
  const edges = edgeSilenceMs(pcm);

  const checks = {
    durationPositive: durationSeconds > 1,
    codecMp3: /mp3|lame/i.test(probe.codec),
    sampleRate48k: probe.sampleRate === 48000,
    mono: /mono/i.test(probe.channelsLabel),
    noClipping: peakRatio < 0.99,
    internalSilence: internalSilenceSeconds <= PRODUCTION_LOUDNESS.maxInternalSilenceSeconds,
    startSilence: edges.startMs <= PRODUCTION_LOUDNESS.silentStartFailMs,
    loudnessMeasured: Number.isFinite(loudness.integratedLufs) && Number.isFinite(loudness.truePeakDbTP),
    loudnessRange: Number.isFinite(loudness.integratedLufs)
      && loudness.integratedLufs >= PRODUCTION_LOUDNESS.integratedMinLufs
      && loudness.integratedLufs <= PRODUCTION_LOUDNESS.integratedMaxLufs,
    truePeak: Number.isFinite(loudness.truePeakDbTP)
      && loudness.truePeakDbTP <= PRODUCTION_LOUDNESS.maxTruePeakDbTP,
  };

  return {
    sha256: sha256(bytes),
    bytes: bytes.length,
    durationSeconds,
    probe,
    loudness: {
      integratedLufs: loudness.integratedLufs,
      truePeakDbTP: loudness.truePeakDbTP,
    },
    peakRatio,
    internalSilenceSeconds,
    edgeSilenceMs: edges,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

function exactAsr(reports) {
  return Array.isArray(reports)
    && reports.length === 2
    && reports.every((report) => report?.status === 'passed'
      && Number(report.substitutions) === 0
      && Number(report.deletions) === 0
      && Number(report.insertions) === 0);
}

const root = process.cwd();
const trialDir = path.resolve(root, argValue('dir', 'audio-acoustic-trials'));
const trial = JSON.parse(await readFile(path.join(trialDir, 'trial-cases.json'), 'utf8'));
const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
const { ffmpeg } = await assertFfmpeg();

const summary = {
  schema: 'bareeq.audio-acoustic-assessment.v1',
  generatedAt: new Date().toISOString(),
  sourceManifestFingerprint: trial.sourceManifestFingerprint,
  publicationAttempted: false,
  publicationLockObserved: process.env.BAREEQ_AUDIO_ENGINE_V2_PUBLISH !== '1',
  asrConfigured: Boolean(apiKey),
  humanListeningRequired: true,
  cases: [],
};

let incomplete = !apiKey;
for (const trialCase of trial.cases) {
  const caseDir = path.join(trialDir, trialCase.caseId);
  const expectedText = (await readFile(path.join(caseDir, 'expected.txt'), 'utf8')).trim();
  const row = {
    caseId: trialCase.caseId,
    syncId: trialCase.syncId,
    expectedText,
    baseline: null,
    candidates: {},
  };

  const baseline = path.join(caseDir, 'sadaltager.mp3');
  row.baseline = {
    engineId: 'gemini',
    voice: 'sadaltager',
    evidence: 'published-production-reference-snippet',
    technical: await technicalAssessment(baseline),
    asr: { status: 'not-repeated', reason: 'baseline is extracted from already-published production Sadaltager audio' },
  };

  for (const engine of ['voxcpm2', 'moss-v15']) {
    let file;
    try {
      file = await normalizeCandidate({ caseDir, engine, ffmpeg });
    } catch (error) {
      row.candidates[engine] = { status: 'generation-output-invalid', error: error.message };
      incomplete = true;
      continue;
    }
    if (!file) {
      row.candidates[engine] = { status: 'generation-missing' };
      incomplete = true;
      continue;
    }

    const technical = await technicalAssessment(file);
    const bytes = await readFile(file);
    const fullSha256 = sha256(bytes);
    const fingerprint = sha256(Buffer.from(`${trialCase.caseId}\0${engine}\0${expectedText}`, 'utf8'));
    let asrReports = [];
    let asrError = null;

    if (apiKey) {
      const reportsDir = path.join(caseDir, 'reports', engine);
      await mkdir(reportsDir, { recursive: true });
      try {
        const dual = await transcribeDualAsr({
          audioPath: file,
          expectedText,
          apiKey,
          reportsDir,
          fingerprint,
          fullSha256,
          article: {
            articleId: `acoustic-${trialCase.caseId}-${engine}`,
            speechScriptHash: sha256(Buffer.from(expectedText, 'utf8')),
          },
        });
        asrReports = dual.asrReports || [];
      } catch (error) {
        asrReports = error?.dual?.asrReports || (error?.result ? [error.result] : []);
        asrError = {
          name: error?.name || 'Error',
          message: String(error?.message || error).slice(0, 1200),
          exitCode: error?.exitCode || null,
          httpStatus: error?.httpStatus || null,
        };
      }
    }

    const asrComplete = asrReports.length === 2;
    if (!asrComplete) incomplete = true;
    const exact = exactAsr(asrReports);
    row.candidates[engine] = {
      status: technical.passed && exact ? 'eligible-for-human-listening' : 'rejected-automatically',
      technical,
      asr: {
        complete: asrComplete,
        exact,
        error: asrError,
        models: asrReports.map((report) => ({
          requestedModel: report.requestedModel || report.model,
          actualResponseModel: report.actualResponseModel || null,
          status: report.status,
          substitutions: report.substitutions,
          deletions: report.deletions,
          insertions: report.insertions,
          transcript: report.transcript || null,
        })),
      },
    };
  }

  summary.cases.push(row);
}

summary.complete = !incomplete;
summary.eligible = summary.cases.flatMap((row) =>
  Object.entries(row.candidates)
    .filter(([, result]) => result.status === 'eligible-for-human-listening')
    .map(([engine]) => ({ caseId: row.caseId, engine }))
);
summary.rejected = summary.cases.flatMap((row) =>
  Object.entries(row.candidates)
    .filter(([, result]) => result.status === 'rejected-automatically')
    .map(([engine]) => ({ caseId: row.caseId, engine }))
);
summary.nextGate = summary.complete
  ? 'Human listening of automatically eligible samples; keep V2 publish lock disabled until that review is explicitly accepted.'
  : 'Trial incomplete; fix generation/ASR evidence and rerun. Do not publish.';

await writeFile(path.join(trialDir, 'assessment.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
  complete: summary.complete,
  eligible: summary.eligible.length,
  rejected: summary.rejected.length,
  nextGate: summary.nextGate,
}, null, 2));

if (!summary.complete) process.exitCode = 1;
