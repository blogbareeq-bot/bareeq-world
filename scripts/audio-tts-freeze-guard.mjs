import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {tranche40OverrideAuthorized} from './audio-tranche40-authorization.mjs';
import { tranche33OverrideAuthorized } from './audio-tranche33-authorization.mjs';

export const FREEZE_PATH = path.join(process.cwd(), 'docs', 'audio', 'TTS-FREEZE.json');
export const GATE5_AUTH_PATH = path.join(process.cwd(), 'docs', 'audio', 'GATE-5-AUTHORIZATION.json');
export const NEW_CONTENT_TEST_CLIP_AUTH_PATH = path.join(process.cwd(), 'docs', 'audio', 'NEW-CONTENT-TEST-CLIP-AUTHORIZATION.json');

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

export async function assertTtsUnfrozen({ file = FREEZE_PATH, operation = 'tts-synthesis', tranche33Context, tranche40Context, text } = {}) {
  const state = await readTtsFreeze(file);
  if (state.active === true) {
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
