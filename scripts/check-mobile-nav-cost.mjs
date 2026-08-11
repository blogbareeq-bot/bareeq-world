import { readFile } from 'node:fs/promises';
const css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const header = await readFile(new URL('../src/components/Header.astro', import.meta.url), 'utf8');
const audio = await readFile(new URL('./generate-audio.mjs', import.meta.url), 'utf8');
const env = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const failures = [];
const mobile900 = css.match(/@media \(max-width:900px\) \{([\s\S]*?)\n\}/)?.[1] || '';
if (!mobile900.includes('display:flex') || !mobile900.includes('flex-wrap:wrap') || !mobile900.includes('flex:1 1 104px')) failures.push('Mobile category strip is not using adaptive wrapped flex navigation.');
if (!mobile900.includes('.category-strip{position:relative;top:auto}')) failures.push('Category strip must stop being sticky at tablet/mobile widths.');
if (mobile900.includes('overflow-x:auto')) failures.push('Mobile category strip still requires horizontal scrolling.');
if (!mobile900.includes('white-space:normal')) failures.push('Mobile category names are not allowed to wrap.');
if (!header.includes('ticker-label-mobile') || !header.includes('ticker-title-mobile') || !header.includes('compactTickerTitle')) failures.push('Compact mobile ticker labels/titles are missing.');
for (const token of ['AZURE_SPEECH_FREE_MONTHLY_CHARS','AZURE_SPEECH_BUILD_WARNING_CHARS','AZURE_SPEECH_BUILD_HARD_LIMIT_CHARS','Azure Speech cost guard','Azure Speech safety stop']) if (!audio.includes(token)) failures.push(`Audio cost guard missing: ${token}`);
for (const token of ['AZURE_SPEECH_FREE_MONTHLY_CHARS=500000','AZURE_SPEECH_BUILD_WARNING_CHARS=400000','AZURE_SPEECH_BUILD_HARD_LIMIT_CHARS=450000']) if (!env.includes(token)) failures.push(`.env.example missing ${token}`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Mobile category navigation, compact ticker, and Azure Speech cost guard audit passed.');
