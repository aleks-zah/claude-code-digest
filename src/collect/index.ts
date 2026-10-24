import type { Source } from "../config.ts";
import { withRetries } from "../http.ts";
import type { RawEntry, SourceResult } from "../types.ts";
import { collectFeed } from "./feed.ts";
import { collectHn } from "./hn.ts";
import { collectHtmlIndex } from "./htmlIndex.ts";
import { collectReadmeLinks } from "./readmeLinks.ts";
import { collectReddit } from "./reddit.ts";

export interface CollectContext {
  since: Date;
  retries: number;
  linkSets: Record<string, string[]>;
}

async function collectOne(s: Source, ctx: CollectContext): Promise<{ entries: RawEntry[]; linkSet?: string[] }> {
  switch (s.adapter) {
    case "feed":
      return { entries: await collectFeed(s.url, ctx.since) };
    case "html-index":
      return collectHtmlIndex(s.url, s.linkPattern, ctx.linkSets[s.id]);
    case "readme-links":
      return collectReadmeLinks(s.url, ctx.linkSets[s.id]);
    case "reddit":
      return { entries: await collectReddit(s.subreddit, ctx.since) };
    case "hn":
      return { entries: await collectHn(s.queries, s.minScore ?? 0, ctx.since) };
  }
}

export function collectAll(sources: Source[], ctx: CollectContext): Promise<SourceResult[]> {
  return Promise.all(
    sources.map(async (s): Promise<SourceResult> => {
      try {
        const { entries, linkSet } = await withRetries(() => collectOne(s, ctx), ctx.retries);
        const newest = entries.toSorted((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
        return { sourceId: s.id, entries: newest.slice(0, s.maxItemsPerRun), linkSet };
      } catch (err) {
        return { sourceId: s.id, entries: [], error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}
