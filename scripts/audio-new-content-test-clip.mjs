import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { synthesizeGeminiPart } from './audio-gemini-tts.mjs';
import { PRODUCTION_TTS_MODEL, PRODUCTION_VOICE, sha256, utf8Bytes } from './audio-constants.mjs';

const ROOT = process.cwd();
const AUTH_FILE = path.join(ROOT, 'docs', 'audio', 'NEW-CONTENT-TEST-CLIP-AUTHORIZATION.json');

function fail(message, exitCode = 78) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

async function loadJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function loadAuthorizedTestClip(root = ROOT) {
  const authFile = path.join(root, 'docs', 'audio', 'NEW-CONTENT-TEST-CLIP-AUTHORIZATION.json');
  const auth = await loadJson(authFile);
  if (auth.schema !== 'bareeq.audio-new-content-test-clip-authorization.v1') fail('unsupported test-clip authorization schema');
  if (auth.authorizationStatus !== 'AUTHORIZED') fail(`test-clip authorization is not active: ${auth.authorizationStatus}`);
  if (auth.successfulTtsRequestsAuthorized !== 1 || auth.successfulTtsRequestsConsumed !== 0) fail('test-clip successful-request budget is not exactly 1 remaining');
  if (auth.providerAttemptsAuthorized !== 1 || auth.providerAttemptsConsumed !== 0) fail('test-clip provider-attempt budget is not exactly 1 remaining');
  if (auth.automaticRetry !== false || auth.publicationAuthorized !== false || auth.fullArticleSynthesisAuthorized !== false || auth.legacyRenewalAuthorized !== false) {
    fail('test-clip authorization scope is broader than allowed');
  }
  if (auth.model !== PRODUCTION_TTS_MODEL || auth.voice !== PRODUCTION_VOICE || auth.provider !== 'gemini-interactions') {
    fail('test-clip provider/model/voice binding mismatch');
  }

  const scriptFile = path.join(root, 'scripts', 'speech-scripts', `${auth.targetArticleId}.json`);
  const planFile = path.join(root, 'scripts', 'speech-test-clips', `${auth.targetArticleId}.json`);
  const speech = await loadJson(scriptFile);
  const plan = await loadJson(planFile);

  if (speech.status !== 'pronunciation-review-passed-test-clip-ready') fail('Speech Script is not test-clip ready');
  if (speech.scriptHash !== auth.speechScriptHash) fail('Speech Script hash no longer matches authorization');
  if (plan.status !== 'ready' || plan.testClipPassed !== false || plan.fullSynthesisAllowed !== false) fail('test clip plan is not in ready/pre-audio state');
  if (plan.planHash !== auth.testClipPlanHash || plan.speechScriptHash !== speech.scriptHash) fail('test clip plan hash no longer matches authorization');
  if (!Array.isArray(plan.selectedSegments) || plan.selectedSegments.length !== 5) fail('test clip must bind exactly five reviewed challenge segments');

  const records = new Map(speech.segments.map((segment) => [segment.segmentId, segment]));
  const selected = plan.selectedSegments.map((item) => {
    const segment = records.get(item.segmentId);
    if (!segment) fail(`selected test segment is missing: ${item.segmentId}`);
    if (segment.linguisticReview?.status !== 'passed' || segment.pronunciationReview?.status !== 'passed') fail(`selected test segment review is not passed: ${item.segmentId}`);
    return { ...item, spokenText: segment.spokenText, type: segment.type };
  });

  const text = selected.map((item) => item.spokenText).join('\n\n');
  const bytes = utf8Bytes(text);
  if (bytes < 100 || bytes > 6500) fail(`test clip text size is outside the bounded one-request envelope: ${bytes} bytes`);

  return { auth, speech, plan, selected, text, bytes, authFile };
}

