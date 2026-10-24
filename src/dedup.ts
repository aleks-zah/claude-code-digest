import { urlId } from "./canonical.ts";
import type { Source } from "./config.ts";
import type { Seen } from "./state.ts";
import { truncate } from "./text.ts";
import type { Item, SourceResult } from "./types.ts";

export function toItems(results: SourceResult[], sources: Map<string, Source>): Item[] {
  return results.flatMap((r) =>
    r.entries.map((e): Item => {
      const id = urlId(e.url);
      return {
        id,
        seenIds: [id],
        url: e.url,
        title: e.title,
        excerpt: e.excerpt,
        publishedAt: e.publishedAt.toISOString(),
        author: e.author,
        engagement: e.engagement ?? {},
        sources: [r.sourceId],
        tier: sources.get(r.sourceId)!.tier,
        discussionUrls: e.discussionUrl ? [e.discussionUrl] : [],
        titleFromIndex: e.titleFromIndex,
      };
    }),
  );
}

export function dropSeen(items: Item[], seen: Seen): Item[] {
  return items.filter((i) => !(i.id in seen));
}

/**
 * Merges each `collapse: day` source's entries from the same UTC day into one item. Runs after
 * dropSeen, so a release already sent yesterday is not folded into today's item.
 */
export function collapseByDay(items: Item[], sources: Map<string, Source>, maxChars: number): Item[] {
  const groups = new Map<string, Item[]>();
  const out: Item[] = [];
  for (const item of items) {
    const source = sources.get(item.sources[0])!;
    if (source.adapter !== "feed" || source.collapse !== "day") {
      out.push(item);
      continue;
    }
    const key = `${source.id}:${item.publishedAt.slice(0, 10)}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const group of groups.values()) {
    const [newest, ...rest] = group.toSorted((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    if (rest.length === 0) {
      out.push(newest);
      continue;
    }
    const text = truncate(group.map((i) => `${i.title}: ${i.excerpt}`).join("\n"), maxChars);
    out.push({
      ...newest,
      seenIds: group.flatMap((i) => i.seenIds),
      title: `${newest.title} (+${rest.length} more)`,
      excerpt: truncate(text, 500),
      text,
    });
  }
  return out;
}

/** Same canonical URL from several sources becomes one item that keeps every source. */
export function mergeSources(items: Item[]): Item[] {
  const byId = new Map<string, Item>();
  for (const item of items.toSorted((a, b) => a.tier - b.tier)) {
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, { ...item });
      continue;
    }
    const union = <T>(a: T[], b: T[]) => [...new Set([...a, ...b])];
    prev.sources = union(prev.sources, item.sources);
    prev.seenIds = union(prev.seenIds, item.seenIds);
    prev.discussionUrls = union(prev.discussionUrls, item.discussionUrls);
    prev.engagement = {
      points: maxDefined(prev.engagement.points, item.engagement.points),
      comments: maxDefined(prev.engagement.comments, item.engagement.comments),
    };
    if (item.publishedAt < prev.publishedAt) prev.publishedAt = item.publishedAt;
    if (!prev.excerpt) prev.excerpt = item.excerpt;
  }
  return [...byId.values()];
}

function maxDefined(a?: number, b?: number): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}
