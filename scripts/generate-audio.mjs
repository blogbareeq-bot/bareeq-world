import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mp3DurationSeconds } from './mp3-duration.mjs';
import {
  CLOUD_TTS_AUDIO_ENCODING,
  CLOUD_TTS_LANGUAGE,
  CLOUD_TTS_MODEL,
  CLOUD_TTS_STYLE,
  CLOUD_TTS_VOICE,
  assertCloudTtsActivation,
  buildCloudTtsRequest,
  extractCloudTtsMp3,
  getCloudTtsAccessToken,
  hasCloudTtsCredentials,
} from './cloud-tts.mjs';
import {
  extractArticleSpeechModel,
  readAmbiguityRules,
  readSpeechScript,
  readTestClipPlan,
  splitReferenceSection,
  validateSpeechScript,
  verifyTestClipEvidence,
} from './speech-script-core.mjs';
import { assertSynthesisAllowed, evaluateSynthesisReadiness } from './speech-synthesis-gate.mjs';
import { buildGeminiPrompt, GEMINI_STYLE, LEGACY_GEMINI_STYLE } from './speech-prompt.mjs';

let ffmpegInstaller = null;
try { ffmpegInstaller = (await import('@ffmpeg-installer/ffmpeg')).default; }
catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const ROOT = process.cwd();
const POSTS_DIR = path.join(ROOT, 'src', 'content', 'posts');
const AUDIO_ROOT = path.join(ROOT, 'public', 'audio', 'articles');
const PROVIDER = process.env.BAREEQ_TTS_PROVIDER?.trim().toLowerCase() || 'bundled';
if (!['bundled', 'gemini', 'google-cloud', 'openai', 'azure'].includes(PROVIDER)) throw new Error('BAREEQ_TTS_PROVIDER must be bundled, gemini, google-cloud, openai, or azure.');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const AZURE_API_KEY = process.env.AZURE_SPEECH_KEY?.trim();
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT?.trim() || 'bareeq-tts';
const REGION = process.env.AZURE_SPEECH_REGION?.trim().toLowerCase() || 'eastus';
const RESOURCE_ENDPOINT = process.env.AZURE_SPEECH_ENDPOINT?.trim().replace(/\/$/, '') || `https://${REGION}.api.cognitive.microsoft.com`;
const GEMINI_MODEL = 'gemini-3.1-flash-tts-preview';
const GEMINI_OFFICIAL_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_API_REVISION = '2026-05-20';
const OPENAI_MODEL = 'gpt-4o-mini-tts-2025-12-15';
const OPENAI_OFFICIAL_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const OPENAI_STYLE = 'اقرأ بالعربية الفصحى الطبيعية بصوت معرفي بشري هادئ، مع وضوح كامل ووقفات تخدم المعنى وإيقاع مريح لمقال طويل، ومن دون مبالغة تمثيلية أو نبرة إعلانية.';
const CONTRACT_TEST = process.env.BAREEQ_TTS_CONTRACT_TEST === '1';
const openAiContractEndpoint = process.env.OPENAI_TTS_ENDPOINT?.trim();
const geminiContractEndpoint = process.env.GEMINI_TTS_ENDPOINT?.trim();
if (openAiContractEndpoint && !CONTRACT_TEST) throw new Error('OPENAI_TTS_ENDPOINT is restricted to the explicit local contract test.');
if (geminiContractEndpoint && !CONTRACT_TEST) throw new Error('GEMINI_TTS_ENDPOINT is restricted to the explicit local contract test.');
for (const contractEndpoint of [openAiContractEndpoint, geminiContractEndpoint].filter(Boolean)) {
  const parsed = new URL(contractEndpoint);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('A contract-test TTS endpoint must be local HTTP.');
}
const OPENAI_ENDPOINT = openAiContractEndpoint || OPENAI_OFFICIAL_ENDPOINT;
const GEMINI_ENDPOINT = geminiContractEndpoint || GEMINI_OFFICIAL_ENDPOINT;
const LANGUAGE = PROVIDER === 'azure' ? 'ar-SA' : PROVIDER === 'google-cloud' ? CLOUD_TTS_LANGUAGE : 'ar';
const SYNTHESIS_RATE = process.env.AZURE_SPEECH_SYNTHESIS_RATE?.trim() || '0%';
const OUTPUT_FORMAT = ['openai', 'google-cloud'].includes(PROVIDER) ? 'mp3' : ['gemini', 'azure'].includes(PROVIDER) ? 'audio-48khz-96kbitrate-mono-mp3' : 'mixed-mp3';
const MODEL = PROVIDER === 'gemini' ? GEMINI_MODEL : PROVIDER === 'google-cloud' ? CLOUD_TTS_MODEL : PROVIDER === 'openai' ? OPENAI_MODEL : PROVIDER === 'azure' ? 'Neural TTS' : 'Approved offline releases';
const PROVIDER_NAME = PROVIDER === 'gemini' ? 'Google Gemini API' : PROVIDER === 'google-cloud' ? 'Google Cloud Text-to-Speech' : PROVIDER === 'openai' ? 'OpenAI' : PROVIDER === 'azure' ? 'Microsoft Azure AI Speech' : 'Bundled Cedar + Azure Hamed';
const VOICES = PROVIDER === 'gemini'
  ? [
      { id: 'sadaltager', label: 'سادالتاجر (Sadaltager)', providerVoice: 'Sadaltager', description: 'معرفي طبيعي مناسب لمقالات بريق' },
    ]
  : PROVIDER === 'google-cloud'
  ? [
      { id: 'sadaltager', label: 'سادالتاجر', providerVoice: CLOUD_TTS_VOICE, description: 'صوت معرفي عربي متزامن مع النص' },
    ]
  : PROVIDER === 'openai'
  ? [
      { id: 'cedar', label: 'سيدر (Cedar)', providerVoice: 'cedar', description: 'هادئ وواضح' },
      { id: 'marin', label: 'مارين (Marin)', providerVoice: 'marin', description: 'دافئ وطبيعي' },
    ]
  : PROVIDER === 'azure' ? [
      { id: 'hamed', label: 'حامد', providerVoice: 'ar-SA-HamedNeural', description: 'صوت سعودي رجالي' },
      { id: 'zariyah', label: 'زارية', providerVoice: 'ar-SA-ZariyahNeural', description: 'صوت سعودي نسائي' },
    ] : [];
