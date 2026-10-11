import {tranche42OverrideAuthorized} from './audio-tranche42-policy.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {tranche40OverrideAuthorized} from './audio-tranche40-authorization.mjs';
import { tranche33OverrideAuthorized } from './audio-tranche33-authorization.mjs';

export const FREEZE_PATH = path.join(process.cwd(), 'docs', 'audio', 'TTS-FREEZE.json');
export const GATE5_AUTH_PATH = path.join(process.cwd(), 'docs', 'audio', 'GATE-5-AUTHORIZATION.json');
export const NEW_CONTENT_TEST_CLIP_AUTH_PATH = path.join(process.cwd(), 'docs', 'audio', 'NEW-CONTENT-TEST-CLIP-AUTHORIZATION.json');
export const NEW_CONTENT_FULL_AUTH_PATH = path.join(process.cwd(), 'docs', 'audio', 'NEW-CONTENT-FULL-SYNTHESIS-AUTHORIZATION.json');
export const NEW_CONTENT_FULL_PREFLIGHT_PATH = path.join(process.cwd(), 'docs', 'audio', 'NEW-CONTENT-FULL-SYNTHESIS-PREFLIGHT.json');
const newContentFullAttempts = new Map();

export async function gate5OverrideAuthorized({
  authorizationFile = GATE5_AUTH_PATH,
  operation = 'tts-synthesis',
  env = process.env,
} = {}) {
  if (env.BAREEQ_GATE5_AUTHORIZED !== '1') return null;
  if (!/^gemini-(?:interactions|generate-content)-tts$/.test(operation)) return null;
  const auth = JSON.parse(await readFile(authorizationFile, 'utf8'));
  const ok = auth?.schema === 'bareeq.audio-gate5-authorization.v1'
    && auth.authorizationStatus === 'AUTHORIZED'
    && Number(auth.successfulTtsRequestsAuthorized) === 1
    && Number(auth.successfulTtsRequestsRequired) === 1
    && auth.targetArticleId === env.BAREEQ_GATE5_TARGET_ARTICLE
    && auth.decisionId === env.BAREEQ_GATE5_DECISION_ID
    && auth.targetCaseId === 'T03'
    && Number(auth.targetPartNumber) === 4
    && auth.targetSegmentId === 'b0030'
    && auth.expectedToken === 'لا';
  return ok ? auth : null;
}


export async function newContentTestClipOverrideAuthorized({
  authorizationFile = NEW_CONTENT_TEST_CLIP_AUTH_PATH,
  operation = 'tts-synthesis',
  env = process.env,
} = {}) {
  if (env.BAREEQ_NEW_CONTENT_TEST_CLIP_AUTHORIZED !== '1') return null;
  if (operation !== 'gemini-interactions-tts') return null;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_RUN_ATTEMPT !== '1') return null;
  const auth = JSON.parse(await readFile(authorizationFile, 'utf8'));
  const ok = auth?.schema === 'bareeq.audio-new-content-test-clip-authorization.v1'
    && auth.authorizationStatus === 'AUTHORIZED'
    && auth.decisionId === env.BAREEQ_NEW_CONTENT_TEST_CLIP_DECISION_ID
    && auth.targetArticleId === env.BAREEQ_NEW_CONTENT_TEST_CLIP_ARTICLE
    && auth.speechScriptHash === env.BAREEQ_NEW_CONTENT_TEST_CLIP_SCRIPT_HASH
    && auth.testClipPlanHash === env.BAREEQ_NEW_CONTENT_TEST_CLIP_PLAN_HASH
    && auth.provider === 'gemini-interactions'
    && auth.model === 'gemini-3.1-flash-tts-preview'
    && auth.voice === 'Sadaltager'
    && Number(auth.successfulTtsRequestsAuthorized) === 1
    && Number(auth.successfulTtsRequestsConsumed) === 0
    && Number(auth.providerAttemptsAuthorized) === 1
    && Number(auth.providerAttemptsConsumed) === 1
    && auth.automaticRetry === false
    && auth.publicationAuthorized === false
    && auth.fullArticleSynthesisAuthorized === false
    && auth.legacyRenewalAuthorized === false
    && auth.freezeRemainsActive === true;
  return ok ? auth : null;
}


