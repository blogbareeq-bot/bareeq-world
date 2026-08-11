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
const OUTPUT_FORMAT = 'audio-48khz-96kbitrate-mono-mp3';
const PLAN_ONLY = process.argv.includes('--plan');
const SYNC_PLAN_ONLY = process.argv.includes('--sync-plan');
const SPEECH_QA_JSON = process.argv.includes('--speech-qa-json') || process.argv.some((arg) => arg.startsWith('--speech-qa-output='));
const SPEECH_QA_OUTPUT = process.argv.find((arg) => arg.startsWith('--speech-qa-output='))?.slice('--speech-qa-output='.length) || '';
const MAX_REQUEST_BYTES = 6000; // smaller parts keep Azure responses compact and resilient on CI/mobile-oriented builds.
const MIN_SYNTHESIS_INTERVAL_MS = Number(process.env.AZURE_SPEECH_MIN_INTERVAL_MS || '3200'); // F0 allows 20 synthesis transactions per rolling 60 seconds.
const GENERATOR_VERSION = 5;
const AZURE_FREE_MONTHLY_CHARS = Number(process.env.AZURE_SPEECH_FREE_MONTHLY_CHARS || '500000');
const BUILD_WARNING_CHARS = Number(process.env.AZURE_SPEECH_BUILD_WARNING_CHARS || '400000');
const BUILD_HARD_LIMIT_CHARS = Number(process.env.AZURE_SPEECH_BUILD_HARD_LIMIT_CHARS || '450000');
const TTS_BASE = (process.env.AZURE_SPEECH_TTS_BASE?.trim().replace(/\/$/, '') || `https://${REGION}.tts.speech.microsoft.com`);
const CACHE_ORIGIN = (process.env.BAREEQ_AUDIO_CACHE_ORIGIN?.trim().replace(/\/$/, '') || 'https://bareeqworld.com');
const USER_AGENT = 'Bareeq-Audio-Builder/4.12.0';
const SPEECH_OVERRIDES_FILE = path.join(ROOT, 'scripts', 'speech-overrides.json');
const SPEECH_OVERRIDES = JSON.parse(await readFile(SPEECH_OVERRIDES_FILE, 'utf8'));
const SPEECH_OVERRIDES_VERSION = Number(SPEECH_OVERRIDES.version || 1);
const SPEECH_REVIEW_VERSION = Number(SPEECH_OVERRIDES.reviewVersion || 1);

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

