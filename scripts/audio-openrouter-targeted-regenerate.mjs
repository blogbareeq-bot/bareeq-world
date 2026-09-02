import path from 'node:path';
import { runProductionMode } from './audio-production.mjs';
import { synthesizeOpenRouterPart } from './audio-openrouter-tts.mjs';

const articleId = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length)
  || process.env.BAREEQ_AUDIO_ARTICLE
  || '';

if (!articleId) {
  console.error('Usage: node scripts/audio-openrouter-targeted-regenerate.mjs --article=<id>');
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
    throw new Error(`Targeted OpenRouter correction expected exactly one ${label}; found ${occurrences}.`);
  }
  return text.replace(needle, replacement);
}

function correctionInput(part, correctionHint) {
  const hint = String(correctionHint || '').trim();
  if (!hint) return part;

  // OpenRouter's /audio/speech endpoint accepts speech text rather than a
  // director-instruction prompt. Keep lexical content unchanged and use only
  // Arabic diacritics or punctuation boundaries that disappear under the ASR
  // lexical normalizer, so the authoritative Speech Script remains identical.
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
    // Strengthen only Arabic vowel/stop marks. The letters remain exactly the
    // reviewed Speech Script tokens after lexical normalization.
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

  throw new Error(`Unsupported OpenRouter targeted correction for ${articleId} part ${part.partIndex + 1}; refusing an unverified rewrite.`);
}

try {
  const result = await runProductionMode({
    mode: 'generate-candidate',
    articleId,
    root: process.cwd(),
    synthesize: ({ part, voice, correctionHint }) => synthesizeOpenRouterPart({
      part: correctionInput(part, correctionHint),
      voice,
    }),
  });

  console.log(JSON.stringify({
    mode: 'targeted-openrouter-regeneration',
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
