const generatedRoot = '/images/generated';
const thumbnailRoot = '/images/thumbnails';
const socialRoot = '/images/social';

function baseName(path?: string): string | undefined {
  if (!path) return undefined;
  return path.split('/').pop()?.replace(/\.[^.]+$/, '');
}

export function responsiveImage(path?: string) {
  const name = baseName(path);
  if (!name || !path?.startsWith('/images/posts/')) return { src: path, srcset: undefined };
  return {
    src: `${generatedRoot}/${name}-640.webp`,
    srcset: [320, 640, 960, 1280].map((width) => `${generatedRoot}/${name}-${width}.webp ${width}w`).join(', ')
  };
}

export function responsiveThumbnail(path?: string) {
  const name = baseName(path);
  if (!name || !path?.startsWith('/images/thumbnails/')) return responsiveImage(path);
  return {
    src: `${thumbnailRoot}/${name}-640.webp`,
    srcset: [320, 640, 960, 1280].map((width) => `${thumbnailRoot}/${name}-${width}.webp ${width}w`).join(', ')
  };
}

export function thumbnailImage(path?: string): string | undefined {
  const name = baseName(path);
  if (!name) return path;
  if (path?.startsWith('/images/thumbnails/')) return `${thumbnailRoot}/${name}-320.webp`;
  return path?.startsWith('/images/posts/') ? `${generatedRoot}/${name}-320.webp` : path;
}

export function socialImage(path?: string): string | undefined {
  const name = baseName(path);
  return name && (path?.startsWith('/images/posts/') || path?.startsWith('/images/thumbnails/'))
    ? `${socialRoot}/${name}-social.jpg`
    : path;
}