const PLAN_ONLY = process.argv.includes('--plan');
const SYNC_PLAN_ONLY = process.argv.includes('--sync-plan');
const LEGACY_AUDIO_VALIDATION = process.argv.includes('--legacy-audio-validation');
if (LEGACY_AUDIO_VALIDATION && !SYNC_PLAN_ONLY) throw new Error('--legacy-audio-validation is restricted to the read-only --sync-plan command.');
const SPEECH_QA_JSON = process.argv.includes('--speech-qa-json') || process.argv.some((arg) => arg.startsWith('--speech-qa-output='));
const SPEECH_QA_OUTPUT = process.argv.find((arg) => arg.startsWith('--speech-qa-output='))?.slice('--speech-qa-output='.length) || '';
const ALLOW_PARTIAL = process.env.BAREEQ_AUDIO_ALLOW_PARTIAL === '1';
const CACHE_ONLY = process.env.BAREEQ_TTS_CACHE_ONLY === '1';
const CACHE_ALLOW_MISSING = process.env.BAREEQ_TTS_CACHE_ALLOW_MISSING === '1';
const MAX_MISSING_ARTICLES_PER_BUILD = Number(process.env.BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD || '0');
const MAX_REQUEST_BYTES = PROVIDER === 'gemini' ? Number(process.env.GEMINI_TTS_MAX_REQUEST_BYTES || '2400') : PROVIDER === 'google-cloud' ? Number(process.env.GOOGLE_CLOUD_TTS_MAX_REQUEST_BYTES || '3200') : PROVIDER === 'azure' ? 6000 : 4800;
const MIN_SYNTHESIS_INTERVAL_MS = Number(PROVIDER === 'gemini' ? (process.env.GEMINI_TTS_MIN_INTERVAL_MS || '9000') : PROVIDER === 'google-cloud' ? (process.env.GOOGLE_CLOUD_TTS_MIN_INTERVAL_MS || '500') : PROVIDER === 'openai' ? (process.env.OPENAI_TTS_MIN_INTERVAL_MS || '200') : PROVIDER === 'azure' ? (process.env.AZURE_SPEECH_MIN_INTERVAL_MS || '3200') : '0');
const GENERATOR_VERSION = 8;
const CLOUD_TTS_INTEGRATION_VERSION = 1;
const AZURE_FREE_MONTHLY_CHARS = Number(process.env.AZURE_SPEECH_FREE_MONTHLY_CHARS || '500000');
const BUILD_WARNING_CHARS = Number(process.env.AZURE_SPEECH_BUILD_WARNING_CHARS || '400000');
const BUILD_HARD_LIMIT_CHARS = Number(process.env.AZURE_SPEECH_BUILD_HARD_LIMIT_CHARS || '450000');
const AZURE_MONTHLY_USED_CHARS = process.env.AZURE_SPEECH_MONTHLY_USED_CHARS?.trim() === '' || process.env.AZURE_SPEECH_MONTHLY_USED_CHARS == null ? null : Number(process.env.AZURE_SPEECH_MONTHLY_USED_CHARS);
const AZURE_MONTHLY_WARNING_CHARS = Number(process.env.AZURE_SPEECH_MONTHLY_WARNING_CHARS || '400000');
const CLOUD_TTS_REQUEST_HARD_LIMIT = Number(process.env.BAREEQ_CLOUD_TTS_MAX_REQUESTS_PER_BUILD || '100');
const CLOUD_TTS_CHARACTER_HARD_LIMIT = Number(process.env.BAREEQ_CLOUD_TTS_MAX_CHARS_PER_BUILD || '120000');
const OPENAI_BUILD_WARNING_USD = Number(process.env.OPENAI_TTS_BUILD_WARNING_USD || '8');
const OPENAI_BUILD_HARD_LIMIT_USD = Number(process.env.OPENAI_TTS_BUILD_HARD_LIMIT_USD || '12');
const OPENAI_ARABIC_CHARS_PER_SECOND = Number(process.env.OPENAI_TTS_ARABIC_CHARS_PER_SECOND || '11');
const OPENAI_ARABIC_CHARS_PER_TEXT_TOKEN = Number(process.env.OPENAI_TTS_ARABIC_CHARS_PER_TEXT_TOKEN || '2');
const OPENAI_AUDIO_TOKENS_PER_SECOND = Number(process.env.OPENAI_TTS_AUDIO_TOKENS_PER_SECOND || '50');
const FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || ffmpegInstaller?.path || 'ffmpeg';
const TTS_BASE = (process.env.AZURE_SPEECH_TTS_BASE?.trim().replace(/\/$/, '') || `https://${REGION}.tts.speech.microsoft.com`);
const configuredCacheOrigin = process.env.BAREEQ_AUDIO_CACHE_ORIGIN?.trim().replace(/\/$/, '');
const CACHE_ORIGINS = configuredCacheOrigin
  ? [configuredCacheOrigin]
  : CONTRACT_TEST
    ? []
    : ['https://bareeq-world.pages.dev', 'https://bareeqworld.com'];
const USER_AGENT = 'Bareeq-Audio-Builder/4.21.1';
const SPEECH_OVERRIDES_FILE = path.join(ROOT, 'scripts', 'speech-overrides.json');
const SPEECH_OVERRIDES = JSON.parse(await readFile(SPEECH_OVERRIDES_FILE, 'utf8'));
const SPEECH_OVERRIDES_VERSION = Number(SPEECH_OVERRIDES.version || 1);
const SPEECH_REVIEW_VERSION = Number(SPEECH_OVERRIDES.reviewVersion || 1);
const STUDIO_MAP_FILE = path.join(ROOT, 'scripts', 'studio-audio-map.json');
const STUDIO_MAP = JSON.parse(await readFile(STUDIO_MAP_FILE, 'utf8'));
const STUDIO_ARTICLE_IDS = new Set(Object.values(STUDIO_MAP.imports || {}).map((item) => item?.articleId).filter(Boolean));
const BUNDLED_MAP_FILE = path.join(ROOT, 'scripts', 'bundled-azure-audio-map.json');
const BUNDLED_MAP = JSON.parse(await readFile(BUNDLED_MAP_FILE, 'utf8'));
const BUNDLED_BY_ARTICLE = new Map((BUNDLED_MAP.articles || []).map((item) => [item.articleId, item]));
const CONTEXTUAL_AMBIGUITY_RULES = await readAmbiguityRules(ROOT);

const encoder = new TextEncoder();
const byteLength = (value) => encoder.encode(value).byteLength;
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const audioKeyFor = (id) => sha(id).slice(0, 16);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeStdout = (value) => new Promise((resolve, reject) => {
  process.stdout.write(value, (error) => error ? reject(error) : resolve());
});
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
  return splitReferenceSection(body).spokenBody;
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