export async function newContentFullSynthesisOverrideAuthorized({
  authorizationFile = NEW_CONTENT_FULL_AUTH_PATH,
  preflightFile = NEW_CONTENT_FULL_PREFLIGHT_PATH,
  operation = 'tts-synthesis',
  context = null,
  env = process.env,
} = {}) {
  if (env.BAREEQ_NEW_CONTENT_FULL_AUTHORIZED !== '1') return null;
  if (operation !== 'gemini-interactions-tts') return null;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_RUN_ATTEMPT !== '1') return null;
  if (!context) return null;
  const [auth, preflight] = await Promise.all([
    readFile(authorizationFile, 'utf8').then(JSON.parse),
    readFile(preflightFile, 'utf8').then(JSON.parse),
  ]);
  const allowed = Array.isArray(auth.allowedPartIndexes) ? auth.allowedPartIndexes.map(Number) : [];
  const ok = auth?.schema === 'bareeq.audio-new-content-full-synthesis-authorization.v1'
    && auth.authorizationStatus === 'EXECUTING'
    && auth.decisionId === env.BAREEQ_NEW_CONTENT_FULL_DECISION_ID
    && auth.targetArticleId === env.BAREEQ_NEW_CONTENT_FULL_ARTICLE
    && auth.speechScriptHash === env.BAREEQ_NEW_CONTENT_FULL_SCRIPT_HASH
    && auth.testClipPlanHash === env.BAREEQ_NEW_CONTENT_FULL_PLAN_HASH
    && auth.candidateFingerprint === env.BAREEQ_NEW_CONTENT_FULL_FINGERPRINT
    && auth.provider === 'gemini-interactions'
    && auth.model === 'gemini-3.1-flash-tts-preview'
    && auth.voice === 'Sadaltager'
    && Number(auth.successfulTtsRequestsAuthorized) === 8
    && Number(auth.providerAttemptsAuthorized) === 8
    && Number(auth.successfulTtsRequestsConsumed) === 0
    && Number(auth.providerAttemptsConsumed) === 0
    && auth.automaticRetry === false
    && auth.validationAfterGeneration === true
    && auth.publicationAuthorized === false
    && auth.legacyRenewalAuthorized === false
    && auth.freezeRemainsActive === true
    && allowed.length === 8
    && allowed.every((value, index) => value === index)
    && preflight?.schema === 'bareeq.audio-new-content-full-synthesis-preflight.v1'
    && preflight.status === 'READY_FOR_BOUNDED_FULL_SYNTHESIS_AUTHORIZATION'
    && preflight.articleId === auth.targetArticleId
    && preflight.speechScriptHash === auth.speechScriptHash
    && preflight.testClipPlanHash === auth.testClipPlanHash
    && preflight.candidateFingerprint === auth.candidateFingerprint
    && Number(preflight.successfulTtsRequestsRequired) === 8
    && Number(preflight.providerAttemptsMaximum) === 8
    && preflight.automaticRetry === false
    && preflight.publish === false
    && context.articleId === auth.targetArticleId
    && context.speechScriptHash === auth.speechScriptHash
    && Number(context.partCount) === 8
    && allowed.includes(Number(context.partIndex));
  if (!ok) return null;
  const key = `${env.GITHUB_RUN_ID || 'no-run'}:${auth.decisionId}`;
  const used = Number(newContentFullAttempts.get(key) || 0);
  if (used >= 8) throw new Error('New-content full synthesis attempt budget exhausted');
  if (Number(context.partIndex) !== allowed[used]) {
    throw new Error(`New-content full synthesis out-of-order part: expected ${allowed[used]}, received ${context.partIndex}`);
  }
  newContentFullAttempts.set(key, used + 1);
  return { ...auth, attemptNumber: used + 1, partIndex: Number(context.partIndex) };
}