function stripReferences(body) {
  return body.replace(/\n##\s+(?:المصادر(?:\s+والتحقق|\s+والقراءة\s+الإضافية)?|المراجع|References?)\b[\s\S]*$/i, '').trim();
}

function cleanInlineMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\([^)]*https?:\/\/[^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+([،؛؟.!])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeMatchText(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getSpeechReplacements(articleId) {
  const global = Array.isArray(SPEECH_OVERRIDES.global) ? SPEECH_OVERRIDES.global : [];
  const local = Array.isArray(SPEECH_OVERRIDES.articles?.[articleId]) ? SPEECH_OVERRIDES.articles[articleId] : [];
  return [...global, ...local]
    .filter((item) => typeof item?.from === 'string' && item.from && typeof item?.to === 'string')
    .sort((a, b) => b.from.length - a.from.length);
}

function applySpeechOverrides(text, articleId) {
  for (const { from, to } of getSpeechReplacements(articleId)) text = text.split(from).join(to);
  return text;
}

function optimizeForSpeech(text, articleId) {
  text = applySpeechOverrides(text, articleId);
  text = text.replace(/(\d+(?:[.,]\d+)?)\s*%/g, '$1 في المئة');
  text = text.replace(/\b(\d+)\s*[–—-]\s*(\d+)\b/g, '$1 إلى $2');
  text = text.replace(/\n+/g, '. ');
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function extractSpeechSegments(body, articleId) {
  body = stripReferences(body)
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n');

  const lines = body.split(/\r?\n/);
  const segments = [];
  let paragraph = [];
  let quote = [];
  let order = 0;

  const addSegment = (type, raw) => {
    const visibleText = cleanInlineMarkdown(raw);
    if (!visibleText || visibleText.length < 2) return;
    const match = normalizeMatchText(visibleText);
    if (!match) return;
    order += 1;
    segments.push({
      id: `b${String(order).padStart(4, '0')}`,
      type,
      visibleText,
      match: match.slice(0, 120),
      spokenText: optimizeForSpeech(visibleText, articleId),
    });
  };
  const flushParagraph = () => {
    if (paragraph.length) addSegment('paragraph', paragraph.join(' '));
    paragraph = [];
  };
  const flushQuote = () => {
    if (quote.length) addSegment('quote', quote.join(' '));
    quote = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushQuote();
      continue;
    }
    if (/^\|.*\|$/.test(trimmed) || /^[-:| ]{3,}$/.test(trimmed)) {
      flushParagraph();
      flushQuote();
      continue;
    }
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(trimmed)) {
      flushParagraph();
      flushQuote();
      continue;
    }
    const heading = trimmed.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushQuote();
      addSegment(`h${heading[1].length}`, heading[2]);
      continue;
    }
    const listItem = trimmed.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (listItem) {
      flushParagraph();
      flushQuote();
      addSegment('list-item', listItem[1]);
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      quote.push(trimmed.replace(/^>\s?/, ''));
      continue;
    }
    if (quote.length) flushQuote();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushQuote();
  return segments;
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

function estimateSpeechWeight(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const letters = [...text.replace(/\s/g, '')].length;
  const strongPauses = (text.match(/[.!؟]/g) || []).length;
  const mediumPauses = (text.match(/[،؛:]/g) || []).length;
  return Math.max(1, words + letters / 22 + strongPauses * 1.1 + mediumPauses * 0.45);
}

function joinSpeechPieces(items) {
  let text = '';
  for (const item of items) {
    if (!text) text = item.text;
    else text += /[.!؟؛:]$/.test(text) ? ` ${item.text}` : `. ${item.text}`;
  }
  return text.trim();
}

function buildAudioParts(title, segments, articleId) {
  const items = [{ segmentId: null, type: 'title', match: '', text: optimizeForSpeech(title, articleId) }];
  for (const segment of segments) {
    const pieces = splitByBytes(segment.spokenText);
    for (const text of pieces) items.push({ segmentId: segment.id, type: segment.type, match: segment.match, text });
  }

  const parts = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const text = joinSpeechPieces(current);
    const weights = current.map((item) => estimateSpeechWeight(item.text));
    const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let elapsed = 0;
    const sync = [];
    for (let index = 0; index < current.length; index += 1) {
      const item = current[index];
      const start = elapsed / total;
      elapsed += weights[index];
      const end = elapsed / total;
      if (!item.segmentId) continue;
      const previous = sync[sync.length - 1];
      if (previous?.id === item.segmentId) previous.end = Number(end.toFixed(6));
      else sync.push({
        id: item.segmentId,
        type: item.type,
        match: item.match,
        start: Number(start.toFixed(6)),
        end: Number(end.toFixed(6)),
      });
    }
    parts.push({ text, items: current, sync });
    current = [];
  };

  for (const item of items) {
    const candidate = joinSpeechPieces([...current, item]);
    if (current.length && byteLength(candidate) > MAX_REQUEST_BYTES) flush();
    current.push(item);
    if (byteLength(joinSpeechPieces(current)) > MAX_REQUEST_BYTES) {
      const overflow = current.pop();
      flush();
      current = [overflow];
    }
  }
  flush();
  return parts;
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
}

const MAX_FETCH_RETRIES = Number(process.env.AZURE_SPEECH_MAX_RETRIES || '5');

function retryDelay(attempt, response = null) {
  const retryAfter = response ? Number(response.headers.get('retry-after')) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return Math.min(30000, 1500 * (2 ** attempt));
}

function transportCode(error) {
  return error?.cause?.code || error?.code || '';
}

function isRetryableTransportError(error) {
  const code = transportCode(error);
  return error instanceof TypeError
    || ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(code);
}

async function request(url, options = {}, attempt = 0) {
  try {
    const response = await fetch(url, options);
    if (response.ok) return response;
    const body = await response.text().catch(() => '');
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_FETCH_RETRIES) {
      const wait = retryDelay(attempt, response);
      console.warn(`Azure request HTTP ${response.status}; retry ${attempt + 1}/${MAX_FETCH_RETRIES} in ${wait}ms.`);
      await sleep(wait);
      return request(url, options, attempt + 1);
    }
    throw new Error(`Azure Speech request failed (${response.status}): ${body.slice(0, 700)}`);
  } catch (error) {
    if (attempt < MAX_FETCH_RETRIES && isRetryableTransportError(error)) {
      const wait = retryDelay(attempt);
      console.warn(`Azure request transport error ${transportCode(error) || error.name}; retry ${attempt + 1}/${MAX_FETCH_RETRIES} in ${wait}ms.`);
      await sleep(wait);
      return request(url, options, attempt + 1);
    }
    throw error;
  }
}

async function requestBinary(url, options = {}, { attempt = 0, throttle = false, label = 'binary request' } = {}) {
  try {
    if (throttle) await throttleSynthesis();
    const response = await fetch(url, options);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_FETCH_RETRIES) {
        const wait = retryDelay(attempt, response);
        console.warn(`${label} HTTP ${response.status}; retry ${attempt + 1}/${MAX_FETCH_RETRIES} in ${wait}ms.`);
        await sleep(wait);
        return requestBinary(url, options, { attempt: attempt + 1, throttle, label });
      }
      throw new Error(`Azure Speech request failed (${response.status}): ${body.slice(0, 700)}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 100) throw new Error(`${label}: response is unexpectedly small (${bytes.length} bytes).`);
    return bytes;
  } catch (error) {
    if (attempt < MAX_FETCH_RETRIES && isRetryableTransportError(error)) {
      const wait = retryDelay(attempt);
      console.warn(`${label} transport error ${transportCode(error) || error.name}; retry ${attempt + 1}/${MAX_FETCH_RETRIES} in ${wait}ms.`);
      await sleep(wait);
      return requestBinary(url, options, { attempt: attempt + 1, throttle, label });
    }
    throw error;
  }
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

async function synthesize(apiKey, voice, part) {
  const { synthesize } = getAzureUrls();
  const paragraphs = part.items.map((item) => {
    const body = `<prosody rate="${escapeXml(SYNTHESIS_RATE)}">${escapeXml(item.text)}</prosody>`;
    if (item.type === 'title') return `<p>${body}<break time="260ms"/></p>`;
    if (/^h\d$/.test(item.type)) return `<p><break time="160ms"/>${body}<break time="180ms"/></p>`;
    return `<p>${body}</p>`;
  }).join('');
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${LANGUAGE}"><voice name="${escapeXml(voice)}">${paragraphs}</voice></speak>`;
  if (byteLength(ssml) >= 64000) throw new Error('Azure SSML request exceeds the 64 KB real-time synthesis limit.');
  return requestBinary(synthesize, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/ssml+xml; charset=utf-8',
      'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
      'User-Agent': USER_AGENT,
    },
    body: ssml,
  }, { throttle: true, label: 'Azure synthesis' });
}

