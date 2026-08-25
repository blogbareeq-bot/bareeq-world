import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import { readSpeechScript, sha256 } from './speech-script-core.mjs';

const ROOT = process.cwd();
const ARTICLE_ID = process.argv.find((argument) => argument.startsWith('--article='))?.slice('--article='.length);
const REVIEWED_BY = process.argv.find((argument) => argument.startsWith('--reviewed-by='))?.slice('--reviewed-by='.length)?.trim();
const CONFIRMATION = process.env.BAREEQ_FAHED_LISTENING_REVIEW;

if (!ARTICLE_ID || !REVIEWED_BY) throw new Error('Pass --article=<article-id> and --reviewed-by=<listener>.');
if (CONFIRMATION !== 'I_LISTENED_TO_THE_EXACT_CLIP_AND_APPROVE_FULL_SYNTHESIS') {
  throw new Error('Listening approval was not recorded. Set BAREEQ_FAHED_LISTENING_REVIEW=I_LISTENED_TO_THE_EXACT_CLIP_AND_APPROVE_FULL_SYNTHESIS only after hearing the complete exact clip.');
}

const basename = `${ARTICLE_ID}-fahed-v1`;
const relativeAudioFile = path.posix.join('scripts', 'speech-test-evidence', `${basename}.mp3`);
const audioFile = path.join(ROOT, relativeAudioFile);
const metadataFile = path.join(ROOT, 'scripts', 'speech-test-evidence', `${basename}.json`);
const planFile = path.join(ROOT, 'scripts', 'speech-test-clips', `${ARTICLE_ID}.json`);
const [audio, metadataRaw, planRaw, script] = await Promise.all([
  readFile(audioFile),
  readFile(metadataFile, 'utf8'),
  readFile(planFile, 'utf8'),
  readSpeechScript(ARTICLE_ID, ROOT),
]);
const metadata = JSON.parse(metadataRaw);
const plan = JSON.parse(planRaw);
const audioSha256 = createHash('sha256').update(audio).digest('hex');
const durationSeconds = mp3DurationSeconds(audio);

if (!script || metadata.schema !== 'bareeq.fahed-test-clip.v1' || metadata.articleId !== ARTICLE_ID || plan.articleId !== ARTICLE_ID) throw new Error('Fahed evidence identity mismatch.');
if (metadata.voice !== 'ar-KW-FahedNeural' || metadata.language !== 'ar-KW') throw new Error('Fahed evidence voice contract mismatch.');
if (metadata.speechScriptHash !== script.scriptHash || plan.speechScriptHash !== script.scriptHash) throw new Error('Fahed evidence targets a stale Speech Script.');
if (metadata.planHash !== plan.planHash) throw new Error('Fahed evidence targets a stale test plan.');
if (metadata.sha256 !== audioSha256 || metadata.bytes !== audio.length || Math.abs(metadata.durationSeconds - durationSeconds) > 0.1) throw new Error('Fahed evidence MP3 integrity mismatch.');

const reviewedAt = new Date().toISOString();
plan.testClipPassed = true;
plan.fullSynthesisAllowed = true;
plan.audioReview = {
  status: 'passed',
  reviewedBy: REVIEWED_BY,
  reviewedAt,
  evidence: {
    file: relativeAudioFile,
    sha256: audioSha256,
    bytes: audio.length,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    voice: 'ar-KW-FahedNeural',
  },
};
const expectedPlanHash = sha256(JSON.stringify({ articleId: plan.articleId, speechScriptHash: plan.speechScriptHash, selectedSegments: plan.selectedSegments, acceptance: plan.acceptance }));
if (plan.planHash !== expectedPlanHash) throw new Error('Fahed test plan hash is invalid.');
metadata.listeningReview = { status: 'passed', reviewedBy: REVIEWED_BY, reviewedAt, approvedFullSynthesis: true };

await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
console.log(`Fahed listening evidence approved for ${ARTICLE_ID}; full synthesis is now allowed for this article only.`);
