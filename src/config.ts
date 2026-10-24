import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const ConfigSchema = z.object({
  userAgent: z.string(),
  timezone: z.string(),
  lookbackHours: z.number().positive(),
  maxItems: z.number().int().positive(),
  candidateCap: z.number().int().positive(),
  fetch: z.object({ timeoutMs: z.number().int().positive(), retries: z.number().int().min(0) }),
  enrich: z.object({ maxChars: z.number().int().positive(), topComments: z.number().int().min(0) }),
  triage: z.object({
    model: z.string(),
    batchSize: z.number().int().positive(),
    dailyTokenBudget: z.number().int().positive(),
  }),
  cutoffs: z.object({ mustRead: z.number(), skim: z.number() }),
  seenRetentionDays: z.number().int().positive(),
  keywords: z.array(z.string()),
  hypePatterns: z.array(z.string()),
});

const SourceBase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  enabled: z.boolean().default(true),
  keywords: z.array(z.string()).optional(),
  minScore: z.number().int().min(0).optional(),
  maxItemsPerRun: z.number().int().positive().optional(),
});

const SourceSchema = z.discriminatedUnion("adapter", [
  SourceBase.extend({
    adapter: z.literal("feed"),
    url: z.url(),
    collapse: z.literal("day").optional(),
  }),
  SourceBase.extend({
    adapter: z.literal("html-index"),
    url: z.url(),
    linkPattern: z.string(),
  }),
  SourceBase.extend({ adapter: z.literal("readme-links"), url: z.url() }),
  SourceBase.extend({ adapter: z.literal("reddit"), subreddit: z.string() }),
  SourceBase.extend({ adapter: z.literal("hn"), queries: z.array(z.string()).min(1) }),
]);

const SourcesSchema = z
  .array(SourceSchema)
  .refine((s) => new Set(s.map((x) => x.id)).size === s.length, "source ids must be unique");

export type Config = z.infer<typeof ConfigSchema>;
export type Source = z.infer<typeof SourceSchema>;

export function loadConfig(path = "config.yaml"): Config {
  return ConfigSchema.parse(parse(readFileSync(path, "utf8")));
}

export function loadSources(path = "sources.yaml"): Source[] {
  return SourcesSchema.parse(parse(readFileSync(path, "utf8")));
}
