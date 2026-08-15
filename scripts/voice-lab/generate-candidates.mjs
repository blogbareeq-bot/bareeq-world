import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadVoiceLabEnv, resolveCandidate } from './env.mjs';
import { estimateCandidateCost, providerReadiness, synthesizeCandidate } from './providers.mjs';

const execFile = promisify(execFileCallback);
const ROOT = process.cwd();
const LAB_ROOT = path.join(ROOT, '.voice-lab');
const INPUT_ROOT = path.join(LAB_ROOT, 'input');
const CONFIG_FILE = path.join(ROOT, 'scripts', 'voice-lab', 'candidates.json');
const CASES_FILE = path.join(ROOT, 'scripts', 'voice-lab', 'cases.json');
const GENERATOR = path.join(ROOT, 'scripts', 'generate-audio.mjs');
const PLAN_FILE = path.join(LAB_ROOT, 'generation-plan.json');
const LEDGER_FILE = path.join(LAB_ROOT, 'generation-ledger.json');
const SPEECH_PLAN_FILE = path.join(os.tmpdir(), `bareeq-voice-candidates-plan-${process.pid}.json`);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const exists = async (target) => { try { await access(target); return true; } catch { return false; } };
const codePointLength = (value) => [...String(value)].length;

function parseArguments(argv) {
  const options = { execute: false, allEnabled: false, force: false, candidates: [], maxUsd: null };
  for (const argument of argv) {
    if (argument === '--execute') options.execute = true;
    else if (argument === '--all-enabled') options.allEnabled = true;
    else if (argument === '--force') options.force = true;
    else if (argument.startsWith('--candidate=')) options.candidates.push(argument.slice('--candidate='.length));
    else if (argument.startsWith('--max-usd=')) options.maxUsd = Number(argument.slice('--max-usd='.length));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.maxUsd != null && (!Number.isFinite(options.maxUsd) || options.maxUsd < 0)) throw new Error('--max-usd must be a non-negative number.');
  if (options.allEnabled && options.candidates.length) throw new Error('Use either --all-enabled or --candidate=ID, not both.');
  if (options.execute && !options.allEnabled && !options.candidates.length) {
    throw new Error('Paid generation requires --all-enabled or one or more --candidate=ID selections.');
  }
  return options;
}

function publicCandidate(candidate) {
  return {
    id: candidate.id,
    provider: candidate.provider,
    model: candidate.model,
    voice: candidate.voice,
    language: candidate.language,
    role: candidate.role || '',
  };
}

async function validateAudio(file) {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,channels,sample_rate:format=duration',
    '-of', 'json',
    file,
  ], { maxBuffer: 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const stream = probe.streams?.[0];
  const duration = Number(probe.format?.duration);
  if (!stream?.codec_name || !(Number(stream.channels) >= 1) || !(Number(stream.sample_rate) >= 16000)) {
    throw new Error(`Generated audio is invalid or too low quality: ${path.basename(file)}`);
  }
  if (!Number.isFinite(duration) || duration < 2 || duration > 120) {
    throw new Error(`Generated audio duration ${duration} is outside the safe 2–120 second range.`);
  }
  return { codec: stream.codec_name, channels: Number(stream.channels), sampleRate: Number(stream.sample_rate), durationSeconds: Number(duration.toFixed(3)) };
}

