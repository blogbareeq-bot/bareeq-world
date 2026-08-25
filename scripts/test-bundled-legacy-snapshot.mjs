import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Regression test: the bundled Azure Hamed Legacy snapshot must be completely
// independent of the parent build environment.
//
// After PR #6 (Arabic Speech Script quality gate) merged, production runs with
// BAREEQ_TTS_PROVIDER=gemini. The bundled importer inherited that state into
// its `generate-audio.mjs --speech-qa-json` child, which switched the segment
// plan to the reviewed Speech Script path (79 segments for
// altadakhom-explained-simply instead of the locked 84 legacy segments) and
// changed the source snapshot hash, producing the false
// "article text/order changed after the approved Hamed recording" production
// failure.
//
// This test runs the importer read-only (--audit --audit-json) under four
// hostile parent environments (bundled/gemini/azure/google-cloud plus dirty
// TTS state such as cache flags, include ids, contract-test endpoints, budget
// traps and dummy API keys) and proves that all four produce identical:
//   - article IDs,
//   - segment counts,
//   - segment order,
//   - source snapshot hashes,
// that altadakhom-explained-simply remains exactly Hamed's original lock
// (a417c9ff02fcc9eb3363c7002cd7c51f7d67f8eee94c45d683db26e409152537), that
// every non-stale locked article matches its lock, and that the whole run
// sends 0 TTS requests and never writes to public/audio.

const ROOT = process.cwd();
const ALTADAKHOM = 'altadakhom-explained-simply';
const ALTADAKHOM_LOCKED_SNAPSHOT = 'a417c9ff02fcc9eb3363c7002cd7c51f7d67f8eee94c45d683db26e409152537';
const ALTADAKHOM_LOCKED_SEGMENT_COUNT = 84;
const PARENT_PROVIDERS = ['bundled', 'gemini', 'azure', 'google-cloud'];
const LOCK_FILE = path.join(ROOT, 'scripts', 'bundled-azure-audio-map.json');

const fail = (message) => { throw new Error(`Bundled legacy snapshot regression failed: ${message}`); };

// --- Canary server: counts any request that leaks through sanitization ------
const canaryRequests = [];
const canary = createServer((request, response) => {
  canaryRequests.push(`${request.method} ${request.url}`);
  response.writeHead(204).end();
});
await new Promise((resolve, reject) => {
  canary.once('error', reject);
  canary.listen(0, '127.0.0.1', resolve);
});
const canaryAddress = canary.address();
if (!canaryAddress?.port) throw new Error('Could not bind the local canary server.');

