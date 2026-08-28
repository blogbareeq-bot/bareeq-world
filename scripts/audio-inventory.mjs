import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  extractArticleSpeechModel,
  readAmbiguityRules,
  readSpeechScript,
  readTestClipPlan,
  sha256,
  validateSpeechScript,
  verifyTestClipEvidence,
} from './speech-script-core.mjs';
import { evaluateGenerationAuthorization, classifyLiveAudio, currentStage, PRODUCTION_NARRATOR, FALLBACK_NARRATOR } from './audio-lifecycle.mjs';

const ROOT = process.cwd();
const LIVE_SNAPSHOT = path.join(ROOT, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json');
const OUT_DIR = path.join(ROOT, 'docs', 'audio');
const encoder = new TextEncoder();

function audioKeyFor(id) {
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}

function spokenFingerprint(script) {
  const spoken = (script?.segments ?? []).map((segment) => segment.spokenText).join('\n');
  return {
    spokenChars: [...spoken].length,
    spokenBytes: encoder.encode(spoken).length,
    spokenSha256: sha256(spoken),
  };
}

const rules = await readAmbiguityRules(ROOT);
const live = JSON.parse(await readFile(LIVE_SNAPSHOT, 'utf8'));
const liveById = new Map((live.articles || []).map((item) => [item.articleId, item]));
const files = (await readdir(path.join(ROOT, 'src', 'content', 'posts'))).filter((name) => name.endsWith('.md')).sort();
const articles = [];

for (const filename of files) {
  const articleId = filename.replace(/\.md$/, '');
  const source = await readFile(path.join(ROOT, 'src', 'content', 'posts', filename), 'utf8');
  const model = extractArticleSpeechModel({ articleId, source, filename });
  if (model.draft) continue;
  const script = await readSpeechScript(articleId, ROOT);
  const plan = await readTestClipPlan(articleId, ROOT);
  const validation = validateSpeechScript(model, script, rules, { requireReviews: false });
  const testClipEvidenceVerified = await verifyTestClipEvidence(plan, ROOT);
  const post = {
    id: articleId,
    speechApproval: { validation, script, testClipPlan: plan, testClipEvidenceVerified },
  };
  const generation = evaluateGenerationAuthorization(post);
  const liveAudio = liveById.get(articleId) || null;
  const liveClass = classifyLiveAudio(liveAudio ? {
    provider: liveAudio.provider,
    model: liveAudio.model,
    defaultVoice: liveAudio.voiceId,
  } : null);
  const spoken = spokenFingerprint(script);
  const record = {
    generated: Boolean(liveClass.reusablePrimary),
    provider: liveAudio?.provider,
    model: liveAudio?.model,
    voiceId: liveAudio?.voiceId,
    asrReports: [],
    humanListening: { status: 'not-performed' },
    technicalStatus: 'pending',
    syncStatus: 'pending',
  };
  const stage = currentStage({
    textReady: validation.approved,
    generationAuthorized: generation.passed,
    generated: record.generated,
    asrPassed: false,
    humanApproved: false,
    technicalPassed: false,
    publishable: false,
    published: false,
  });
  articles.push({
    articleId,
    title: model.title,
    slug: articleId,
    audioKey: audioKeyFor(articleId),
    textReady: validation.approved,
    generationAuthorized: generation.passed,
    generationBlockers: generation.reasons,
    spoken,
    previousVoice: liveAudio ? {
      provider: liveAudio.provider,
      model: liveAudio.model,
      voiceId: liveAudio.voiceId,
      durationSeconds: liveAudio.durationSeconds,
      liveUrl: liveAudio.liveUrl,
      class: liveClass.class,
    } : null,
    finalVoice: liveClass.reusablePrimary ? {
      provider: PRODUCTION_NARRATOR.provider,
      model: PRODUCTION_NARRATOR.model,
      voiceId: PRODUCTION_NARRATOR.voiceId,
      version: PRODUCTION_NARRATOR.model,
    } : null,
    asr: {
      first: { model: 'gemini-3.5-transcribe', substitutions: null, deletions: null, insertions: null, status: 'not-run' },
      second: { model: 'gemini-3.6-transcribe', substitutions: null, deletions: null, insertions: null, status: 'not-run' },
    },
    humanListening: { status: 'not-performed', reviewer: '', reviewedAt: '', result: 'pending' },
    technical: { status: 'pending', report: null },
    sync: { status: 'pending' },
    preview: { url: `https://bareeqworld.com/posts/${encodeURIComponent(articleId)}/`, status: 'live-site-has-current-audio' },
    production: { url: liveAudio?.liveUrl || null, fingerprint: spoken.spokenSha256, status: liveAudio ? 'live-audio-present' : 'missing' },
    rollback: liveAudio ? `keep current ${liveAudio.voiceId} manifest ${liveAudio.audioKey}` : 'none',
    status: liveClass.reusablePrimary ? 'pending' : liveClass.class === 'live-fallback' ? 'blocked' : 'pending',
    nextAction: liveClass.reusablePrimary
      ? 'Reuse live Sadaltager. Run dual ASR + human listening + technical QA before certification.'
      : generation.passed
        ? 'Generate Sadaltager candidate with locked gemini-3.1-flash-tts-preview / Sadaltager settings; keep live Hamed until publishable.'
        : `Unblock text/generation first: ${generation.reasons.join('; ')}`,
    stage,
    reusePrimary: liveClass.reusablePrimary,
  });
}

const snapshot = {
  schema: 'bareeq.audio-truth.v1',
  generatedAt: new Date().toISOString(),
  narratorPolicy: {
    primary: PRODUCTION_NARRATOR,
    fallback: FALLBACK_NARRATOR,
    conflictingDocumentedDecision: {
      source: 'docs/قرار-وتنفيذ-صوت-فهد-v4.22.0.md on audio/fahed-v4220 dated 2026-08-25',
      claim: 'Azure Fahed as immediate production narrator',
      resolution: 'The 2026-08-28 closure instruction is later and selects Gemini/Sadaltager as primary. No generation of a competing Fahed corpus was started.',
    },
  },
  counts: {
    articles: articles.length,
    textReady: articles.filter((item) => item.textReady).length,
    generationAuthorized: articles.filter((item) => item.generationAuthorized).length,
    liveSadaltager: articles.filter((item) => item.reusePrimary).length,
    liveFallback: articles.filter((item) => item.previousVoice?.voiceId === 'hamed').length,
    asrCertified: 0,
    humanApproved: 0,
    publishable: 0,
  },
  articles,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, 'AUDIO-TRUTH-SNAPSHOT.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
await writeFile(path.join(OUT_DIR, 'AUDIO-CLOSURE-LEDGER.json'), `${JSON.stringify({
  schema: 'bareeq.audio-closure-ledger.v1',
  generatedAt: snapshot.generatedAt,
  articles: articles.map((item) => ({
    article: item.articleId,
    title: item.title,
    slug: item.slug,
    previousVoice: item.previousVoice,
    finalVoice: item.finalVoice,
    spokenFingerprint: item.spoken,
    files: item.previousVoice,
    asrFirst: item.asr.first,
    asrSecond: item.asr.second,
    listening: item.humanListening,
    technical: item.technical,
    sync: item.sync,
    preview: item.preview,
    production: item.production,
    rollback: item.rollback,
    status: item.status,
    next: item.nextAction,
    stage: item.stage,
  })),
}, null, 2)}\n`);

const rows = articles.map((item) => `| \`${item.articleId}\` | ${item.previousVoice?.voiceId || 'missing'} | ${item.textReady ? 'yes' : 'no'} | ${item.generationAuthorized ? 'yes' : 'no'} | ${item.reusePrimary ? 'reuse live' : 'generate candidate'} | not-run | not-run | not-performed | pending | pending | ${item.stage} | ${item.status} | ${item.nextAction} |`).join('\n');
await writeFile(path.join(OUT_DIR, 'COMPLETENESS.md'), `# Bareeq audio completeness

Generated: ${snapshot.generatedAt}

Primary narrator: Gemini \`${PRODUCTION_NARRATOR.model}\` / Sadaltager.
Fallback only: Azure Hamed or Fahed. Live Hamed remains until a candidate is publishable.

| article | previous voice | text_ready | generation_authorized | generated | ASR 3.5 | ASR 3.6 | human listening | technical | sync | stage | status | next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

Counts: ${snapshot.counts.articles} articles; text_ready ${snapshot.counts.textReady}; generation_authorized ${snapshot.counts.generationAuthorized}; live Sadaltager ${snapshot.counts.liveSadaltager}; live Hamed ${snapshot.counts.liveFallback}; publishable ${snapshot.counts.publishable}.

Human listening is not stamped passed. Dual ASR has not been run. Do not treat a green GitHub Action as production-complete.
`);

console.log(`Audio truth snapshot: ${snapshot.counts.articles} articles; text_ready ${snapshot.counts.textReady}; generation_authorized ${snapshot.counts.generationAuthorized}; live Sadaltager ${snapshot.counts.liveSadaltager}; live Hamed ${snapshot.counts.liveFallback}.`);
console.log('No TTS or ASR requests were sent.');
