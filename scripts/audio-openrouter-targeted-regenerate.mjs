import path from 'node:path';
import { runProductionMode } from './audio-production.mjs';
import { synthesizeOpenRouterPart } from './audio-openrouter-tts.mjs';
import { synthesizeGeminiGenerateContentPart, synthesizeGeminiPart } from './audio-gemini-tts.mjs';

const articleId = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length)
  || process.env.BAREEQ_AUDIO_ARTICLE
  || '';
const targetedTransport = process.env.BAREEQ_TARGETED_TTS_TRANSPORT?.trim() || 'openrouter-speech';

if (!articleId) {
  console.error('Usage: node scripts/audio-openrouter-targeted-regenerate.mjs --article=<id>');
  process.exit(2);
}
if (!['openrouter-speech', 'developer-generate-content', 'developer-interactions'].includes(targetedTransport)) {
  console.error(`Unsupported BAREEQ_TARGETED_TTS_TRANSPORT=${targetedTransport}`);
  process.exit(2);
}

const SINGULAR_PHRASE = 'تحديد المشكلة والمراجعة والتواصل وتحمل القرار';
const SINGULAR_PHRASE_VOCALIZED = 'تحديد الْمُشْكِلَة والمراجعة والتواصل وتحمل القرار';

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const index = text.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}

function replaceExactlyOnce(text, needle, replacement, label) {
  const occurrences = countOccurrences(text, needle);
  if (occurrences !== 1) {
    throw new Error(`Targeted correction expected exactly one ${label}; found ${occurrences}.`);
  }
  return text.replace(needle, replacement);
}

function correctionInput(part, correctionHint) {
  const hint = String(correctionHint || '').trim();
  if (!hint) return part;

  // Keep lexical content identical to the reviewed Speech Script. Targeted
  // retries may only strengthen Arabic diacritics or punctuation boundaries
  // that disappear under the exact lexical normalizer.
  if (articleId === 'ai-agents-future-now' && part.partIndex === 4 && hint.includes('المشكلة')) {
    return {
      ...part,
      text: replaceExactlyOnce(
        part.text,
        SINGULAR_PHRASE,
        SINGULAR_PHRASE_VOCALIZED,
        'singular phrase in ai-agents part 5',
      ),
    };
  }

  if (articleId === 'ai-as-coworker-future-of-human-work' && part.partIndex === 0) {
    let text = part.text;
    text = replaceExactlyOnce(text, 'أَنْثْرُوبِك', 'أَنْثْرُوبِكْ', 'reviewed Anthropic token in coworker part 1');
    text = replaceExactlyOnce(text, 'كلود', 'كْلُودْ', 'كلود token in coworker part 1');
    return { ...part, text };
  }

  if (articleId === 'ai-as-coworker-future-of-human-work' && part.partIndex === 3) {
    return {
      ...part,
      text: replaceExactlyOnce(part.text, 'موزعًا', 'مُوَزَّعًا', 'موزعًا token in coworker part 4'),
    };
  }

  if (articleId === 'ai-as-coworker-future-of-human-work' && part.partIndex === 4) {
    return {
      ...part,
      text: replaceExactlyOnce(part.text, 'استخدموا', 'اِسْتَخْدَمُوا', 'استخدموا token in coworker part 5'),
    };
  }

  if (articleId === 'ai-as-coworker-future-of-human-work' && part.partIndex === 5) {
    return {
      ...part,
      text: replaceExactlyOnce(part.text, 'بروكتر', 'بْرُوكْتَر', 'بروكتر token in coworker part 6'),
    };
  }

  if (articleId === 'ai-as-coworker-future-of-human-work' && part.partIndex === 6) {
    return {
      ...part,
      text: replaceExactlyOnce(part.text, 'في ما', 'في، ما', 'في ما boundary in coworker part 7'),
    };
  }

  if (articleId === 'ai-as-coworker-future-of-human-work' && part.partIndex === 7) {
    return {
      ...part,
      text: replaceExactlyOnce(part.text, 'موزعًا', 'مُوَزَّعًا', 'موزعًا token in coworker part 8'),
    };
  }

  throw new Error(`Unsupported targeted correction for ${articleId} part ${part.partIndex + 1}; refusing an unverified rewrite.`);
}

async function synthesizeTargeted({ article, part, splitPlan, voice, correctionHint }) {
  const correctedPart = correctionInput(part, correctionHint);
  const context = {
    articleTitle: article.title,
    partIndex: part.partIndex,
    partCount: splitPlan.parts.length,
    correctionHint,
  };
  if (targetedTransport === 'developer-generate-content') {
    return synthesizeGeminiGenerateContentPart({
      apiKey: process.env.GEMINI_API_KEY,
      part: correctedPart,
      context,
      voice,
    });
  }
  if (targetedTransport === 'developer-interactions') {
    return synthesizeGeminiPart({
      apiKey: process.env.GEMINI_API_KEY,
      part: correctedPart,
      context,
      voice,
    });
  }
  return synthesizeOpenRouterPart({ part: correctedPart, voice });
}

try {
  const result = await runProductionMode({
    mode: 'generate-candidate',
    articleId,
    root: process.cwd(),
    synthesize: synthesizeTargeted,
  });

  console.log(JSON.stringify({
    mode: 'targeted-regeneration',
    transport: targetedTransport,
    status: result.status,
    articleId,
    fingerprint: result.fingerprint,
    ttsRequestsSent: result.ttsRequestsSent,
    providerAttempts: result.providerAttempts,
    resumedParts: result.resumedParts,
    forceRegeneratedParts: result.forceRegeneratedParts,
    transportsUsed: result.transportsUsed,
  }, null, 2));
  process.exit(result.exitCode || 0);
} catch (error) {
  console.error(error.message);
  process.exit(error.exitCode || 1);
}
