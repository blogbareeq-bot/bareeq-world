import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { VisualStoryData } from '../../types/visual-story';

const STORIES_DIR = resolve(process.cwd(), 'src', 'data', 'visual-stories');

let cache: VisualStoryData[] | null = null;

export const loadAllVisualStories = async (): Promise<VisualStoryData[]> => {
  if (cache) return cache;
  const files = (await readdir(STORIES_DIR))
    .filter((name) => name.endsWith('.json') && !name.endsWith('.skeleton.json'))
    .sort();
  const stories: VisualStoryData[] = [];
  for (const file of files) {
    const raw = await readFile(resolve(STORIES_DIR, file), 'utf8');
    const parsed = JSON.parse(raw) as VisualStoryData;
    // Defensive: skip placeholder skeletons even if a future script forgets
    // the naming convention.
    if ((parsed as unknown as { _skeleton?: unknown })._skeleton) continue;
    stories.push(parsed);
  }
  cache = stories;
  return stories;
};

export const findVisualStoryBySlug = async (slug: string): Promise<VisualStoryData | undefined> => {
  const stories = await loadAllVisualStories();
  return stories.find((story) => story.slug === slug);
};

export const clearVisualStoryCache = (): void => {
  cache = null;
};