async function retry(operation, label, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (attempt >= attempts || /HTTP (400|401|402|403|404|422)/.test(error.message)) break;
      const delay = 800 * (2 ** (attempt - 1));
      console.warn(`${label}: transient failure, retrying (${attempt}/${attempts})…`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function atomicReplaceDirectory(tempDir, finalDir) {
  const backupDir = `${finalDir}.backup-${process.pid}`;
  await rm(backupDir, { recursive: true, force: true });
  const hadFinal = await exists(finalDir);
  if (hadFinal) await rename(finalDir, backupDir);
  try {
    await rename(tempDir, finalDir);
    await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (hadFinal && await exists(backupDir) && !await exists(finalDir)) await rename(backupDir, finalDir);
    throw error;
  }
}

async function candidateCacheHit(finalDir, fingerprint, cases) {
  const metadataFile = path.join(finalDir, 'candidate.json');
  if (!await exists(metadataFile)) return false;
  let metadata;
  try { metadata = JSON.parse(await readFile(metadataFile, 'utf8')); }
  catch { return false; }
  if (!metadata || metadata.generationFingerprint !== fingerprint) return false;
  for (const item of cases) {
    const generated = metadata.cases?.find((entry) => entry.id === item.id);
    if (!generated?.file || !await exists(path.join(finalDir, generated.file))) return false;
  }
  return true;
}

async function loadLedger() {
  if (!await exists(LEDGER_FILE)) return { schemaVersion: 1, runs: [] };
  const value = JSON.parse(await readFile(LEDGER_FILE, 'utf8'));
  return value?.schemaVersion === 1 && Array.isArray(value.runs) ? value : { schemaVersion: 1, runs: [] };
}

async function appendLedger(run) {
  const ledger = await loadLedger();
  ledger.runs.push(run);
  if (ledger.runs.length > 100) ledger.runs = ledger.runs.slice(-100);
  const temp = `${LEDGER_FILE}.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(ledger, null, 2) + '\n');
  await rename(temp, LEDGER_FILE);
}

const options = parseArguments(process.argv.slice(2));
const env = await loadVoiceLabEnv(ROOT);
const [config, casesConfig] = await Promise.all([
  readFile(CONFIG_FILE, 'utf8').then(JSON.parse),
  readFile(CASES_FILE, 'utf8').then(JSON.parse),
]);
if (config.schemaVersion !== 1 || !Array.isArray(config.candidates)) throw new Error('Voice candidate configuration is invalid.');
if (!Array.isArray(casesConfig.cases) || !casesConfig.cases.length) throw new Error('Voice Lab cases are missing.');

await mkdir(LAB_ROOT, { recursive: true });
try {
  await execFile(process.execPath, [GENERATOR, `--speech-qa-output=${SPEECH_PLAN_FILE}`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
  const speechPlan = JSON.parse(await readFile(SPEECH_PLAN_FILE, 'utf8'));
  const articles = new Map(speechPlan.map((article) => [article.id, article]));
  const cases = casesConfig.cases.map((testCase) => {
    const segment = articles.get(testCase.articleId)?.segments.find((entry) => entry.id === testCase.segmentId);
    if (!segment?.spokenText) throw new Error(`${testCase.id}: canonical speech text is missing.`);
    return {
      ...testCase,
      spokenText: segment.spokenText,
      textSha256: sha256(segment.spokenText),
      style: config.caseStyles?.[testCase.id] || config.caseStyles?.default || config.commonStyle || '',
    };
  });
  const allCandidates = config.candidates.filter((candidate) => candidate.enabled !== false).map((candidate) => resolveCandidate(candidate, env));
  const selectedIds = new Set(options.candidates);
  const selected = options.allEnabled ? allCandidates : options.candidates.length ? allCandidates.filter((candidate) => selectedIds.has(candidate.id)) : allCandidates;
  const unknown = [...selectedIds].filter((id) => !allCandidates.some((candidate) => candidate.id === id));
  if (unknown.length) throw new Error(`Unknown candidate id(s): ${unknown.join(', ')}`);
  if (!selected.length) throw new Error('No voice candidates were selected.');

  const spokenCharacters = cases.reduce((sum, item) => sum + codePointLength(item.spokenText), 0);
  const planCandidates = selected.map((candidate) => {
    const promptCharacters = ['openai', 'google'].includes(candidate.provider)
      ? cases.reduce((sum, item) => sum + codePointLength(item.style), 0)
      : 0;
    const billableCharacters = spokenCharacters + promptCharacters;
    const readiness = providerReadiness(candidate, env);
    const estimate = estimateCandidateCost(candidate, billableCharacters, config.budget?.assumptions, env);
    const fingerprint = sha256(JSON.stringify({
      candidate: publicCandidate(candidate),
      options: candidate.options || {},
      cases: cases.map((item) => ({ id: item.id, textSha256: item.textSha256, style: item.style })),
    }));
    return { candidate: publicCandidate(candidate), readiness, spokenCharacters, promptCharacters, billableCharacters, estimate, fingerprint };
  });
  const maxUsd = options.maxUsd ?? Number(config.budget?.maxUsd ?? 2);
  const maxCharacters = Number(config.budget?.maxCharacters ?? 12000);
  const totalCharacters = planCandidates.reduce((sum, item) => sum + item.billableCharacters, 0);
  const knownCosts = planCandidates.map((item) => item.estimate.usd).filter(Number.isFinite);
  const hasUnknownCost = knownCosts.length !== planCandidates.length;
  const estimatedUsd = hasUnknownCost ? null : knownCosts.reduce((sum, value) => sum + value, 0);
  const blocks = [];
  if (totalCharacters > maxCharacters) blocks.push(`Character guard exceeded: ${totalCharacters} > ${maxCharacters}.`);
  if (hasUnknownCost) blocks.push('At least one selected provider has unknown pricing. Supply its local dashboard rate before execution.');
  if (estimatedUsd != null && estimatedUsd > maxUsd) blocks.push(`Estimated cost guard exceeded: $${estimatedUsd.toFixed(4)} > $${maxUsd.toFixed(2)}.`);
  for (const item of planCandidates) {
    if (!item.readiness.ready) blocks.push(`${item.candidate.id} is missing: ${item.readiness.missing.join(', ')}.`);
  }
  const budgetRatio = estimatedUsd == null || maxUsd === 0 ? null : estimatedUsd / maxUsd;
  const warning = [...(config.budget?.warningThresholds || [0.7, 0.85, 0.95])].sort((a, b) => b - a).find((threshold) => budgetRatio >= threshold) || null;
  const plan = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    mode: options.execute ? 'execute' : 'plan-only',
    pricingReviewedAt: config.pricingReviewedAt || null,
    cases: cases.map((item) => ({ id: item.id, articleId: item.articleId, segmentId: item.segmentId, textSha256: item.textSha256, characters: codePointLength(item.spokenText) })),
    candidates: planCandidates,
    totals: {
      candidates: planCandidates.length,
      requests: planCandidates.length * cases.length,
      billableCharacters: totalCharacters,
      estimatedUsd: estimatedUsd == null ? null : Number(estimatedUsd.toFixed(6)),
      maxUsd,
      maxCharacters,
      budgetWarningThreshold: warning,
    },
    executable: blocks.length === 0,
    blocks,
  };
  await writeFile(PLAN_FILE, JSON.stringify(plan, null, 2) + '\n');
  console.log(`Voice candidate plan: ${plan.totals.candidates} candidate(s), ${plan.totals.requests} request(s), ${plan.totals.billableCharacters} billable character(s).`);
  console.log(`Estimated upper cost: ${estimatedUsd == null ? 'unknown' : `$${estimatedUsd.toFixed(4)}`} / $${maxUsd.toFixed(2)} guard.`);
  for (const item of planCandidates) {
    const status = item.readiness.ready ? 'ready' : `missing ${item.readiness.missing.join(' + ')}`;
    console.log(`- ${item.candidate.id}: ${status}; ${item.estimate.usd == null ? 'unknown cost' : `$${item.estimate.usd.toFixed(4)}`}`);
  }
  if (!options.execute) {
    console.log(`Plan written to ${path.relative(ROOT, PLAN_FILE)}. No provider was contacted and no cost was incurred.`);
    process.exitCode = 0;
  } else {
    if (blocks.length) throw new Error(`Generation is blocked:\n- ${blocks.join('\n- ')}`);
    await mkdir(INPUT_ROOT, { recursive: true });
    for (const planned of planCandidates) {
      const candidate = allCandidates.find((item) => item.id === planned.candidate.id);
      const finalDir = path.join(INPUT_ROOT, candidate.id);
      if (!options.force && await candidateCacheHit(finalDir, planned.fingerprint, cases)) {
        console.log(`${candidate.id}: cache hit; no request sent and no cost incurred.`);
        await appendLedger({ at: new Date().toISOString(), candidateId: candidate.id, fingerprint: planned.fingerprint, status: 'cache-hit', estimatedUsd: 0, requests: 0 });
        continue;
      }
      const tempDir = path.join(LAB_ROOT, `.candidate-${candidate.id}-${process.pid}`);
      await rm(tempDir, { recursive: true, force: true });
      await mkdir(tempDir, { recursive: true });
      const generatedCases = [];
      let totalBytes = 0;
      try {
        for (const testCase of cases) {
          console.log(`${candidate.id}/${testCase.id}: generating…`);
          const result = await retry(() => synthesizeCandidate({
            candidate,
            text: testCase.spokenText,
            style: testCase.style,
            env,
          }), `${candidate.id}/${testCase.id}`);
          if (!Buffer.isBuffer(result.bytes) || result.bytes.byteLength < 1000) throw new Error(`${candidate.id}/${testCase.id}: provider returned empty audio.`);
          const file = `${testCase.id}.${result.extension}`;
          const destination = path.join(tempDir, file);
          await writeFile(destination, result.bytes);
          const probe = await validateAudio(destination);
          totalBytes += result.bytes.byteLength;
          generatedCases.push({
            id: testCase.id,
            file,
            articleId: testCase.articleId,
            segmentId: testCase.segmentId,
            textSha256: testCase.textSha256,
            sha256: sha256(result.bytes),
            bytes: result.bytes.byteLength,
            ...probe,
          });
        }
        const metadata = {
          schemaVersion: 1,
          ...publicCandidate(candidate),
          generatedAt: new Date().toISOString(),
          generationFingerprint: planned.fingerprint,
          pricingReviewedAt: config.pricingReviewedAt || null,
          estimatedUsd: Number(planned.estimate.usd.toFixed(6)),
          sourceFormatPolicy: 'Highest stable provider format retained; Voice Lab performs anonymous final normalization.',
          cases: generatedCases,
        };
        await writeFile(path.join(tempDir, 'candidate.json'), JSON.stringify(metadata, null, 2) + '\n');
        await atomicReplaceDirectory(tempDir, finalDir);
        await appendLedger({
          at: metadata.generatedAt,
          candidateId: candidate.id,
          fingerprint: planned.fingerprint,
          status: 'generated',
          estimatedUsd: metadata.estimatedUsd,
          billableCharacters: planned.billableCharacters,
          requests: cases.length,
          bytes: totalBytes,
        });
        console.log(`${candidate.id}: generated and validated ${generatedCases.length} case(s).`);
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    console.log('Selected voice candidates generated successfully. Run npm run voice:lab:build then npm run voice:lab:check.');
  }
} finally {
  await rm(SPEECH_PLAN_FILE, { force: true }).catch(() => {});
}
