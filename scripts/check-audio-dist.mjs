import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const postDir = path.join(root, 'src', 'content', 'posts');
const dist = path.join(root, 'dist');
const posts = (await readdir(postDir)).filter((name) => name.endsWith('.md')).sort();
let totalParts = 0;

for (const name of posts) {
  const source = await readFile(path.join(postDir, name), 'utf8');
  if (/^draft:\s*true\s*$/mi.test(source)) continue;
  const id = name.replace(/\.md$/, '');
  const key = createHash('sha256').update(id).digest('hex').slice(0, 16);
  const manifestFile = path.join(dist, 'audio', 'articles', key, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); }
  catch { throw new Error(`${id}: production audio manifest is missing or invalid.`); }
  if (manifest.provider !== 'Microsoft Azure AI Speech' || manifest.model !== 'Neural TTS' || manifest.language !== 'ar-SA') {
    throw new Error(`${id}: production audio is not Azure AI Speech Saudi Arabic.`);
  }
  if (typeof manifest.voice !== 'string' || !manifest.voice.startsWith('ar-SA-')) throw new Error(`${id}: unexpected Azure voice ${manifest.voice}.`);
  if (manifest.outputFormat !== 'audio-48khz-192kbitrate-mono-mp3') throw new Error(`${id}: unexpected Azure audio format.`);
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) throw new Error(`${id}: audio manifest has no MP3 parts.`);
  for (const part of manifest.parts) {
    if (typeof part.src !== 'string' || !part.src.startsWith(`/audio/articles/${key}/`) || !part.src.endsWith('.mp3')) {
      throw new Error(`${id}: unsafe or invalid MP3 path in manifest.`);
    }
    const file = path.join(dist, part.src.replace(/^\//, ''));
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size < 100) throw new Error(`${id}: missing or empty MP3: ${part.src}`);
    totalParts += 1;
  }
}

const textFiles = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (/\.(?:html|js|json|xml|txt)$/i.test(entry.name)) textFiles.push(full);
  }
}
await collect(dist);
const secret = process.env.AZURE_SPEECH_KEY?.trim();
for (const file of textFiles) {
  const text = await readFile(file, 'utf8').catch(() => '');
  if (/AZURE_SPEECH_KEY/.test(text)) throw new Error(`Azure secret variable name leaked into production output: ${path.relative(dist, file)}`);
  if (secret && secret.length >= 16 && text.includes(secret)) throw new Error(`Azure Speech key leaked into production output: ${path.relative(dist, file)}`);
}
console.log(`Production Azure AI Speech audio audit passed: ${totalParts} MP3 part(s).`);