function extractSpeechSegments(body, articleId, { includeReferences = false } = {}) {
  body = (includeReferences ? body : stripReferences(body))
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

function buildAudioParts(title, segments, articleId, { titleIsApproved = false } = {}) {
  const items = [{ segmentId: null, type: 'title', match: '', text: titleIsApproved ? title : optimizeForSpeech(title, articleId) }];
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

const MAX_FETCH_RETRIES = Number(process.env.BAREEQ_TTS_MAX_RETRIES || process.env.AZURE_SPEECH_MAX_RETRIES || '8');
const GEMINI_REQUEST_HARD_LIMIT = Number(process.env.BAREEQ_GEMINI_MAX_REQUESTS_PER_BUILD || '80');
const GEMINI_SYNTHESIS_BUDGET_MS = Number(process.env.BAREEQ_GEMINI_SYNTHESIS_BUDGET_MS || '780000');
if (!Number.isFinite(MAX_FETCH_RETRIES) || MAX_FETCH_RETRIES < 0) throw new Error('BAREEQ_TTS_MAX_RETRIES must be zero or a positive number.');
if (!Number.isFinite(GEMINI_REQUEST_HARD_LIMIT) || GEMINI_REQUEST_HARD_LIMIT < 1) throw new Error('BAREEQ_GEMINI_MAX_REQUESTS_PER_BUILD must be a positive number.');
if (!Number.isFinite(GEMINI_SYNTHESIS_BUDGET_MS) || GEMINI_SYNTHESIS_BUDGET_MS < 60000) throw new Error('BAREEQ_GEMINI_SYNTHESIS_BUDGET_MS must be at least 60000ms.');
if (!Number.isInteger(MAX_MISSING_ARTICLES_PER_BUILD) || MAX_MISSING_ARTICLES_PER_BUILD < 0) throw new Error('BAREEQ_TTS_MAX_MISSING_ARTICLES_PER_BUILD must be zero or a positive integer.');
if (CACHE_ALLOW_MISSING && !CACHE_ONLY) throw new Error('BAREEQ_TTS_CACHE_ALLOW_MISSING=1 is valid only with BAREEQ_TTS_CACHE_ONLY=1.');
if (PROVIDER === 'google-cloud' && (!Number.isFinite(MAX_REQUEST_BYTES) || MAX_REQUEST_BYTES < 1000 || MAX_REQUEST_BYTES > 4000)) throw new Error('GOOGLE_CLOUD_TTS_MAX_REQUEST_BYTES must be between 1000 and 4000.');
if (!Number.isFinite(CLOUD_TTS_REQUEST_HARD_LIMIT) || CLOUD_TTS_REQUEST_HARD_LIMIT < 1) throw new Error('BAREEQ_CLOUD_TTS_MAX_REQUESTS_PER_BUILD must be a positive number.');
if (!Number.isFinite(CLOUD_TTS_CHARACTER_HARD_LIMIT) || CLOUD_TTS_CHARACTER_HARD_LIMIT < 1) throw new Error('BAREEQ_CLOUD_TTS_MAX_CHARS_PER_BUILD must be a positive number.');
if (AZURE_MONTHLY_USED_CHARS !== null && (!Number.isFinite(AZURE_MONTHLY_USED_CHARS) || AZURE_MONTHLY_USED_CHARS < 0)) throw new Error('AZURE_SPEECH_MONTHLY_USED_CHARS must be zero or a positive number when provided.');

function retryDelay(attempt, response = null, body = '') {
  const retryAfterRaw = response?.headers?.get?.('retry-after')?.trim() || '';
  const retryAfterSeconds = Number.parseFloat(retryAfterRaw);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return Math.ceil(retryAfterSeconds * 1000) + 500;
  if (retryAfterRaw) {
    const retryAt = Date.parse(retryAfterRaw);
    if (Number.isFinite(retryAt) && retryAt > Date.now()) return Math.min(90000, retryAt - Date.now() + 500);
  }
  const bodyRetry = String(body).match(/["']retryDelay["']\s*:\s*["']([0-9.]+)s["']/i);
  if (bodyRetry) return Math.ceil(Number(bodyRetry[1]) * 1000) + 500;
  const exponential = Math.min(60000, 4000 * (2 ** attempt));
  const jitter = Math.floor(Math.random() * 1500);
  return exponential + jitter;
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
      const wait = retryDelay(attempt, response, body);
      console.warn(`${PROVIDER_NAME} request HTTP ${response.status}; retry ${attempt + 1}/${MAX_FETCH_RETRIES} in ${wait}ms.`);
      await sleep(wait);
      return request(url, options, attempt + 1);
    }
    const error = new Error(`${PROVIDER_NAME} request failed (${response.status}): ${body.slice(0, 700)}`);
    error.httpStatus = response.status;
    error.responseBody = body;
    throw error;
  } catch (error) {
    if (attempt < MAX_FETCH_RETRIES && isRetryableTransportError(error)) {
      const wait = retryDelay(attempt);
      console.warn(`${PROVIDER_NAME} request transport error ${transportCode(error) || error.name}; retry ${attempt + 1}/${MAX_FETCH_RETRIES} in ${wait}ms.`);
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
        const wait = retryDelay(attempt, response, body);
        console.warn(`${label} HTTP ${response.status}; retry ${attempt + 1}/${MAX_FETCH_RETRIES} in ${wait}ms.`);
        await sleep(wait);
        return requestBinary(url, options, { attempt: attempt + 1, throttle, label });
      }
      throw new Error(`${label} failed (${response.status}): ${body.slice(0, 700)}`);
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

async function resolveAzureVoices(apiKey) {
  const { voices } = getAzureUrls();
  const response = await request(voices, { headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'User-Agent': USER_AGENT } });
  const data = await response.json();
  const candidates = Array.isArray(data) ? data.filter((voice) => voice?.Locale === LANGUAGE && typeof voice?.ShortName === 'string') : [];
  if (!candidates.length) throw new Error(`Azure Speech returned no ${LANGUAGE} voices for region ${REGION}.`);
  const available = new Set(candidates.map((voice) => voice.ShortName));
  for (const voice of VOICES) if (!available.has(voice.providerVoice)) throw new Error(`Azure Speech voice ${voice.providerVoice} is unavailable in ${REGION}.`);
  return VOICES;
}

async function throttleSynthesis() {
  const elapsed = Date.now() - lastSynthesisAt;
  if (lastSynthesisAt && elapsed < MIN_SYNTHESIS_INTERVAL_MS) await sleep(MIN_SYNTHESIS_INTERVAL_MS - elapsed);
  lastSynthesisAt = Date.now();
}

async function synthesizeAzure(apiKey, voice, part) {
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

async function synthesizeOpenAI(apiKey, voice, part) {
  return requestBinary(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      voice: voice.providerVoice,
      input: part.text,
      instructions: OPENAI_STYLE,
      response_format: 'mp3',
      speed: 1,
    }),
  }, { throttle: true, label: 'OpenAI speech synthesis' });
}

function encodeGeminiPcmToMp3(pcm) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
      '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once('error', (error) => fail(new Error(`ffmpeg could not encode Gemini PCM: ${error.message}`)));
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') fail(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`ffmpeg failed to encode Gemini PCM (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 700)}`));
        return;
      }
      const mp3 = Buffer.concat(stdout);
      if (mp3.length < 100) {
        fail(new Error(`ffmpeg returned an unexpectedly small Gemini MP3 (${mp3.length} bytes).`));
        return;
      }
      settled = true;
      resolve(mp3);
    });
    child.stdin.end(pcm);
  });
}

function extractGeminiAudio(payload) {
  const stepContent = Array.isArray(payload?.steps)
    ? payload.steps.flatMap((step) => Array.isArray(step?.content) ? step.content : [])
    : [];
  const legacyContent = Array.isArray(payload?.outputs)
    ? payload.outputs.flatMap((output) => Array.isArray(output?.content) ? output.content : [output])
    : [];
  return [...stepContent, ...legacyContent].find((block) => block?.type === 'audio' && typeof block?.data === 'string')
    || payload?.output_audio
    || payload?.outputAudio
    || null;
}

function describeGeminiResponse(payload) {
  const status = typeof payload?.status === 'string' ? payload.status : 'unknown';
  const stepTypes = Array.isArray(payload?.steps) ? payload.steps.map((step) => step?.type || 'unknown').join(',') : 'none';
  const contentTypes = Array.isArray(payload?.steps)
    ? payload.steps.flatMap((step) => Array.isArray(step?.content) ? step.content.map((block) => block?.type || 'unknown') : []).join(',')
    : 'none';
  return `status=${status}; steps=${stepTypes || 'none'}; content=${contentTypes || 'none'}`;
}

async function synthesizeGemini(apiKey, voice, part, context) {
  await throttleSynthesis();
  const response = await request(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Api-Revision': GEMINI_API_REVISION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: buildGeminiPrompt(part, context),
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [{ voice: voice.providerVoice }],
      },
    }),
  });
  let payload;
  try { payload = await response.json(); }
  catch (error) { throw new Error(`Gemini speech synthesis returned invalid JSON: ${error.message}`); }
  const outputAudio = extractGeminiAudio(payload);
  const encoded = typeof outputAudio?.data === 'string' ? outputAudio.data.replace(/\s+/g, '') : '';
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(`Gemini speech synthesis response has no valid REST audio content (${describeGeminiResponse(payload)}).`);
  }
  const mimeType = String(outputAudio?.mime_type || outputAudio?.mimeType || '').toLowerCase();
  if (mimeType && !mimeType.includes('l16') && !mimeType.includes('pcm')) throw new Error(`Gemini speech synthesis returned unsupported audio MIME type ${mimeType}.`);
  const sampleRate = Number(outputAudio?.sample_rate || outputAudio?.sampleRate || 24000);
  const channels = Number(outputAudio?.channels || 1);
  if (sampleRate !== 24000 || channels !== 1) throw new Error(`Gemini speech synthesis returned unsupported PCM layout (${sampleRate} Hz, ${channels} channel(s)).`);
  const pcm = Buffer.from(encoded, 'base64');
  if (pcm.length < 100 || pcm.length % 2 !== 0) throw new Error(`Gemini speech synthesis returned invalid 16-bit PCM (${pcm.length} bytes).`);
  return encodeGeminiPcmToMp3(pcm);
}

async function synthesizeGoogleCloud(voice, part) {
  assertCloudTtsActivation(process.env, CONTRACT_TEST);
  await throttleSynthesis();
  const accessToken = await getCloudTtsAccessToken(process.env);
  const { url, options } = buildCloudTtsRequest({
    env: process.env,
    contractTest: CONTRACT_TEST,
    accessToken,
    projectId: GOOGLE_CLOUD_PROJECT,
    text: part.text,
    prompt: CLOUD_TTS_STYLE,
    userAgent: USER_AGENT,
  });
  const response = await request(url, options);
  let payload;
  try { payload = await response.json(); }
  catch (error) { throw new Error(`Google Cloud TTS returned invalid JSON: ${error.message}`); }
  if (voice.providerVoice !== CLOUD_TTS_VOICE) throw new Error(`Unexpected Google Cloud TTS voice: ${voice.providerVoice}`);
  return extractCloudTtsMp3(payload);
}

