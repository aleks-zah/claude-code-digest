import type { Config, Source } from "./config.ts";
import type { Item } from "./types.ts";

export type DropReason = "off-topic" | "low-engagement" | "noise" | "over-cap";

export interface Dropped {
  item: Item;
  reason: DropReason;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function keywordRegex(keywords: string[]): RegExp {
  return new RegExp(`(^|\\W)(${keywords.map(escapeRegex).join("|")})(?=\\W|$)`, "i");
}

export function prefilter(items: Item[], sources: Map<string, Source>, config: Config) {
  const hype = config.hypePatterns.map((p) => new RegExp(p, "i"));
  const gates = new Map<string, RegExp | null>();
  for (const s of sources.values()) {
    // Tier 1 is always a candidate unless the source sets its own keywords (Anthropic news does).
    const keywords = s.keywords ?? (s.tier === 1 ? [] : config.keywords);
    gates.set(s.id, keywords.length ? keywordRegex(keywords) : null);
  }

  const dropped: Dropped[] = [];
  const kept: Item[] = [];
  for (const item of items) {
    const reason = dropReason(item, sources, gates, hype);
    if (reason) dropped.push({ item, reason });
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

function dropReason(
  item: Item,
  sources: Map<string, Source>,
  gates: Map<string, RegExp | null>,
  hype: RegExp[],
): DropReason | undefined {
  const text = `${item.title} ${item.excerpt}`;
  if (!item.sources.some((id) => gates.get(id)?.test(text) ?? true)) return "off-topic";
  if (item.tier < 3) return;
  const points = item.engagement.points ?? 0;
  if (!item.sources.some((id) => points >= (sources.get(id)!.minScore ?? 0))) return "low-engagement";
  if (hype.some((h) => h.test(item.title))) return "noise";
}