export async function readTtsFreeze(file = FREEZE_PATH) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  if (raw?.schema !== 'bareeq.audio-tts-freeze.v1') {
    throw new Error(`unsupported TTS freeze schema: ${raw?.schema || 'missing'}`);
  }
  return raw;
}

export async function ttsIsFrozen(file = FREEZE_PATH) {
  const state = await readTtsFreeze(file);
  return state.active === true;
}

export async function assertTtsUnfrozen({ file = FREEZE_PATH, operation = 'tts-synthesis', tranche33Context, tranche40Context, tranche42Context, newContentFullContext, text } = {}) {
  const state = await readTtsFreeze(file);
  if (state.active === true) {
    const authorized42=await tranche42OverrideAuthorized({operation,context:tranche42Context,text});
    if(authorized42){console.error(`BAREEQ_TRANCHE42_OVERRIDE=AUTHORIZED request=${authorized42.requestId} maxHttpAttempts=1`);return {...state,tranche42Authorization:authorized42};}
    const fullNewContent = await newContentFullSynthesisOverrideAuthorized({ operation, context: newContentFullContext });
    if (fullNewContent) {
      console.error(`BAREEQ_NEW_CONTENT_FULL_OVERRIDE=AUTHORIZED decision=${fullNewContent.decisionId} target=${fullNewContent.targetArticleId} part=${fullNewContent.partIndex + 1}/8 attempt=${fullNewContent.attemptNumber}/8`);
      return { ...state, newContentFullAuthorization: fullNewContent };
    }
    const testClip = await newContentTestClipOverrideAuthorized({ operation });
    if (testClip) {
      console.error(`BAREEQ_NEW_CONTENT_TEST_CLIP_OVERRIDE=AUTHORIZED decision=${testClip.decisionId} target=${testClip.targetArticleId} successfulRequests=1 attempts=1`);
      return { ...state, newContentTestClipAuthorization: testClip };
    }
    const authorized40=await tranche40OverrideAuthorized({operation,context:tranche40Context,text});
    if(authorized40){console.error(`BAREEQ_TRANCHE40_OVERRIDE=AUTHORIZED decision=${authorized40.decisionId} target=${authorized40.requestId} maxHttpAttempts=1`);return {...state,tranche40Authorization:authorized40};}
    const tranche = await tranche33OverrideAuthorized({operation, context:tranche33Context, text});
    if(tranche){
      console.error(`BAREEQ_TRANCHE33_OVERRIDE=AUTHORIZED decision=${tranche.decisionId} target=${tranche.targetArticleId} maxHttpAttempts=1`);
      return {...state,tranche33Authorization:tranche};
    }
    const override = await gate5OverrideAuthorized({ operation });
    if (override) {
      console.error(`BAREEQ_TTS_GATE5_OVERRIDE=AUTHORIZED decision=${override.decisionId} target=${override.targetArticleId} successfulRequests=1`);
      return { ...state, gate5Override: true, gate5Authorization: override };
    }
    const error = new Error(`BAREEQ_TTS_FROZEN operation=${operation} reason=${state.reason || 'policy'}`);
    error.code = 'BAREEQ_TTS_FROZEN';
    error.exitCode = 78;
    throw error;
  }
  return state;
}

async function cli() {
  const state = await readTtsFreeze();
  if (process.argv.includes('--expect-frozen')) {
    if (state.active !== true) throw new Error('expected repository TTS freeze to be active');
    console.log(`BAREEQ_TTS_FREEZE=ACTIVE sourceRun=${state.sourceRunId || 'n/a'} strategy=${state.strategySnapshot?.successfulTtsSinceLastNewExact ?? 'n/a'}/${state.strategySnapshot?.threshold ?? 'n/a'}`);
    return;
  }
  if (process.argv.includes('--require-unfrozen')) {
    if (state.active === true) {
      console.error(`BAREEQ_TTS_FREEZE=BLOCKED reason=${state.reason || 'policy'}`);
      process.exitCode = 78;
      return;
    }
    console.log('BAREEQ_TTS_FREEZE=INACTIVE');
    return;
  }
  console.log(JSON.stringify(state, null, 2));
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await cli();

