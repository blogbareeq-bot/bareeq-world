import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const ARTICLE_ID = 'ai-as-coworker-future-of-human-work';
const ARTICLE_PATH = `src/content/posts/${ARTICLE_ID}.md`;
const EXPECTED_BODY_SHA256 = '1687340cc19bc9c12981d13bdeb3025e2dd5010149844fe75d560824aaa2e3fb';
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function patchFile(file, mutate) {
  const before = await readFile(file, 'utf8');
  const after = mutate(before);
  if (after === before) return false;
  await writeFile(file, after);
  return true;
}

const articleSource = await readFile(ARTICLE_PATH, 'utf8');
const articleMatch = articleSource.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
if (!articleMatch) throw new Error('V4.20: coworker article has invalid frontmatter.');
const articleFrontmatter = articleMatch[1];
const articleBody = articleMatch[2].replace(/\r\n/g, '\n').trim();
if (!/^draft:\s*false\s*$/mi.test(articleFrontmatter)) throw new Error('V4.20: coworker article must be published.');
if (sha(articleBody) !== EXPECTED_BODY_SHA256) throw new Error('V4.20: coworker article changed after editorial/audio review lock.');

await patchFile('scripts/speech-review.json', (source) => {
  const review = JSON.parse(source);
  review.articles ||= {};
  const current = review.articles[ARTICLE_ID];
  if (current && current.bodyHash !== EXPECTED_BODY_SHA256) throw new Error('V4.20: conflicting speech-review entry for coworker article.');
  if (!current) review.articles[ARTICLE_ID] = { bodyHash: EXPECTED_BODY_SHA256, checks: [] };
  return JSON.stringify(review, null, 2) + '\n';
});

await patchFile('scripts/generate-audio.mjs', (source) => {
  source = source.replace(/const USER_AGENT = 'Bareeq-Audio-Builder\/4\.[0-9.]+?';/, "const USER_AGENT = 'Bareeq-Audio-Builder/4.20.0';");

  if (!source.includes("const CACHE_ONLY = process.env.BAREEQ_TTS_CACHE_ONLY === '1';")) {
    const anchor = "const ALLOW_PARTIAL = process.env.BAREEQ_AUDIO_ALLOW_PARTIAL === '1';";
    if (!source.includes(anchor)) throw new Error('V4.20: CACHE_ONLY insertion anchor missing.');
    source = source.replace(anchor, `${anchor}\nconst CACHE_ONLY = process.env.BAREEQ_TTS_CACHE_ONLY === '1';`);
  }

  // V4.19 generated Hamed-only manifests while the provider fingerprint deliberately
  // retained the two-voice Azure configuration. Accept those atomic Hamed-only manifests
  // when BAREEQ_AZURE_HAMED_ONLY=1 so routine redeploys can restore them instead of
  // synthesizing the same seven articles again.
  if (!source.includes('const effectiveManifestVoices =')) {
    const anchor = "function manifestAssets(manifest, post) {\n  const imported = importedManifestAssets(manifest, post);";
    if (!source.includes(anchor)) throw new Error('V4.20: manifest voice compatibility anchor missing.');
    source = source.replace(anchor, `function manifestAssets(manifest, post) {\n  const effectiveManifestVoices = PROVIDER === 'azure' && process.env.BAREEQ_AZURE_HAMED_ONLY === '1'\n    ? VOICES.filter((voice) => voice.id === 'hamed')\n    : VOICES;\n  const imported = importedManifestAssets(manifest, post);`);

    source = source.replace(
      "if (Boolean(manifest.contractTest) !== CONTRACT_TEST || !Array.isArray(manifest.voices) || manifest.voices.length !== VOICES.length || !Array.isArray(manifest.parts) || !manifest.parts.length) return null;\n  if (manifest.defaultVoice !== VOICES[0].id) return null;\n  for (let index = 0; index < VOICES.length; index += 1) {\n    const expected = VOICES[index];",
      "if (Boolean(manifest.contractTest) !== CONTRACT_TEST || !Array.isArray(manifest.voices) || manifest.voices.length !== effectiveManifestVoices.length || !Array.isArray(manifest.parts) || !manifest.parts.length) return null;\n  if (manifest.defaultVoice !== effectiveManifestVoices[0].id) return null;\n  for (let index = 0; index < effectiveManifestVoices.length; index += 1) {\n    const expected = effectiveManifestVoices[index];"
    );
    source = source.replace('for (const voice of VOICES) {\n      const asset = part.audio[voice.id];', 'for (const voice of effectiveManifestVoices) {\n      const asset = part.audio[voice.id];');
    if (!source.includes('manifest.voices.length !== effectiveManifestVoices.length') || !source.includes('for (const voice of effectiveManifestVoices)')) {
      throw new Error('V4.20: Hamed-only manifest compatibility patch did not apply completely.');
    }
  }

  if (!source.includes('Cache-only production restore failed for')) {
    const anchor = 'const missingSourceChars = missing.reduce((sum, post) => sum + [...post.spokenText].length, 0);';
    if (!source.includes(anchor)) throw new Error('V4.20: cache-only guard insertion anchor missing.');
    const guard = `if (CACHE_ONLY) {\n  if (missing.length) throw new Error(\`Cache-only production restore failed for \${missing.length} article(s): \${missing.map((post) => post.id).join(', ')}. No synthesis API was called for these articles.\`);\n  console.log(\`Cache-only production restore passed for \${synthesisPosts.length} article(s); 0 synthesis requests.\`);\n  process.exit(0);\n}\n\n`;
    source = source.replace(anchor, guard + anchor);
  }

  // Make Azure cost/request reporting match Hamed-only generation rather than counting
  // the unused Zariyah voice. This does not alter the provider fingerprint, preserving
  // compatibility with the V4.19 production cache.
  if (!source.includes('const effectiveVoiceCount =')) {
    const anchor = 'const missingSourceChars = missing.reduce((sum, post) => sum + [...post.spokenText].length, 0);\nconst missingChars = missingSourceChars * VOICES.length;\nconst missingRequests = missing.reduce((sum, post) => sum + post.audioParts.length, 0) * VOICES.length;';
    if (!source.includes(anchor)) throw new Error('V4.20: cost-accounting anchor missing.');
    source = source.replace(anchor, `const missingSourceChars = missing.reduce((sum, post) => sum + [...post.spokenText].length, 0);\nconst effectiveVoiceCount = PROVIDER === 'azure' && process.env.BAREEQ_AZURE_HAMED_ONLY === '1' ? 1 : VOICES.length;\nconst missingChars = missingSourceChars * effectiveVoiceCount;\nconst missingRequests = missing.reduce((sum, post) => sum + post.audioParts.length, 0) * effectiveVoiceCount;`);
  }

  for (const token of ['BAREEQ_TTS_INCLUDE_IDS', 'restoreFromProduction', 'GEMINI_REQUEST_HARD_LIMIT', 'GEMINI_SYNTHESIS_BUDGET_MS', 'effectiveManifestVoices', 'effectiveVoiceCount']) {
    if (!source.includes(token)) throw new Error(`V4.20: required audio safeguard missing after patch: ${token}`);
  }
  return source;
});

console.log('V4.20.0 preparation passed: 13th article locked, speech review registered, Hamed cache compatibility fixed, cache-only protection installed.');
