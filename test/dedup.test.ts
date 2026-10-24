import assert from "node:assert/strict";
import { test } from "node:test";
import { urlId } from "../src/canonical.ts";
import { collapseByDay, dropSeen, mergeSources, toItems } from "../src/dedup.ts";
import { item, sourceMap } from "./helpers.ts";

const sources = sourceMap(
  { id: "simon", name: "Simon Willison", tier: 2 },
  { id: "hn", name: "HN", tier: 3, adapter: "hn", queries: ["x"] },
  { id: "releases", tier: 1, collapse: "day" },
);

test("same URL from HN and Simon Willison becomes one item naming both sources", () => {
  const items = toItems(
    [
      {
        sourceId: "hn",
        entries: [
          {
            url: "https://simonwillison.net/2026/Oct/20/x/?utm_source=hn",
            title: "HN title",
            excerpt: "",
            publishedAt: new Date("2026-10-20T10:00:00Z"),
            engagement: { points: 120, comments: 30 },
            discussionUrl: "https://news.ycombinator.com/item?id=9",
          },
        ],
      },
      {
        sourceId: "simon",
        entries: [
          {
            url: "https://simonwillison.net/2026/Oct/20/x/",
            title: "Simon title",
            excerpt: "the post",
            publishedAt: new Date("2026-10-20T09:00:00Z"),
          },
        ],
      },
    ],
    sources,
  );
  const merged = mergeSources(items);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, ["simon", "hn"]);
  assert.equal(merged[0].tier, 2);
  assert.equal(merged[0].title, "Simon title");
  assert.equal(merged[0].url, "https://simonwillison.net/2026/Oct/20/x/");
  assert.deepEqual(merged[0].engagement, { points: 120, comments: 30 });
  assert.deepEqual(merged[0].discussionUrls, ["https://news.ycombinator.com/item?id=9"]);
  assert.equal(merged[0].publishedAt, "2026-10-20T09:00:00.000Z");
});

test("dropSeen removes items already in state", () => {
  const a = item({ url: "https://a.test/1", id: urlId("https://a.test/1") });
  const b = item({ url: "https://a.test/2", id: urlId("https://a.test/2") });
  assert.deepEqual(dropSeen([a, b], { [a.id]: "2026-10-23" }), [b]);
});

test("collapseByDay merges a day's releases into the newest one and keeps every id for state", () => {
  const rel = (v: string, at: string) => item({ url: `https://r.test/${v}`, id: v, seenIds: [v], title: v, excerpt: `notes ${v}`, publishedAt: at, sources: ["releases"], tier: 1 });
  const other = item({ url: "https://s.test/1", sources: ["simon"] });
  const out = collapseByDay(
    [rel("v1", "2026-10-23T08:00:00Z"), rel("v2", "2026-10-23T20:00:00Z"), rel("v3", "2026-10-24T01:00:00Z"), other],
    sources,
    6000,
  );
  assert.equal(out.length, 3);
  const day = out.find((i) => i.id === "v2")!;
  assert.equal(day.title, "v2 (+1 more)");
  assert.deepEqual(day.seenIds.toSorted(), ["v1", "v2"]);
  assert.match(day.text!, /v1: notes v1/);
  assert.equal(out.find((i) => i.id === "v3")!.title, "v3");
});
