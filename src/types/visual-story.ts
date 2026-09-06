export type VisualStoryCardKind =
  | 'hook'
  | 'reveal'
  | 'question'
  | 'example'
  | 'contrast'
  | 'myth'
  | 'evidence'
  | 'experiment'
  | 'reflection'
  | 'application'
  | 'takeaway';

export interface VisualStoryCard {
  id: string;
  /** Editorial Arabic kicker shown before the title. */
  kicker: string;
  /** Editorial card title — must be a complete editorial sentence, not an H2 label. */
  title: string;
  /** Standalone body. Must read and inform without the original article. */
  body: string;
  /** Single semantic kind for analytics and validation. */
  kind: VisualStoryCardKind;
  /** Visual hint for the SVG art layer. */
  visual: string;
  /** Optional pull-quote, surfaced in share text. */
  pullQuote?: string;
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
  /** Short storyboard synopsis for QA — must describe the editorial arc, not the article. */
  arc: string;
  /** Narrative path label: e.g. technical, reflective, books, world, simply. */
  path: 'technical' | 'reflective' | 'books' | 'world' | 'simply';
  director: VisualStoryDirector;
  cards: VisualStoryCard[];
}
