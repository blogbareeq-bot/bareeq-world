import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();

function fail(message) {
  const error = new Error(message);
  error.code = 'BAREEQ_AUDIO_STATE_INCONSISTENT';
  throw error;
}

export function validateAudioState({ status, strategy, marker, classification, freeze }) {
  if (!status || status.schema !== 'bareeq.audio-progressive-status.v2') fail('missing/unsupported progressive status');
  const rows = Array.isArray(status.rows) ? status.rows : [];
  if (rows.length !== 15) fail(`status must contain 15 rows, got ${rows.length}`);
  const ids = new Set(rows.map((row) => row.articleId));
  if (ids.size !== 15) fail('status article ids are not unique');

  const exactRows = rows.filter((row) => row.exact === true);
  const publishedRows = rows.filter((row) => row.publishedExact === true);
  const fallbackRows = rows.filter((row) => row.publishedExact !== true);
  if (exactRows.length !== Number(status.exactCount)) fail(`exactCount mismatch: rows=${exactRows.length} status=${status.exactCount}`);
  if (publishedRows.length !== Number(status.publishedCount)) fail(`publishedCount mismatch: rows=${publishedRows.length} status=${status.publishedCount}`);
  if (fallbackRows.length !== Number(status.fallbackCount)) fail(`fallbackCount mismatch: rows=${fallbackRows.length} status=${status.fallbackCount}`);
  if (Number(status.publishedCount) + Number(status.fallbackCount) !== 15) fail('published + fallback must equal 15');
  if (publishedRows.some((row) => row.exact !== true)) fail('publishedExact row is not exact');

  if (!marker || !Array.isArray(marker.articles) || !Array.isArray(marker.fallbacks)) fail('partial publication marker malformed');
  if (marker.articles.length !== Number(status.publishedCount)) fail('marker published count differs from status');
  if (marker.fallbacks.length !== Number(status.fallbackCount)) fail('marker fallback count differs from status');

  const byId = new Map(rows.map((row) => [row.articleId, row]));
  for (const item of marker.articles) {
    const row = byId.get(item.articleId);
    if (!row?.publishedExact) fail(`marker article not publishedExact in status: ${item.articleId}`);
    if (item.fingerprint !== row.fingerprint) fail(`fingerprint mismatch for ${item.articleId}`);
    if (item.fullSha256 !== row.fullSha256) fail(`full SHA mismatch for ${item.articleId}`);
  }
  for (const item of marker.fallbacks) {
    const row = byId.get(item.articleId);
    if (!row || row.publishedExact === true) fail(`marker fallback disagrees with status: ${item.articleId}`);
  }

  if (!strategy || strategy.schema !== 'bareeq.audio-engine-strategy.v1') fail('engine strategy missing/unsupported');
  if (Number(strategy.exactBaseline) !== Number(status.exactCount)) fail(`strategy exactBaseline ${strategy.exactBaseline} != status exactCount ${status.exactCount}`);
  if (Number(strategy.successfulTtsSinceLastNewExact) < 0 || Number(strategy.threshold) < 1) fail('invalid strategy counters');
  if (Number(strategy.successfulTtsSinceLastNewExact) > Number(strategy.threshold) && strategy.status !== 'paused-for-engine-review') {
    fail('strategy exceeds threshold without engine-review pause');
  }

  if (classification) {
    const crows = Array.isArray(classification.rows) ? classification.rows : [];
    if (crows.length !== 15 || new Set(crows.map((row) => row.articleId)).size !== 15) fail('classification must contain 15 unique rows');
    for (const row of crows) {
      if (row.baselineScore != null && Number(row.baselineScore) < 0) fail(`invalid baseline score for ${row.articleId}`);
      if (row.rejectedScore != null && Number(row.rejectedScore) < 0) fail(`invalid rejected score for ${row.articleId}`);
    }
  }

  if (freeze?.active === true) {
    const snapshot = freeze.strategySnapshot || {};
    if (Number(snapshot.successfulTtsSinceLastNewExact) !== Number(strategy.successfulTtsSinceLastNewExact)) fail('freeze strategy counter drift');
    if (Number(snapshot.threshold) !== Number(strategy.threshold)) fail('freeze threshold drift');
  }

  return {
    exact: exactRows.length,
    published: publishedRows.length,
    fallback: fallbackRows.length,
    strategy: `${strategy.successfulTtsSinceLastNewExact}/${strategy.threshold}`,
  };
}

async function readJson(rel) {
  return JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
}

async function cli() {
  const result = validateAudioState({
    status: await readJson('docs/audio/PROGRESSIVE-STATUS.json'),
    strategy: await readJson('docs/audio/ENGINE-STRATEGY-STATE.json'),
    marker: await readJson('docs/audio/PUBLISHED-SADALTAGER-PARTIAL-20260903.json'),
    classification: await readJson('docs/audio/PHASE-1-CLASSIFICATION.json'),
    freeze: await readJson('docs/audio/TTS-FREEZE.json'),
  });
  console.log(`AUDIO_STATE_CONSISTENCY=PASS exact=${result.exact}/15 published=${result.published}/15 fallback=${result.fallback} strategy=${result.strategy}`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await cli();