try {
  // --- Derive the production stale-fallback skip list -----------------------
  // The Cloudflare build runs the importer with BAREEQ_BUNDLED_SKIP_IDS taken
  // from run-v4211-audio.mjs. Derive it from that file (the source of truth)
  // so this audit mirrors the production pipeline exactly.
  const runnerSource = await readFile(path.join(ROOT, 'scripts', 'run-v4211-audio.mjs'), 'utf8');
  const legacyBlock = runnerSource.match(/const LEGACY_HAMED_CACHE = \[([\s\S]*?)\];/)?.[1] || '';
  const legacyHamedCache = [...legacyBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const coworker = runnerSource.match(/const COWORKER = '([^']+)'/)?.[1];
  if (!legacyHamedCache.length || !coworker) fail('could not derive the stale-fallback skip list from scripts/run-v4211-audio.mjs.');
  const productionSkipIds = [...legacyHamedCache, coworker].join(',');

  const lock = JSON.parse(await readFile(LOCK_FILE, 'utf8'));
  const lockById = new Map(lock.articles.map((article) => [article.articleId, article]));
  if (lockById.get(ALTADAKHOM)?.sourceSnapshotSha256 !== ALTADAKHOM_LOCKED_SNAPSHOT) {
    fail(`the lock file no longer contains Hamed's original snapshot for ${ALTADAKHOM}; refusing to continue.`);
  }

  // --- public/audio snapshot (must be untouched by the read-only audit) -----
  const snapshotAudioTree = () => {
    const entries = new Map();
    const stack = [path.join(ROOT, 'public', 'audio')];
    while (stack.length) {
      const current = stack.pop();
      let items = [];
      try { items = readdirSync(current, { withFileTypes: true }); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      for (const item of items) {
        const full = path.join(current, item.name);
        if (item.isDirectory()) stack.push(full);
        else {
          const stat = statSync(full);
          entries.set(path.relative(ROOT, full), `${stat.size}:${Math.floor(stat.mtimeMs)}`);
        }
      }
    }
    return entries;
  };
  const audioBefore = snapshotAudioTree();

  // --- Hostile parent environment per provider ------------------------------
  const hostileParentEnv = (provider) => ({
    ...process.env,
    BAREEQ_TTS_PROVIDER: provider,
    // Dummy credentials: if any of them reaches a synthesis call the build is
    // already compromised; the canary below detects any leaked HTTP surface.
    GEMINI_API_KEY: 'canary-key-must-never-be-used',
    OPENAI_API_KEY: 'canary-key-must-never-be-used',
    AZURE_SPEECH_KEY: 'canary-key-must-never-be-used',
    GOOGLE_SERVICE_ACCOUNT_JSON: '{"canary":true}',
    // Contract-test endpoints pointed at the canary: a leaked endpoint must
    // show up as a canary request, never as a real provider call.
    BAREEQ_TTS_CONTRACT_TEST: '1',
    GEMINI_TTS_ENDPOINT: `http://127.0.0.1:${canaryAddress.port}/gemini`,
    OPENAI_TTS_ENDPOINT: `http://127.0.0.1:${canaryAddress.port}/openai`,
    // Plan-changing state that must not be inherited:
    BAREEQ_TTS_INCLUDE_IDS: 'definitely-not-a-real-article',
    BAREEQ_TTS_CACHE_ONLY: '1',
    BAREEQ_TTS_CACHE_ALLOW_MISSING: '1',
    BAREEQ_AUDIO_ALLOW_PARTIAL: '1',
    BAREEQ_AUDIO_CACHE_ORIGIN: `http://127.0.0.1:${canaryAddress.port}/cache`,
    BAREEQ_AZURE_HAMED_ONLY: '1',
    AZURE_SPEECH_REGION: 'canary-region',
    BAREEQ_SPEECH_GATE_UNSAFE_TEST_BYPASS: 'I_ACKNOWLEDGE_LOCAL_CONTRACT_ONLY',
    // Dirty traps: inheriting any of these makes the child throw immediately,
    // so a broken sanitizer fails loudly instead of silently changing plans.
    BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD: 'not-a-number',
    BAREEQ_GEMINI_MAX_REQUESTS_PER_BUILD: '0',
    BAREEQ_GEMINI_SYNTHESIS_BUDGET_MS: '0',
    GEMINI_TTS_MAX_REQUEST_BYTES: '50',
    GOOGLE_CLOUD_TTS_MAX_REQUEST_BYTES: '50',
  });

  // --- Run the importer read-only under the four parent providers -----------
  const reports = [];
  for (const provider of PARENT_PROVIDERS) {
    const output = execFileSync(process.execPath, ['scripts/import-bundled-azure-audio.mjs', '--audit', '--audit-json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...hostileParentEnv(provider), BAREEQ_BUNDLED_SKIP_IDS: productionSkipIds },
    });
    let report;
    try { report = JSON.parse(output); }
    catch (error) { fail(`audit JSON is invalid under parent provider ${provider}: ${error.message}`); }
    if (report.schema !== 'bareeq.bundled-azure.audit.v1') fail(`unexpected audit schema under ${provider}: ${report.schema}`);
    if (report.releaseId !== lock.releaseId) fail(`audit release id differs from the lock under ${provider}.`);
    if (report.forcedProvider !== 'bundled') fail(`legacy child provider was not forced to bundled under ${provider}.`);
    if (report.inheritedProvider !== provider) fail(`parent provider ${provider} was not visible to the importer (test would be vacuous).`);
    if (!Array.isArray(report.articles) || report.articles.length !== lock.articles.length) fail(`audit must report all ${lock.articles.length} locked articles under ${provider}.`);
    if (JSON.stringify(report.articles.map((article) => article.articleId)) !== JSON.stringify(lock.articles.map((article) => article.articleId))) {
      fail(`audit article ids/order differ from the lock under ${provider}.`);
    }
    reports.push({ provider, report });
  }

  // --- 1) All four parent environments must produce identical results -------
  const fingerprint = (report) => JSON.stringify(report.articles.map(({ articleId, audioKey, skipped, verified, segmentCount, segmentIds, snapshotSha256, lockedSnapshotSha256, lockMatch, partCount }) =>
    ({ articleId, audioKey, skipped, verified, segmentCount, segmentIds, snapshotSha256, lockedSnapshotSha256, lockMatch, partCount })));
  const fingerprints = reports.map(({ provider, report }) => ({ provider, value: fingerprint(report) }));
  for (const { provider, value } of fingerprints.slice(1)) {
    if (value !== fingerprints[0].value) fail(`parent provider ${provider} produced a different legacy snapshot (article IDs, segment counts, segment order or source snapshot hashes).`);
  }

  const articles = reports[0].report.articles;
  const verified = articles.filter((article) => !article.skipped);
  const skipped = articles.filter((article) => article.skipped);

  // --- 2) The production skip list must match exactly -----------------------
  // The production list may contain ids outside the bundled lock (Studio and
  // non-locked articles); within the locked set the two must agree exactly.
  const expectedSkipped = new Set(productionSkipIds.split(',').filter(Boolean));
  const expectedSkippedInLock = lock.articles.map((article) => article.articleId).filter((id) => expectedSkipped.has(id));
  if (JSON.stringify(skipped.map((article) => article.articleId)) !== JSON.stringify(expectedSkippedInLock)) {
    fail(`skipped articles do not match the production stale-fallback list.`);
  }
  if (verified.length !== lock.articles.length - expectedSkippedInLock.length) fail(`expected ${lock.articles.length - expectedSkippedInLock.length} verified articles, got ${verified.length}.`);

  // --- 3) Every verified article must match its locked Hamed snapshot -------
  for (const article of verified) {
    if (!article.verified) fail(`${article.articleId} was not fully verified.`);
    if (!article.lockMatch || article.snapshotSha256 !== article.lockedSnapshotSha256) fail(`${article.articleId} legacy snapshot no longer matches the locked Hamed snapshot.`);
    if (article.lockedSnapshotSha256 !== lockById.get(article.articleId)?.sourceSnapshotSha256) fail(`${article.articleId} lock metadata drifted from the lock file.`);
    if (!article.segmentIds.length || article.segmentIds.some((id, index) => id !== `b${String(index + 1).padStart(4, '0')}`)) {
      fail(`${article.articleId} segment ids are not the ordered legacy b0001..b${String(article.segmentIds.length).padStart(4, '0')} sequence.`);
    }
  }

  // --- 4) altadakhom-explained-simply must remain Hamed's original lock -----
  const altadakhom = articles.find((article) => article.articleId === ALTADAKHOM);
  if (!altadakhom) fail(`${ALTADAKHOM} is missing from the locked article set.`);
  if (altadakhom.snapshotSha256 !== ALTADAKHOM_LOCKED_SNAPSHOT) {
    fail(`${ALTADAKHOM} snapshot ${altadakhom.snapshotSha256} no longer matches Hamed's original lock ${ALTADAKHOM_LOCKED_SNAPSHOT}.`);
  }
  if (altadakhom.segmentCount !== ALTADAKHOM_LOCKED_SEGMENT_COUNT) {
    fail(`${ALTADAKHOM} legacy segment count is ${altadakhom.segmentCount}, expected the locked ${ALTADAKHOM_LOCKED_SEGMENT_COUNT}.`);
  }

  // --- 5) Zero TTS requests, zero writes to public/audio ---------------------
  if (canaryRequests.length) fail(`the canary received ${canaryRequests.length} request(s) that must never leave the hermetic child: ${canaryRequests.slice(0, 5).join('; ')}`);
  const audioAfter = snapshotAudioTree();
  if (JSON.stringify([...audioBefore.entries()].sort()) !== JSON.stringify([...audioAfter.entries()].sort())) {
    fail('public/audio changed during the read-only audit (files created, removed or modified).');
  }

  console.log(`Bundled legacy snapshot regression passed: 4 parent providers (${PARENT_PROVIDERS.join('/')}) produced identical article IDs, segment counts, segment order and source snapshot hashes; ${verified.length} locked article(s) verified against the Hamed lock (including ${ALTADAKHOM} = ${ALTADAKHOM_LOCKED_SNAPSHOT.slice(0, 12)}…, ${ALTADAKHOM_LOCKED_SEGMENT_COUNT} segments); ${skipped.length} stale fallback(s) skipped as in production; TTS requests = ${canaryRequests.length}; public/audio untouched.`);
} finally {
  await new Promise((resolve) => canary.close(resolve));
}
