import { readFile, writeFile } from 'node:fs/promises';

const SOURCE = 'scripts/generate-audio.mjs';
const TARGET = 'scripts/.v4215-generate-audio.mjs';
let source = await readFile(SOURCE, 'utf8');

function replaceOnce(from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one locked source block, found ${count}.`);
  source = source.replace(from, to);
}

replaceOnce(
  "const AUDIO_ROOT = path.join(ROOT, 'public', 'audio', 'articles');\nconst PROVIDER = process.env.BAREEQ_TTS_PROVIDER?.trim().toLowerCase() || 'bundled';",
  "const AUDIO_ROOT = path.join(ROOT, 'public', 'audio', 'articles');\nconst RESUME_ENABLED = process.env.BAREEQ_GEMINI_RESUME === '1';\nconst RESUME_ROOT = path.join(ROOT, '.bareeq-audio-checkpoints');\nconst PROVIDER = process.env.BAREEQ_TTS_PROVIDER?.trim().toLowerCase() || 'bundled';",
  'resume constants',
);

replaceOnce(
`  const finalDir = path.join(AUDIO_ROOT, post.key);
  const tempDir = \`${'${finalDir}'}.tmp-${'${process.pid}'}\`;
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });`,
`  const finalDir = path.join(AUDIO_ROOT, post.key);
  const checkpointDir = path.join(RESUME_ROOT, post.key, post.sourceHash);
  const tempDir = PROVIDER === 'gemini' && RESUME_ENABLED ? checkpointDir : \`${'${finalDir}'}.tmp-${'${process.pid}'}\`;
  if (!(PROVIDER === 'gemini' && RESUME_ENABLED)) await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });`,
  'checkpoint directory',
);

replaceOnce(
`        const audio = await synthesizeVoice(API_KEY, voice, audioPart, {
          articleTitle: post.title,
          partIndex: index,
          partCount: post.audioParts.length,
        });
        if (audio.length < 100) throw new Error(\`${'${post.id}'}: generated MP3 ${'${filename}'} is unexpectedly small.\`);
        const durationSeconds = mp3DurationSeconds(audio);
        await writeFile(path.join(tempDir, filename), audio);`,
`        const checkpointFile = path.join(tempDir, filename);
        let audio = null;
        if (PROVIDER === 'gemini' && RESUME_ENABLED && await exists(checkpointFile)) {
          const cached = await readFile(checkpointFile);
          try {
            const cachedDuration = mp3DurationSeconds(cached);
            if (cached.length >= 100 && cachedDuration > 0) {
              audio = cached;
              console.log(\`↺ ${'${post.id}'}: resumed ${'${filename}'} from V4.21.5 checkpoint.\`);
            }
          } catch {}
          if (!audio) await rm(checkpointFile, { force: true });
        }
        if (!audio) {
          audio = await synthesizeVoice(API_KEY, voice, audioPart, {
            articleTitle: post.title,
            partIndex: index,
            partCount: post.audioParts.length,
          });
          if (audio.length < 100) throw new Error(\`${'${post.id}'}: generated MP3 ${'${filename}'} is unexpectedly small.\`);
          await writeFile(checkpointFile, audio);
          if (PROVIDER === 'gemini' && RESUME_ENABLED) console.log(\`✓ ${'${post.id}'}: checkpointed ${'${filename}'}.\`);
        }
        const durationSeconds = mp3DurationSeconds(audio);`,
  'part checkpoint reuse',
);

replaceOnce(
`  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    if (PROVIDER === 'gemini' && (error?.httpStatus === 429 || error?.code === 'BAREEQ_GEMINI_BUDGET')) {
      deferredReason = error?.httpStatus === 429 ? 'persistent HTTP 429' : 'build-time budget';
      console.warn(\`⚠ Gemini progressive rollout paused at ${'${post.id}'}: ${'${deferredReason}'}.\`);
      console.warn('⚠ Safe progressive fallback: completed Sadaltager articles remain publishable; this and later articles retain approved Cedar/Hamed fallback audio and will be retried on a later deployment.');
      break;
    }
    throw error;
  }`,
`  } catch (error) {
    const resumableGemini = PROVIDER === 'gemini' && RESUME_ENABLED;
    if (!resumableGemini) await rm(tempDir, { recursive: true, force: true });
    if (PROVIDER === 'gemini' && (error?.httpStatus === 429 || error?.code === 'BAREEQ_GEMINI_BUDGET')) {
      deferredReason = error?.httpStatus === 429 ? 'persistent HTTP 429' : 'build-time budget';
      console.warn(\`⚠ Gemini progressive rollout paused at ${'${post.id}'}: ${'${deferredReason}'}.\`);
      if (RESUME_ENABLED) console.warn(\`⚠ V4.21.5 checkpoint preserved at ${'${tempDir}'}; the next manual run resumes completed MP3 parts instead of starting over.\`);
      else console.warn('⚠ Safe progressive fallback: completed Sadaltager articles remain publishable; this and later articles retain approved Cedar/Hamed fallback audio and will be retried on a later deployment.');
      break;
    }
    if (resumableGemini) console.warn(\`⚠ V4.21.5 preserved previously validated checkpoint MP3 parts at ${'${tempDir}'} before surfacing the fatal error.\`);
    throw error;
  }`,
  'checkpoint preservation',
);

await writeFile(TARGET, source, 'utf8');
console.log(`Prepared resumable Gemini generator: ${TARGET}. Source generator remains unchanged.`);
