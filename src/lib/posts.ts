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
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>|[`*_>#\[\]()|~!-]/g, ' ')
    .split(/\s+/u)
    .filter(Boolean).length;
}

export function postReadingMinutes(post: Post): number {
  return Math.max(1, Math.ceil(postWordCount(post) / 170));
}

export function getRelatedPosts(post: Post, posts: Post[], limit = 3): Post[] {
  const ranked = posts
    .filter((candidate) => candidate.id !== post.id)
    .map((candidate) => {
      const sharedTags = candidate.data.tags.filter((tag) => post.data.tags.includes(tag)).length;
      const sameSeries = Boolean(post.data.seriesSlug && candidate.data.seriesSlug === post.data.seriesSlug);
      const sameCategory = candidate.data.categorySlug === post.data.categorySlug;
      const intentScore = (sameSeries ? 8 : 0) + (sharedTags * 3) + (sameCategory ? 1 : 0);
      return { candidate, sharedTags, sameSeries, sameCategory, intentScore };
    });
  const primary = ranked
    .filter(({ sharedTags, sameSeries }) => sameSeries || sharedTags > 0)
    .sort((a,b) => b.intentScore-a.intentScore || b.candidate.data.publishedAt.valueOf()-a.candidate.data.publishedAt.valueOf());
  const selected = primary.map(({candidate})=>candidate);
  if (selected.length < limit) {
    for (const { candidate } of ranked.filter(x=>x.sameCategory).sort((a,b)=>b.candidate.data.publishedAt.valueOf()-a.candidate.data.publishedAt.valueOf())) {
      if (!selected.some(x=>x.id===candidate.id)) selected.push(candidate);
      if (selected.length>=limit) break;
    }
  }
  if (selected.length < limit) {
    for (const { candidate } of ranked.sort((a,b)=>b.candidate.data.publishedAt.valueOf()-a.candidate.data.publishedAt.valueOf())) {
      if (!selected.some(x=>x.id===candidate.id)) selected.push(candidate);
      if (selected.length>=limit) break;
    }
  }
  return selected.slice(0,limit);
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
