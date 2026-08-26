import { readFile } from 'node:fs/promises';

const files = Object.fromEntries(await Promise.all([
  'package.json',
  'package-lock.json',
  'scripts/generate-audio.mjs',
  'scripts/azure-speech-ssml.mjs',
  'scripts/generate-fahed-test-clip.mjs',
  'scripts/apply-fahed-speech-review.mjs',
  'scripts/check-speech-scripts.mjs',
  'scripts/arabic-transcript-match.mjs',
  'scripts/verify-gemini-audio-transcript.mjs',
  'scripts/approve-gemini-test-clip.mjs',
  'scripts/assemble-gemini-article-sample.mjs',
  '.github/workflows/generate-fahed-pilot.yml',
  '.github/workflows/generate-fahed-full-pilot.yml',
  '.github/workflows/verify-gemini-pilot-transcript.yml',
  '.github/workflows/generate-gemini-full-pilot.yml',
  'docs/editorial/speech-script-inventory.json',
].map(async (file) => [file, await readFile(file, 'utf8')])));

const pkg = JSON.parse(files['package.json']);
const lock = JSON.parse(files['package-lock.json']);
const inventory = JSON.parse(files['docs/editorial/speech-script-inventory.json']);
if (pkg.version !== '4.22.0' || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('V4.22.0 package identity is not locked consistently.');
if (inventory.articleCount !== 15 || inventory.counts?.passed !== 15 || inventory.counts?.needsReview !== 0 || inventory.counts?.highRisk !== 0) throw new Error('V4.22.0 requires 15/15 approved Speech Scripts.');

function requireAll(label, source, tokens) {
  for (const token of tokens) if (!source.includes(token)) throw new Error(`${label} is missing ${token}`);
}

requireAll('Fahed generator', files['scripts/generate-audio.mjs'], [
  "PROVIDER === 'azure-fahed'",
  'ar-KW-FahedNeural',
  "const GENERATOR_VERSION = 8",
  'azureSsmlVersion',
  'official microsoft.com or azure.com Speech endpoints',
]);
requireAll('Azure SSML', files['scripts/azure-speech-ssml.mjs'], ['number_digit', 'cardinal', 'في المئة', 'buildAzureSsml']);
requireAll('Fahed listening clip', files['scripts/generate-fahed-test-clip.mjs'], ['bareeq.fahed-test-clip.v1', 'listeningReview', 'pending', 'ar-KW-FahedNeural']);
requireAll('Fahed contextual review', files['scripts/apply-fahed-speech-review.mjs'], ['ARABIC_PHRASE_READINGS', 'FOREIGN_REPLACEMENTS', 'requireReviews: true']);
requireAll('Fahed pilot workflow', files['.github/workflows/generate-fahed-pilot.yml'], ['AZURE_SPEECH_KEY', 'generate-fahed-test-clip.mjs', 'speech-test-evidence']);
requireAll('Fahed full-pilot workflow', files['.github/workflows/generate-fahed-full-pilot.yml'], ['testClipPassed', 'fullSynthesisAllowed', 'BAREEQ_TTS_PROVIDER: azure-fahed', 'ar-KW-FahedNeural']);
requireAll('Arabic transcript matcher', files['scripts/arabic-transcript-match.mjs'], ['arabic-lexical-exact-v1', 'wordErrorCount', 'substitution', 'normalizeArabicTranscript']);
requireAll('Gemini transcript verifier', files['scripts/verify-gemini-audio-transcript.mjs'], ['gemini-3.7-flash', 'transcriptionPassesPerPart', 'The transcription model received audio and instructions only', 'wordErrorCountAcrossAllPasses']);
requireAll('Gemini approval gate', files['scripts/approve-gemini-test-clip.mjs'], ['automatedTranscriptReview', 'gemini-3.7-flash', 'wordErrorCountAcrossAllPasses']);
requireAll('Gemini sample assembler', files['scripts/assemble-gemini-article-sample.mjs'], ['automatedTranscriptReview', 'wordErrorCount', 'ffmpeg concat']);
requireAll('Gemini pilot transcript workflow', files['.github/workflows/verify-gemini-pilot-transcript.yml'], ['verify-gemini-audio-transcript.mjs --pilot', 'test-gemini-audio-transcript-contract.mjs', 'approve-gemini-test-clip.mjs']);
requireAll('Gemini full-pilot workflow', files['.github/workflows/generate-gemini-full-pilot.yml'], ['BAREEQ_TTS_PROVIDER: gemini', 'verify-gemini-audio-transcript.mjs --article=how-touchscreens-work', '0 word errors']);
requireAll('V4.22.0 package scripts', JSON.stringify(pkg.scripts), ['prepare-v4220.mjs', 'check-v4220-release.mjs', 'plan:audio:fahed', 'test:audio:fahed', 'test:audio:transcript']);

console.log('V4.22.0 preparation passed: 15 reviewed Speech Scripts plus a two-pass, audio-only Gemini transcript gate that blocks publication on any word error.');
