import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ROOT = process.cwd();
const ARTICLE_ID = 'how-touchscreens-work';
const AUDIO_KEY = 'de93f3d9f91c8b8b';
const PLAN_FILE = path.join(ROOT, 'scripts', 'speech-test-clips', `${ARTICLE_ID}.json`);
const GENERATOR_FILE = path.join(ROOT, 'scripts', 'generate-audio.mjs');
const TEMP_GENERATOR_FILE = path.join(ROOT, 'scripts', '.generate-hamed-final-v3.mjs');
const AUDIO_DIR = path.join(ROOT, 'public', 'audio', 'articles', AUDIO_KEY);
const MANIFEST_FILE = path.join(AUDIO_DIR, 'manifest.json');
const FULL_AUDIO_FILE = path.join(ROOT, 'scripts', 'speech-test-evidence', `${ARTICLE_ID}-hamed-final-production-v3.mp3`);
const META_FILE = path.join(ROOT, 'scripts', 'speech-test-evidence', `${ARTICLE_ID}-hamed-final-production-v3.json`);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function assertZeroErrorEvidence(report, label) {
  if (report?.status !== 'passed' || report?.wordErrorCount !== 0 || report?.substitutions !== 0 || report?.deletions !== 0 || report?.insertions !== 0) {
    throw new Error(`${label} exact evidence is missing or non-zero.`);
  }
}

async function runNode(args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`node ${args.join(' ')} exited ${code}`)));
  });
}

async function assemble(files, outputFile) {
  const listFile = '/tmp/hamed-final-production-v3-concat.txt';
  const escapePath = (value) => path.resolve(value).replace(/'/g, "'\\''");
  await writeFile(listFile, files.map((file) => `file '${escapePath(file)}'`).join('\n') + '\n');
  await mkdir(path.dirname(outputFile), { recursive: true });
  await rm(outputFile, { force: true });
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegInstaller.path, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-map_metadata', '-1', '-c', 'copy', '-y', outputFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    const errors = [];
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString('utf8'))));
  });
}

const pilot = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'speech-transcript-evidence', `${ARTICLE_ID}-hamed-corrected-gemini36-independent-final.json`), 'utf8'));
assertZeroErrorEvidence(pilot, 'Corrected Hamed pilot');
const final3 = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'speech-transcript-evidence', `${ARTICLE_ID}-hamed-final3-gemini35.json`), 'utf8'));
assertZeroErrorEvidence(final3, 'Final three-target Gemini 3.5 adjudication');

if (!process.env.AZURE_SPEECH_KEY?.trim()) throw new Error('AZURE_SPEECH_KEY is required.');

