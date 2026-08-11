import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const POSTS_DIR = path.join(ROOT, 'src', 'content', 'posts');
const AUDIO_ROOT = path.join(ROOT, 'public', 'audio', 'articles');
const API_KEY = process.env.AZURE_SPEECH_KEY?.trim();
const REGION = process.env.AZURE_SPEECH_REGION?.trim().toLowerCase() || 'eastus';
const RESOURCE_ENDPOINT = process.env.AZURE_SPEECH_ENDPOINT?.trim().replace(/\/$/, '') || `https://${REGION}.api.cognitive.microsoft.com`;
const LANGUAGE = 'ar-SA';
const DEFAULT_VOICE = process.env.AZURE_SPEECH_VOICE?.trim() || 'ar-SA-HamedNeural';
const SYNTHESIS_RATE = process.env.AZURE_SPEECH_SYNTHESIS_RATE?.trim() || '0%';
const OUTPUT_FORMAT = 'audio-48khz-192kbitrate-mono-mp3';
const PLAN_ONLY = process.argv.includes('--plan');
const MAX_REQUEST_BYTES = 12000; // keeps each part well below the 64 KB SSML limit and comfortably below 10 minutes.
const MIN_SYNTHESIS_INTERVAL_MS = Number(process.env.AZURE_SPEECH_MIN_INTERVAL_MS || '3200'); // F0 allows 20 synthesis transactions per rolling 60 seconds.
const GENERATOR_VERSION = 3;
const TTS_BASE = (process.env.AZURE_SPEECH_TTS_BASE?.trim().replace(/\/$/, '') || `https://${REGION}.tts.speech.microsoft.com`);
const CACHE_ORIGIN = (process.env.BAREEQ_AUDIO_CACHE_ORIGIN?.trim().replace(/\/$/, '') || 'https://bareeqworld.com');
const USER_AGENT = 'Bareeq-Audio-Builder/4.7.0';

const encoder = new TextEncoder();
const byteLength = (value) => encoder.encode(value).byteLength;
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const audioKeyFor = (id) => sha(id).slice(0, 16);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastSynthesisAt = 0;

