import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSuccessfulTts } from './audio-engine-strategy-guard.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const STATUS_FILE = process.env.BAREEQ_STATUS_FILE?.trim() || path.join('docs', 'audio', 'PROGRESSIVE-STATUS.json');
const SESSION_STARTED_AT = process.env.BAREEQ_REPAIR_SESSION_STARTED_AT || null;
const SOURCE_RUN_ID = process.env.BAREEQ_SOURCE_RUN_ID || null;
const PROVIDER_CREDENTIAL_VERIFIED = process.env.BAREEQ_PROVIDER_CREDENTIAL_VERIFIED === '1';
const LOG_ARG = process.argv.find((arg) => arg.startsWith('--log='));
const SESSION_LOG_PATH = process.env.BAREEQ_REPAIR_SESSION_LOG || LOG_ARG?.slice('--log='.length) || null;
const EXCLUDED_ARTICLES = new Set(['اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع']);

const output = {
  phase0: path.join(ROOT, 'docs', 'audio', 'PHASE-0-READINESS.md'),
  classification: path.join(ROOT, 'docs', 'audio', 'PHASE-1-CLASSIFICATION.json'),
  repairLog: path.join(ROOT, 'docs', 'audio', 'REPAIR-LOG.json'),
  session: path.join(ROOT, 'docs', 'audio', 'REPAIR-SESSION-LATEST.md'),
  final: path.join(ROOT, 'docs', 'audio', 'FINAL-COMPLETION-REPORT.md'),
};

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
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

function consensus(row = {}) {
  const value = row.validation?.consensus || {};
  const normalized = {
    substitutions: Number.isFinite(Number(value.substitutions)) ? Number(value.substitutions) : null,
    deletions: Number.isFinite(Number(value.deletions)) ? Number(value.deletions) : null,
    insertions: Number.isFinite(Number(value.insertions)) ? Number(value.insertions) : null,
    unresolved: Number.isFinite(Number(value.unresolved)) ? Number(value.unresolved) : null,
  };
  const parts = Object.values(normalized);
  normalized.totalErrors = parts.every((item) => item !== null)
    ? parts.reduce((sum, item) => sum + item, 0)
    : null;
  return normalized;
}

async function requestLogFor(articleId, fingerprint) {
  if (!fingerprint) return [];
  const file = path.join(ROOT, 'audio-candidates', articleId, fingerprint, 'request-log.json');
  const log = await readJson(file, { entries: [] });
  return Array.isArray(log?.entries) ? log.entries : [];
}

function isoMillis(value) {
  const number = Date.parse(value || '');
  return Number.isFinite(number) ? number : null;
}

const statePath = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');
const snapshotPath = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');
const state = await readJson(statePath);
const snapshot = await readJson(snapshotPath);
const status = await readJson(path.join(ROOT, STATUS_FILE));
if (!state?.generationComplete || !Array.isArray(snapshot?.articles) || snapshot.articles.length !== 15 || !status) {
  throw new Error('repair reporting requires generation-complete state, truth snapshot, and progressive status');
}

const publishedIds = new Set((status.rows || []).filter((row) => row.publishedExact).map((row) => row.articleId));
const classificationRows = [];
const repairEntries = [];
for (const item of snapshot.articles) {
  const row = state.articles?.[item.articleId] || {};
  const c = consensus(row);
  const isExact = exact(row);
  const fingerprint = row.generation?.fingerprint || null;
  const logs = await requestLogFor(item.articleId, fingerprint);
  classificationRows.push({
    articleId: item.articleId,
    title: item.title,
    fingerprint,
    generationStatus: row.generation?.status || 'missing',
    validationStatus: row.validation?.status || 'not-run',
    ...c,
    exact: isExact,
    publishedExact: publishedIds.has(item.articleId),
    repairedParts: row.validation?.repairedParts || [],
    repairInProgress: row.validation?.repairInProgress === true,
    baselineScore: Number.isFinite(Number(row.validation?.baselineScore)) ? Number(row.validation.baselineScore) : null,
    acceptedScore: Number.isFinite(Number(row.validation?.acceptedScore)) ? Number(row.validation.acceptedScore) : null,
    rejectedScore: Number.isFinite(Number(row.validation?.rejectedScore)) ? Number(row.validation.rejectedScore) : null,
    latestError: row.validation?.error || null,
    estimatedTtsCharsNeeded: null,
    estimateNote: isExact ? 'none; already exact' : 'calculated at repair time from the targeted sentence/paragraph; no whole-article estimate is fabricated',
    fallbackActive: !publishedIds.has(item.articleId),
    excludedFromCurrentCampaign: EXCLUDED_ARTICLES.has(item.articleId),
  });
  for (const [index, entry] of logs.entries()) {
    repairEntries.push({
      articleId: item.articleId,
      fingerprint,
      requestIndex: index + 1,
      ...entry,
    });
  }
}

const pending = classificationRows
  .filter((row) => !row.exact && !row.excludedFromCurrentCampaign)
  .sort((a, b) => (a.totalErrors ?? Number.MAX_SAFE_INTEGER) - (b.totalErrors ?? Number.MAX_SAFE_INTEGER)
    || a.articleId.localeCompare(b.articleId, 'ar'));
const excludedRows = classificationRows.filter((row) => !row.exact && row.excludedFromCurrentCampaign);
const exactRows = classificationRows.filter((row) => row.exact);
const ordered = [...pending, ...excludedRows, ...exactRows.sort((a, b) => a.articleId.localeCompare(b.articleId, 'ar'))];

