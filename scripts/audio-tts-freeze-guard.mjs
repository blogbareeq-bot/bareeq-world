import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FREEZE_PATH = path.join(process.cwd(), 'docs', 'audio', 'TTS-FREEZE.json');

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

export async function assertTtsUnfrozen({ file = FREEZE_PATH, operation = 'tts-synthesis' } = {}) {
  const state = await readTtsFreeze(file);
  if (state.active === true) {
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