function parsePost(source, filename) {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw new Error(`${filename}: invalid frontmatter.`);
  const frontmatter = match[1];
  const body = match[2];
  const title = frontmatter.match(/^title:\s*["']?(.*?)["']?\s*$/m)?.[1]?.trim();
  const draft = /^draft:\s*true\s*$/mi.test(frontmatter);
  if (!title) throw new Error(`${filename}: title is missing.`);
  return { title, draft, body };
}

function stripMarkdown(body) {
  body = body.replace(/\n##\s+(?:المصادر(?:\s+والتحقق|\s+والقراءة\s+الإضافية)?|المراجع|References?)\b[\s\S]*$/i, '');
  body = body.replace(/```[\s\S]*?```/g, ' ');
  body = body.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ');
  body = body.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  body = body.replace(/^\s*\|.*\|\s*$/gm, ' ');
  body = body.replace(/^\s*[-:| ]{3,}\s*$/gm, ' ');
  body = body.replace(/<[^>]+>/g, ' ');
  body = body.replace(/^\s{0,3}#{1,6}\s+/gm, '\n');
  body = body.replace(/^\s*>\s?/gm, '');
  body = body.replace(/^\s*[-*+]\s+/gm, '');
  body = body.replace(/^\s*\d+[.)]\s+/gm, '');
  body = body.replace(/[*_~`]/g, '');
  body = body.replace(/\([^)]*https?:\/\/[^)]*\)/g, ' ');
  body = body.replace(/https?:\/\/\S+/g, ' ');
  body = body.replace(/\s+([،؛؟.!])/g, '$1');
  body = body.replace(/[ \t]+/g, ' ');
  body = body.replace(/\n{3,}/g, '\n\n');
  return body.trim();
}

const pronunciationMap = new Map([
  ['OpenAI', 'أوبن إيه آي'],
  ['ChatGPT', 'شات جي بي تي'],
  ['NIST', 'إن آي إس تي'],
  ['OWASP', 'أو واسب'],
  ['Google', 'غوغل'],
  ['Microsoft', 'مايكروسوفت'],
  ['Azure', 'أزور'],
  ['NASA', 'ناسا'],
  ['UNESCO', 'يونسكو'],
  ['AI', 'إيه آي'],
]);

function optimizeForSpeech(text) {
  for (const [from, to] of pronunciationMap) {
    text = text.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), to);
  }
  text = text.replace(/(\d+(?:[.,]\d+)?)\s*%/g, '$1 في المئة');
  text = text.replace(/\n+/g, '. ');
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function splitByBytes(text, maxBytes = MAX_REQUEST_BYTES) {
  if (byteLength(text) <= maxBytes) return [text];
  const sentences = text.match(/[^.!؟؛]+[.!؟؛]?/g) || [text];
  const chunks = [];
  let current = '';

  const pushWords = (sentence) => {
    const words = sentence.trim().split(/\s+/);
    let part = '';
    for (const word of words) {
      const candidate = part ? `${part} ${word}` : word;
      if (byteLength(candidate) > maxBytes && part) {
        chunks.push(part.trim());
        part = word;
      } else if (byteLength(candidate) > maxBytes) {
        let tiny = '';
        for (const char of [...word]) {
          if (byteLength(tiny + char) > maxBytes && tiny) { chunks.push(tiny); tiny = ''; }
          tiny += char;
        }
        part = tiny;
      } else {
        part = candidate;
      }
    }
    if (part) chunks.push(part.trim());
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (byteLength(sentence) > maxBytes) {
      if (current) { chunks.push(current.trim()); current = ''; }
      pushWords(sentence);
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (byteLength(candidate) > maxBytes && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
}

async function request(url, options = {}, attempt = 0) {
  const response = await fetch(url, options);
  if (response.ok) return response;
  const body = await response.text();
  if ((response.status === 429 || response.status >= 500) && attempt < 5) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 1000 * (2 ** attempt));
    await sleep(wait);
    return request(url, options, attempt + 1);
  }
  throw new Error(`Azure Speech request failed (${response.status}): ${body.slice(0, 700)}`);
}

function getAzureUrls() {
  let endpointHost = '';
  try { endpointHost = new URL(RESOURCE_ENDPOINT).hostname; } catch { throw new Error('AZURE_SPEECH_ENDPOINT must be a valid HTTPS URL.'); }
  if (!RESOURCE_ENDPOINT.startsWith('https://')) throw new Error('AZURE_SPEECH_ENDPOINT must use HTTPS.');
  const isCustomDomain = endpointHost.endsWith('.cognitiveservices.azure.com');
  if (isCustomDomain) {
    return {
      voices: `${RESOURCE_ENDPOINT}/tts/cognitiveservices/voices/list`,
      synthesize: `${RESOURCE_ENDPOINT}/cognitiveservices/v1`,
    };
  }
  return {
    voices: `${TTS_BASE}/cognitiveservices/voices/list`,
    synthesize: `${TTS_BASE}/cognitiveservices/v1`,
  };
}

async function resolveVoice(apiKey) {
  const { voices } = getAzureUrls();
  const response = await request(voices, { headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'User-Agent': USER_AGENT } });
  const data = await response.json();
  const candidates = Array.isArray(data) ? data.filter((voice) => voice?.Locale === LANGUAGE && typeof voice?.ShortName === 'string') : [];
  if (!candidates.length) throw new Error(`Azure Speech returned no ${LANGUAGE} voices for region ${REGION}.`);
  return candidates.find((voice) => voice.ShortName === DEFAULT_VOICE)?.ShortName
    || candidates.find((voice) => voice.ShortName === 'ar-SA-HamedNeural')?.ShortName
    || candidates[0].ShortName;
}

async function throttleSynthesis() {
  const elapsed = Date.now() - lastSynthesisAt;
  if (lastSynthesisAt && elapsed < MIN_SYNTHESIS_INTERVAL_MS) await sleep(MIN_SYNTHESIS_INTERVAL_MS - elapsed);
  lastSynthesisAt = Date.now();
}

async function synthesize(apiKey, voice, text) {
  await throttleSynthesis();
  const { synthesize } = getAzureUrls();
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${LANGUAGE}"><voice name="${escapeXml(voice)}"><prosody rate="${escapeXml(SYNTHESIS_RATE)}">${escapeXml(text)}</prosody></voice></speak>`;
  if (byteLength(ssml) >= 64000) throw new Error('Azure SSML request exceeds the 64 KB real-time synthesis limit.');
  const response = await request(synthesize, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/ssml+xml; charset=utf-8',
      'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
      'User-Agent': USER_AGENT,
    },
    body: ssml,
  });
  return Buffer.from(await response.arrayBuffer());
}

async function loadPosts() {
  const files = (await readdir(POSTS_DIR)).filter((name) => name.endsWith('.md')).sort();
  const posts = [];
  for (const name of files) {
    const source = await readFile(path.join(POSTS_DIR, name), 'utf8');
    const post = parsePost(source, name);
    if (post.draft) continue;
    const id = name.replace(/\.md$/, '');
    const spokenBody = optimizeForSpeech(stripMarkdown(post.body));
    const spokenText = optimizeForSpeech(`${post.title}. ${spokenBody}`);
    const chunks = splitByBytes(spokenText);
    if (!spokenText || !chunks.length) throw new Error(`${name}: no speech text after cleanup.`);
    if (chunks.some((chunk) => byteLength(chunk) > MAX_REQUEST_BYTES)) throw new Error(`${name}: a TTS chunk exceeds ${MAX_REQUEST_BYTES} bytes.`);
    posts.push({ id, title: post.title, spokenText, chunks, key: audioKeyFor(id) });
  }
  return posts;
}

async function hasCompleteCache(post, hash) {
  const dir = path.join(AUDIO_ROOT, post.key);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!await exists(manifestPath)) return false;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.sourceHash !== hash || manifest.generatorVersion !== GENERATOR_VERSION || manifest.provider !== 'Microsoft Azure AI Speech' || manifest.language !== LANGUAGE || !Array.isArray(manifest.parts) || !manifest.parts.length) return false;
    for (const part of manifest.parts) {
      if (!await exists(path.join(ROOT, 'public', part.src.replace(/^\//, '')))) return false;
    }
    return true;
  } catch { return false; }
}

async function restoreFromProduction(post) {
  const manifestUrl = `${CACHE_ORIGIN}/audio/articles/${post.key}/manifest.json`;
  let response;
  try { response = await fetch(manifestUrl, { headers: { 'User-Agent': USER_AGENT } }); }
  catch { return false; }
  if (!response.ok) return false;
  let manifest;
  try { manifest = await response.json(); } catch { return false; }
  if (manifest.sourceHash !== post.sourceHash || manifest.generatorVersion !== GENERATOR_VERSION || manifest.provider !== 'Microsoft Azure AI Speech' || manifest.model !== 'Neural TTS' || manifest.language !== LANGUAGE || !Array.isArray(manifest.parts) || !manifest.parts.length) return false;
  if (!manifest.parts.every((part) => typeof part?.src === 'string' && part.src.startsWith(`/audio/articles/${post.key}/`) && part.src.endsWith('.mp3'))) return false;

  const finalDir = path.join(AUDIO_ROOT, post.key);
  const tempDir = `${finalDir}.restore-${process.pid}`;
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  try {
    for (const part of manifest.parts) {
      const audioResponse = await fetch(`${CACHE_ORIGIN}${part.src}`, { headers: { 'User-Agent': USER_AGENT } });
      if (!audioResponse.ok) throw new Error(`HTTP ${audioResponse.status}`);
      const bytes = Buffer.from(await audioResponse.arrayBuffer());
      if (bytes.length < 100) throw new Error('Cached MP3 is unexpectedly small.');
      await writeFile(path.join(tempDir, path.basename(part.src)), bytes);
    }
    await writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rm(finalDir, { recursive: true, force: true });
    await rename(tempDir, finalDir);
    return true;
  } catch {
    await rm(tempDir, { recursive: true, force: true });
    return false;
  }
}

const posts = await loadPosts();
const totalChars = posts.reduce((sum, post) => sum + [...post.spokenText].length, 0);
const totalBytes = posts.reduce((sum, post) => sum + byteLength(post.spokenText), 0);
const totalRequests = posts.reduce((sum, post) => sum + post.chunks.length, 0);

if (PLAN_ONLY) {
  console.log(`Azure AI Speech audio plan: ${posts.length} articles, ${totalRequests} synthesis request(s), ${totalChars} characters, ${totalBytes} UTF-8 bytes.`);
  for (const post of posts) console.log(`- ${post.id}: ${post.chunks.length} part(s), ${[...post.spokenText].length} chars`);
  process.exit(0);
}

await mkdir(AUDIO_ROOT, { recursive: true });
const prepared = posts.map((post) => ({
  ...post,
  sourceHash: sha(JSON.stringify({ generatorVersion: GENERATOR_VERSION, provider: 'azure', region: REGION, language: LANGUAGE, voice: DEFAULT_VOICE, rate: SYNTHESIS_RATE, outputFormat: OUTPUT_FORMAT, text: post.spokenText })),
}));

let missing = [];
for (const post of prepared) if (!await hasCompleteCache(post, post.sourceHash)) missing.push(post);

if (missing.length) {
  const stillMissing = [];
  for (const post of missing) {
    if (await restoreFromProduction(post)) console.log(`↺ ${post.id}: restored unchanged Azure audio from production cache.`);
    else stillMissing.push(post);
  }
  missing = stillMissing;
}

if (!API_KEY && missing.length) {
  throw new Error(`AZURE_SPEECH_KEY is required to generate Azure Speech audio for ${missing.length} new or changed article(s). Existing unchanged audio is restored automatically from ${CACHE_ORIGIN}. Add AZURE_SPEECH_KEY as a Production Secret in Cloudflare Pages. AZURE_SPEECH_REGION and AZURE_SPEECH_ENDPOINT are optional overrides; eastus defaults are built in.`);
}

if (!missing.length) {
  console.log(`Azure AI Speech audio cache is complete for ${posts.length} articles.`);
  process.exit(0);
}

const voice = await resolveVoice(API_KEY);
console.log(`Generating Azure AI Speech (${LANGUAGE}) with ${voice} in ${REGION} for ${missing.length} article(s).`);

for (const post of missing) {
  const finalDir = path.join(AUDIO_ROOT, post.key);
  const tempDir = `${finalDir}.tmp-${process.pid}`;
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  const parts = [];
  try {
    for (let index = 0; index < post.chunks.length; index += 1) {
      const filename = `part-${String(index + 1).padStart(3, '0')}-${post.sourceHash.slice(0, 8)}.mp3`;
      const audio = await synthesize(API_KEY, voice, post.chunks[index]);
      if (audio.length < 100) throw new Error(`${post.id}: generated MP3 ${filename} is unexpectedly small.`);
      await writeFile(path.join(tempDir, filename), audio);
      parts.push({
        src: `/audio/articles/${post.key}/${filename}`,
        characters: [...post.chunks[index]].length,
        bytes: audio.length,
      });
    }
    const manifest = {
      version: 1,
      generatorVersion: GENERATOR_VERSION,
      provider: 'Microsoft Azure AI Speech',
      model: 'Neural TTS',
      language: LANGUAGE,
      voice,
      region: REGION,
      outputFormat: OUTPUT_FORMAT,
      articleId: post.id,
      title: post.title,
      sourceHash: post.sourceHash,
      parts,
    };
    await writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rm(finalDir, { recursive: true, force: true });
    await rename(tempDir, finalDir);
    console.log(`✓ ${post.id}: ${parts.length} MP3 part(s)`);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

console.log(`Azure AI Speech audio ready: ${posts.length} article(s).`);
