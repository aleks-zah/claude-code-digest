import type { Config, Source } from "./config.ts";
import type { Item } from "./types.ts";

export type DropReason = "low-engagement" | "over-cap";

export interface Dropped {
  item: Item;
  reason: DropReason;
}

export function prefilter(items: Item[], sources: Map<string, Source>, config: Config) {
  const dropped: Dropped[] = [];
  const kept: Item[] = [];
  for (const item of items) {
    if (lowEngagement(item, sources)) dropped.push({ item, reason: "low-engagement" });
    else kept.push(item);
  }

  const ranked = kept.toSorted(
    (a, b) =>
      a.tier - b.tier ||
      (b.engagement.points ?? 0) - (a.engagement.points ?? 0) ||
      b.publishedAt.localeCompare(a.publishedAt),
  );
  for (const item of ranked.slice(config.candidateCap)) dropped.push({ item, reason: "over-cap" });
  return { candidates: ranked.slice(0, config.candidateCap), dropped };
}

function lowEngagement(item: Item, sources: Map<string, Source>): boolean {
  if (item.tier < 3) return false;
  const points = item.engagement.points ?? 0;
  return !item.sources.some((id) => points >= (sources.get(id)!.minScore ?? 0));
}
