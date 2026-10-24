export type Tier = 1 | 2 | 3;

export interface Engagement {
  points?: number;
  comments?: number;
}

export interface RawEntry {
  url: string;
  title: string;
  excerpt: string;
  publishedAt: Date;
  author?: string;
  engagement?: Engagement;
  /** HN or Reddit thread, when the entry is a link post. */
  discussionUrl?: string;
  /** Index-page anchor text is noisy; enrich replaces it with the article title. */
  titleFromIndex?: boolean;
}

export interface SourceResult {
  sourceId: string;
  entries: RawEntry[];
  /** Current link set for html-index / readme-links sources, persisted after a successful send. */
  linkSet?: string[];
  error?: string;
}

export interface Item {
  id: string;
  /** Ids to mark as seen: the item itself plus any entries collapsed into it. */
  seenIds: string[];
  url: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  author?: string;
  engagement: Engagement;
  sources: string[];
  tier: Tier;
  discussionUrls: string[];
  titleFromIndex?: boolean;
  text?: string;
  comments?: string[];
}
