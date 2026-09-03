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
import { audioKeyFor, liveAudioDir } from './audio-constants.mjs';

const encoder = new TextEncoder();

function spokenFingerprint(script) {
  const spoken = (script?.segments ?? []).map((segment) => segment.spokenText).join('\n');
  return {
    spokenChars: [...spoken].length,
    spokenBytes: encoder.encode(spoken).length,
    spokenSha256: sha256(spoken),
  };
}

async function readJsonSafe(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

const emptyAsr = () => ({
  first: { model: 'gemini-3.5-transcribe', substitutions: null, deletions: null, insertions: null, status: 'not-run' },
  second: { model: 'gemini-3.6-flash', substitutions: null, deletions: null, insertions: null, status: 'not-run' },
});

export function bindObservedCandidate({ candidates = [], liveFingerprint = null, liveFilesMatch = false }) {
  const published = candidates.find((item) => {
    const fp = item.fingerprint || item.publishRecord?.fingerprint || item.publishRecord?.candidateFingerprint;
    return Boolean(liveFingerprint)
      && liveFilesMatch
      && fp === liveFingerprint
      && item.publishRecord
      && (item.publishRecord.status === 'published' || item.publishRecord.fingerprint === liveFingerprint || item.publishRecord.candidateFingerprint === liveFingerprint);
  }) || null;
  return {
    published: Boolean(published),
    boundFingerprint: published?.fingerprint || null,
    latestBySha: null,
    note: published
      ? 'published because live manifest fingerprint matches publish-record and live files'
      : 'not published; ledger does not pick the latest candidate SHA',
  };
}

export async function observeArticleArtifacts(articleId, root, script) {
  const base = {
    generated: false,
    asrReports: [],
    asr: emptyAsr(),
    humanListening: { status: 'not-performed', reviewer: '', reviewedAt: '', result: 'pending' },
    technical: { status: 'pending', report: null },
    sync: { status: 'pending' },
    technicalStatus: 'pending',
    syncStatus: 'pending',
    candidateFingerprint: null,
    fullSha256: null,
    parts: [],
    candidates: [],
    liveSnapshots: [],
    published: false,
    liveFingerprint: null,
  };
  const parent = path.join(root, 'audio-candidates', articleId);
  let names = [];
  try { names = (await readdir(parent, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { names = []; }

  const liveDir = liveAudioDir(articleId, root);
  const liveManifest = await readJsonSafe(path.join(liveDir, 'manifest.json'));
  const liveFiles = [];
  if (liveManifest) {
    for (const part of liveManifest.parts || []) {
      const asset = part.audio?.[liveManifest.defaultVoice];
      if (!asset?.src) {
        liveFiles.push({ missing: 'src' });
        continue;
      }
      const file = path.join(root, 'public', asset.src.replace(/^\//, ''));
      try {
        const bytes = await readFile(file);
        liveFiles.push({ sha256: sha256(bytes), bytes: bytes.length });
      } catch {
        liveFiles.push({ missing: asset.src });
      }
    }
  }
  const liveFingerprint = liveManifest?.fingerprint || liveManifest?.candidateFingerprint || liveManifest?.publishedFromCandidate || null;
  const liveFilesMatch = Boolean(liveManifest) && liveFiles.length > 0 && liveFiles.every((item) => !item.missing);

  const candidates = [];
  const liveSnapshots = [];
  for (const name of names) {
    const dir = path.join(parent, name);
    const snapshot = await readJsonSafe(path.join(dir, 'live-snapshot.json'));
    const validate = await readJsonSafe(path.join(dir, 'reports', 'validate.json'));
    const technical = await readJsonSafe(path.join(dir, 'reports', 'technical-qa.json'));
    const sync = await readJsonSafe(path.join(dir, 'reports', 'sync.json'));
    const asrFirst = await readJsonSafe(path.join(dir, 'reports', 'asr-gemini-3.5-transcribe.json'));
    const asrSecond = await readJsonSafe(path.join(dir, 'reports', 'asr-gemini-3.6-flash.json'));
    const listening = await readJsonSafe(path.join(dir, 'reports', 'human-listening.json'));
    const generation = await readJsonSafe(path.join(dir, 'generation-report.json'));
    const candidate = await readJsonSafe(path.join(dir, 'manifest.candidate.json'));
    const publishRecord = await readJsonSafe(path.join(dir, 'reports', 'publish-record.json'));
    const fingerprint = validate?.candidateFingerprint
      || generation?.candidateFingerprint
      || candidate?.candidateFingerprint
      || publishRecord?.candidateFingerprint
      || (snapshot ? snapshot.candidateFingerprint : null)
      || name;
    const entry = {
      name,
      dir,
      fingerprint,
      kind: snapshot ? 'live-snapshot' : 'generated',
      snapshot,
      validate,
      generation,
      technical,
      sync,
      asrFirst,
      asrSecond,
      listening,
      candidate,
      publishRecord,
    };
    if (snapshot) liveSnapshots.push(entry);
    else candidates.push(entry);
  }

  const bound = bindObservedCandidate({
    candidates: [...candidates, ...liveSnapshots.filter((item) => item.publishRecord)],
    liveFingerprint,
    liveFileFingerprint: liveFingerprint,
  });

  const chosen = bound.published
    ? [...candidates, ...liveSnapshots].find((item) => item.fingerprint === bound.boundFingerprint)
    : null;

  if (!chosen) {
    return {
      ...base,
      candidates: candidates.map((item) => ({ fingerprint: item.fingerprint, kind: item.kind })),
      liveSnapshots: liveSnapshots.map((item) => ({ fingerprint: item.fingerprint, certified: item.snapshot?.certified === true })),
      liveFingerprint,
      published: false,
      generated: candidates.some((item) => item.generation || item.validate),
      speechScriptHash: script?.scriptHash ?? null,
    };
  }

  const asrReports = [chosen.asrFirst, chosen.asrSecond].filter(Boolean);
  return {
    generated: Boolean(chosen.generation || chosen.validate),
    asrReports,
    asr: {
      first: chosen.asrFirst ? {
        model: chosen.asrFirst.requestedModel || chosen.asrFirst.model,
        substitutions: chosen.asrFirst.substitutions,
        deletions: chosen.asrFirst.deletions,
        insertions: chosen.asrFirst.insertions,
        status: chosen.asrFirst.status,
      } : emptyAsr().first,
      second: chosen.asrSecond ? {
        model: chosen.asrSecond.requestedModel || chosen.asrSecond.model,
        substitutions: chosen.asrSecond.substitutions,
        deletions: chosen.asrSecond.deletions,
        insertions: chosen.asrSecond.insertions,
        status: chosen.asrSecond.status,
      } : emptyAsr().second,
    },
    humanListening: chosen.listening || { status: 'not-performed', reviewer: '', reviewedAt: '', result: 'pending' },
    technical: { status: chosen.technical?.passed ? 'passed' : chosen.technical ? 'failed' : 'pending', report: chosen.technical },
    sync: { status: chosen.sync?.passed ? 'passed' : chosen.sync ? 'failed' : 'pending' },
    technicalStatus: chosen.technical?.passed ? 'passed' : 'pending',
    syncStatus: chosen.sync?.passed ? 'passed' : 'pending',
    candidateFingerprint: bound.boundFingerprint,
    fullSha256: chosen.validate?.fullSha256 || chosen.candidate?.fullSha256 || liveManifest?.fullSha256 || null,
    speechScriptHash: script?.scriptHash ?? null,
    parts: chosen.candidate?.parts || liveManifest?.parts || [],
    candidates: candidates.map((item) => ({ fingerprint: item.fingerprint, kind: item.kind })),
    liveSnapshots: liveSnapshots.map((item) => ({ fingerprint: item.fingerprint, certified: item.snapshot?.certified === true })),
    liveFingerprint,
    published: bound.published,
  };
}

export async function buildAudioInventory(root, { liveSnapshotPath } = {}) {
  const snapshotPath = liveSnapshotPath || path.join(root, 'docs', 'audio', 'LIVE-AUDIO-OBSERVED-20260828.json');
  const rules = await readAmbiguityRules(root);
  const live = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const liveById = new Map((live.articles || []).map((item) => [item.articleId, item]));
  const files = (await readdir(path.join(root, 'src', 'content', 'posts'))).filter((name) => name.endsWith('.md')).sort();
  const articles = [];

  for (const filename of files) {
    const articleId = filename.replace(/\.md$/, '');
    const source = await readFile(path.join(root, 'src', 'content', 'posts', filename), 'utf8');
    const model = extractArticleSpeechModel({ articleId, source, filename });
    if (model.draft) continue;
    const script = await readSpeechScript(articleId, root);
    const plan = await readTestClipPlan(articleId, root);
    const validation = validateSpeechScript(model, script, rules, { requireReviews: false });
    const testClipEvidenceVerified = await verifyTestClipEvidence(plan, root);
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
    const observed = await observeArticleArtifacts(articleId, root, script);
    const asrPassed = observed.asr.first.status === 'passed'
      && observed.asr.second.status === 'passed'
      && Number(observed.asr.first.substitutions) === 0
      && Number(observed.asr.second.substitutions) === 0
      && Number(observed.asr.first.deletions) === 0
      && Number(observed.asr.second.deletions) === 0
      && Number(observed.asr.first.insertions) === 0
      && Number(observed.asr.second.insertions) === 0;
    const humanApproved = observed.humanListening.status === 'passed';
    const technicalPassed = observed.technicalStatus === 'passed' && observed.syncStatus === 'passed';
    const publishable = generation.passed && observed.generated && asrPassed && humanApproved && technicalPassed;
    const stage = currentStage({
      textReady: validation.approved,
      generationAuthorized: generation.passed,
      generated: observed.generated,
      asrPassed,
      humanApproved,
      technicalPassed,
      publishable,
      published: observed.published === true,
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
      asr: observed.asr,
      humanListening: observed.humanListening,
      technical: observed.technical,
      sync: observed.sync,
      candidateFingerprint: observed.candidateFingerprint,
      fullSha256: observed.fullSha256,
      speechScriptHash: script?.scriptHash ?? null,
      parts: observed.parts,
      candidates: observed.candidates,
      liveSnapshots: observed.liveSnapshots,
      published: observed.published,
      liveFingerprint: observed.liveFingerprint,
      preview: { url: `https://bareeqworld.com/posts/${encodeURIComponent(articleId)}/`, status: 'live-site-has-current-audio' },
      production: {
        url: liveAudio?.liveUrl || null,
        fingerprint: observed.published ? observed.liveFingerprint : null,
        spokenSha256: spoken.spokenSha256,
        status: observed.published ? 'published-fingerprint-matched' : (liveAudio ? 'live-audio-present-uncertified' : 'missing'),
      },
      rollback: liveAudio ? `keep current ${liveAudio.voiceId} manifest ${liveAudio.audioKey}` : 'none',
      status: observed.published ? 'published' : (liveClass.reusablePrimary ? 'pending' : liveClass.class === 'live-fallback' ? 'blocked' : 'pending'),
      nextAction: observed.published
        ? 'Published fingerprint matches live manifest. Keep rollback.'
        : liveClass.reusablePrimary
          ? 'Reuse live Sadaltager. Run dual ASR + human listening + technical QA before certification.'
          : generation.passed
            ? 'Generate Sadaltager candidate with locked gemini-3.1-flash-tts-preview / Sadaltager settings; keep live Hamed until publishable.'
            : `Unblock text/generation first: ${generation.reasons.join('; ')}`,
      stage,
      reusePrimary: liveClass.reusablePrimary,
    });
  }

  return {
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
      asrCertified: articles.filter((item) => item.asr.first.status === 'passed' && item.asr.second.status === 'passed').length,
      humanApproved: articles.filter((item) => item.humanListening.status === 'passed').length,
      publishable: articles.filter((item) => item.stage === 'publishable').length,
      published: articles.filter((item) => item.published).length,
    },
    articles,
  };
}

const isCli = process.argv[1] && path.basename(process.argv[1]) === 'audio-inventory.mjs';
if (isCli) {
  const ROOT = process.cwd();
  const OUT_DIR = path.join(ROOT, 'docs', 'audio');
  const snapshot = await buildAudioInventory(ROOT);
  const articles = snapshot.articles;
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
      candidateFingerprint: item.candidateFingerprint,
      fullSha256: item.fullSha256,
      speechScriptHash: item.speechScriptHash,
      parts: item.parts,
      candidates: item.candidates,
      liveSnapshots: item.liveSnapshots,
      published: item.published,
      liveFingerprint: item.liveFingerprint,
      status: item.status,
      next: item.nextAction,
      stage: item.stage,
    })),
  }, null, 2)}\n`);

  const cell = (value) => (value == null || value === '' ? 'pending' : String(value));
  const rows = articles.map((item) => `| \`${item.articleId}\` | ${item.previousVoice?.voiceId || 'missing'} | ${item.textReady ? 'yes' : 'no'} | ${item.generationAuthorized ? 'yes' : 'no'} | ${item.reusePrimary ? 'reuse live' : (item.candidateFingerprint ? 'candidate' : 'generate candidate')} | ${cell(item.asr.first.status)} | ${cell(item.asr.second.status)} | ${cell(item.humanListening.status)} | ${cell(item.technical.status)} | ${cell(item.sync.status)} | ${item.stage} | ${item.status} | ${item.nextAction} |`).join('\n');
  await writeFile(path.join(OUT_DIR, 'COMPLETENESS.md'), `# Bareeq audio completeness

Generated: ${snapshot.generatedAt}

Primary narrator: Gemini \`${PRODUCTION_NARRATOR.model}\` / Sadaltager.
Fallback only: Azure Hamed or Fahed. Live Hamed remains until a candidate is publishable.

| article | previous voice | text_ready | generation_authorized | generated | ASR 3.5 | ASR 3.6 | human listening | technical | sync | stage | status | next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

Counts: ${snapshot.counts.articles} articles; text_ready ${snapshot.counts.textReady}; generation_authorized ${snapshot.counts.generationAuthorized}; live Sadaltager ${snapshot.counts.liveSadaltager}; live Hamed ${snapshot.counts.liveFallback}; publishable ${snapshot.counts.publishable}; published ${snapshot.counts.published}.

Human listening is not stamped passed. Dual ASR has not been run. Do not treat a green GitHub Action as production-complete. Ledger does not pick the latest candidate SHA. Published only when the live manifest fingerprint matches the publish record.
`);

  console.log(`Audio truth snapshot: ${snapshot.counts.articles} articles; text_ready ${snapshot.counts.textReady}; generation_authorized ${snapshot.counts.generationAuthorized}; live Sadaltager ${snapshot.counts.liveSadaltager}; live Hamed ${snapshot.counts.liveFallback}; published ${snapshot.counts.published}.`);
  console.log('No TTS or ASR requests were sent.');
}
