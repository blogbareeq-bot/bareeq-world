import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tranche33OverrideAuthorized } from './audio-tranche33-authorization.mjs';

export const FREEZE_PATH = path.join(process.cwd(), 'docs', 'audio', 'TTS-FREEZE.json');
export const GATE5_AUTH_PATH = path.join(process.cwd(), 'docs', 'audio', 'GATE-5-AUTHORIZATION.json');

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

export async function assertTtsUnfrozen({ file = FREEZE_PATH, operation = 'tts-synthesis', tranche33Context, text } = {}) {
  const state = await readTtsFreeze(file);
  if (state.active === true) {
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