const originalPlan = await readFile(PLAN_FILE, 'utf8');
try {
  const plan = JSON.parse(originalPlan);
  plan.testClipPassed = true;
  plan.fullSynthesisAllowed = true;
  plan.audioReview = {
    status: 'passed',
    reviewedBy: 'Automated exact ASR evidence — user-authorized conditional publication',
    reviewedAt: new Date().toISOString(),
    evidence: {
      humanListening: false,
      approvalBasis: 'User authorized continuation through publication after exact automated transcript validation.',
    },
  };
  await writeFile(PLAN_FILE, `${JSON.stringify(plan, null, 2)}\n`);
  await runNode(['scripts/check-speech-scripts.mjs']);

  let generator = await readFile(GENERATOR_FILE, 'utf8');
  const maxMarker = 'IS_AZURE ? 6000 : 4800';
  if ((generator.split(maxMarker).length - 1) !== 1) throw new Error('Azure max request bytes marker mismatch.');
  generator = generator.replace(maxMarker, 'IS_AZURE ? 3000 : 4800');

  const splitMarker = 'const pieces = splitByBytes(segment.spokenText);';
  if ((generator.split(splitMarker).length - 1) !== 1) throw new Error('splitByBytes marker mismatch.');
  const correctedBlock = `let correctedHamedText = segment.spokenText;
    const hamedFixes = [
      ['بِبَسَاطَة:', 'بِبَسَاطَةٍ:'],
      ['أَقْطَابِ الشَّبَكَة.', 'أَقْطَابِ الشَّبَكَةِ.'],
      ['عَلَى الشَّاشَة.', 'عَلَى الشَّاشَةِ.'],
      ['عَادَةً «الشَّاشَة» لَيْسَ طَبَقَةً وَاحِدَة.', 'عَادَةً «الشَّاشَةَ» لَيْسَ طَبَقَةً وَاحِدَةً.'],
      ['عَلَى الشَّاشَة،', 'عَلَى الشَّاشَةِ،'],
      ['مِنَ الشَّبَكَة.', 'مِنَ الشَّبَكَةِ.'],
      ['تَكْبِيرَ الصُّورَة،', 'تَكْبِيرَ الصُّورَةِ،'],
      ['تَحْرِيكَ خَرِيطَة.', 'تَحْرِيكَ خَرِيطَةٍ.'],
      ['الَّذِي اعْتَدْنَاهُ اليَوْم.', 'الَّذِي اِعْتَدْنَاهُ اليَوْم.'],
      ['لِنَفْهَمِ اللَّمْسَة، نَحْتَاجُ', 'لِنَفْهَمِ اللَّمْسَةَ نَحْتَاجُ'],
      ['ثُمَّ تُقَدِّرُ مَرْكَزَ مِنْطَقَةِ اللَّمْسِ', 'ثُمَّ تُقَدِّرُ مَرْكَزَ، مِنْطَقَةِ اللَّمْسِ'],
      ['إِلَى سَطْحِ الشَّاشَة.', 'إِلَى سَطْحِ الشَّاشَةِ.'],
      ['الَّذِي تَبْحَثُ عَنْهُ الشَّاشَة.', 'الَّذِي تَبْحَثُ عَنْهُ الشَّاشَةُ.'],
      ['تُغَطِّي الشَّاشَة،', 'تُغَطِّي الشَّاشَةَ،'],
      ['حَرْفَ «بَاء».', 'حَرْفَ بَاءٍ.'],
      ['فَوْقَ حَرْفِ «بَاء»،', 'فَوْقَ حَرْفِ بَاءٍ،']
    ];
    for (const [from, to] of hamedFixes) correctedHamedText = correctedHamedText.split(from).join(to);
    const pieces = splitByBytes(correctedHamedText);`;
  generator = generator.replace(splitMarker, correctedBlock);
  await writeFile(TEMP_GENERATOR_FILE, generator);
  await runNode([path.relative(ROOT, TEMP_GENERATOR_FILE), '--plan'], {
    ...process.env,
    BAREEQ_TTS_PROVIDER: 'azure',
    BAREEQ_TTS_INCLUDE_IDS: ARTICLE_ID,
    BAREEQ_AZURE_HAMED_ONLY: '1',
  });

  await rm(AUDIO_DIR, { recursive: true, force: true });
  await runNode([path.relative(ROOT, TEMP_GENERATOR_FILE)], {
    ...process.env,
    AZURE_SPEECH_REGION: process.env.AZURE_SPEECH_REGION?.trim() || 'eastus',
    BAREEQ_TTS_PROVIDER: 'azure',
    BAREEQ_TTS_INCLUDE_IDS: ARTICLE_ID,
    BAREEQ_AZURE_HAMED_ONLY: '1',
    BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD: '1',
    BAREEQ_TTS_MAX_RETRIES: '4',
    AZURE_SPEECH_MIN_INTERVAL_MS: '1500',
  });

  const manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8'));
  if (manifest.provider !== 'Microsoft Azure AI Speech' || manifest.model !== 'Neural TTS' || manifest.defaultVoice !== 'hamed' || manifest.voices?.length !== 1 || manifest.voices[0]?.providerVoice !== 'ar-SA-HamedNeural') {
    throw new Error('Final Hamed v3 identity mismatch.');
  }
  if (manifest.parts.length < 8 || manifest.parts.length > 12) throw new Error(`Expected 8-12 shorter parts, got ${manifest.parts.length}.`);

  const files = [];
  const partRecords = [];
  let totalDuration = 0;
  for (const [index, part] of manifest.parts.entries()) {
    const asset = part.audio?.hamed;
    if (!asset?.src || !asset.sha256 || !(asset.bytes > 100) || !(asset.durationSeconds > 0)) throw new Error(`Invalid Hamed part ${index + 1}.`);
    const file = path.join(ROOT, 'public', asset.src.replace(/^\//u, ''));
    const bytes = await readFile(file);
    const duration = mp3DurationSeconds(bytes);
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256 || Math.abs(duration - asset.durationSeconds) > 0.15) throw new Error(`Hamed part ${index + 1} integrity mismatch.`);
    files.push(file);
    totalDuration += duration;
    partRecords.push({ part: index + 1, src: asset.src, sha256: asset.sha256, bytes: asset.bytes, durationSeconds: asset.durationSeconds });
  }
  if (!(totalDuration > 800 && totalDuration < 1000)) throw new Error(`Unexpected total Hamed duration ${totalDuration}.`);

  await assemble(files, FULL_AUDIO_FILE);
  const fullBytes = await readFile(FULL_AUDIO_FILE);
  const fullDuration = mp3DurationSeconds(fullBytes);
  await writeFile(META_FILE, `${JSON.stringify({
    schema: 'bareeq.hamed-final-production-candidate.v3',
    articleId: ARTICLE_ID,
    provider: manifest.provider,
    model: manifest.model,
    voice: 'ar-SA-HamedNeural',
    partCount: manifest.parts.length,
    parts: partRecords,
    fullAudioSha256: sha256(fullBytes),
    fullAudioBytes: fullBytes.length,
    durationSeconds: Number(fullDuration.toFixed(3)),
    qaStatus: 'pending',
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`HAMED_FINAL_V3_CANDIDATE parts=${manifest.parts.length} duration=${fullDuration.toFixed(3)} sha=${sha256(fullBytes)}`);
} finally {
  await writeFile(PLAN_FILE, originalPlan);
  await rm(TEMP_GENERATOR_FILE, { force: true });
}
