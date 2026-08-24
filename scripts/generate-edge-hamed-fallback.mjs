import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { mp3DurationSeconds } from './mp3-duration.mjs';

const ARTICLE_ID = 'how-touchscreens-work';
const AUDIO_KEY = 'de93f3d9f91c8b8b';
const VOICE = 'ar-SA-HamedNeural';
const ROOT = process.cwd();
const planFile = path.resolve(ROOT, process.argv[2] || '.touchscreen-parts.json');
const edgeTts = process.env.EDGE_TTS_BIN?.trim() || 'edge-tts';
const ffmpeg = process.env.FFMPEG_PATH?.trim() || ffmpegInstaller.path;
const plans = JSON.parse(await readFile(planFile, 'utf8'));

if (!Array.isArray(plans) || plans.length !== 1) throw new Error('Expected exactly one exported article plan.');
const plan = plans[0];
if (plan.id !== ARTICLE_ID || plan.key !== AUDIO_KEY || !Array.isArray(plan.parts) || plan.parts.length !== 3) {
  throw new Error('Touchscreen Hamed fallback plan does not match the locked article contract.');
}
if (!/^[a-f0-9]{64}$/.test(plan.sourceHash || '')) throw new Error('Touchscreen provider source hash is invalid.');

const finalDir = path.join(ROOT, 'public', 'audio', 'articles', AUDIO_KEY);
const tempDir = `${finalDir}.edge-${process.pid}`;
await rm(tempDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const parts = [];
let totalDurationSeconds = 0;

try {
  for (let index = 0; index < plan.parts.length; index += 1) {
    const source = plan.parts[index];
    if (typeof source?.text !== 'string' || !source.text.trim() || !Array.isArray(source.sync) || !source.sync.length) {
      throw new Error(`Invalid exported touchscreen part ${index + 1}.`);
    }

    const sequence = String(index + 1).padStart(3, '0');
    const textFile = path.join(tempDir, `part-${sequence}.txt`);
    const rawFile = path.join(tempDir, `part-${sequence}.edge.mp3`);
    const filename = `hamed-part-${sequence}-${plan.sourceHash.slice(0, 8)}.mp3`;
    const outputFile = path.join(tempDir, filename);
    await writeFile(textFile, source.text, 'utf8');

    const synthesis = spawnSync(edgeTts, [
      '--voice', VOICE,
      '--rate=+0%',
      '--volume=+0%',
      '--pitch=+0Hz',
      '--file', textFile,
      '--write-media', rawFile,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (synthesis.error) throw synthesis.error;
    if (synthesis.status !== 0) throw new Error(`Hamed synthesis failed for part ${index + 1}: ${synthesis.stderr || synthesis.stdout}`);

    const transcode = spawnSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', rawFile,
      '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
      '-c:a', 'libmp3lame', '-b:a', '96k', outputFile,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (transcode.error) throw transcode.error;
    if (transcode.status !== 0) throw new Error(`MP3 normalization failed for part ${index + 1}: ${transcode.stderr || transcode.stdout}`);

    const bytes = await readFile(outputFile);
    if (bytes.length < 100) throw new Error(`Generated Hamed MP3 is too small for part ${index + 1}.`);
    const durationSeconds = mp3DurationSeconds(bytes);
    totalDurationSeconds += durationSeconds;
    parts.push({
      characters: [...source.text].length,
      sync: source.sync.map(({ id, start, end }) => ({ id, start, end })),
      audio: {
        hamed: {
          src: `/audio/articles/${AUDIO_KEY}/${filename}`,
          bytes: bytes.length,
          durationSeconds,
          sha256: sha256(bytes),
        },
      },
    });

    await rm(textFile, { force: true });
    await rm(rawFile, { force: true });
  }

  const manifest = {
    version: 3,
    generatorVersion: 8,
    syncVersion: 1,
    speechOverridesVersion: 1,
    speechReviewVersion: 2,
    provider: 'Microsoft Azure AI Speech',
    model: 'Neural TTS',
    language: 'ar-SA',
    outputFormat: 'audio-48khz-96kbitrate-mono-mp3',
    articleId: ARTICLE_ID,
    title: plan.title,
    sourceHash: plan.sourceHash,
    defaultVoice: 'hamed',
    voices: [{
      id: 'hamed',
      label: 'حامد',
      description: 'صوت سعودي رجالي',
      providerVoice: VOICE,
      totalDurationSeconds: Number(totalDurationSeconds.toFixed(3)),
    }],
    syncMethod: 'paragraph-weighted',
    disclosure: 'الصوت مولّد بالذكاء الاصطناعي وليس صوتًا بشريًا.',
    region: 'eastus',
    synthesisRate: '0%',
    generationRoute: 'Microsoft Edge online neural speech fallback',
    parts,
  };
  await writeFile(path.join(tempDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rm(finalDir, { recursive: true, force: true });
  await rename(tempDir, finalDir);
  console.log(`Touchscreen Hamed fallback generated: ${parts.length} MP3 part(s), ${totalDurationSeconds.toFixed(2)} seconds.`);
} catch (error) {
  await rm(tempDir, { recursive: true, force: true });
  throw error;
}
