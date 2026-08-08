import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const publicRoot = path.resolve('public');
const sourceRoot = path.join(publicRoot, 'images', 'posts');
const thumbnailSourceRoot = path.resolve('assets', 'thumbnails-source');
const generatedRoot = path.join(publicRoot, 'images', 'generated');
const thumbnailRoot = path.join(publicRoot, 'images', 'thumbnails');
const socialRoot = path.join(publicRoot, 'images', 'social');
const widths = [320, 640, 960, 1280];

await rm(generatedRoot, { recursive: true, force: true });
await rm(thumbnailRoot, { recursive: true, force: true });
await rm(socialRoot, { recursive: true, force: true });
await mkdir(generatedRoot, { recursive: true });
await mkdir(thumbnailRoot, { recursive: true });
await mkdir(socialRoot, { recursive: true });

const coverFiles = (await readdir(sourceRoot)).filter((name) => /\.(?:webp|png|jpe?g)$/i.test(name));
const thumbnailFiles = (await readdir(thumbnailSourceRoot)).filter((name) => /\.(?:webp|png|jpe?g)$/i.test(name));
const coverNames = new Set(coverFiles.map((file) => path.parse(file).name));
const thumbnailNames = new Set(thumbnailFiles.map((file) => path.parse(file).name));
const missingThumbnails = [...coverNames].filter((name) => !thumbnailNames.has(name));
const orphanThumbnails = [...thumbnailNames].filter((name) => !coverNames.has(name));
if (missingThumbnails.length || orphanThumbnails.length) {
  throw new Error(`Thumbnail sources must match article covers. Missing: ${missingThumbnails.join(', ') || 'none'}; orphaned: ${orphanThumbnails.join(', ') || 'none'}`);
}

for (const file of coverFiles) {
  const input = path.join(sourceRoot, file);
  const name = path.parse(file).name;
  for (const width of widths) {
    await sharp(input)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 78, effort: 5 })
      .toFile(path.join(generatedRoot, `${name}-${width}.webp`));
  }
}

for (const file of thumbnailFiles) {
  const input = path.join(thumbnailSourceRoot, file);
  const name = path.parse(file).name;
  for (const width of widths) {
    await sharp(input)
      .rotate()
      .resize(width, Math.round(width * 9 / 16), { fit: 'cover', position: 'centre' })
      .webp({ quality: 80, effort: 5 })
      .toFile(path.join(thumbnailRoot, `${name}-${width}.webp`));
  }
  await sharp(input)
    .rotate()
    .resize(1200, 630, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 84, progressive: true, mozjpeg: true })
    .toFile(path.join(socialRoot, `${name}-social.jpg`));
}

const defaultSocial = path.join(publicRoot, 'images', 'bareeq-social-card.webp');
if ((await stat(defaultSocial)).isFile()) {
  await sharp(defaultSocial)
    .jpeg({ quality: 86, progressive: true, mozjpeg: true })
    .toFile(path.join(publicRoot, 'images', 'bareeq-social-card.jpg'));
}

console.log(`Generated ${coverFiles.length * widths.length} article images, ${thumbnailFiles.length * widths.length} 16:9 thumbnails, and ${thumbnailFiles.length + 1} social images.`);
