import type { Config } from "../config.ts";
import type { Item, Tier } from "../types.ts";
import type { ItemScore } from "./schema.ts";

const WEIGHTS = { relevance: 0.3, novelty: 0.25, actionability: 0.25, evidence: 0.2 } as const;

export type VerdictKind = "must" | "skim" | "drop";

export interface Verdict {
  kind: VerdictKind;
  score: number;
  /** Tier 1 with relevance >= 2: kept whatever the score, and ranked ahead of everything else. */
  protected: boolean;
  dropReason?: "low-score" | "prompt-injection";
}

export function finalScore(s: ItemScore, tier: Tier): number {
  const weighted = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((sum, k) => sum + WEIGHTS[k] * (s[k] / 3), 0);
  const tierBonus = tier === 2 ? 1 : 0;
  const raw = 10 * weighted + tierBonus - 1.5 * Math.min(s.hypeFlags.length, 2);
  return Math.round(Math.min(10, Math.max(0, raw)) * 10) / 10;
}

export function verdict(s: ItemScore, tier: Tier, cutoffs: Config["cutoffs"]): Verdict {
  const score = finalScore(s, tier);
  if (s.hypeFlags.includes("prompt_injection")) {
    return { kind: "drop", score, protected: false, dropReason: "prompt-injection" };
  }
  const isProtected = tier === 1 && s.relevance >= 2;
  if (score >= cutoffs.mustRead) return { kind: "must", score, protected: isProtected };
  if (score >= cutoffs.skim || isProtected) return { kind: "skim", score, protected: isProtected };
  return { kind: "drop", score, protected: false, dropReason: "low-score" };
}

export type FinalDropReason = NonNullable<Verdict["dropReason"]> | "invalid-output" | "over-limit";

export interface Choice {
  item: Item;
  kind: "must" | "skim" | "unscored";
  score?: ItemScore;
  verdict?: Verdict;
}

export interface Selection {
  kept: Choice[];
  dropped: { item: Item; reason: FinalDropReason; score?: ItemScore; verdict?: Verdict }[];
}

/**
 * Protected tier-1 items rank first, then by score; unscored (heuristics-only) items follow in
 * prefilter order. Everything counts toward maxItems.
 */
export function select(
  candidates: Item[],
  scores: Map<string, ItemScore>,
  unscored: Set<string>,
  config: Pick<Config, "cutoffs" | "maxItems">,
): Selection {
  const scored: Choice[] = [];
  const heuristic: Choice[] = [];
  const dropped: Selection["dropped"] = [];
  for (const item of candidates) {
    const score = scores.get(item.id);
    if (!score) {
      if (unscored.has(item.id)) heuristic.push({ item, kind: "unscored" });
      else dropped.push({ item, reason: "invalid-output" });
      continue;
    }
    const v = verdict(score, item.tier, config.cutoffs);
    if (v.kind === "drop") dropped.push({ item, reason: v.dropReason!, score, verdict: v });
    else scored.push({ item, kind: v.kind, score, verdict: v });
  }
  scored.sort((a, b) => Number(b.verdict!.protected) - Number(a.verdict!.protected) || b.verdict!.score - a.verdict!.score);
  const ranked = [...scored, ...heuristic];
  for (const p of ranked.slice(config.maxItems)) {
    dropped.push({ item: p.item, reason: "over-limit", score: p.score, verdict: p.verdict });
  }
  return { kept: ranked.slice(0, config.maxItems), dropped };
}
