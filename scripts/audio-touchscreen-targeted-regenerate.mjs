import { runProductionMode } from './audio-production.mjs';
import { synthesizeGeminiGenerateContentPart, synthesizeGeminiPart } from './audio-gemini-tts.mjs';

const articleId = process.argv.find((arg) => arg.startsWith('--article='))?.slice('--article='.length)
  || process.env.BAREEQ_AUDIO_ARTICLE
  || 'how-touchscreens-work';
const targetedTransport = process.env.BAREEQ_TARGETED_TTS_TRANSPORT?.trim() || 'developer-interactions';

if (articleId !== 'how-touchscreens-work') {
  console.error(`Unsupported article ${articleId}; this helper is touchscreen-only.`);
  process.exit(2);
}
if (!['developer-generate-content', 'developer-interactions'].includes(targetedTransport)) {
  console.error(`Unsupported BAREEQ_TARGETED_TTS_TRANSPORT=${targetedTransport}`);
  process.exit(2);
}

async function synthesizeTargeted({ article, part, splitPlan, voice, correctionHint }) {
  if (![0, 1, 4].includes(part.partIndex)) {
    throw new Error(`Unsupported touchscreen targeted part ${part.partIndex + 1}; refusing to regenerate successful audio.`);
  }
  const context = {
    articleTitle: article.title,
    partIndex: part.partIndex,
    partCount: splitPlan.parts.length,
    correctionHint,
  };
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