export async function generateOneShotTestClip({ root = ROOT, apiKey = process.env.GEMINI_API_KEY } = {}) {
  const loaded = await loadAuthorizedTestClip(root);
  const { auth, selected, text, bytes, authFile } = loaded;
  const outDir = path.join(root, 'audio-candidates', '_test-clips', auth.targetArticleId, auth.speechScriptHash);
  await mkdir(outDir, { recursive: true });
  const resultFile = path.join(outDir, 'result.json');
  const audioFile = path.join(outDir, 'test-clip.mp3');

  process.env.BAREEQ_NEW_CONTENT_TEST_CLIP_AUTHORIZED = '1';
  process.env.BAREEQ_NEW_CONTENT_TEST_CLIP_DECISION_ID = auth.decisionId;
  process.env.BAREEQ_NEW_CONTENT_TEST_CLIP_ARTICLE = auth.targetArticleId;
  process.env.BAREEQ_NEW_CONTENT_TEST_CLIP_SCRIPT_HASH = auth.speechScriptHash;
  process.env.BAREEQ_NEW_CONTENT_TEST_CLIP_PLAN_HASH = auth.testClipPlanHash;

  const startedAt = new Date().toISOString();
  auth.providerAttemptsConsumed = 1;
  auth.execution = {
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || 0) || null,
    startedAt,
  };
  await writeFile(authFile, `${JSON.stringify(auth, null, 2)}\n`);

  try {
    const audio = await synthesizeGeminiPart({
      apiKey,
      part: { partIndex: 0, text, syncIds: selected.map((item) => item.segmentId) },
      context: {
        articleTitle: auth.articleTitle,
        partIndex: 0,
        partCount: 1,
        correctionHint: 'Read the approved Arabic exactly as written, including diacritics, names, percentages, and numbers. Do not paraphrase or omit.',
      },
      voice: PRODUCTION_VOICE,
      model: PRODUCTION_TTS_MODEL,
    });
    await writeFile(audioFile, audio);
    const fullSha256 = sha256(audio);
    const completedAt = new Date().toISOString();
    auth.successfulTtsRequestsConsumed = 1;
    auth.authorizationStatus = 'EXECUTED';
    auth.result = {
      status: 'GENERATED_AWAITING_HUMAN_LISTENING',
      completedAt,
      bytes: audio.length,
      sha256: fullSha256,
      selectedSegmentIds: selected.map((item) => item.segmentId),
      spokenTextBytes: bytes,
      artifactPath: path.relative(root, audioFile),
    };
    await writeFile(authFile, `${JSON.stringify(auth, null, 2)}\n`);
    const result = {
      schema: 'bareeq.audio-new-content-test-clip-result.v1',
      decisionId: auth.decisionId,
      articleId: auth.targetArticleId,
      speechScriptHash: auth.speechScriptHash,
      testClipPlanHash: auth.testClipPlanHash,
      provider: auth.provider,
      model: auth.model,
      voice: auth.voice,
      successfulTtsRequestsConsumed: 1,
      providerAttemptsConsumed: 1,
      selectedSegments: selected.map((item) => ({ segmentId: item.segmentId, challenges: item.challenges })),
      spokenTextBytes: bytes,
      audio: { file: path.relative(root, audioFile), sha256: fullSha256, bytes: audio.length },
      status: 'GENERATED_AWAITING_HUMAN_LISTENING',
      completedAt,
    };
    await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    auth.authorizationStatus = error?.httpStatus === 429 ? 'PAUSED_QUOTA_NO_RETRY' : 'FAILED_NO_RETRY';
    auth.result = {
      status: auth.authorizationStatus,
      failedAt: new Date().toISOString(),
      successfulTtsRequestsConsumed: 0,
      providerAttemptsConsumed: 1,
      error: String(error?.message || error).slice(0, 900),
    };
    await writeFile(authFile, `${JSON.stringify(auth, null, 2)}\n`);
    await writeFile(resultFile, `${JSON.stringify({ schema:'bareeq.audio-new-content-test-clip-result.v1', decisionId:auth.decisionId, articleId:auth.targetArticleId, status:auth.authorizationStatus, error:auth.result.error }, null, 2)}\n`);
    throw error;
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
  try {
    const loaded = await loadAuthorizedTestClip();
    if (process.argv.includes('--preflight')) {
      console.log(JSON.stringify({
        status:'AUTHORIZED',
        articleId:loaded.auth.targetArticleId,
        selectedSegments:loaded.selected.map((item) => item.segmentId),
        bytes:loaded.bytes,
        successfulTtsRequestsRemaining:1,
        providerAttemptsRemaining:1,
      }, null, 2));
    } else {
      const result = await generateOneShotTestClip();
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode || 1);
  }
}
