import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUN_ID = '37284619084';
export const ARTICLE_ID = 'كيف-يعرف-الانترنت-ما-الذي-تبحث-عنه-قبل-ان-تكمل-الكتابه';

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function walk(root, current = root, out = []) {
  let entries = [];
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) {
      const info = await stat(full);
      out.push({ full, rel: path.relative(root, full).replaceAll('\\', '/'), size: info.size });
    }
  }
  return out;
}

async function sha256(file) {
  const bytes = await readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

function arg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function targetStatus(status) {
  return Array.isArray(status?.rows) ? status.rows.find((row) => row.articleId === ARTICLE_ID) || null : null;
}

export async function inspectArtifact(root) {
  const files = await walk(root);
  const statusFile = files.find((item) => item.rel === 'docs/audio/PROGRESSIVE-STATUS.json');
  const strategyFile = files.find((item) => item.rel === 'docs/audio/ENGINE-STRATEGY-STATE.json');
  const status = statusFile ? await readJson(statusFile.full, {}) : {};
  const strategy = strategyFile ? await readJson(strategyFile.full, {}) : {};
  const row = targetStatus(status);
  const fingerprint = row?.fingerprint || null;

  const articleNeedle = `audio-candidates/${ARTICLE_ID}/`;
  const targetFiles = files.filter((item) => item.rel.includes(articleNeedle));
  const candidateFiles = fingerprint
    ? targetFiles.filter((item) => item.rel.includes(`/${fingerprint}/`))
    : targetFiles;

  const fullAudio = candidateFiles.filter((item) => /(^|\/)full\.mp3$/i.test(item.rel));
  const audioFiles = candidateFiles.filter((item) => /\.(mp3|wav|pcm)$/i.test(item.rel));
  const trialAudio = candidateFiles.filter((item) =>
    /(?:trial|rejected|replacement)/i.test(item.rel) && /\.(mp3|wav|pcm)$/i.test(item.rel));
  const microPreflight = candidateFiles.filter((item) => /micro-cut-preflight\.json$/i.test(item.rel));
  const requestLogs = candidateFiles.filter((item) => /request-log\.json$/i.test(item.rel));
  const asrEvidence = candidateFiles.filter((item) =>
    /reports\//i.test(item.rel) && /(?:asr|adjudication|consensus|transcript)/i.test(item.rel));

  const targetedRequestEntries = [];
  for (const item of requestLogs) {
    const log = await readJson(item.full, { entries: [] });
    for (const entry of Array.isArray(log?.entries) ? log.entries : []) {
      if (/targeted|segment|micro/i.test(String(entry?.action || ''))) targetedRequestEntries.push(entry);
    }
  }

  const baselineFull = fullAudio[0] || null;
  const baselineFullSha256 = baselineFull && baselineFull.size <= 100 * 1024 * 1024
    ? await sha256(baselineFull.full)
    : null;

  const hasComparableRejectedTrial = trialAudio.length > 0
    || candidateFiles.some((item) => /(?:trial|rejected)[^/]*full\.mp3$/i.test(item.rel));

  const classification = hasComparableRejectedTrial
    ? 'EVIDENCE_AVAILABLE_FOR_DIFFERENTIAL'
    : 'INSUFFICIENT_EVIDENCE';

  const reason = hasComparableRejectedTrial
    ? 'A rejected/trial audio artifact is present and can be compared against the baseline.'
    : 'The retained artifact contains no rejected/trial/replacement audio for the target candidate, so baseline-vs-trial waveform and timestamped ASR differential cannot be reconstructed from this artifact.';

  return {
    schema: 'bareeq.audio-forensics-37284619084.v1',
    runId: RUN_ID,
    articleId: ARTICLE_ID,
    fingerprint,
    statusSnapshot: row ? {
      exact: row.exact,
      publishedExact: row.publishedExact,
      substitutions: row.consensus?.substitutions ?? row.substitutions ?? null,
      deletions: row.consensus?.deletions ?? row.deletions ?? null,
      insertions: row.consensus?.insertions ?? row.insertions ?? null,
      unresolved: row.consensus?.unresolved ?? row.unresolved ?? null,
      baselineScore: row.baselineScore ?? null,
      rejectedScore: row.rejectedScore ?? null,
      latestError: row.latestError ?? null,
    } : null,
    strategySnapshot: {
      exactBaseline: strategy.exactBaseline ?? null,
      successfulTtsSinceLastNewExact: strategy.successfulTtsSinceLastNewExact ?? null,
      threshold: strategy.threshold ?? null,
    },
    evidence: {
      totalArtifactFiles: files.length,
      targetArticleFiles: targetFiles.length,
      targetCandidateFiles: candidateFiles.length,
      audioFiles: audioFiles.map(({ rel, size }) => ({ path: rel, size })),
      fullAudio: fullAudio.map(({ rel, size }) => ({ path: rel, size })),
      baselineFullSha256,
      trialAudio: trialAudio.map(({ rel, size }) => ({ path: rel, size })),
      microPreflightFiles: microPreflight.map(({ rel, size }) => ({ path: rel, size })),
      asrEvidenceFiles: asrEvidence.map(({ rel, size }) => ({ path: rel, size })),
      targetedRequestEntries,
    },
    classification,
    reason,
    ttsRequired: false,
    ttsPermitted: false,
  };
}

export function markdown(result) {
  const e = result.evidence;
  const list = (items) => items.length ? items.map((item) => `- \`${item.path}\` (${item.size} bytes)`).join('\n') : '- None';
  return `# Forensics result — Run ${result.runId}

## Verdict

- Classification: **${result.classification}**
- Article: \`${result.articleId}\`
- Fingerprint: \`${result.fingerprint || 'not-found'}\`
- TTS required: **no**
- TTS permitted: **no**

${result.reason}

## Artifact inventory

- Total files: ${e.totalArtifactFiles}
- Target article files: ${e.targetArticleFiles}
- Target candidate files: ${e.targetCandidateFiles}
- Baseline full SHA-256: \`${e.baselineFullSha256 || 'not-computed'}\`

### Full audio
${list(e.fullAudio)}

### Rejected / trial / replacement audio
${list(e.trialAudio)}

### Micro-preflight evidence
${list(e.microPreflightFiles)}

### ASR evidence
${list(e.asrEvidenceFiles)}

## Request-log evidence

Targeted request entries retained in the post-run artifact: **${e.targetedRequestEntries.length}**.

## Interpretation

If the classification is \`INSUFFICIENT_EVIDENCE\`, the correct next action is **not** to spend another TTS request to recreate the incident. The repair pipeline must first be changed so rejected trials preserve a diagnostic bundle before rollback. Only a later, independently justified experiment may produce new synthesis.

If rejected/trial audio is present, continue with PCM identity checks outside the splice guard band and timestamped ASR differentials before assigning \`ASR_CONTEXT_INSTABILITY\`, \`SPLICE_EFFECT\`, or \`TRUE_TTS_REGRESSION\`.
`;
}

async function cli() {
  const root = path.resolve(arg('root', 'forensics-input'));
  const outJson = path.resolve(arg('out-json', 'forensics-output/FORENSICS-37284619084.json'));
  const outMd = path.resolve(arg('out-md', 'forensics-output/FORENSICS-37284619084.md'));
  const result = await inspectArtifact(root);
  await mkdir(path.dirname(outJson), { recursive: true });
  await mkdir(path.dirname(outMd), { recursive: true });
  await writeFile(outJson, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(outMd, markdown(result));
  console.log(`BAREEQ_FORENSICS classification=${result.classification} targetFiles=${result.evidence.targetCandidateFiles} trialAudio=${result.evidence.trialAudio.length} fullAudio=${result.evidence.fullAudio.length}`);
  if (!result.fingerprint || result.evidence.targetCandidateFiles === 0) process.exitCode = 2;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await cli();
