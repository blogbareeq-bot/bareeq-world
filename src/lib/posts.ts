import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

export async function getPublishedPosts(): Promise<Post[]> {
  const posts = await getCollection('posts', ({ data }) => import.meta.env.PROD ? data.draft !== true : true);
  return posts.sort((a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf());
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('ar-SA-u-ca-gregory', {
    day: 'numeric', month: 'long', year: 'numeric'
  }).format(date);
}

export function formatArabicNumber(value: number): string {
  return new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 0 }).format(value);
}

export function formatArticleCount(value: number): string {
  const number = formatArabicNumber(value);
  if (value === 0) return 'لا مقالات منشورة';
  if (value === 1) return 'مقال واحد';
  if (value === 2) return 'مقالان';
  if (value >= 3 && value <= 10) return `${number} مقالات`;
  return `${number} مقالًا`;
}

export function formatReadingMinutes(value: number): string {
  const number = formatArabicNumber(value);
  if (value === 1) return 'دقيقة قراءة';
  if (value === 2) return 'دقيقتا قراءة';
  if (value >= 3 && value <= 10) return `${number} دقائق قراءة`;
  return `${number} دقيقة قراءة`;
}

export function postWordCount(post: Post): number {
  return post.body
    .replace(/^---[\s\S]*?---/m, '')
    .replace(/<[^>]+>|[`*_>#\[\]()!-]/g, ' ')
    .split(/\s+/u)
    .filter(Boolean).length;
}

export function absoluteUrl(path: string, siteUrl = 'https://bareeqworld.com'): string {
  return new URL(path, siteUrl).toString();
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function uniqueTags(posts: Post[]): string[] {
  return [...new Set(posts.flatMap((post) => post.data.tags))].sort((a, b) => a.localeCompare(b, 'ar'));
}
