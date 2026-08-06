import type { APIRoute } from 'astro';
import { getPublishedPosts, escapeXml } from '../lib/posts';
import { site } from '../config/site';

export const GET: APIRoute = async ({ site: astroSite }) => {
  const posts = await getPublishedPosts();
  const base = astroSite?.toString() ?? site.url;
  const items = posts.map((post) => `
    <item>
      <title>${escapeXml(post.data.title)}</title>
      <link>${new URL(`/posts/${post.id}/`, base)}</link>
      <guid>${new URL(`/posts/${post.id}/`, base)}</guid>
      <pubDate>${post.data.publishedAt.toUTCString()}</pubDate>
      <description>${escapeXml(post.data.description)}</description>
      <category>${escapeXml(post.data.category)}</category>
    </item>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0">
    <channel>
      <title>${escapeXml(site.name)}</title>
      <link>${base}</link>
      <description>${escapeXml(site.description)}</description>
      <language>ar</language>${items}
    </channel>
  </rss>`;

  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
};