async function synthesizeVoice(apiKey, voice, part, context) {
  if (PROVIDER === 'gemini') return synthesizeGemini(apiKey, voice, part, context);
  if (PROVIDER === 'google-cloud') return synthesizeGoogleCloud(voice, part);
  if (PROVIDER === 'openai') return synthesizeOpenAI(apiKey, voice, part);
  return synthesizeAzure(apiKey, voice.providerVoice, part);
}

async function loadPosts() {
  const files = (await readdir(POSTS_DIR)).filter((name) => name.endsWith('.md')).sort();
  const posts = [];
  for (const name of files) {
    const source = await readFile(path.join(POSTS_DIR, name), 'utf8');
    const post = parsePost(source, name);
    if (post.draft) continue;
    const id = name.replace(/\.md$/, '');
    const speechModel = extractArticleSpeechModel({ articleId: id, source, filename: name });
    const speechScript = await readSpeechScript(id, ROOT);
    const speechValidation = validateSpeechScript(speechModel, speechScript, CONTEXTUAL_AMBIGUITY_RULES, { requireReviews: false });
    const testClipPlan = await readTestClipPlan(id, ROOT);
    const testClipEvidenceVerified = await verifyTestClipEvidence(testClipPlan, ROOT);
    const useLegacyPublishedInput = LEGACY_AUDIO_VALIDATION || PROVIDER === 'bundled' || CACHE_ONLY;
    let title = post.title;
    let segments;
    let audioParts;
    let speechInput;

    if (useLegacyPublishedInput) {
      // Existing bundled/static audio is immutable in this migration. Its manifests
      // retain the historical segment plan (including any already-published source
      // appendix). Every future synthesis provider uses the reviewed Speech Script.
      segments = extractSpeechSegments(post.body, id, { includeReferences: true });
      audioParts = buildAudioParts(post.title, segments, id);
      speechInput = 'legacy-published-audio-compatibility';
    } else {
      const records = new Map((speechScript?.segments ?? []).map((segment) => [segment.segmentId, segment]));
      const titleSegment = speechModel.segments.find((segment) => segment.type === 'title');
      title = records.get(titleSegment?.segmentId)?.spokenText ?? titleSegment?.sourceText ?? post.title;
      segments = speechModel.segments.filter((segment) => segment.type !== 'title').map((segment) => {
        const record = records.get(segment.segmentId);
        return {
          id: segment.runtimeId,
          speechScriptSegmentId: segment.segmentId,
          type: segment.type,
          visibleText: segment.sourceText,
          match: segment.match,
          spokenText: record?.spokenText ?? segment.sourceText,
        };
      });
      audioParts = buildAudioParts(title, segments, id, { titleIsApproved: true });
      speechInput = 'reviewed-contextual-speech-script';
    }

    const spokenText = joinSpeechPieces(audioParts.map((part) => ({ text: part.text })));
    if (!spokenText || !audioParts.length || !segments.length) throw new Error(`${name}: no speech text after cleanup.`);
    if (audioParts.some((part) => byteLength(part.text) > MAX_REQUEST_BYTES)) throw new Error(`${name}: a TTS part exceeds ${MAX_REQUEST_BYTES} bytes.`);
    posts.push({
      id,
      title: post.title,
      spokenTitle: title,
      spokenText,
      segments,
      audioParts,
      key: audioKeyFor(id),
      speechInput,
      speechScriptHash: speechScript?.scriptHash ?? null,
      speechApproval: { model: speechModel, script: speechScript, validation: speechValidation, testClipPlan, testClipEvidenceVerified },
    });
  }
  return posts;
}

function providerFingerprint(post) {
  const reviewedSpeechInput = post.speechInput === 'reviewed-contextual-speech-script';
  return sha(JSON.stringify({
    generatorVersion: GENERATOR_VERSION,
    cloudTtsIntegrationVersion: PROVIDER === 'google-cloud' ? CLOUD_TTS_INTEGRATION_VERSION : undefined,
    speechOverridesVersion: SPEECH_OVERRIDES_VERSION,
    ...(reviewedSpeechInput ? {
      speechScriptVersion: post.speechApproval?.script?.version,
      speechScriptHash: post.speechScriptHash,
      speechInput: post.speechInput,
    } : {}),
    provider: PROVIDER,
    model: MODEL,
    region: PROVIDER === 'azure' ? REGION : PROVIDER === 'google-cloud' ? (process.env.GOOGLE_CLOUD_TTS_REGION?.trim().toLowerCase() || 'global') : undefined,
    language: LANGUAGE,
    voices: VOICES.map(({ id, providerVoice }) => ({ id, providerVoice })),
    style: PROVIDER === 'gemini' ? (reviewedSpeechInput ? GEMINI_STYLE : LEGACY_GEMINI_STYLE) : PROVIDER === 'google-cloud' ? CLOUD_TTS_STYLE : PROVIDER === 'openai' ? OPENAI_STYLE : undefined,
    rate: PROVIDER === 'azure' ? SYNTHESIS_RATE : 1,
    outputFormat: OUTPUT_FORMAT,
    text: post.spokenText,
    sync: post.audioParts.map((part) => part.sync),
  }));
}

function bundledManifestAssets(manifest, post) {
  if (PROVIDER !== 'bundled' || manifest.version !== 5 || manifest.importerVersion !== 1 || manifest.articleId !== post.id) return null;
  if (manifest.provider !== 'Microsoft Azure AI Speech' || manifest.model !== 'Neural TTS' || manifest.language !== 'ar-SA' || manifest.outputFormat !== 'audio-48khz-96kbitrate-mono-mp3') return null;
  if (manifest.syncVersion !== 1 || manifest.syncMethod !== 'paragraph-weighted-legacy' || manifest.contractTest) return null;
  const config = BUNDLED_BY_ARTICLE.get(post.id);
  if (!config || config.audioKey !== post.key || manifest.sourceHash !== config.sourceSnapshotSha256) return null;
  if (manifest.bundledRelease?.schema !== 'bareeq.bundled-azure.v1' || manifest.bundledRelease?.releaseId !== BUNDLED_MAP.releaseId || manifest.bundledRelease?.sourceManifestSha256 !== config.sourceManifestSha256 || manifest.bundledRelease?.legacySourceHash !== config.legacySourceHash) return null;
  if (manifest.defaultVoice !== 'hamed' || !Array.isArray(manifest.voices) || manifest.voices.length !== 1) return null;
  const voice = manifest.voices[0];
  if (voice?.id !== 'hamed' || voice?.providerVoice !== 'ar-SA-HamedNeural' || typeof voice?.label !== 'string' || !(voice.totalDurationSeconds > 0)) return null;
  if (!Array.isArray(manifest.parts) || manifest.parts.length !== config.parts.length) return null;

  const assets = [];
  const paths = new Set();
  const seenIds = new Set();
  let segmentIndex = 0;
  let totalDurationSeconds = 0;
  for (let partIndex = 0; partIndex < manifest.parts.length; partIndex += 1) {
    const part = manifest.parts[partIndex];
    const expected = config.parts[partIndex];
    if (!Array.isArray(part?.sync) || !part.sync.length || !part.audio || typeof part.audio !== 'object') return null;
    let previousStart = -1;
    for (const entry of part.sync) {
      const segment = post.segments[segmentIndex];
      if (!segment || entry?.id !== segment.id || entry?.type !== segment.type || entry?.match !== segment.match || seenIds.has(entry.id)) return null;
      if (!(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end) || entry.start < previousStart) return null;
      seenIds.add(entry.id);
      previousStart = entry.start;
      segmentIndex += 1;
    }
    const asset = part.audio.hamed;
    const prefix = `/audio/articles/${post.key}/releases/${BUNDLED_MAP.releaseId}/`;
    if (typeof asset?.src !== 'string' || !asset.src.startsWith(prefix) || path.basename(asset.src) !== expected.file || !asset.src.endsWith('.mp3') || paths.has(asset.src)) return null;
    if (asset.bytes !== expected.bytes || asset.sha256 !== expected.sha256 || Math.abs(asset.durationSeconds - expected.durationSeconds) > 0.1) return null;
    paths.add(asset.src);
    assets.push(asset);
    totalDurationSeconds += asset.durationSeconds;
  }
  if (segmentIndex !== post.segments.length || Math.abs(totalDurationSeconds - voice.totalDurationSeconds) > 0.1) return null;
  return assets;
}

