import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    category: z.enum(['أطياف العقل', 'بريق الكتب', 'نافذة على العالم', 'المستقبل الآن', 'ببساطة…']),
    categorySlug: z.enum(['atyaf-al-aql', 'bareeq-books', 'window-on-world', 'future-now', 'simply']),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    readingMinutes: z.number().int().positive().default(5),
    tags: z.array(z.string()).default([]),
    author: z.string().default('فريق بريق')
  })
});

export const collections = { posts };
