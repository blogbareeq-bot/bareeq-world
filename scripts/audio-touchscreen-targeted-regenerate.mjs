import { runProductionMode } from './audio-production.mjs';
import { synthesizeGeminiGenerateContentPart, synthesizeGeminiPart } from './audio-gemini-tts.mjs';
import { synthesizeOpenRouterPart } from './audio-openrouter-tts.mjs';

const articleId = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length)
  || process.env.BAREEQ_AUDIO_ARTICLE
  || 'how-touchscreens-work';
const targetedTransport = process.env.BAREEQ_TARGETED_TTS_TRANSPORT?.trim() || 'developer-interactions';

if (articleId !== 'how-touchscreens-work') {
  console.error(`Unsupported article ${articleId}; this helper is touchscreen-only.`);
  process.exit(2);
}
if (!['developer-generate-content', 'developer-interactions', 'openrouter-speech'].includes(targetedTransport)) {
  console.error(`Unsupported BAREEQ_TARGETED_TTS_TRANSPORT=${targetedTransport}`);
  process.exit(2);
}

async function synthesizeTargeted({ article, part, splitPlan, voice, correctionHint }) {
  // All six touchscreen parts now have confirmed dual-ASR mismatch evidence
  // across the bounded repair passes. The force-part
  // gate still decides which one is regenerated on each invocation, so already
  // successful parts remain byte-for-byte untouched.
  if (![0, 1, 2, 3, 4, 5].includes(part.partIndex)) {
    throw new Error(`Unsupported touchscreen targeted part ${part.partIndex + 1}; refusing to regenerate successful audio.`);
  }
  const context = {
    articleTitle: article.title,
    partIndex: part.partIndex,
    partCount: splitPlan.parts.length,
    correctionHint,
  };
  if (targetedTransport === 'openrouter-speech') {
    // OpenRouter uses the exact reviewed part text and the same approved
    // Gemini TTS model/voice. It is a quota-independent transport fallback;
    // no candidate can publish unless the fresh dual-ASR 0/0/0/0 gate passes.
    return synthesizeOpenRouterPart({
      apiKey: process.env.OPENROUTER_API_KEY,
      part,
      voice,
    });
  }
  if (targetedTransport === 'developer-generate-content') {
    return synthesizeGeminiGenerateContentPart({
      apiKey: process.env.GEMINI_API_KEY,
      part,
      context,
      voice,
    });
  }
  return synthesizeGeminiPart({
    apiKey: process.env.GEMINI_API_KEY,
    part,
    context,
    voice,
  });
}

try {
  const result = await runProductionMode({
    mode: 'generate-candidate',
    articleId,
    root: process.cwd(),
    synthesize: synthesizeTargeted,
  });

  console.log(JSON.stringify({
    mode: 'touchscreen-targeted-regeneration',
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
