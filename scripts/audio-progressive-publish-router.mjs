import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { writeJson } from './audio-checkpoint.mjs';

const ROOT = process.cwd();
const CAMPAIGN_ID = process.env.BAREEQ_AUDIO_CAMPAIGN_ID?.trim() || 'sadaltager-openrouter-20260901-v1';
const STATE_PATH = path.join(ROOT, 'audio-candidates', '_campaigns', CAMPAIGN_ID, 'state.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'audio', 'AUDIO-TRUTH-SNAPSHOT.json');
const KEYS = ['substitutions', 'deletions', 'insertions', 'unresolved'];

const state = JSON.parse(await readFile(STATE_PATH, 'utf8'));
const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const exact = snapshot.articles.filter((item) => {
  const row = state.articles?.[item.articleId] || {};
  const c = row.validation?.consensus || {};
  return row.generation?.status === 'generated'
    && row.validation?.status === 'validated'
    && row.validation?.fingerprint === row.generation?.fingerprint
    && KEYS.every((key) => Number(c[key]) === 0);
});

const final = exact.length === snapshot.articles.length;
if (final) {
  state.validationComplete = true;
  state.updatedAt = new Date().toISOString();
  await writeJson(STATE_PATH, state);
}

const mode = final ? 'publish' : 'publish-current';
console.log(`PROGRESSIVE_PUBLISH_ROUTER exact=${exact.length}/15 mode=${mode}`);
const child = spawnSync(process.execPath, ['scripts/audio-openrouter-campaign.mjs', `--mode=${mode}`], {
  cwd: ROOT,
  env: process.env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
if (child.status !== 0) process.exit(child.status || 1);
