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
  GENERATOR_VERSION,
  utf8Bytes,
  sha256,
  joinSpeechPieces,
  estimateGeminiTokens,
} from './audio-constants.mjs';
import { attachSync } from './audio-sync.mjs';

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
  if (settings.maxTranscriptBytes && transcriptBytes > settings.maxTranscriptBytes) return true;
  if (settings.maxSeconds && estimateSeconds(text, charsPerSecond) > settings.maxSeconds) return true;
  if (settings.geminiInputTokenLimit) {
    const prompt = buildGeminiPrompt({ text }, { articleTitle, partIndex, partCount });
    if (estimateGeminiTokens(prompt) > settings.geminiInputTokenLimit) return true;
  }
  return false;
}

function makePart(items, charsPerSecond, articleTitle, partIndex, partCount) {
  const text = joinSpeechPieces(items);
  const prompt = buildGeminiPrompt({ text }, { articleTitle, partIndex, partCount });
  return attachSync({
    text,
    items,
    chars: [...text].length,
    bytes: utf8Bytes(text),
    estimatedSeconds: Number(estimateSeconds(text, charsPerSecond).toFixed(2)),
    promptBytes: utf8Bytes(prompt),
    estimatedTokens: estimateGeminiTokens(prompt),
    partIndex,
    partCount,
  });
}

function reindex(parts, charsPerSecond, articleTitle) {
  return parts.map((part, index) => makePart(part.items, charsPerSecond, articleTitle, index, parts.length));
}

function rebalanceParts(parts, settings, charsPerSecond, articleTitle) {
  if (parts.length < 2) return parts;
  const floor = settings.rebalanceFloorSeconds ?? 45;
  const last = parts[parts.length - 1];
  if (!(last.estimatedSeconds < floor)) return parts;

  const prev = parts[parts.length - 2];
  const mergedItems = [...prev.items, ...last.items];
  const mergedText = joinSpeechPieces(mergedItems);
  if (!wouldExceed(mergedText, settings, charsPerSecond, articleTitle, parts.length - 2, parts.length - 1)) {
    return reindex([...parts.slice(0, -2), { items: mergedItems }], charsPerSecond, articleTitle);
  }

  const stolen = [...last.items];
  const remain = [...prev.items];
  while (remain.length > 1) {
    const candidate = remain.pop();
    const nextStolen = [candidate, ...stolen];
    const prevText = joinSpeechPieces(remain);
    const lastText = joinSpeechPieces(nextStolen);
    if (wouldExceed(lastText, settings, charsPerSecond, articleTitle, parts.length - 1, parts.length)) {
      remain.push(candidate);
      break;
    }
    if (settings.minSeconds && estimateSeconds(prevText, charsPerSecond) < settings.minSeconds) {
      remain.push(candidate);
      break;
    }
    stolen.unshift(candidate);
    const lastSeconds = estimateSeconds(joinSpeechPieces(stolen), charsPerSecond);
    if (lastSeconds >= floor) break;
  }
  if (stolen.length === last.items.length) return parts;
  return reindex([...parts.slice(0, -2), { items: remain }, { items: stolen }], charsPerSecond, articleTitle);
}

function packItems(items, settings, charsPerSecond, articleTitle) {
  const units = [];
  for (const item of items) {
    const pieces = splitOversizedText(item.text, settings.maxTranscriptBytes || utf8Bytes(item.text));
    for (const text of pieces) units.push({ ...item, text });
  }

  const parts = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    parts.push({ items: current });
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
  const folded = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const hasBody = (part.items || []).some((item) => item.type !== 'title');
    if (!hasBody && index + 1 < parts.length) {
      const combined = { items: [...part.items, ...parts[index + 1].items] };
      const combinedText = joinSpeechPieces(combined.items);
      if (!wouldExceed(combinedText, settings, charsPerSecond, articleTitle, folded.length, Math.max(1, parts.length - 1))) {
        parts[index + 1] = combined;
        continue;
      }
    }
    folded.push(part);
  }
  return rebalanceParts(reindex(folded, charsPerSecond, articleTitle), settings, charsPerSecond, articleTitle);
}

export function activeSplitSettings(settings) {
  if (process.env.BAREEQ_AUDIO_TEST_SPLIT === 'tiny' && process.env.BAREEQ_TTS_CONTRACT_TEST === '1') {
    return {
      ...QUOTA_SPLIT,
      name: 'test-tiny',
      maxTranscriptBytes: 80,
      maxSeconds: 600,
      minSeconds: 0,
      rebalanceFloorSeconds: 0,
      targetSeconds: 1,
    };
  }
  return settings || QUOTA_SPLIT;
}

export function splitSpokenArticle(article, { settings = QUOTA_SPLIT, liveDurationSeconds = null } = {}) {
  const charsPerSecond = estimateCharsPerSecond(article, liveDurationSeconds);
  const parts = packItems(article.items, settings, charsPerSecond, article.title);
  const justification = parts.length > 6
    ? `Article spoken length ${article.spokenChars} chars / live ${liveDurationSeconds ?? 'n/a'}s needs ${parts.length} parts at ≤${settings.maxSeconds || 'n/a'}s Gemini quality cap and ≤${settings.geminiInputTokenLimit || 'n/a'} input tokens.`
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
    maxPartEstimatedTokens: Math.max(0, ...parts.map((part) => part.estimatedTokens || 0)),
    justification,
  };
}

function splitFingerprintPayload(splitPlan) {
  return {
    version: splitPlan.settings.version,
    name: splitPlan.settings.name,
    maxTranscriptBytes: splitPlan.settings.maxTranscriptBytes,
    targetSeconds: splitPlan.settings.targetSeconds,
    maxSeconds: splitPlan.settings.maxSeconds,
    minSeconds: splitPlan.settings.minSeconds,
    geminiInputTokenLimit: splitPlan.settings.geminiInputTokenLimit,
    geminiTokenEstimateDivisorBytes: splitPlan.settings.geminiTokenEstimateDivisorBytes,
    rebalanceFloorSeconds: splitPlan.settings.rebalanceFloorSeconds,
    generatorVersion: splitPlan.settings.generatorVersion || GENERATOR_VERSION,
  };
}

export function candidateFingerprint(article, splitPlan) {
  return sha256(JSON.stringify({
    articleId: article.articleId,
    spokenText: article.spokenText,
    speechScriptHash: article.speechScriptHash,
    model: PRODUCTION_TTS_MODEL,
    voice: PRODUCTION_VOICE,
    generatorVersion: GENERATOR_VERSION,
    performanceInstructions: PERFORMANCE_INSTRUCTIONS,
    split: splitFingerprintPayload(splitPlan),
    partTexts: splitPlan.parts.map((part) => part.text),
  }));
}

export function partFingerprint(article, splitPlan, part) {
  return sha256(JSON.stringify({
    articleId: article.articleId,
    spokenText: part.text,
    model: PRODUCTION_TTS_MODEL,
    voice: PRODUCTION_VOICE,
    generatorVersion: GENERATOR_VERSION,
    performanceInstructions: PERFORMANCE_INSTRUCTIONS,
    split: splitFingerprintPayload(splitPlan),
    partIndex: part.partIndex,
  }));
}

export { LEGACY_SPLIT, QUOTA_SPLIT };
