/**
 * Candidate staleness audit.
 *
 * Recomputes, for every article in the campaign, the candidate fingerprint and
 * split that the *current* code produces, and compares them with what the
 * restored campaign checkpoint actually contains.
 *
 * This answers a gate question directly: "no stale candidate" and
 * "SHA/fingerprint binding" can only pass if the stored candidate is the one
 * current code would produce. Makes no network calls and no TTS requests.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { candidateDir, sha256, GENERATOR_VERSION, PRODUCTION_TTS_MODEL, PRODUCTION_VOICE } from './audio-constants.mjs';
import { candidateFingerprint, loadSpokenArticle, splitSpokenArticle } from './audio-split.mjs';

const ROOT = process.cwd();
const STORE = process.env.BAREEQ_AUDIO_STORE || path.join(ROOT, 'audio-candidates');
const CAMPAIGN = process.env.BAREEQ_AUDIO_CAMPAIGN_ID || 'sadaltager-openrouter-20260901-v1';
const OUT = process.env.BAREEQ_AUDIT_OUTPUT || path.join(ROOT, 'docs', 'audio', 'asr-probe', 'candidate-staleness-audit.json');

async function main() {
  const report = {
    schema: 'bareeq.candidate-staleness-audit.v1',
    generatedAt: new Date().toISOString(),
    campaignId: CAMPAIGN,
    code: {
      generatorVersion: GENERATOR_VERSION,
      ttsModel: PRODUCTION_TTS_MODEL,
      voice: PRODUCTION_VOICE,
    },
    note: 'Read-only audit. No network calls, no TTS.',
    articles: [],
    summary: {},
  };

  const statePath = path.join(STORE, '_campaigns', CAMPAIGN, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  report.stateGenerationComplete = state.generationComplete === true;
  report.statePublicationComplete = state.publicationComplete === true;
  report.stateArticleCount = Object.keys(state.articles || {}).length;
  report.stateGeneratorVersion = state.generatorVersion ?? null;

  for (const [articleId, record] of Object.entries(state.articles || {})) {
    const stored = record?.generation?.fingerprint || null;
    const entry = { articleId, storedFingerprint: stored };
    try {
      const article = await loadSpokenArticle(articleId, ROOT);
      const plan = splitSpokenArticle(article);
      const expected = candidateFingerprint(article, plan);
      entry.recomputedFingerprint = expected;
      entry.fingerprintMatches = expected === stored;
      entry.recomputedParts = plan.parts.length;
      entry.speechScriptHash = article.speechScriptHash;
      entry.spokenChars = article.spokenChars;

      if (stored) {
        const dir = candidateDir(articleId, stored, ROOT);
        let files = [];
        try {
          files = (await readdir(path.join(dir, 'parts'))).filter((name) => name.endsWith('.mp3'));
        } catch { /* parts dir may be absent */ }
        // A part is only a real part file when it is not a ".clean.mp3" derivative.
        entry.storedPartFiles = files.filter((name) => !name.endsWith('.clean.mp3')).length;
        entry.storedCleanFiles = files.filter((name) => name.endsWith('.clean.mp3')).length;
        entry.partCountMatches = entry.storedPartFiles === plan.parts.length;
        try {
          const full = await readFile(path.join(dir, 'full.mp3'));
          entry.fullSha256 = sha256(full);
          entry.fullBytes = full.length;
        } catch {
          entry.fullSha256 = null;
        }
      }
    } catch (error) {
      entry.error = String(error?.message || error).slice(0, 400);
    }
    report.articles.push(entry);
  }

  report.summary = {
    articles: report.articles.length,
    fingerprintMatches: report.articles.filter((a) => a.fingerprintMatches).length,
    fingerprintMismatches: report.articles.filter((a) => a.fingerprintMatches === false).length,
    partCountMismatches: report.articles.filter((a) => a.partCountMatches === false).length,
    missingFullMp3: report.articles.filter((a) => !a.fullSha256).length,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);

  console.log('--- CANDIDATE STALENESS AUDIT ---');
  for (const entry of report.articles) {
    console.log([
      entry.fingerprintMatches ? 'FRESH' : 'STALE',
      entry.articleId,
      `stored=${(entry.storedFingerprint || '-').slice(0, 12)}`,
      `recomputed=${(entry.recomputedFingerprint || '-').slice(0, 12)}`,
      `parts stored=${entry.storedPartFiles ?? '-'} recomputed=${entry.recomputedParts ?? '-'}`,
    ].join(' '));
  }
  console.log(JSON.stringify(report.summary));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(error?.exitCode || 1);
});
