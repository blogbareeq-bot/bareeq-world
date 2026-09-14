import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const STATUS_FILE = process.env.BAREEQ_STATUS_FILE?.trim() || path.join('docs', 'audio', 'PROGRESSIVE-STATUS.json');

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function exact(row = {}) {
  const consensus = row.validation?.consensus || {};
  return Boolean(
    row.generation?.fingerprint
    && row.validation?.status === 'validated'
    && row.validation?.fingerprint === row.generation.fingerprint
    && ['substitutions', 'deletions', 'insertions', 'unresolved'].every((key) => Number(consensus[key]) === 0)
  );
}

const state = await readJson(path.join('audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json'));
const snapshot = await readJson(path.join('docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json'));
const partial = await readJson(path.join('docs', 'audio', 'PUBLISHED-SADALTAGER-PARTIAL-20260903.json'), { articles: [] });
const final = await readJson(path.join('docs', 'audio', 'PUBLISHED-SADALTAGER-OPENROUTER-20260901.json'), null);
if (!state || !Array.isArray(snapshot?.articles) || snapshot.articles.length !== 15) {
  throw new Error('progressive status requires the 15-article state and truth snapshot');
}

const fullyPublished = state.publicationComplete === true && final?.articleCount === 15;
const publishedIds = fullyPublished
  ? new Set(snapshot.articles.map((item) => item.articleId))
  : new Set((partial.articles || []).map((item) => item.articleId));

const rows = snapshot.articles.map((item) => {
  const row = state.articles?.[item.articleId] || {};
  const generation = row.generation || {};
  const validation = row.validation || {};
  const consensus = validation.consensus || {};
  return {
    articleId: item.articleId,
    title: item.title,
    audioKey: item.audioKey,
    fingerprint: generation.fingerprint || null,
    generationStatus: generation.status || 'missing',
    validationStatus: validation.status || 'not-run',
    substitutions: Number.isFinite(Number(consensus.substitutions)) ? Number(consensus.substitutions) : null,
    deletions: Number.isFinite(Number(consensus.deletions)) ? Number(consensus.deletions) : null,
    insertions: Number.isFinite(Number(consensus.insertions)) ? Number(consensus.insertions) : null,
    unresolved: Number.isFinite(Number(consensus.unresolved)) ? Number(consensus.unresolved) : null,
    exact: exact(row),
    publishedExact: publishedIds.has(item.articleId),
    fullSha256: validation.fullSha256 || null,
    repairedParts: validation.repairedParts || [],
    error: validation.error || null,
  };
});

const exactCount = rows.filter((row) => row.exact).length;
const publishedCount = rows.filter((row) => row.publishedExact).length;
const summary = {
  schema: 'bareeq.audio-progressive-status.v2',
  campaignId: CAMPAIGN_ID,
  sourceRunId: process.env.BAREEQ_SOURCE_RUN_ID || null,
  sourceArtifact: process.env.BAREEQ_SOURCE_ARTIFACT || null,
  generatedAt: new Date().toISOString(),
  publicationComplete: fullyPublished,
  publishedCount,
  fallbackCount: 15 - publishedCount,
  exactCount,
  rows,
};

await mkdir(path.dirname(path.join(ROOT, STATUS_FILE)), { recursive: true });
await writeFile(path.join(ROOT, STATUS_FILE), `${JSON.stringify(summary, null, 2)}\n`);
for (const row of rows) {
  console.log(`PROGRESSIVE_STATUS ${row.articleId} val=${row.validationStatus} sub=${row.substitutions} del=${row.deletions} ins=${row.insertions} un=${row.unresolved} exact=${row.exact} pub=${row.publishedExact}`);
}
console.log(`PROGRESSIVE_STATUS_SUMMARY published=${publishedCount}/15 exact=${exactCount}/15 fallback=${15 - publishedCount}`);
