import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractArticleSpeechModel, readSpeechScript } from './speech-script-core.mjs';
import { buildGeminiPrompt } from './speech-prompt.mjs';
import {
  LEGACY_SPLIT,
  QUOTA_SPLIT,
  PERFORMANCE_INSTRUCTIONS,
  PRODUCTION_TTS_MODEL,
  PRODUCTION_VOICE,
  utf8Bytes,
  sha256,
  joinSpeechPieces,
} from './audio-constants.mjs';

function splitOversizedText(text, maxBytes) {
  if (utf8Bytes(text) <= maxBytes) return [text];
  const sentences = text.match(/[^.!؟؛]+[.!؟؛]?/g) || [text];
  const chunks = [];
  let current = '';
  const pushWords = (sentence) => {
    const words = sentence.trim().split(/\s+/);
    let part = '';
    for (const word of words) {
      const candidate = part ? `${part} ${word}` : word;
      if (utf8Bytes(candidate) > maxBytes && part) {
        chunks.push(part.trim());
        part = word;
      } else if (utf8Bytes(candidate) > maxBytes) {
        let tiny = '';
        for (const char of [...word]) {
          if (utf8Bytes(tiny + char) > maxBytes && tiny) {
            chunks.push(tiny);
            tiny = '';
          }
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
    if (utf8Bytes(sentence) > maxBytes) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      pushWords(sentence);
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (utf8Bytes(candidate) > maxBytes && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

export async function loadSpokenArticle(articleId, root = process.cwd()) {
  const filename = `${articleId}.md`;
  const source = await readFile(path.join(root, 'src', 'content', 'posts', filename), 'utf8');
  const model = extractArticleSpeechModel({ articleId, source, filename });
  const script = await readSpeechScript(articleId, root);
  const records = new Map((script?.segments ?? []).map((segment) => [segment.segmentId, segment]));
  const items = model.segments.map((segment) => ({
    segmentId: segment.segmentId,
    runtimeId: segment.runtimeId,
    type: segment.type,
    match: segment.match,
    text: records.get(segment.segmentId)?.spokenText ?? segment.sourceText,
  }));
  const spokenText = joinSpeechPieces(items);
  return {
    articleId,
    title: model.title,
    model,
    script,
    items,
    spokenText,
    spokenChars: [...spokenText].length,
    spokenBytes: utf8Bytes(spokenText),
    speechScriptHash: script?.scriptHash ?? null,
  };
}

export function estimateCharsPerSecond(article, liveDurationSeconds) {
  if (liveDurationSeconds > 0 && article.spokenChars > 0) {
    return article.spokenChars / liveDurationSeconds;
  }
  return QUOTA_SPLIT.defaultCharsPerSecond;
}

function estimateSeconds(text, charsPerSecond) {
  return [...text].length / Math.max(1, charsPerSecond);
}

function wouldExceed(text, settings, charsPerSecond, articleTitle, partIndex, partCount) {
  const transcriptBytes = utf8Bytes(text);
  if (transcriptBytes > settings.maxTranscriptBytes) return true;
  if (settings.maxSeconds && estimateSeconds(text, charsPerSecond) > settings.maxSeconds) return true;
  if (settings.officialCombinedLimitBytes) {
    const prompt = buildGeminiPrompt({ text }, { articleTitle, partIndex, partCount });
    if (utf8Bytes(prompt) > settings.officialCombinedLimitBytes) return true;
  }
  return false;
}

function packItems(items, settings, charsPerSecond, articleTitle) {
  const units = [];
  for (const item of items) {
    const pieces = splitOversizedText(item.text, settings.maxTranscriptBytes);
    for (const text of pieces) units.push({ ...item, text });
  }

  const parts = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const text = joinSpeechPieces(current);
    parts.push({
      text,
      items: current,
      chars: [...text].length,
      bytes: utf8Bytes(text),
      estimatedSeconds: Number(estimateSeconds(text, charsPerSecond).toFixed(2)),
    });
    current = [];
  };

  for (const item of units) {
    const candidateItems = [...current, item];
    const candidateText = joinSpeechPieces(candidateItems);
    const over = wouldExceed(candidateText, settings, charsPerSecond, articleTitle, parts.length, parts.length + 1);
    if (current.length && over) flush();
    current.push(item);
    const solo = joinSpeechPieces(current);
    if (wouldExceed(solo, settings, charsPerSecond, articleTitle, parts.length, parts.length + 1) && current.length > 1) {
      const overflow = current.pop();
      flush();
      current = [overflow];
    }
  }
  flush();
  return parts.map((part, index) => ({
    ...part,
    partIndex: index,
    partCount: parts.length,
    promptBytes: utf8Bytes(buildGeminiPrompt(part, { articleTitle, partIndex: index, partCount: parts.length })),
  }));
}

export function splitSpokenArticle(article, { settings = QUOTA_SPLIT, liveDurationSeconds = null } = {}) {
  const charsPerSecond = estimateCharsPerSecond(article, liveDurationSeconds);
  const parts = packItems(article.items, settings, charsPerSecond, article.title);
  const justification = parts.length > 6
    ? `Article spoken length ${article.spokenChars} chars / live ${liveDurationSeconds ?? 'n/a'}s needs ${parts.length} parts at ≤${settings.maxSeconds || 'n/a'}s and ≤${settings.maxTranscriptBytes} transcript bytes (official text limit ${settings.officialTextLimitBytes || settings.maxTranscriptBytes}).`
    : null;
  return {
    articleId: article.articleId,
    settings,
    charsPerSecond: Number(charsPerSecond.toFixed(3)),
    liveDurationSeconds,
    parts,
    ttsRequests: parts.length,
    maxPartBytes: Math.max(0, ...parts.map((part) => part.bytes)),
    maxPartEstimatedSeconds: Math.max(0, ...parts.map((part) => part.estimatedSeconds)),
    justification,
  };
}

export function candidateFingerprint(article, splitPlan) {
  return sha256(JSON.stringify({
    articleId: article.articleId,
    spokenText: article.spokenText,
    speechScriptHash: article.speechScriptHash,
    model: PRODUCTION_TTS_MODEL,
    voice: PRODUCTION_VOICE,
    performanceInstructions: PERFORMANCE_INSTRUCTIONS,
    split: {
      version: splitPlan.settings.version,
      name: splitPlan.settings.name,
      maxTranscriptBytes: splitPlan.settings.maxTranscriptBytes,
      targetSeconds: splitPlan.settings.targetSeconds,
      maxSeconds: splitPlan.settings.maxSeconds,
    },
  }));
}

export function partFingerprint(article, splitPlan, part) {
  return sha256(JSON.stringify({
    articleId: article.articleId,
    spokenText: part.text,
    model: PRODUCTION_TTS_MODEL,
    voice: PRODUCTION_VOICE,
    performanceInstructions: PERFORMANCE_INSTRUCTIONS,
    split: {
      version: splitPlan.settings.version,
      name: splitPlan.settings.name,
      maxTranscriptBytes: splitPlan.settings.maxTranscriptBytes,
      targetSeconds: splitPlan.settings.targetSeconds,
      maxSeconds: splitPlan.settings.maxSeconds,
    },
    partIndex: part.partIndex,
  }));
}

export { LEGACY_SPLIT, QUOTA_SPLIT };
