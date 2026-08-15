import { loadVoiceLabEnv } from './env.mjs';
import { listProviderVoices } from './providers.mjs';

const providerArg = process.argv.slice(2).find((value) => value.startsWith('--provider='));
if (!providerArg) throw new Error('Usage: npm run voice:lab:voices -- --provider=openai|elevenlabs|google|munsit');
const provider = providerArg.slice('--provider='.length).trim().toLowerCase();
if (!['openai', 'elevenlabs', 'google', 'munsit'].includes(provider)) throw new Error(`Unsupported provider: ${provider}`);

const env = await loadVoiceLabEnv(process.cwd());
const voices = await listProviderVoices({ provider, env });
if (!voices.length) {
  console.log(`${provider}: no voices were returned for this account.`);
  process.exit(0);
}
console.table(voices.map((voice) => ({
  id: voice.voiceId,
  name: voice.name,
  languages: (voice.languages || []).join(', '),
  dialects: (voice.dialects || []).join(', '),
  gender: voice.gender || '',
  note: voice.note || '',
})));
console.log(`${provider}: ${voices.length} voice(s). Copy only the selected voice ID into .env.voice-lab; never copy the API key into chat or source files.`);
