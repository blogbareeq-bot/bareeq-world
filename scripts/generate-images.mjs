import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const publicRoot = path.resolve('public');
const sourceRoot = path.join(publicRoot, 'images', 'posts');
const generatedRoot = path.join(publicRoot, 'images', 'generated');
const socialRoot = path.join(publicRoot, 'images', 'social');
const widths = [320, 640, 960, 1280];

await rm(generatedRoot, { recursive: true, force: true });
await rm(socialRoot, { recursive: true, force: true });
await mkdir(generatedRoot, { recursive: true });
await mkdir(socialRoot, { recursive: true });

const files = (await readdir(sourceRoot)).filter((name) => /\.(?:webp|png|jpe?g)$/i.test(name));
for (const file of files) {
  const input = path.join(sourceRoot, file);
  const name = path.parse(file).name;
  for (const width of widths) {
    await sharp(input)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 78, effort: 5 })
      .toFile(path.join(generatedRoot, `${name}-${width}.webp`));
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

console.log(`Generated ${files.length * widths.length} responsive images and ${files.length + 1} social images.`);
