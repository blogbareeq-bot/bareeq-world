import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const inventory = JSON.parse(await readFile('docs/editorial/speech-script-inventory.json', 'utf8'));
if (pkg.version !== '4.22.0' || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('V4.22.0 package identity mismatch.');
if (inventory.articleCount !== 15 || inventory.counts?.passed !== 15 || inventory.counts?.needsReview !== 0 || inventory.counts?.highRisk !== 0) throw new Error('V4.22.0 Speech Script inventory is not fully approved.');

const plan = execFileSync(process.execPath, ['scripts/generate-audio.mjs', '--plan'], {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  env: {
    ...process.env,
    BAREEQ_TTS_PROVIDER: 'azure-fahed',
    BAREEQ_TTS_INCLUDE_IDS: '',
    AZURE_SPEECH_KEY: '',
    GEMINI_TTS_ENDPOINT: '',
    OPENAI_TTS_ENDPOINT: '',
    BAREEQ_TTS_CONTRACT_TEST: '',
  },
});
for (const token of [
  '15 selected article(s)',
  '52 synthesis request(s)',
  '140591 billable character(s)',
  'فهد [ar-KW-FahedNeural]',
  'planning itself sends 0 provider requests',
]) if (!plan.includes(token)) throw new Error(`V4.22.0 Fahed plan is missing: ${token}`);

const speechScripts = (await readdir('scripts/speech-scripts')).filter((file) => file.endsWith('.json'));
const testPlans = (await readdir('scripts/speech-test-clips')).filter((file) => file.endsWith('.json'));
if (speechScripts.length !== 15 || testPlans.length !== 15) throw new Error(`V4.22.0 expected 15 Speech Scripts and 15 test plans; found ${speechScripts.length}/${testPlans.length}.`);

const manifestFile = path.join('public', 'audio', 'articles', 'de93f3d9f91c8b8b', 'manifest.json');
let manifest = null;
try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); } catch {}
if (manifest?.defaultVoice === 'fahed') {
  if (manifest.provider !== 'Microsoft Azure AI Speech' || manifest.model !== 'Neural TTS' || manifest.language !== 'ar-KW' || manifest.voices?.length !== 1 || manifest.voices[0]?.providerVoice !== 'ar-KW-FahedNeural' || manifest.azureSsmlVersion !== 1) {
    throw new Error('V4.22.0 detected an incomplete or incompatible Fahed pilot manifest.');
  }
}

const build = pkg.scripts?.build || '';
for (const token of ['prepare-v4220.mjs', 'check-v4220-release.mjs', 'test-azure-fahed.mjs', 'astro build']) if (!build.includes(token)) throw new Error(`V4.22.0 build pipeline is missing ${token}.`);

const sensitivePatterns = [/AIza[0-9A-Za-z_-]{20,}/u, /sk-proj-[0-9A-Za-z_-]{20,}/u, /AZURE_SPEECH_KEY[ \t]*=[ \t]*[^\s"']{20,}/u];
for (const file of ['.env.example', 'README.md', 'scripts/generate-audio.mjs', 'scripts/generate-fahed-test-clip.mjs']) {
  const source = await readFile(file, 'utf8');
  if (sensitivePatterns.some((pattern) => pattern.test(source))) throw new Error(`V4.22.0 secret scan failed: ${file}`);
}

console.log(`V4.22.0 release gate passed: 15/15 text scripts approved, Fahed plan locked at 52 requests/140,591 characters, provider calls during planning = 0, and pilot audio state = ${manifest?.defaultVoice === 'fahed' ? 'complete Fahed manifest detected' : 'approved fallback retained until listening gate passes'}.`);
