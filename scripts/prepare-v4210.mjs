import { readFile, writeFile } from 'node:fs/promises';

const generatorPath = 'scripts/generate-audio.mjs';
const generatorBefore = await readFile(generatorPath, 'utf8');
const generatorAfter = generatorBefore.replace(
  /const USER_AGENT = 'Bareeq-Audio-Builder\/4\.[0-9.]+';/,
  "const USER_AGENT = 'Bareeq-Audio-Builder/4.21.0';",
);
if (!generatorAfter.includes("const USER_AGENT = 'Bareeq-Audio-Builder/4.21.0';")) throw new Error('V4.21: audio builder version anchor is missing.');
if (generatorAfter !== generatorBefore) await writeFile(generatorPath, generatorAfter);

const [component, page, client, cloud, runner] = await Promise.all([
  readFile('src/components/ReadingModes.astro', 'utf8'),
  readFile('src/pages/posts/[id].astro', 'utf8'),
  readFile('public/scripts/article.js', 'utf8'),
  readFile('scripts/cloud-tts.mjs', 'utf8'),
  readFile('scripts/run-v4210-audio.mjs', 'utf8'),
]);

const readinessPath = 'scripts/check-launch-readiness.mjs';
const readinessBefore = await readFile(readinessPath, 'utf8');
const readinessAfter = readinessBefore.replace(
  "if (pkg.version !== '4.20.0') failures.push(`Expected package version 4.20.0, got ${pkg.version}`);",
  "if (pkg.version !== '4.21.0') failures.push(`Expected package version 4.21.0, got ${pkg.version}`);",
);
if (!readinessAfter.includes("if (pkg.version !== '4.21.0') failures.push(`Expected package version 4.21.0, got ${pkg.version}`);")
  && !readinessAfter.includes("if (pkg.version !== '4.21.1') failures.push(`Expected package version 4.21.1, got ${pkg.version}`);")) throw new Error('V4.21: launch-readiness version gate or patch successor is missing.');
if (readinessAfter !== readinessBefore) await writeFile(readinessPath, readinessAfter);

if (component.includes('data-audio-manifest-inline') || component.includes('data-audio-current-voice')) throw new Error('V4.21: eager audio metadata remains in ReadingModes.astro.');
for (const token of ['hasAudio={hasAudio}', 'await access(manifestPath)']) if (!page.includes(token)) throw new Error(`V4.21: lazy manifest page safeguard missing: ${token}`);
for (const token of ['forceScroll', 'ratioOverride', 'The manifest is fetched only after the reader deliberately opens Listen']) if (!client.includes(token)) throw new Error(`V4.21: audio UI safeguard missing: ${token}`);
for (const token of ['gemini-2.5-flash-tts', 'ar-EG', 'Sadaltager', 'BAREEQ_CLOUD_TTS_ACTIVATE', 'modelName', 'audioEncoding']) if (!cloud.includes(token)) throw new Error(`V4.21: Cloud TTS safeguard missing: ${token}`);
for (const token of ["process.env.BAREEQ_CLOUD_TTS_ACTIVATE !== '1'", "runStrict('scripts/run-v4200-audio.mjs')", "BAREEQ_TTS_PROVIDER: 'google-cloud'"]) if (!runner.includes(token)) throw new Error(`V4.21: safe activation runner safeguard missing: ${token}`);

console.log('V4.21.0 preparation passed: audio metadata is lazy, seek-to-text is forced on deliberate seek, and Cloud TTS remains behind the explicit post-CNTXT activation gate.');
