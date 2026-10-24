import type { Config, Source } from "../src/config.ts";
import type { Item } from "../src/types.ts";

export function item(overrides: Partial<Item> & { url: string }): Item {
  return {
    id: overrides.url,
    seenIds: [overrides.id ?? overrides.url],
    title: "Title",
    excerpt: "",
    publishedAt: "2026-10-24T06:00:00.000Z",
    engagement: {},
    sources: ["src"],
    tier: 2,
    discussionUrls: [],
    ...overrides,
  };
}

export function sourceMap(...sources: Partial<Source>[]): Map<string, Source> {
  return new Map(
    sources.map((s) => [
      s.id!,
      { name: s.id!, tier: 2, enabled: true, adapter: "feed", url: "https://x.test/feed", ...s } as Source,
    ]),
  );
}

export const config: Config = {
  userAgent: "test",
  timezone: "Europe/Lisbon",
  lookbackHours: 36,
  maxItems: 7,
  candidateCap: 40,
  fetch: { timeoutMs: 1000, retries: 0 },
  enrich: { maxChars: 6000, topComments: 3 },
  triage: { model: "claude-haiku-5-5", batchSize: 10, dailyTokenBudget: 400000 },
  cutoffs: { mustRead: 7, skim: 5 },
  seenRetentionDays: 45,
  keywords: ["claude code", "mcp", "amp"],
  hypePatterns: ["^\\d+\\s+(tips|tricks)\\b", "\\bgame[- ]?changer\\b"],
};
