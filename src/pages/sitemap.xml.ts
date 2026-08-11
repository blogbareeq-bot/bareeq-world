import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { getPublishedPosts, escapeXml, uniqueTags } from '../lib/posts';
import { archivePolicy, categories, series, site } from '../config/site';

function latestDate(dates: Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.valueOf())));
}

export const GET: APIRoute = async ({ site: astroSite }) => {
  const base = astroSite?.toString() ?? site.url;
  const posts = await getPublishedPosts();
  const pages = await getCollection('pages');
  const latestPostDate = latestDate(posts.map((post) => post.data.updatedAt ?? post.data.publishedAt));
  const pageDate = (id: string) => pages.find((page) => page.id === id)?.data.updatedAt ?? latestPostDate;
  const tagCounts = new Map(uniqueTags(posts).map((tag) => [tag, posts.filter((post) => post.data.tags.includes(tag))]));
  const staticPaths = [
    { path: '/', date: latestPostDate },
    { path: '/articles/', date: latestPostDate },
    { path: '/start-here/', date: latestPostDate },
    { path: '/series/', date: latestPostDate },
    { path: '/about/', date: pageDate('about') },
    { path: '/team/', date: pageDate('team') },
    { path: '/contact/', date: pageDate('contact-source') },
    { path: '/privacy/', date: pageDate('privacy') },
    { path: '/terms/', date: pageDate('terms') },
    { path: '/disclaimer/', date: pageDate('disclaimer') },
    { path: '/editorial-policy/', date: pageDate('editorial-policy') }
  ];
  const categoryPaths = categories.map((category) => {
    const relevant = posts.filter((post) => post.data.categorySlug === category.slug);
    return { path: `/category/${category.slug}/`, date: latestDate(relevant.map((post) => post.data.updatedAt ?? post.data.publishedAt)) };
  });
  const seriesPaths = series.flatMap((item) => {
    const relevant = posts.filter((post) => post.data.seriesSlug === item.slug);
    return relevant.length < archivePolicy.minPostsToIndexSeries ? [] : [{ path: `/series/${item.slug}/`, date: latestDate(relevant.map((post) => post.data.updatedAt ?? post.data.publishedAt)) }];
  });
  const tagPaths = [...tagCounts.entries()].flatMap(([tag, relevant]) => relevant.length < archivePolicy.minPostsToIndexArchive ? [] : [{
    path: `/tags/${encodeURIComponent(tag)}/`,
    date: latestDate(relevant.map((post) => post.data.updatedAt ?? post.data.publishedAt))
  }]);
  const urls = [
    ...staticPaths,
    ...categoryPaths,
    ...seriesPaths,
    ...tagPaths,
    ...posts.map((post) => ({ path: `/posts/${post.id}/`, date: post.data.updatedAt ?? post.data.publishedAt }))
  ];
  const entries = urls.map(({ path, date }) => `<url><loc>${escapeXml(new URL(path, base).toString())}</loc><lastmod>${date.toISOString().slice(0, 10)}</lastmod></url>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
};
