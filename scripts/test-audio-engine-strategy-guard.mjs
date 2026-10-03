import assert from 'node:assert/strict';
import {
  REVIEW_RECOVERY_ALLOWANCE,
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
assert.equal(remainingAllowance(capped, 7), REVIEW_RECOVERY_ALLOWANCE);

const recoverySpent = recordRun(capped, { currentExact: 7, successfulTts: REVIEW_RECOVERY_ALLOWANCE, runId: 'recovery' });
assert.equal(recoverySpent.successfulTtsSinceLastNewExact, 23);
assert.equal(recoverySpent.status, 'paused-for-engine-review');
assert.equal(remainingAllowance(recoverySpent, 7), 0);

const quotaBlockedRecovery = recordRun(capped, { currentExact: 7, successfulTts: 0, runId: 'quota-blocked' });
assert.equal(quotaBlockedRecovery.successfulTtsSinceLastNewExact, 20);
assert.equal(remainingAllowance(quotaBlockedRecovery, 7), REVIEW_RECOVERY_ALLOWANCE);

// Explicit engine review may temporarily lift the threshold by exactly the
// number of successful provider calls approved for recovery. This models the
// live 25->28 window without erasing any historical successful requests.
const reviewed = {
  threshold: 28,
  exactBaseline: 7,
  successfulTtsSinceLastNewExact: 25,
  status: 'active',
};
assert.equal(remainingAllowance(reviewed, 7), 3);
const reviewedNoExact = recordRun(reviewed, { currentExact: 7, successfulTts: 3, runId: 'review-no-exact' });
assert.equal(reviewedNoExact.threshold, 28);
assert.equal(reviewedNoExact.successfulTtsSinceLastNewExact, 28);
assert.equal(reviewedNoExact.status, 'paused-for-engine-review');
assert.equal(remainingAllowance(reviewedNoExact, 7), 0);
const reviewedNewExact = recordRun(reviewed, { currentExact: 8, successfulTts: 1, runId: 'review-new-exact' });
assert.equal(reviewedNewExact.threshold, 20);
assert.equal(reviewedNewExact.exactBaseline, 8);
assert.equal(reviewedNewExact.successfulTtsSinceLastNewExact, 1);
assert.equal(reviewedNewExact.status, 'active');
assert.equal(remainingAllowance(reviewedNewExact, 8), 19);

const newExact = recordRun(seeded, { currentExact: 8, successfulTts: 2, runId: 'new-exact' });
assert.equal(newExact.exactBaseline, 8);
assert.equal(newExact.successfulTtsSinceLastNewExact, 2);
assert.equal(newExact.status, 'active');
assert.equal(remainingAllowance(newExact, 8), 18);

const reconciled = reconcileBeforeRun({ ...capped, exactBaseline: 7 }, 8, '2026-09-28T08:00:00Z');
assert.equal(reconciled.threshold, 20);
assert.equal(reconciled.exactBaseline, 8);
assert.equal(reconciled.successfulTtsSinceLastNewExact, 0);
assert.equal(reconciled.status, 'active');

console.log('Engine strategy guard tests passed: normal allowance is preserved; 20/20 grants one bounded boundary recovery; the explicit live 25->28 review window is exactly three calls; no-exact exhaustion closes it; quota-only blocks preserve it; and any new exact publication retires the temporary threshold back to 20.');
