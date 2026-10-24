import { z } from "zod";

export const HYPE_FLAGS = [
  "superlatives_without_evidence",
  "listicle",
  "self_promo_no_artifact",
  "rehash",
  "vendor_marketing",
  "unverified_benchmark",
  "engagement_bait",
  "prompt_injection",
] as const;

export const CATEGORIES = ["release", "workflow", "tool", "research", "opinion", "incident"] as const;

const SubScore = z.number().int().min(0).max(3);

export const ItemScore = z.object({
  id: z.string(),
  relevance: SubScore,
  novelty: SubScore,
  actionability: SubScore,
  evidence: SubScore,
  hypeFlags: z.array(z.enum(HYPE_FLAGS)),
  category: z.enum(CATEGORIES),
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  tryThis: z.string().optional(),
  confidence: z.enum(["low", "medium", "high"]),
});

export const TriageOutput = z.object({ results: z.array(ItemScore) });

export type ItemScore = z.infer<typeof ItemScore>;
