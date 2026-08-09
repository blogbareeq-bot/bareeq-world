import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const categoryNames = ['أطياف العقل', 'بريق الكتب', 'نافذة على العالم', 'المستقبل الآن', 'ببساطة…'] as const;
const categorySlugs = ['atyaf-al-aql', 'bareeq-books', 'window-on-world', 'future-now', 'simply'] as const;
const seriesSlugs = ['mind-and-decisions', 'technology-simply', 'windows-to-world', 'books-for-life'] as const;

const posts = defineCollection({
  loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string().min(40),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    category: z.enum(categoryNames),
    categorySlug: z.enum(categorySlugs),
    seriesSlug: z.enum(seriesSlugs).optional(),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    imageWidth: z.number().int().positive().optional(),
    imageHeight: z.number().int().positive().optional(),
    imagePosition: z.string().default('center'),
    thumbnail: z.string().optional(),
    thumbnailAlt: z.string().optional(),
    thumbnailWidth: z.number().int().positive().default(1600),
    thumbnailHeight: z.number().int().positive().default(900),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    tags: z.array(z.string()).max(2).default([]),
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