function importedManifestAssets(manifest, post) {
  if (!['bundled', 'openai'].includes(PROVIDER) || manifest.version !== 4 || manifest.importerVersion !== 1 || manifest.articleId !== post.id || manifest.provider !== 'OpenAI' || manifest.model !== OPENAI_MODEL || manifest.language !== 'ar' || manifest.outputFormat !== 'mp3' || manifest.syncVersion !== 1 || manifest.syncMethod !== 'studio-block-timestamps') return null;
  if (!manifest.importedRelease || manifest.importedRelease.targetBareeqVersion !== 'V4.16.0' || !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.importedRelease.releaseId || '')) return null;
  if (manifest.contractTest || !Array.isArray(manifest.voices) || !manifest.voices.length || !Array.isArray(manifest.parts) || manifest.parts.length !== 1) return null;
  if (!manifest.voices.some((voice) => voice?.id === manifest.defaultVoice)) return null;

  const sync = manifest.parts[0]?.sync;
  if (!Array.isArray(sync) || !sync.length) return null;
  const seenIds = new Set();
  const sourceSnapshot = [];
  let previousStart = -1;
  for (const entry of sync) {
    if (!entry || typeof entry.id !== 'string' || seenIds.has(entry.id) || !Number.isInteger(entry.ordinal) || entry.ordinal < 0 || entry.ordinal >= post.segments.length) return null;
    const segment = post.segments[entry.ordinal];
    if (segment.id !== entry.id || segment.type !== entry.type || !(entry.start >= 0 && entry.end <= 1 && entry.start < entry.end) || entry.start < previousStart) return null;
    seenIds.add(entry.id);
    previousStart = entry.start;
    sourceSnapshot.push({ id: segment.id, type: segment.type, visibleText: segment.visibleText });
  }
  if (sha(JSON.stringify(sourceSnapshot)) !== manifest.sourceHash) return null;

  const assets = [];
  const paths = new Set();
  for (const voice of manifest.voices) {
    if (!voice?.id || !voice.providerVoice || typeof voice.label !== 'string' || !(voice.totalDurationSeconds > 0)) return null;
    const asset = manifest.parts[0].audio?.[voice.id];
    const prefix = `/audio/articles/${post.key}/releases/${manifest.importedRelease.releaseId}/`;
    if (typeof asset?.src !== 'string' || !asset.src.startsWith(prefix) || !asset.src.endsWith('.mp3') || !(asset.bytes >= 100) || !(asset.durationSeconds > 0) || paths.has(asset.src)) return null;
    paths.add(asset.src);
    assets.push(asset);
  }
  return assets;
}

function manifestAssets(manifest, post) {
  const effectiveManifestVoices = PROVIDER === 'azure' && process.env.BAREEQ_AZURE_HAMED_ONLY === '1'
    ? VOICES.filter((voice) => voice.id === 'hamed')
    : VOICES;
  const imported = importedManifestAssets(manifest, post);
  if (imported) return imported;
  const bundled = bundledManifestAssets(manifest, post);
  if (bundled) return bundled;
  if (PROVIDER === 'bundled') return null;
  if (manifest.version !== 3 || manifest.sourceHash !== post.sourceHash || manifest.generatorVersion !== GENERATOR_VERSION || manifest.provider !== PROVIDER_NAME || manifest.model !== MODEL || manifest.language !== LANGUAGE || manifest.syncVersion !== 1 || manifest.syncMethod !== 'paragraph-weighted') return null;
  if (Boolean(manifest.contractTest) !== CONTRACT_TEST || !Array.isArray(manifest.voices) || manifest.voices.length !== effectiveManifestVoices.length || !Array.isArray(manifest.parts) || !manifest.parts.length) return null;
  if (manifest.defaultVoice !== effectiveManifestVoices[0].id) return null;
  for (let index = 0; index < effectiveManifestVoices.length; index += 1) {
    const expected = effectiveManifestVoices[index];
    const actual = manifest.voices[index];
    if (actual?.id !== expected.id || actual?.providerVoice !== expected.providerVoice || typeof actual?.label !== 'string' || !(actual?.totalDurationSeconds > 0)) return null;
  }
  const assets = [];
  const paths = new Set();
  for (const part of manifest.parts) {
    if (!Array.isArray(part?.sync) || !part.audio || typeof part.audio !== 'object') return null;
    for (const voice of effectiveManifestVoices) {
      const asset = part.audio[voice.id];
      if (typeof asset?.src !== 'string' || !asset.src.startsWith(`/audio/articles/${post.key}/`) || !asset.src.endsWith('.mp3') || !(asset.bytes >= 100) || !(asset.durationSeconds > 0) || !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || paths.has(asset.src)) return null;
      paths.add(asset.src);
      assets.push(asset);
    }
  }
  return assets;
}

