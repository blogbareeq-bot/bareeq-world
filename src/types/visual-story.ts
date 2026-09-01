export interface VisualStoryCard {
  id: string;
  kicker: string;
  title: string;
  body: string;
  visual: string;
}

export interface VisualStoryDirector {
  mood: string;
  label: string;
  grammar: string;
  density: 'airy';
  motion: 'calm';
  palette: string[];
}

export interface VisualStoryData {
  slug: string;
  title: string;
  articlePath: string;
  image: string;
  sourceFingerprint: string;
  director: VisualStoryDirector;
  cards: VisualStoryCard[];
}
