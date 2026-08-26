import assert from 'node:assert/strict';
import { buildAzureSsml, escapeXml, textToAzureSsml } from './azure-speech-ssml.mjs';

assert.equal(escapeXml(`أ & ب < ج > د " هـ ' و`), 'أ &amp; ب &lt; ج &gt; د &quot; هـ &apos; و');

const numbers = textToAzureSsml('عام 2026 ارتفعت 3.3% من 5,172، والرقم 9789960549699.');
assert.match(numbers, /interpret-as="cardinal">2026<\/say-as>/u);
assert.match(numbers, /interpret-as="cardinal">3\.3<\/say-as> في المئة/u);
assert.match(numbers, /interpret-as="cardinal">5172<\/say-as>/u);
assert.match(numbers, /interpret-as="number_digit">9789960549699<\/say-as>/u);

const embedded = textToAzureSsml('الإصدار RMF1.0 و DOI10.1177 يظلان نصًا كما هما.');
assert.equal(embedded, 'الإصدار RMF1.0 و DOI10.1177 يظلان نصًا كما هما.');

const ssml = buildAzureSsml({
  language: 'ar-KW',
  voice: 'ar-KW-FahedNeural',
  rate: '-2%',
  items: [
    { type: 'title', text: 'عنوان & اختبار 2026' },
    { type: 'h2', text: 'قسم 1' },
    { type: 'paragraph', text: 'النسبة 12%.' },
  ],
});
assert.match(ssml, /^<speak[^>]+xml:lang="ar-KW"><voice name="ar-KW-FahedNeural">/u);
assert.match(ssml, /<prosody rate="-2%">عنوان &amp; اختبار <say-as interpret-as="cardinal">2026<\/say-as><\/prosody><break time="260ms"\/>/u);
assert.match(ssml, /<break time="160ms"\/>/u);
assert.match(ssml, /<say-as interpret-as="cardinal">12<\/say-as> في المئة/u);
assert.match(ssml, /<\/voice><\/speak>$/u);

const legacySsml = buildAzureSsml({
  language: 'ar-SA',
  voice: 'ar-SA-HamedNeural',
  numberHints: false,
  items: [{ type: 'paragraph', text: 'النسبة 12%.' }],
});
assert.match(legacySsml, />النسبة 12%\.<\/prosody>/u);
assert.doesNotMatch(legacySsml, /<say-as/u);

assert.throws(() => buildAzureSsml({ language: 'ar-KW', voice: '', items: [] }), /requires language, voice/u);

console.log('Azure Fahed SSML tests passed: escaping, Arabic number hints, percentages, long identifiers, and structural pauses.');
