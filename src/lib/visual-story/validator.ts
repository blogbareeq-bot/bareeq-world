import type { VisualStoryData } from '../../types/visual-story';

export const isValidVisualStory = (story: VisualStoryData | undefined): story is VisualStoryData => {
  if (!story || !story.slug || !story.title || !/^[a-f0-9]{64}$/.test(story.sourceFingerprint)) return false;
  if (!Array.isArray(story.cards) || story.cards.length < 7 || story.cards.length > 12) return false;
  const ids = new Set<string>();
  for (const card of story.cards) {
    if (!card.id || ids.has(card.id) || !card.title?.trim() || !card.body?.trim() || card.body.length > 290) return false;
    ids.add(card.id);
  }
  return story.director?.density === 'airy'
    && story.director?.motion === 'calm'
    && story.director?.palette?.length === 4;
};
