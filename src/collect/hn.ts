import { getJson } from "../http.ts";
import { htmlToText, truncate } from "../text.ts";
import type { RawEntry } from "../types.ts";

export interface HnHit {
  objectID: string;
  title: string;
  url?: string | null;
  author: string;
  points: number;
  num_comments?: number | null;
  created_at_i: number;
  story_text?: string | null;
}

export function parseHits(hits: HnHit[]): RawEntry[] {
  return hits.map((h) => {
    const thread = `https://news.ycombinator.com/item?id=${h.objectID}`;
    return {
      url: h.url || thread,
      title: h.title,
      excerpt: truncate(htmlToText(h.story_text ?? ""), 500),
      publishedAt: new Date(h.created_at_i * 1000),
      author: h.author,
      engagement: { points: h.points, comments: h.num_comments ?? 0 },
      discussionUrl: thread,
    };
  });
}

export async function collectHn(queries: string[], minPoints: number, since: Date): Promise<RawEntry[]> {
  const filters = `points>${minPoints},created_at_i>${Math.floor(since.getTime() / 1000)}`;
  const results = await Promise.all(
    queries.map((q) =>
      getJson<{ hits: HnHit[] }>(
        `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=50` +
          `&query=${encodeURIComponent(q)}&numericFilters=${encodeURIComponent(filters)}`,
      ),
    ),
  );
  const byId = new Map(results.flatMap((r) => r.hits).map((h) => [h.objectID, h]));
  return parseHits([...byId.values()]);
}

interface FirebaseItem {
  text?: string;
  kids?: number[];
  deleted?: boolean;
  dead?: boolean;
}

/** The Firebase API lists `kids` in ranked display order, which Algolia does not. */
export async function topHnComments(threadUrl: string, n: number): Promise<string[]> {
  const id = new URL(threadUrl).searchParams.get("id");
  const item = (s: string | number) => getJson<FirebaseItem>(`https://hacker-news.firebaseio.com/v0/item/${s}.json`);
  const story = await item(id!);
  const kids = await Promise.all((story.kids ?? []).slice(0, n).map(item));
  return kids.filter((k) => k.text && !k.deleted && !k.dead).map((k) => truncate(htmlToText(k.text!), 800));
}
