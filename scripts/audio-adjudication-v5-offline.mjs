import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adjudicateDualAsr, ADJUDICATION_POLICY_VERSION } from './audio-dual-asr-adjudicate.mjs';
import { loadSpokenArticle } from './audio-split.mjs';
import { sha256 } from './audio-constants.mjs';

const EXCLUDED = new Set(['اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع']);

function arg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function score(consensus = {}) {
  return ['substitutions','deletions','insertions','unresolved']
    .reduce((sum, key) => sum + (Number(consensus[key]) || 0), 0);
}

export async function runOfflineAdjudicationV5({
  artifactRoot,
  repoRoot = process.cwd(),
}) {
  const status = await readJson(path.join(artifactRoot, 'docs', 'audio', 'PROGRESSIVE-STATUS.json'));
  const active = (status.rows || []).filter((row) => row.exact !== true && !EXCLUDED.has(row.articleId));
  if (active.length !== 7) throw new Error(`expected 7 active pending articles, found ${active.length}`);

  const rows = [];
  for (const row of active) {
    const fingerprint = row.fingerprint;
    const dir = path.join(artifactRoot, 'audio-candidates', row.articleId, fingerprint);
    const fullPath = path.join(dir, 'full.mp3');
    const reportsDir = path.join(dir, 'reports');
    const existing = await readJson(path.join(reportsDir, 'asr-adjudication.json'));
    const models = Array.isArray(existing.models) ? existing.models : [];
    if (models.length !== 2 || new Set(models).size !== 2) {
      throw new Error(`${row.articleId}: stored adjudication does not bind exactly two independent models`);
    }

    const fullBytes = await readFile(fullPath);
    const fullSha256 = sha256(fullBytes);
    const reports = [];
    for (const model of models) {
      const report = await readJson(path.join(reportsDir, `asr-${model}.json`));
      const reportModel = report.requestedModel || report.model;
      if (reportModel !== model) throw new Error(`${row.articleId}: model identity mismatch for ${model}`);
      if ((report.candidateFingerprint || report.fingerprint) !== fingerprint) {
        throw new Error(`${row.articleId}: fingerprint mismatch in ${model}`);
      }
      if (report.fullSha256 !== fullSha256) {
        throw new Error(`${row.articleId}: full SHA mismatch in ${model}`);
      }
      reports.push(report);
    }

    const article = await loadSpokenArticle(row.articleId, repoRoot);
    const result = adjudicateDualAsr({
      expectedText: article.spokenText,
      reports,
      articleId: row.articleId,
      fingerprint,
      fullSha256,
      models,
    });

    rows.push({
      articleId: row.articleId,
      title: row.title,
      fingerprint,
      fullSha256,
      models,
      baseline: {
        substitutions: row.substitutions,
        deletions: row.deletions,
        insertions: row.insertions,
        unresolved: row.unresolved,
        score: score(row),
      },
      v5: {
        substitutions: result.consensus.substitutions,
        deletions: result.consensus.deletions,
        insertions: result.consensus.insertions,
        unresolved: result.consensus.unresolved,
        score: score(result.consensus),
        exact: result.passed,
        representationOnly: result.representationOnly.length,
        modelDisagreements: result.modelDisagreements.length,
      },
    });
  }

  return {
    schema: 'bareeq.audio-adjudication-v5-offline.v1',
    adjudicationPolicyVersion: ADJUDICATION_POLICY_VERSION,
    generatedAt: new Date().toISOString(),
    sourceRunId: status.sourceRunId,
    activePendingCount: rows.length,
    newlyExactWithoutTts: rows.filter((row) => row.v5.exact).length,
    excluded: [...EXCLUDED],
    rows,
    ttsCalls: 0,
  };
}

export function markdown(result) {
  const lines = result.rows.map((row) =>
    `- **${row.title}** — baseline=${row.baseline.score}, v5=${row.v5.score}, exact=${row.v5.exact ? 'yes' : 'no'}, representationOnly=${row.v5.representationOnly}, disagreements=${row.v5.modelDisagreements}`
  ).join('\n');
  return `# Adjudication v5 — Offline replay

- Policy version: **${result.adjudicationPolicyVersion}**
- Source run: **${result.sourceRunId || 'n/a'}**
- Active pending: **${result.activePendingCount}**
- Newly Exact without TTS: **${result.newlyExactWithoutTts}**
- TTS calls: **0**
- Excluded/frozen: \`${result.excluded.join(', ')}\`

## Results

${lines}

## Decision

This pass reuses immutable raw ASR evidence and the current spoken text. It does not mutate synthesis text, fingerprints, candidate audio, or publication state.

${result.newlyExactWithoutTts > 0
  ? 'One or more candidates became Exact by stricter offline interpretation only; each must still pass the unchanged publication identity/QA gates before publication.'
  : 'No additional candidate became Exact. Gate 3 therefore exhausts the currently approved representation-equivalence rules without spending synthesis quota.'}
`;
}

async function cli() {
  const artifactRoot = path.resolve(arg('root', 'adjudication-input'));
  const outJson = path.resolve(arg('out-json', 'adjudication-output/ADJUDICATION-V5.json'));
  const outMd = path.resolve(arg('out-md', 'adjudication-output/ADJUDICATION-V5.md'));
  const result = await runOfflineAdjudicationV5({ artifactRoot });
  await mkdir(path.dirname(outJson), { recursive: true });
  await mkdir(path.dirname(outMd), { recursive: true });
  await writeFile(outJson, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(outMd, markdown(result));
  console.log(`ADJUDICATION_V5 active=${result.activePendingCount} newlyExact=${result.newlyExactWithoutTts} ttsCalls=0`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await cli();
