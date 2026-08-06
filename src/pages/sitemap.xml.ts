import type { APIRoute } from 'astro';
import { getPublishedPosts, escapeXml } from '../lib/posts';
import { categories, site } from '../config/site';

export const GET: APIRoute = async ({ site: astroSite }) => {
  const base = astroSite?.toString() ?? site.url;
  const posts = await getPublishedPosts();
  const staticPaths = ['/', '/articles/', '/about/', '/contact/', '/privacy/', '/terms/', '/search/'];
  const urls = [
    ...staticPaths.map((path) => ({ path, date: new Date() })),
    ...categories.map((category) => ({ path: `/category/${category.slug}/`, date: new Date() })),
    ...posts.map((post) => ({ path: `/posts/${post.id}/`, date: post.data.updatedAt ?? post.data.publishedAt }))
  ];
  const entries = urls.map(({ path, date }) => `<url><loc>${escapeXml(new URL(path, base).toString())}</loc><lastmod>${date.toISOString().slice(0, 10)}</lastmod></url>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
