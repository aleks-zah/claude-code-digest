import assert from "node:assert/strict";
import { test } from "node:test";
import { prefilter } from "../src/prefilter.ts";
import { config, item, sourceMap } from "./helpers.ts";

const sources = sourceMap(
  { id: "official", tier: 1 },
  { id: "blog", tier: 2 },
  { id: "reddit", tier: 3, minScore: 50 },
);

const reasons = (items: ReturnType<typeof item>[]) => {
  const { candidates, dropped } = prefilter(items, sources, config);
  return { kept: candidates.map((c) => c.url), dropped: Object.fromEntries(dropped.map((d) => [d.item.url, d.reason])) };
};

test("engagement floor applies to tier 3 only", () => {
  const r = reasons([
    item({ url: "u1", sources: ["reddit"], tier: 3, title: "Claude Code hooks", engagement: { points: 10 } }),
    item({ url: "u2", sources: ["reddit"], tier: 3, title: "Claude Code hooks", engagement: { points: 60 } }),
    item({ url: "u3", sources: ["blog"], tier: 2, title: "Gardening", engagement: { points: 0 } }),
  ]);
  assert.deepEqual(r.dropped, { u1: "low-engagement" });
});

test("cap keeps the highest tier, then engagement", () => {
  const many = Array.from({ length: 45 }, (_, i) =>
    item({ url: `r${i}`, sources: ["reddit"], tier: 3, title: "Claude Code", engagement: { points: 100 + i } }),
  );
  const { candidates, dropped } = prefilter(
    [...many, item({ url: "t1", sources: ["official"], tier: 1 })],
    sources,
    config,
  );
  assert.equal(candidates.length, 40);
  assert.equal(candidates[0].url, "t1");
  assert.equal(candidates[1].url, "r44");
  assert.equal(dropped.filter((d) => d.reason === "over-cap").length, 6);
});
