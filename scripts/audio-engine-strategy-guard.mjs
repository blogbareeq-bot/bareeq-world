import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
export const DEFAULT_THRESHOLD = 20;
export const REVIEW_RECOVERY_ALLOWANCE = 3;
export const STRATEGY_PATH = path.join(ROOT, 'docs', 'audio', 'ENGINE-STRATEGY-STATE.json');
export const STATUS_PATH = path.join(ROOT, 'docs', 'audio', 'PROGRESSIVE-STATUS.json');

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function parseSuccessfulTts(logText = '') {
  const matches = [...String(logText).matchAll(/PROGRESSIVE_REPAIR_SUMMARY[^\n]*tts=(\{[^\n]+\})/g)];
  if (!matches.length) return 0;
  try {
    const stats = JSON.parse(matches.at(-1)[1]);
    return Math.max(0, Number(stats.successful) || 0);
  } catch {
    return 0;
  }
}

export function normalizeStrategyState(raw = {}, exactCount = 0) {
  const threshold = Math.max(1, Number(raw.threshold) || DEFAULT_THRESHOLD);
  return {
    schema: 'bareeq.audio-engine-strategy.v1',
    provider: 'Gemini / Sadaltager',
    threshold,
    exactBaseline: Math.max(0, Number(raw.exactBaseline) || Number(exactCount) || 0),
    successfulTtsSinceLastNewExact: Math.max(0, Number(raw.successfulTtsSinceLastNewExact) || 0),
    status: raw.status === 'paused-for-engine-review' ? 'paused-for-engine-review' : 'active',
    reason: raw.reason || null,
    lastExactAt: raw.lastExactAt || null,
    lastRunId: raw.lastRunId || null,
    updatedAt: raw.updatedAt || null,
  };
}

function resetReviewedThresholdAfterNewExact(state) {
  if (state.threshold !== DEFAULT_THRESHOLD) state.threshold = DEFAULT_THRESHOLD;
}

export function reconcileBeforeRun(raw, currentExact, generatedAt = null) {
  const state = normalizeStrategyState(raw, currentExact);
  if (Number(currentExact) > state.exactBaseline) {
    state.exactBaseline = Number(currentExact);
    state.successfulTtsSinceLastNewExact = 0;
    resetReviewedThresholdAfterNewExact(state);
    state.status = 'active';
    state.reason = 'new-exact-publication-reset';
    state.lastExactAt = generatedAt || new Date().toISOString();
  }
  if (state.successfulTtsSinceLastNewExact >= state.threshold) {
    state.status = 'paused-for-engine-review';
    state.reason = `Gemini-only kill switch reached: ${state.successfulTtsSinceLastNewExact}/${state.threshold} successful TTS requests without another exact publication`;
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

export function recordRun(raw, { currentExact, successfulTts = 0, runId = null, generatedAt = null } = {}) {
  const state = normalizeStrategyState(raw, currentExact);
  const success = Math.max(0, Number(successfulTts) || 0);
  if (Number(currentExact) > state.exactBaseline) {
    // Count the current run's successful requests conservatively after the new
    // exact milestone. Any temporary engine-review threshold extension is
    // automatically retired as soon as it produces a new exact article.
    state.exactBaseline = Number(currentExact);
    state.successfulTtsSinceLastNewExact = success;
    resetReviewedThresholdAfterNewExact(state);
    state.lastExactAt = generatedAt || new Date().toISOString();
    state.reason = 'new-exact-publication-reset-with-current-run-requests-counted';
  } else {
    state.successfulTtsSinceLastNewExact += success;
    state.reason = success > 0 ? 'Gemini successful requests recorded without a new exact publication' : state.reason;
  }
  state.status = state.successfulTtsSinceLastNewExact >= state.threshold ? 'paused-for-engine-review' : 'active';
  if (state.status === 'paused-for-engine-review') {
    state.reason = `Gemini-only kill switch reached: ${state.successfulTtsSinceLastNewExact}/${state.threshold} successful TTS requests without another exact publication`;
  }
  state.lastRunId = runId || state.lastRunId;
  state.updatedAt = new Date().toISOString();
  return state;
}

export function remainingAllowance(raw, currentExact) {
  const state = reconcileBeforeRun(raw, currentExact);
  const normalRemaining = Math.max(0, state.threshold - state.successfulTtsSinceLastNewExact);
  if (normalRemaining > 0) return normalRemaining;

  // Only the canonical 20-request boundary may open the legacy three-request
  // review window. A separately reviewed temporary threshold (for example
  // 25->28) must close when it reaches that temporary threshold; otherwise
  // every equality point would recursively mint another three requests.
  const exactlyAtReviewBoundary = state.threshold === DEFAULT_THRESHOLD
    && state.status === 'paused-for-engine-review'
    && state.successfulTtsSinceLastNewExact === state.threshold
    && Number(currentExact) === state.exactBaseline;
  return exactlyAtReviewBoundary ? REVIEW_RECOVERY_ALLOWANCE : 0;
}

async function currentStatus() {
  return await readJson(STATUS_PATH, { exactCount: 0, generatedAt: null, sourceRunId: null });
}

async function loadState(status) {
  const raw = await readJson(STRATEGY_PATH, null);
  return normalizeStrategyState(raw || {}, status.exactCount);
}

async function cli() {
  const status = await currentStatus();
  let state = await loadState(status);
  if (process.argv.includes('--remaining')) {
    state = reconcileBeforeRun(state, status.exactCount, status.generatedAt);
    await writeJson(STRATEGY_PATH, state);
    const remaining = remainingAllowance(state, status.exactCount);
    const recovery = remaining > 0 && state.successfulTtsSinceLastNewExact >= state.threshold;
    console.error(`GEMINI_STRATEGY remaining=${remaining} successfulSinceExact=${state.successfulTtsSinceLastNewExact} threshold=${state.threshold} exactBaseline=${state.exactBaseline} reviewRecovery=${recovery}`);
    process.stdout.write(String(remaining));
    return;
  }

  if (process.argv.includes('--record')) {
    const logArg = process.argv.find((arg) => arg.startsWith('--log='));
    const logPath = logArg?.slice('--log='.length);
    const log = logPath ? await readFile(logPath, 'utf8').catch(() => '') : '';
    const successfulTts = parseSuccessfulTts(log);
    const runId = process.env.GITHUB_RUN_ID || status.sourceRunId || null;
    state = recordRun(state, {
      currentExact: status.exactCount,
      successfulTts,
      runId,
      generatedAt: status.generatedAt,
    });
    await writeJson(STRATEGY_PATH, state);
    console.log(`GEMINI_STRATEGY_RECORDED run=${runId || 'n/a'} successful=${successfulTts} sinceExact=${state.successfulTtsSinceLastNewExact}/${state.threshold} exact=${status.exactCount} status=${state.status}`);
    return;
  }

  console.log(JSON.stringify(state, null, 2));
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  await cli();
}