const generatedAt = new Date().toISOString();
const classification = {
  schema: 'bareeq.audio-phase-1-classification.v1',
  campaignId: CAMPAIGN_ID,
  generatedAt,
  rule: 'seven active pending candidates are classified before repair; intentionally excluded articles remain frozen outside the current completion campaign',
  exactGate: { substitutions: 0, deletions: 0, insertions: 0, unresolved: 0 },
  provider: 'Google Gemini API / Sadaltager (current repair provider; campaign id retains historical OpenRouter naming)',
  rows: ordered,
};

repairEntries.sort((a, b) => (isoMillis(a.at) ?? 0) - (isoMillis(b.at) ?? 0));
const repairLog = {
  schema: 'bareeq.audio-repair-log.v1',
  campaignId: CAMPAIGN_ID,
  generatedAt,
  sourceRunId: SOURCE_RUN_ID,
  entries: repairEntries,
};

const sessionStartMs = isoMillis(SESSION_STARTED_AT);
const sessionEntries = sessionStartMs === null
  ? []
  : repairEntries.filter((entry) => (isoMillis(entry.at) ?? 0) >= sessionStartMs);
const requestLogProviderCalls = sessionEntries.reduce((sum, entry) => sum + (Number(entry.providerCalls) || 0), 0);
const workflowLogText = SESSION_LOG_PATH ? await readFile(SESSION_LOG_PATH, 'utf8').catch(() => '') : '';
const workflowSuccessfulTts = parseSuccessfulTts(workflowLogText);
const sessionProviderCalls = Math.max(requestLogProviderCalls, workflowSuccessfulTts);
const sessionChars = sessionEntries.reduce((sum, entry) => sum + (Number(entry.chars) || Number(entry.textChars) || 0), 0);

await mkdir(path.dirname(output.phase0), { recursive: true });
const phase0 = `# Audio completion — Phase 0 readiness\n\n- Generated: ${generatedAt}\n- Campaign: \`${CAMPAIGN_ID}\`\n- Existing production provider: **Google Gemini API / Sadaltager**\n- Provider credential verified in this workflow: **${PROVIDER_CREDENTIAL_VERIFIED ? 'yes' : 'not attested'}**\n- Generation checkpoint: **${state.generationComplete === true ? '15/15 complete' : 'not complete'}**\n- Exact publication gate: **0 substitutions / 0 deletions / 0 insertions / 0 unresolved**\n- Production safety: existing exact audio remains immutable; rejected trials restore baseline.\n- Google Cloud TTS migration from the supplied plan: **not applied**. The live campaign is fingerprinted and voiced for Gemini/Sadaltager; silently switching providers would invalidate the campaign identity and successful audio.\n\n## Gate\n\n**${PROVIDER_CREDENTIAL_VERIFIED && state.generationComplete === true ? 'PASS for the existing production campaign.' : 'BLOCKED until the production credential/checkpoint gate passes.'}**\n`;
await writeFile(output.phase0, phase0);
await writeFile(output.classification, `${JSON.stringify(classification, null, 2)}\n`);
await writeFile(output.repairLog, `${JSON.stringify(repairLog, null, 2)}\n`);

const pendingLines = pending.length
  ? pending.map((row, index) => `${index + 1}. ${row.title} — errors=${row.totalErrors ?? 'unknown'}; validation=${row.validationStatus}`).join('\n')
  : 'None.';
const excludedLines = excludedRows.length
  ? excludedRows.map((row) => `- ${row.title} — EXCLUDED/FROZEN; fallback remains active`).join('\n')
  : 'None.';
const sessionReport = `# تقرير جلسة الإصلاح — ${generatedAt.slice(0, 10)}\n\n## ملخص\n- Run: ${SOURCE_RUN_ID || 'n/a'}\n- بداية الجلسة: ${SESSION_STARTED_AT || 'n/a'}\n- مقالات Exact: **${status.exactCount}/15**\n- مقالات منشورة Exact: **${status.publishedCount}/15**\n- مقالات على fallback: **${status.fallbackCount}**\n- طلبات المزود المسجلة في هذه الجلسة: **${sessionProviderCalls}**\n- مصدر عداد الجلسة: **max(request-log calls, progressive workflow summary)**\n- أحرف TTS المسجلة صراحة في request logs: **${sessionChars}**\n\n## المقالات النشطة المتبقية (7 كحد أقصى)\n${pendingLines}\n\n## مستبعد من الحملة الحالية\n${excludedLines}\n\n## قواعد الجلسة\n- لا نشر دون 0/0/0/0 + Technical QA + sync/fingerprint gates.\n- أي trial مرفوض يعود إلى baseline ولا يعاد فورًا في الجولة نفسها.\n- لا إعادة توليد للمقالات Exact.\n`;
await writeFile(output.session, sessionReport);

if (status.publicationComplete === true && status.exactCount === 15 && status.publishedCount === 15) {
  const finalReport = `# FINAL COMPLETION REPORT\n\n- Completed: ${generatedAt}\n- Campaign: \`${CAMPAIGN_ID}\`\n- Exact published articles: **15/15**\n- Fallback articles: **0**\n- Quality gate: **0 substitutions / 0 deletions / 0 insertions / 0 unresolved** for every published article.\n- Durable repair log entries: **${repairEntries.length}**\n\n## Lessons retained\n- Classify the backlog before spending TTS quota.\n- Repair the smallest safe synchronized unit.\n- Treat representation-only ASR differences offline.\n- Reject regressions and restore baseline atomically.\n- Spread scarce stochastic TTS attempts across near-exact candidates.\n`;
  await writeFile(output.final, finalReport);
}

console.log(`REPAIR_REPORT classification=${classificationRows.length} pending=${pending.length} exact=${status.exactCount}/15 published=${status.publishedCount}/15 sessionCalls=${sessionProviderCalls} logEntries=${repairEntries.length}`);