async function hasCompleteCache(post) {
  const dir = path.join(AUDIO_ROOT, post.key);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!await exists(manifestPath)) return false;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const assets = manifestAssets(manifest, post);
    if (!assets) return false;
    for (const asset of assets) if (!await exists(path.join(ROOT, 'public', asset.src.replace(/^\//, '')))) return false;
    return true;
  } catch { return false; }
}

async function restoreFromProductionOrigin(post, cacheOrigin) {
  const cacheHost = new URL(cacheOrigin).host;
  const manifestUrl = `${cacheOrigin}/audio/articles/${post.key}/manifest.json`;
  let response;
  try { response = await fetch(manifestUrl, { headers: { 'User-Agent': USER_AGENT } }); }
  catch (error) {
    console.warn(`↷ ${post.id}: cache manifest unavailable from ${cacheHost} (${transportCode(error) || error.name}).`);
    return false;
  }
  if (!response.ok) {
    console.warn(`↷ ${post.id}: cache manifest from ${cacheHost} returned HTTP ${response.status}.`);
    return false;
  }
  let manifest;
  try { manifest = await response.json(); }
  catch {
    console.warn(`↷ ${post.id}: cache manifest from ${cacheHost} is not valid JSON.`);
    return false;
  }
  if (manifest?.contractTest) {
    console.warn(`↷ ${post.id}: rejected contract-test cache manifest from ${cacheHost}.`);
    return false;
  }
  const assets = manifestAssets(manifest, post);
  if (!assets) {
    console.warn(`↷ ${post.id}: cache manifest from ${cacheHost} failed the locked provider/source/assets contract.`);
    return false;
  }

  const finalDir = path.join(AUDIO_ROOT, post.key);
  const tempDir = `${finalDir}.restore-${process.pid}`;
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  try {
    for (const asset of assets) {
      const bytes = await requestBinary(`${cacheOrigin}${asset.src}`, { headers: { 'User-Agent': USER_AGENT } }, { label: 'Production audio cache download' });
      if (bytes.length !== asset.bytes) throw new Error(`Cached MP3 byte-length mismatch: ${asset.src}`);
      if (sha(bytes) !== asset.sha256) throw new Error(`Cached MP3 SHA-256 mismatch: ${asset.src}`);
      const duration = mp3DurationSeconds(bytes);
      if (Math.abs(duration - asset.durationSeconds) > 2) throw new Error(`Cached MP3 duration mismatch: ${asset.src}`);
      await writeFile(path.join(tempDir, path.basename(asset.src)), bytes);
    }
    await writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rm(finalDir, { recursive: true, force: true });
    await rename(tempDir, finalDir);
    return true;
  } catch (error) {
    console.warn(`↷ ${post.id}: atomic cache restore from ${cacheHost} failed (${transportCode(error) || error.message}).`);
    await rm(tempDir, { recursive: true, force: true });
    return false;
  }
}

async function restoreFromProduction(post) {
  for (const cacheOrigin of CACHE_ORIGINS) {
    if (await restoreFromProductionOrigin(post, cacheOrigin)) return true;
  }
  return false;
}

function estimateOpenAiCost(characters, requestCount) {
  const promptCharacters = characters + OPENAI_STYLE.length * requestCount;
  const textTokens = Math.ceil(promptCharacters / Math.max(1, OPENAI_ARABIC_CHARS_PER_TEXT_TOKEN));
  const seconds = characters / Math.max(1, OPENAI_ARABIC_CHARS_PER_SECOND);
  const audioTokens = Math.ceil(seconds * Math.max(1, OPENAI_AUDIO_TOKENS_PER_SECOND));
  return {
    usd: textTokens * 0.6 / 1_000_000 + audioTokens * 12 / 1_000_000,
    estimatedSeconds: seconds,
    textTokens,
    audioTokens,
  };
}

const posts = await loadPosts();
const INCLUDE_IDS = new Set((process.env.BAREEQ_TTS_INCLUDE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
const providerPosts = INCLUDE_IDS.size ? posts.filter((post) => INCLUDE_IDS.has(post.id)) : posts;
if (INCLUDE_IDS.size && providerPosts.length !== INCLUDE_IDS.size) throw new Error('BAREEQ_TTS_INCLUDE_IDS contains unknown or draft article id(s).');
const synthesisPosts = PROVIDER === 'gemini'
  ? providerPosts
  : PROVIDER === 'openai'
    ? providerPosts.filter((post) => !STUDIO_ARTICLE_IDS.has(post.id))
    : providerPosts;
const sourceChars = posts.reduce((sum, post) => sum + [...post.spokenText].length, 0);
const sourceBytes = posts.reduce((sum, post) => sum + byteLength(post.spokenText), 0);
const sourceRequests = posts.reduce((sum, post) => sum + post.audioParts.length, 0);

if (SYNC_PLAN_ONLY) {
  const payload = JSON.stringify(posts.map((post) => ({ id: post.id, segments: post.segments.map(({ id, type, match }) => ({ id, type, matchLength: match.length })), parts: post.audioParts.map((part) => ({ sync: part.sync.map(({ id, start, end }) => ({ id, start, end })) })) })), null, 2) + '\n';
  await writeStdout(payload);
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
  else await writeStdout(payload);
  process.exit(0);
}

if (PLAN_ONLY) {
  if (PROVIDER === 'bundled') {
    console.log(`Bundled mixed audio plan: ${posts.length} articles, 0 synthesis request(s), 0 billable character(s), ${sourceBytes} source UTF-8 bytes.`);
    console.log('Voices: approved Studio Cedar for the cultural-habits article + bundled Azure Hamed for the other ten articles.');
    for (const post of posts) {
      console.log(STUDIO_ARTICLE_IDS.has(post.id)
        ? `- ${post.id}: approved Bareeq Voice Studio release (Cedar), no synthesis request`
        : `- ${post.id}: approved bundled Azure Hamed release, no synthesis request`);
    }
    process.exit(0);
  }
  const generationRequests = synthesisPosts.reduce((sum, post) => sum + post.audioParts.length, 0);
  const generationChars = synthesisPosts.reduce((sum, post) => sum + [...post.spokenText].length, 0);
  const characterLabel = PROVIDER === 'gemini' ? 'source character(s)' : 'billable character(s)';
  console.log(PROVIDER === 'gemini'
    ? `${PROVIDER_NAME} full Sadaltager rollout plan: ${providerPosts.length} selected article(s), ${generationRequests} synthesis request(s), ${generationChars} ${characterLabel}; unchanged Sadaltager audio is restored from production before any new synthesis.`
    : PROVIDER === 'google-cloud'
      ? `${PROVIDER_NAME} pre-activation plan: ${providerPosts.length} selected article(s), ${generationRequests} synthesis request(s), ${generationChars} ${characterLabel}, model ${CLOUD_TTS_MODEL}, voice ${CLOUD_TTS_VOICE}, locale ${CLOUD_TTS_LANGUAGE}. Planning sends 0 API requests.`
      : `${PROVIDER_NAME} audio plan: ${providerPosts.length} selected article(s), ${generationRequests * VOICES.length} synthesis request(s), ${generationChars * VOICES.length} ${characterLabel}, ${sourceBytes} source UTF-8 bytes.`);
  console.log(`Voices: ${VOICES.map((voice) => `${voice.label} [${voice.providerVoice}]`).join(' + ')}.`);
  const readiness = providerPosts.map((post) => ({ post, state: evaluateSynthesisReadiness(post) }));
  console.log(`Speech Script synthesis gate: ${readiness.filter(({ state }) => state.allowed).length}/${readiness.length} selected article(s) allowed; planning itself sends 0 provider requests.`);
  for (const { post, state } of readiness) {
    const imported = PROVIDER === 'openai' && STUDIO_ARTICLE_IDS.has(post.id);
    console.log(imported
      ? `- ${post.id}: approved Bareeq Voice Studio release (Cedar), no synthesis request`
      : `- ${post.id}: ${post.audioParts.length} part(s) × ${VOICES.length} voice(s), ${post.segments.length} sync block(s), ${[...post.spokenText].length} source chars; ${state.allowed ? 'SYNTHESIS ALLOWED' : `BLOCKED — ${state.reasons.join('; ')}`}`);
  }
  process.exit(0);
}

await mkdir(AUDIO_ROOT, { recursive: true });
const prepared = synthesisPosts.map((post) => ({ ...post, sourceHash: providerFingerprint(post) }));

let missing = [];
for (const post of prepared) if (!await hasCompleteCache(post)) missing.push(post);

if (missing.length && PROVIDER !== 'bundled' && !CONTRACT_TEST && !ALLOW_PARTIAL) {
  const stillMissing = [];
  for (const post of missing) {
    if (await restoreFromProduction(post)) console.log(`↺ ${post.id}: restored unchanged ${PROVIDER === 'gemini' ? 'Sadaltager' : PROVIDER_NAME} audio from production cache.`);
    else stillMissing.push(post);
  }
  missing = stillMissing;
}

if (CACHE_ONLY) {
  if (missing.length && !CACHE_ALLOW_MISSING) throw new Error(`Cache-only production restore failed for ${missing.length} article(s): ${missing.map((post) => post.id).join(', ')}. No synthesis API was called for these articles.`);
  if (missing.length) {
    console.log(`Partial cache-only restore completed: ${synthesisPosts.length - missing.length} compatible article(s) restored/preserved and ${missing.length} article(s) left on their approved fallback. No synthesis API was called.`);
    process.exit(0);
  }
  console.log(`Cache-only production restore passed for ${synthesisPosts.length} article(s); 0 synthesis requests.`);
  process.exit(0);
}

const unresolvedBeforeArticleCap = missing.length;
if (PROVIDER === 'gemini' && MAX_MISSING_ARTICLES_PER_BUILD > 0 && missing.length > 1) {
  missing.sort((left, right) => left.audioParts.length - right.audioParts.length || left.id.localeCompare(right.id, 'ar'));
  console.log(`Progressive article priority: shortest unresolved transcript first (${missing[0].id}, ${missing[0].audioParts.length} part(s)).`);
}
if (MAX_MISSING_ARTICLES_PER_BUILD > 0 && missing.length > MAX_MISSING_ARTICLES_PER_BUILD) {
  missing = missing.slice(0, MAX_MISSING_ARTICLES_PER_BUILD);
  console.log(`Progressive article cap: selected ${missing.length} of ${unresolvedBeforeArticleCap} unresolved article(s) for this build; the remainder keep their approved fallback audio.`);
}

if (PROVIDER === 'google-cloud' && missing.length) assertCloudTtsActivation(process.env, CONTRACT_TEST);
if (PROVIDER !== 'bundled' && missing.length) assertSynthesisAllowed(missing, process.env);

const missingSourceChars = missing.reduce((sum, post) => sum + [...post.spokenText].length, 0);
const effectiveVoiceCount = PROVIDER === 'azure' && process.env.BAREEQ_AZURE_HAMED_ONLY === '1' ? 1 : VOICES.length;
const missingChars = missingSourceChars * effectiveVoiceCount;
const missingRequests = missing.reduce((sum, post) => sum + post.audioParts.length, 0) * effectiveVoiceCount;

if (PROVIDER === 'bundled' && missing.length) {
  throw new Error(`Bundled production audio is missing or no longer matches ${missing.length} article(s): ${missing.map((post) => post.id).join(', ')}. This zero-cost build never calls a synthesis API. Restore the approved audio-releases bundle or deliberately regenerate and re-lock the affected recording(s).`);
} else if (PROVIDER === 'openai') {
  const estimate = estimateOpenAiCost(missingChars, missingRequests);
  console.log(`OpenAI TTS cost guard: this build needs ${missingRequests} new request(s), ${missingChars.toLocaleString('en-US')} billable character(s), and an estimated $${estimate.usd.toFixed(2)} for Cedar + Marin.`);
  console.log('Note: this is a conservative per-build estimate, not the OpenAI account bill. Unchanged published audio is restored without new synthesis.');
  if (OPENAI_BUILD_WARNING_USD > 0 && estimate.usd >= OPENAI_BUILD_WARNING_USD) console.warn(`⚠ OpenAI TTS usage warning: estimated $${estimate.usd.toFixed(2)} (warning threshold: $${OPENAI_BUILD_WARNING_USD.toFixed(2)}).`);
  if (OPENAI_BUILD_HARD_LIMIT_USD > 0 && estimate.usd > OPENAI_BUILD_HARD_LIMIT_USD) throw new Error(`OpenAI TTS safety stop: estimated $${estimate.usd.toFixed(2)} exceeds the configured $${OPENAI_BUILD_HARD_LIMIT_USD.toFixed(2)} hard limit. Raise OPENAI_TTS_BUILD_HARD_LIMIT_USD deliberately if this full regeneration is expected.`);
} else if (PROVIDER === 'gemini') {
  console.log(`Gemini TTS rollout: this build needs ${missingRequests} new request(s) and ${missingChars.toLocaleString('en-US')} source character(s) for Sadaltager.`);
  console.log(`Gemini pacing: one request at a time, minimum ${MIN_SYNTHESIS_INTERVAL_MS}ms between request starts, up to ${MAX_FETCH_RETRIES} retries with Retry-After/exponential backoff, and a ${Math.round(GEMINI_SYNTHESIS_BUDGET_MS / 60000)}-minute synthesis budget.`);
  if (missingRequests > GEMINI_REQUEST_HARD_LIMIT) { console.warn(`⚠ Gemini progressive rollout deferred: ${missingRequests} new request(s) exceed the ${GEMINI_REQUEST_HARD_LIMIT}-request per-build ceiling.`); console.warn('⚠ Safe fallback: matching Hamed/Cedar audio already present in this build remains publishable; unchanged Sadaltager restored from production is preserved.'); process.exit(0); }
} else if (PROVIDER === 'google-cloud') {
  console.log(`Google Cloud TTS safety gate: ${missingRequests} new request(s), ${missingChars.toLocaleString('en-US')} billable character(s), ${CLOUD_TTS_MODEL}, ${CLOUD_TTS_VOICE}, ${CLOUD_TTS_LANGUAGE}, direct ${CLOUD_TTS_AUDIO_ENCODING}.`);
  if (missingRequests > CLOUD_TTS_REQUEST_HARD_LIMIT) throw new Error(`Google Cloud TTS safety stop: ${missingRequests} requests exceed BAREEQ_CLOUD_TTS_MAX_REQUESTS_PER_BUILD=${CLOUD_TTS_REQUEST_HARD_LIMIT}.`);
  if (missingChars > CLOUD_TTS_CHARACTER_HARD_LIMIT) throw new Error(`Google Cloud TTS safety stop: ${missingChars} characters exceed BAREEQ_CLOUD_TTS_MAX_CHARS_PER_BUILD=${CLOUD_TTS_CHARACTER_HARD_LIMIT}.`);
  assertCloudTtsActivation(process.env, CONTRACT_TEST);
} else if (PROVIDER === 'azure') {
  const percent = AZURE_FREE_MONTHLY_CHARS > 0 ? (missingChars / AZURE_FREE_MONTHLY_CHARS) * 100 : 0;
  console.log(`Azure Speech cost guard: this build needs ${missingChars.toLocaleString('en-US')} new synthesis character(s) across ${missingRequests} request(s), about ${percent.toFixed(1)}% of the configured ${AZURE_FREE_MONTHLY_CHARS.toLocaleString('en-US')} monthly allowance.`);
  console.log('Note: this is a per-build estimate, not Azure account monthly usage. Unchanged published audio is restored without new synthesis.');
  if (BUILD_WARNING_CHARS > 0 && missingChars >= BUILD_WARNING_CHARS) console.warn(`⚠ Azure Speech usage warning: this build will synthesize ${missingChars.toLocaleString('en-US')} characters (warning threshold: ${BUILD_WARNING_CHARS.toLocaleString('en-US')}).`);
  if (BUILD_HARD_LIMIT_CHARS > 0 && missingChars > BUILD_HARD_LIMIT_CHARS) throw new Error(`Azure Speech safety stop: this build would synthesize ${missingChars.toLocaleString('en-US')} characters, above the configured hard limit of ${BUILD_HARD_LIMIT_CHARS.toLocaleString('en-US')}. Raise AZURE_SPEECH_BUILD_HARD_LIMIT_CHARS deliberately if this is expected.`);
  if (AZURE_MONTHLY_USED_CHARS !== null) {
    const projected = AZURE_MONTHLY_USED_CHARS + missingChars;
    console.log(`Azure monthly ledger: ${AZURE_MONTHLY_USED_CHARS.toLocaleString('en-US')} already recorded + ${missingChars.toLocaleString('en-US')} planned = ${projected.toLocaleString('en-US')} projected character(s).`);
    if (AZURE_MONTHLY_WARNING_CHARS > 0 && projected >= AZURE_MONTHLY_WARNING_CHARS) console.warn(`⚠ Azure monthly allowance warning: projected usage is ${projected.toLocaleString('en-US')} characters (warning threshold: ${AZURE_MONTHLY_WARNING_CHARS.toLocaleString('en-US')}).`);
    if (AZURE_FREE_MONTHLY_CHARS > 0 && projected > AZURE_FREE_MONTHLY_CHARS) throw new Error(`Azure monthly allowance safety stop: projected usage ${projected.toLocaleString('en-US')} exceeds ${AZURE_FREE_MONTHLY_CHARS.toLocaleString('en-US')}. Update AZURE_SPEECH_MONTHLY_USED_CHARS from the Azure portal before retrying.`);
  } else {
    console.warn('⚠ Azure monthly ledger is unavailable. Set AZURE_SPEECH_MONTHLY_USED_CHARS from the Azure portal to enable cumulative allowance alerts before synthesis.');
  }
}

const API_KEY = PROVIDER === 'gemini' ? GEMINI_API_KEY : PROVIDER === 'openai' ? OPENAI_API_KEY : PROVIDER === 'azure' ? AZURE_API_KEY : '';
if (PROVIDER === 'google-cloud' && missing.length && !hasCloudTtsCredentials(process.env)) {
  if (ALLOW_PARTIAL) {
    console.warn(`⚠ Offline verification mode: skipping ${missing.length} Google Cloud TTS article(s); no paid request was sent.`);
    process.exit(0);
  }
  throw new Error('Google Cloud TTS credentials are required after activation. Add GOOGLE_SERVICE_ACCOUNT_JSON as an encrypted Production Secret; no Cloud TTS request was sent.');
}
if (PROVIDER !== 'google-cloud' && !API_KEY && missing.length) {
  if (ALLOW_PARTIAL) {
    console.warn(`⚠ Offline pilot mode: preserving imported fallback audio and skipping ${missing.length} unavailable synthesis article(s). This mode is for local release verification only.`);
    process.exit(0);
  }
  if (PROVIDER === 'gemini') throw new Error(`GEMINI_API_KEY is required to generate Sadaltager for ${missing.length} new or changed article(s). Existing unchanged Gemini audio is restored automatically from ${CACHE_ORIGINS.join(' or ')}. Create the key in Google AI Studio and add it as an encrypted Production Secret in Cloudflare Pages; if it is absent, the deployment fails safely and the previous live version remains active.`);
  if (PROVIDER === 'openai') throw new Error(`OPENAI_API_KEY is required to generate Cedar and Marin for ${missing.length} new or changed article(s). Existing unchanged OpenAI audio is restored automatically from ${CACHE_ORIGINS.join(' or ')}. Add OPENAI_API_KEY as an encrypted Production Secret in Cloudflare Pages; if it is absent, the deployment fails safely and the previous live version remains active.`);
  throw new Error(`AZURE_SPEECH_KEY is required to generate Hamed and Zariyah for ${missing.length} new or changed article(s). Add it as an encrypted Production Secret in Cloudflare Pages, or redeploy the previous release for an immediate rollback.`);
}

if (!missing.length) {
  console.log(PROVIDER === 'bundled'
    ? `Bundled mixed audio cache is complete for ${posts.length} articles: 1 Studio Cedar + ${BUNDLED_BY_ARTICLE.size} Azure Hamed, 0 synthesis requests and no API key required.`
    : PROVIDER === 'gemini'
      ? `Gemini Sadaltager cache is complete for all ${posts.length} article(s): 0 new synthesis requests required.`
      : PROVIDER === 'google-cloud'
        ? `Google Cloud TTS cache is complete for ${synthesisPosts.length} selected article(s): 0 paid synthesis requests required.`
      : `${PROVIDER_NAME} audio cache is complete for ${posts.length} articles with ${VOICES.length} approved listening voice(s).`);
  process.exit(0);
}

const resolvedVoices = PROVIDER === 'azure'
  ? (process.env.BAREEQ_AZURE_HAMED_ONLY === '1' ? (await resolveAzureVoices(API_KEY)).filter((voice) => voice.id === 'hamed') : await resolveAzureVoices(API_KEY))
  : VOICES;
console.log(`Generating ${PROVIDER_NAME} ${MODEL} (${LANGUAGE}) with ${resolvedVoices.map((voice) => voice.providerVoice).join(' + ')} for ${missing.length} article(s).`);

const synthesisStartedAt = Date.now();
const geminiBudgetExceeded = () => PROVIDER === 'gemini' && Date.now() - synthesisStartedAt >= GEMINI_SYNTHESIS_BUDGET_MS;
let generatedThisBuild = 0;
let deferredReason = '';

for (const post of missing) {
  if (geminiBudgetExceeded()) {
    deferredReason = 'build-time budget';
    console.warn(`⚠ Gemini synthesis budget reached before ${post.id}; remaining articles keep their approved fallback audio for this deployment.`);
    break;
  }
  const finalDir = path.join(AUDIO_ROOT, post.key);
  const tempDir = `${finalDir}.tmp-${process.pid}`;
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  const parts = post.audioParts.map((audioPart) => ({ characters: [...audioPart.text].length, sync: audioPart.sync, audio: {} }));
  const manifestVoices = [];
  try {
    for (const voice of resolvedVoices) {
      let totalDurationSeconds = 0;
      for (let index = 0; index < post.audioParts.length; index += 1) {
        if (geminiBudgetExceeded()) {
          const budgetError = new Error('Gemini synthesis budget reached during article generation.');
          budgetError.code = 'BAREEQ_GEMINI_BUDGET';
          throw budgetError;
        }
        const audioPart = post.audioParts[index];
        const filename = `${voice.id}-part-${String(index + 1).padStart(3, '0')}-${post.sourceHash.slice(0, 8)}.mp3`;
        const audio = await synthesizeVoice(API_KEY, voice, audioPart, {
          articleTitle: post.title,
          partIndex: index,
          partCount: post.audioParts.length,
        });
        if (audio.length < 100) throw new Error(`${post.id}: generated MP3 ${filename} is unexpectedly small.`);
        const durationSeconds = mp3DurationSeconds(audio);
        await writeFile(path.join(tempDir, filename), audio);
        parts[index].audio[voice.id] = {
          src: `/audio/articles/${post.key}/${filename}`,
          bytes: audio.length,
          durationSeconds,
          sha256: sha(audio),
        };
        totalDurationSeconds += durationSeconds;
      }
      manifestVoices.push({
        id: voice.id,
        label: voice.label,
        description: voice.description,
        providerVoice: voice.providerVoice,
        totalDurationSeconds: Number(totalDurationSeconds.toFixed(3)),
      });
    }
    const manifest = {
      version: 3,
      generatorVersion: GENERATOR_VERSION,
      syncVersion: 1,
      speechOverridesVersion: SPEECH_OVERRIDES_VERSION,
      speechReviewVersion: SPEECH_REVIEW_VERSION,
      speechScriptVersion: post.speechApproval?.script?.version,
      speechScriptHash: post.speechScriptHash,
      speechInput: post.speechInput,
      speechQualityState: 'generated-from-reviewed-speech-script-publication-pending',
      provider: PROVIDER_NAME,
      model: MODEL,
      language: LANGUAGE,
      outputFormat: OUTPUT_FORMAT,
      articleId: post.id,
      title: post.title,
      sourceHash: post.sourceHash,
      defaultVoice: resolvedVoices[0].id,
      voices: manifestVoices,
      syncMethod: 'paragraph-weighted',
      disclosure: 'الصوت مولّد بالذكاء الاصطناعي وليس صوتًا بشريًا.',
      ...(PROVIDER === 'azure'
        ? { region: REGION, synthesisRate: SYNTHESIS_RATE }
        : PROVIDER === 'gemini'
          ? { performanceInstructions: GEMINI_STYLE, sourceAudioFormat: 'pcm-s16le-24000hz-mono', encodingTool: 'ffmpeg-libmp3lame' }
          : PROVIDER === 'google-cloud'
            ? { performanceInstructions: CLOUD_TTS_STYLE, cloudTtsIntegrationVersion: CLOUD_TTS_INTEGRATION_VERSION, region: process.env.GOOGLE_CLOUD_TTS_REGION?.trim().toLowerCase() || 'global', directAudioEncoding: CLOUD_TTS_AUDIO_ENCODING }
            : { styleInstructions: OPENAI_STYLE }),
      ...(CONTRACT_TEST ? { contractTest: true } : {}),
      parts,
    };
    await writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rm(finalDir, { recursive: true, force: true });
    await rename(tempDir, finalDir);
    generatedThisBuild += 1;
    console.log(`✓ ${post.id}: ${parts.length} synchronized part(s) × ${resolvedVoices.length} voice(s)`);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    if (PROVIDER === 'gemini' && (error?.httpStatus === 429 || error?.code === 'BAREEQ_GEMINI_BUDGET')) {
      deferredReason = error?.httpStatus === 429 ? 'persistent HTTP 429' : 'build-time budget';
      console.warn(`⚠ Gemini progressive rollout paused at ${post.id}: ${deferredReason}.`);
      console.warn('⚠ Safe progressive fallback: completed Sadaltager articles remain publishable; this and later articles retain approved Cedar/Hamed fallback audio and will be retried on a later deployment.');
      break;
    }
    throw error;
  }
}

console.log(PROVIDER === 'gemini'
  ? (deferredReason
      ? `Gemini progressive rollout safely paused (${deferredReason}): ${generatedThisBuild} new Sadaltager article(s) completed in this build; remaining articles retain approved fallback audio.`
      : unresolvedBeforeArticleCap > missing.length
        ? `Gemini free-tier step complete: ${generatedThisBuild} Sadaltager article(s) completed atomically; ${Math.max(0, unresolvedBeforeArticleCap - generatedThisBuild)} unresolved article(s) remain on approved fallback audio for later deployments.`
        : `Gemini full Sadaltager rollout ready: ${posts.length} article(s), synchronized paragraphs, static cached MP3 output, and production-cache reuse enabled.`)
  : `${PROVIDER_NAME} audio ready: ${posts.length} article(s), ${VOICES.length} approved listening voice(s), synchronized paragraphs, and static cached MP3 output.`);
