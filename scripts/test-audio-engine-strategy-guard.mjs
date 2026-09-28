import assert from 'node:assert/strict';
import {
  parseSuccessfulTts,
  recordRun,
  reconcileBeforeRun,
  remainingAllowance,
} from './audio-engine-strategy-guard.mjs';

const seeded = {
  threshold: 20,
  exactBaseline: 7,
  successfulTtsSinceLastNewExact: 13,
  status: 'active',
};
assert.equal(remainingAllowance(seeded, 7), 7);
assert.equal(parseSuccessfulTts('PROGRESSIVE_REPAIR_SUMMARY exact=7/15 attemptedRounds=7 visited=7 tts={"sent":7,"successful":6,"quotaRejected":1,"maxRequests":10,"dailyQuotaExhausted":true,"budgetExhausted":false}'), 6);
assert.equal(parseSuccessfulTts('unrelated log'), 0);

const capped = recordRun(seeded, { currentExact: 7, successfulTts: 7, runId: 'next' });
assert.equal(capped.successfulTtsSinceLastNewExact, 20);
assert.equal(capped.status, 'paused-for-engine-review');
assert.equal(remainingAllowance(capped, 7), 0);

const newExact = recordRun(seeded, { currentExact: 8, successfulTts: 2, runId: 'new-exact' });
assert.equal(newExact.exactBaseline, 8);
assert.equal(newExact.successfulTtsSinceLastNewExact, 2);
assert.equal(newExact.status, 'active');
assert.equal(remainingAllowance(newExact, 8), 18);

const reconciled = reconcileBeforeRun({ ...capped, exactBaseline: 7 }, 8, '2026-09-28T08:00:00Z');
assert.equal(reconciled.exactBaseline, 8);
assert.equal(reconciled.successfulTtsSinceLastNewExact, 0);
assert.equal(reconciled.status, 'active');

console.log('Engine strategy guard tests passed: 13/20 seed leaves seven requests, 20/20 pauses Gemini-only, and a new exact milestone resets the window.');
