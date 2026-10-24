import assert from "node:assert/strict";
import { test } from "node:test";
import { prefilter } from "../src/prefilter.ts";
import { config, item, sourceMap } from "./helpers.ts";

const sources = sourceMap(
  { id: "official", tier: 1 },
  { id: "news", tier: 1, keywords: ["claude"] },
  { id: "blog", tier: 2 },
  { id: "tagged", tier: 2, keywords: [] },
  { id: "reddit", tier: 3, minScore: 50 },
);

const reasons = (items: ReturnType<typeof item>[]) => {
  const { candidates, dropped } = prefilter(items, sources, config);
  return { kept: candidates.map((c) => c.url), dropped: Object.fromEntries(dropped.map((d) => [d.item.url, d.reason])) };
};

test("relevance gate: tier 1 passes unless the source sets keywords; [] disables the gate", () => {
  const r = reasons([
    item({ url: "u1", sources: ["official"], tier: 1, title: "Company update" }),
    item({ url: "u2", sources: ["news"], tier: 1, title: "Company update" }),
    item({ url: "u3", sources: ["blog"], title: "Gardening" }),
    item({ url: "u4", sources: ["blog"], title: "My MCP setup" }),
    item({ url: "u5", sources: ["tagged"], title: "Gardening" }),
  ]);
  assert.deepEqual(r.dropped, { u2: "off-topic", u3: "off-topic" });
});

test("keywords match whole words only", () => {
  const r = reasons([
    item({ url: "u1", sources: ["blog"], title: "An example of champions" }),
    item({ url: "u2", sources: ["blog"], title: "Amp vs Claude Code" }),
  ]);
  assert.deepEqual(r.dropped, { u1: "off-topic" });
});

test("tier 3: engagement floor and hype patterns", () => {
  const r = reasons([
    item({ url: "u1", sources: ["reddit"], tier: 3, title: "Claude Code hooks", engagement: { points: 10 } }),
    item({ url: "u2", sources: ["reddit"], tier: 3, title: "27 tips for Claude Code", engagement: { points: 500 } }),
    item({ url: "u3", sources: ["reddit"], tier: 3, title: "Claude Code hooks", engagement: { points: 60 } }),
    item({ url: "u4", sources: ["blog"], tier: 2, title: "Claude Code is a game changer" }),
  ]);
  assert.deepEqual(r.dropped, { u1: "low-engagement", u2: "noise" });
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
