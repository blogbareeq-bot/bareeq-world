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

function correctionInput(part, correctionHint) {
  const hint = String(correctionHint || '').trim();
  if (!hint) return part;

  // OpenRouter's /audio/speech endpoint accepts speech text rather than a
  // director-instruction prompt. For the confirmed ASR substitution in part 5,
  // preserve the lexical content and add Arabic diacritics only to the exact
  // singular token. The ASR lexical normalizer removes diacritics, so the
  // expected transcript remains unchanged while the TTS pronunciation is made
  // unambiguous.
  if (part.partIndex === 4 && hint.includes('المشكلة')) {
    const occurrences = countOccurrences(part.text, SINGULAR_PHRASE);
    if (occurrences !== 1) {
      throw new Error(`Targeted OpenRouter correction expected exactly one singular phrase in part 5; found ${occurrences}.`);
    }
    return {
      ...part,
      text: part.text.replace(SINGULAR_PHRASE, SINGULAR_PHRASE_VOCALIZED),
    };
  }

  throw new Error(`Unsupported OpenRouter targeted correction for part ${part.partIndex + 1}; refusing an unverified rewrite.`);
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
