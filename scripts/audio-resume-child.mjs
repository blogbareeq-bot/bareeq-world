import { generateCandidate, QuotaError } from './audio-generate-candidate.mjs';
import { QUOTA_SPLIT, EXIT_QUOTA, EXIT_HARD } from './audio-constants.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.env.BAREEQ_RESUME_ROOT;
const storeRoot = process.env.BAREEQ_RESUME_STORE || root;
const failAt = Number(process.env.BAREEQ_RESUME_FAIL_AT || '-1');
const articleId = process.env.BAREEQ_RESUME_ARTICLE || 'resume-fixture';
const settings = {
  ...QUOTA_SPLIT,
  name: 'test-tiny',
  maxTranscriptBytes: 400,
  maxSeconds: 600,
  targetSeconds: 1,
  minSeconds: 0,
  rebalanceFloorSeconds: 0,
};

let sent = 0;
try {
  const result = await generateCandidate({
    articleId,
    root,
    storeRoot,
    settings,
    liveDurationSeconds: 40,
    synthesize: async ({ part }) => {
      sent += 1;
      if (failAt >= 0 && part.partIndex === failAt) {
        const error = new QuotaError('simulated HTTP 429');
        throw error;
      }
      const file = path.join(root, `tone-${part.partIndex}.mp3`);
      return readFile(file);
    },
  });
  process.stdout.write(`${JSON.stringify({ ...result, childSent: sent })}\n`);
} catch (error) {
  const payload = {
    status: error.result?.status || 'error',
    exitCode: error.exitCode || EXIT_HARD,
    result: error.result || null,
    childSent: sent,
    message: error.message,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(error.exitCode || EXIT_HARD);
}
