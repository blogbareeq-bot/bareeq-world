import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const categoryNames = ['أطياف العقل', 'بريق الكتب', 'نافذة على العالم', 'المستقبل الآن', 'ببساطة…'] as const;
const categorySlugs = ['atyaf-al-aql', 'bareeq-books', 'window-on-world', 'future-now', 'simply'] as const;

const posts = defineCollection({
  loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string().min(40),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    category: z.enum(categoryNames),
    categorySlug: z.enum(categorySlugs),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    imageWidth: z.number().int().positive().optional(),
    imageHeight: z.number().int().positive().optional(),
    imagePosition: z.string().default('center'),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    readingMinutes: z.number().int().positive().default(5),
    tags: z.array(z.string()).default([]),
    author: z.string().default('فريق بريق'),
    legacyPath: z.string().optional()
  })
});

const pages = defineCollection({
  loader: glob({ base: './src/content/pages', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    updatedAt: z.coerce.date().optional()
  })
});

export const collections = { posts, pages };