async function loadPosts() {
  const files = (await readdir(POSTS_DIR)).filter((name) => name.endsWith('.md')).sort();
  const posts = [];
  for (const name of files) {
    const source = await readFile(path.join(POSTS_DIR, name), 'utf8');
    const post = parsePost(source, name);
    if (post.draft) continue;
    const id = name.replace(/\.md$/, '');
    const segments = extractSpeechSegments(post.body, id);
    const audioParts = buildAudioParts(post.title, segments, id);
    const spokenText = joinSpeechPieces(audioParts.map((part) => ({ text: part.text })));
    if (!spokenText || !audioParts.length || !segments.length) throw new Error(`${name}: no speech text after cleanup.`);
    if (audioParts.some((part) => byteLength(part.text) > MAX_REQUEST_BYTES)) throw new Error(`${name}: a TTS part exceeds ${MAX_REQUEST_BYTES} bytes.`);
    posts.push({ id, title: post.title, spokenText, segments, audioParts, key: audioKeyFor(id) });
  }
  return posts;
}

async function hasCompleteCache(post, hash) {
  const dir = path.join(AUDIO_ROOT, post.key);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!await exists(manifestPath)) return false;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.sourceHash !== hash || manifest.generatorVersion !== GENERATOR_VERSION || manifest.provider !== 'Microsoft Azure AI Speech' || manifest.language !== LANGUAGE || manifest.syncVersion !== 1 || !Array.isArray(manifest.parts) || !manifest.parts.length) return false;
    if (!manifest.parts.every((part) => Array.isArray(part.sync))) return false;
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
  if (manifest.sourceHash !== post.sourceHash || manifest.generatorVersion !== GENERATOR_VERSION || manifest.provider !== 'Microsoft Azure AI Speech' || manifest.model !== 'Neural TTS' || manifest.language !== LANGUAGE || manifest.syncVersion !== 1 || !Array.isArray(manifest.parts) || !manifest.parts.length) return false;
  if (!manifest.parts.every((part) => Array.isArray(part.sync))) return false;
  if (!manifest.parts.every((part) => typeof part?.src === 'string' && part.src.startsWith(`/audio/articles/${post.key}/`) && part.src.endsWith('.mp3'))) return false;

  const finalDir = path.join(AUDIO_ROOT, post.key);
  const tempDir = `${finalDir}.restore-${process.pid}`;
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  try {
    for (const part of manifest.parts) {
      const bytes = await requestBinary(`${CACHE_ORIGIN}${part.src}`, { headers: { 'User-Agent': USER_AGENT } }, { label: 'Production audio cache download' });
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
const totalRequests = posts.reduce((sum, post) => sum + post.audioParts.length, 0);

if (SYNC_PLAN_ONLY) {
  console.log(JSON.stringify(posts.map((post) => ({ id: post.id, segments: post.segments.map(({ id, type, match }) => ({ id, type, matchLength: match.length })), parts: post.audioParts.map((part) => ({ sync: part.sync.map(({ id, start, end }) => ({ id, start, end })) })) })), null, 2));
  process.exit(0);
}

if (SPEECH_QA_JSON) {
  const payload = JSON.stringify(posts.map((post) => ({
    id: post.id,
    title: post.title,
    segments: post.segments.map(({ id, type, visibleText, spokenText }) => ({ id, type, visibleText, spokenText })),
    spokenText: post.spokenText
  })), null, 2) + '\n';
  if (SPEECH_QA_OUTPUT) await writeFile(path.resolve(ROOT, SPEECH_QA_OUTPUT), payload);
  else console.log(payload.trimEnd());
  process.exit(0);
}

if (PLAN_ONLY) {
  console.log(`Azure AI Speech audio plan: ${posts.length} articles, ${totalRequests} synthesis request(s), ${totalChars} characters, ${totalBytes} UTF-8 bytes.`);
  for (const post of posts) console.log(`- ${post.id}: ${post.audioParts.length} part(s), ${post.segments.length} sync block(s), ${[...post.spokenText].length} chars`);
  process.exit(0);
}

await mkdir(AUDIO_ROOT, { recursive: true });
const prepared = posts.map((post) => ({
  ...post,
  sourceHash: sha(JSON.stringify({ generatorVersion: GENERATOR_VERSION, speechOverridesVersion: SPEECH_OVERRIDES_VERSION, provider: 'azure', region: REGION, language: LANGUAGE, voice: DEFAULT_VOICE, rate: SYNTHESIS_RATE, outputFormat: OUTPUT_FORMAT, text: post.spokenText, sync: post.audioParts.map((part) => part.sync) })),
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

const missingChars = missing.reduce((sum, post) => sum + [...post.spokenText].length, 0);
const missingRequests = missing.reduce((sum, post) => sum + post.audioParts.length, 0);
const percent = AZURE_FREE_MONTHLY_CHARS > 0 ? (missingChars / AZURE_FREE_MONTHLY_CHARS) * 100 : 0;
console.log(`Azure Speech cost guard: this build needs ${missingChars.toLocaleString('en-US')} new synthesis character(s) across ${missingRequests} request(s), about ${percent.toFixed(1)}% of the configured ${AZURE_FREE_MONTHLY_CHARS.toLocaleString('en-US')} monthly allowance.`);
console.log('Note: this is a per-build estimate, not Azure account monthly usage. Unchanged published audio is restored and does not consume new synthesis characters.');
if (BUILD_WARNING_CHARS > 0 && missingChars >= BUILD_WARNING_CHARS) {
  console.warn(`⚠ Azure Speech usage warning: this build will synthesize ${missingChars.toLocaleString('en-US')} characters (warning threshold: ${BUILD_WARNING_CHARS.toLocaleString('en-US')}).`);
}
if (BUILD_HARD_LIMIT_CHARS > 0 && missingChars > BUILD_HARD_LIMIT_CHARS) {
  throw new Error(`Azure Speech safety stop: this build would synthesize ${missingChars.toLocaleString('en-US')} characters, above the configured hard limit of ${BUILD_HARD_LIMIT_CHARS.toLocaleString('en-US')}. Raise AZURE_SPEECH_BUILD_HARD_LIMIT_CHARS deliberately if this is expected.`);
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
    for (let index = 0; index < post.audioParts.length; index += 1) {
      const audioPart = post.audioParts[index];
      const filename = `part-${String(index + 1).padStart(3, '0')}-${post.sourceHash.slice(0, 8)}.mp3`;
      const audio = await synthesize(API_KEY, voice, audioPart);
      if (audio.length < 100) throw new Error(`${post.id}: generated MP3 ${filename} is unexpectedly small.`);
      await writeFile(path.join(tempDir, filename), audio);
      parts.push({
        src: `/audio/articles/${post.key}/${filename}`,
        characters: [...audioPart.text].length,
        bytes: audio.length,
        sync: audioPart.sync,
      });
    }
    const manifest = {
      version: 2,
      generatorVersion: GENERATOR_VERSION,
      syncVersion: 1,
      speechOverridesVersion: SPEECH_OVERRIDES_VERSION,
      speechReviewVersion: SPEECH_REVIEW_VERSION,
      provider: 'Microsoft Azure AI Speech',
      model: 'Neural TTS',
      language: LANGUAGE,
      voice,
      region: REGION,
      outputFormat: OUTPUT_FORMAT,
      articleId: post.id,
      title: post.title,
      sourceHash: post.sourceHash,
      syncMethod: 'paragraph-weighted',
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
