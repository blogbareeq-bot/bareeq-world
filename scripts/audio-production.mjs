import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FALLBACK_NARRATOR, INDEPENDENT_ASR_MODELS, PRODUCTION_NARRATOR } from './audio-lifecycle.mjs';

const ROOT = process.cwd();
const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--execute');
const EXECUTE = process.argv.includes('--execute');
const ARTICLE = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length) || '';
const SNAPSHOT = JSON.parse(await readFile(path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json'), 'utf8'));
const OUT = path.join(ROOT, 'docs', 'audio', 'DRY-RUN.json');

function planGemini(articleId) {
  const result = spawnSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      BAREEQ_TTS_PROVIDER: 'gemini',
      BAREEQ_TTS_INCLUDE_IDS: articleId,
      GEMINI_TTS_ENDPOINT: '',
      OPENAI_TTS_ENDPOINT: '',
      BAREEQ_TTS_CONTRACT_TEST: '',
    },
  });
  if (result.status !== 0) {
    return {
      articleId,
      ok: false,
      output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    };
  }
  const line = (result.stdout || '').split('\n').find((item) => item.startsWith(`- ${articleId}:`)) || '';
  const parts = Number(/(\d+) part\(s\)/.exec(line)?.[1] || 0);
  const chars = Number(/(\d+) source chars/.exec(line)?.[1] || 0);
  const allowed = /SYNTHESIS ALLOWED/.test(line);
  return { articleId, ok: true, parts, chars, allowed, line, output: result.stdout };
}

const reusable = SNAPSHOT.articles.filter((item) => item.reusePrimary);
const replace = SNAPSHOT.articles.filter((item) => !item.reusePrimary);
const selected = ARTICLE ? SNAPSHOT.articles.filter((item) => item.articleId === ARTICLE) : SNAPSHOT.articles;
if (ARTICLE && !selected.length) throw new Error(`Unknown article id: ${ARTICLE}`);

const plans = [];
for (const item of selected) {
  if (item.reusePrimary) {
    plans.push({
      articleId: item.articleId,
      action: 'reuse-live-sadaltager',
      ttsRequests: 0,
      asrRequests: INDEPENDENT_ASR_MODELS.length,
      reason: 'Live Gemini/Sadaltager already exists; do not regenerate. Dual ASR still required for certification of the merged file.',
    });
    continue;
  }
  const plan = planGemini(item.articleId);
  plans.push({
    articleId: item.articleId,
    action: 'generate-sadaltager-candidate',
    ttsRequests: plan.parts || null,
    asrRequests: INDEPENDENT_ASR_MODELS.length,
    chars: plan.chars || null,
    generationAuthorized: plan.allowed,
    planLine: plan.line,
    ok: plan.ok,
    error: plan.ok ? null : plan.output.slice(-1500),
  });
}

const ttsRequests = plans.reduce((sum, item) => sum + (item.ttsRequests || 0), 0);
const asrRequests = plans.reduce((sum, item) => sum + (item.asrRequests || 0), 0);
const report = {
  schema: 'bareeq.audio-production-dry-run.v1',
  generatedAt: new Date().toISOString(),
  mode: EXECUTE ? 'execute-requested' : 'dry-run',
  narrator: PRODUCTION_NARRATOR,
  fallback: FALLBACK_NARRATOR,
  lockedSettingsFromAcceptedNine: {
    model: 'gemini-3.1-flash-tts-preview',
    voice: 'Sadaltager',
    language: 'ar',
    style: 'legacy-gemini-style-from-live-manifests',
    maxRequestBytes: 2400,
    generatorVersion: 8,
  },
  reusableSadaltager: reusable.map((item) => item.articleId),
  replaceWithSadaltager: replace.map((item) => item.articleId),
  plans,
  expected: {
    ttsRequests,
    asrRequests,
    asrModels: INDEPENDENT_ASR_MODELS,
    articlesTouched: plans.length,
  },
  quota: {
    geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY?.trim()),
    measuredRemaining: null,
    note: 'Free-tier remaining quota cannot be read without a live API probe. No probe was sent during dry-run.',
  },
  resume: {
    command: 'node scripts/audio-production.mjs --execute --article=<id>',
    afterQuotaExhaustion: 'Re-run the same command. Completed parts in .bareeq-audio-checkpoints/ are reused by fingerprint.',
  },
  executeBlockedUnless: [
    'dry-run has been reviewed',
    'GEMINI_API_KEY is present',
    'only one production audio workflow is running',
    'the targeted article is generation_authorized',
  ],
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Audio production ${report.mode}: reuse ${reusable.length} Sadaltager article(s); replace ${replace.length} Hamed article(s).`);
console.log(`Expected TTS requests: ${ttsRequests}. Expected ASR requests: ${asrRequests} across ${INDEPENDENT_ASR_MODELS.join(' + ')}.`);
for (const item of plans) {
  console.log(`- ${item.articleId}: ${item.action}; TTS ${item.ttsRequests ?? '?'}; ASR ${item.asrRequests}`);
}
if (EXECUTE) {
  if (!ARTICLE) {
    console.error('Execute aborted: --article is required so only one article can consume quota.');
    process.exit(2);
  }
  const target = selected[0];
  if (target.reusePrimary) {
    console.error(`Execute aborted: ${ARTICLE} already has live Sadaltager. Regeneration is forbidden. Run dual ASR against the live merged file instead.`);
    process.exit(2);
  }
  if (!target.generationAuthorized && plans[0]?.generationAuthorized !== true) {
    console.error(`Execute aborted: ${ARTICLE} is not generation_authorized.`);
    process.exit(2);
  }
  if (!process.env.GEMINI_API_KEY?.trim()) {
    console.error('Execute aborted: GEMINI_API_KEY is not present in this environment. Dry-run was saved. No TTS/ASR request was sent.');
    process.exit(78);
  }
  if (process.env.BAREEQ_AUDIO_PRODUCTION_LOCK !== '1') {
    console.error('Execute aborted until BAREEQ_AUDIO_PRODUCTION_LOCK=1 (the single GitHub production workflow). Dry-run was saved. No TTS/ASR request was sent.');
    process.exit(78);
  }
  const result = spawnSync(process.execPath, ['scripts/generate-audio.mjs'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      BAREEQ_TTS_PROVIDER: 'gemini',
      BAREEQ_TTS_INCLUDE_IDS: ARTICLE,
      BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD: '1',
      BAREEQ_CLOUD_TTS_ACTIVATE: '0',
      BAREEQ_GEMINI_FREE_ROLLOUT: '0',
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  process.exit(0);
}
console.log(`Dry-run written to ${path.relative(ROOT, OUT)}. Zero provider requests were sent.`);
