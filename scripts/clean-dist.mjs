import { rm } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const outputRoot = path.resolve(projectRoot, 'dist');

if (path.dirname(outputRoot) !== projectRoot || path.basename(outputRoot) !== 'dist') {
  throw new Error(`Refusing to clean an unexpected output path: ${outputRoot}`);
}

await rm(outputRoot, { recursive: true, force: true });
console.log('Cleaned the production output directory.');
