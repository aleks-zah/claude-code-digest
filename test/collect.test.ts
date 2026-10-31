import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseFeed } from "../src/collect/feed.ts";
import { parseHits } from "../src/collect/hn.ts";
import { diffLinks, extractIndexLinks } from "../src/collect/htmlIndex.ts";
import { extractReadmeLinks } from "../src/collect/readmeLinks.ts";
import { parsePosts } from "../src/collect/reddit.ts";
import { collectAll } from "../src/collect/index.ts";
import { collectFeed } from "../src/collect/feed.ts";
import type { Source } from "../src/config.ts";
import { parseRobots, withRetries } from "../src/http.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("atom: GitHub releases", () => {
  const entries = parseFeed(fixture("releases.atom"));
  assert.equal(entries.length, 3);
  assert.deepEqual(
    { url: entries[0].url, title: entries[0].title, at: entries[0].publishedAt.toISOString() },
    {
      url: "https://github.com/anthropics/claude-code/releases/tag/v2.1.310",
      title: "v2.1.310",
      at: "2026-10-23T23:39:00.000Z",
    },
  );
  assert.match(entries[0].excerpt, /^What's changed Added the Monitor tool/);
  assert.doesNotMatch(entries[0].excerpt, /<|&lt;/);
});

test("rss: Substack", () => {
  const entries = parseFeed(fixture("addy.rss"));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].url, "https://addyo.substack.com/p/agentic-verification");
  assert.equal(entries[0].title, "Agentic Verification");
  assert.equal(entries[0].author, "Addy Osmani");
  assert.equal(entries[0].publishedAt.toISOString(), "2026-10-14T11:31:03.000Z");
});

test("feed: rejects non-feed responses", () => {
  assert.throws(() => parseFeed("<html><body>Not found</body></html>"), /not an RSS or Atom feed/);
});

test("html-index: Anthropic engineering links live under /research/", () => {
  const links = extractIndexLinks(
    fixture("anthropic-engineering.html"),
    "https://www.anthropic.com/engineering",
    /^\/research\/[^/]+$/,
  );
  assert.equal(links.length, 24);
  assert.deepEqual(links[0], {
    url: "https://www.anthropic.com/research/redesigning-source-control",
    title: "Redesigning source control at Anthropic",
  });
  assert.equal(new Set(links.map((l) => l.url)).size, links.length);
});

test("html-index: HumanLayer blog", () => {
  const links = extractIndexLinks(fixture("humanlayer.html"), "https://www.humanlayer.dev/blog", /^\/blog\/[^/]+$/);
  assert.equal(links.length, 12);
  assert.equal(links[0].url, "https://www.humanlayer.dev/blog/open-sourcing-humanlayer");
});

test("diffLinks: first run is a baseline, later runs return only new links", () => {
  const links = [
    { url: "https://a.test/1", title: "One" },
    { url: "https://a.test/2", title: "Two" },
  ];
  assert.deepEqual(diffLinks(links, undefined, true), []);
  const fresh = diffLinks(links, ["https://a.test/1"], true);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].url, "https://a.test/2");
  assert.equal(fresh[0].titleFromIndex, true);
});

test("readme-links: skips badges and the repo's own links", () => {
  const links = extractReadmeLinks(fixture("readme.md"), "https://github.com/hesreallyhim/awesome-claude-code");
  assert.ok(links.length > 50);
  assert.ok(links.every((l) => !l.url.endsWith(".svg")));
  assert.ok(links.every((l) => !l.url.startsWith("https://github.com/hesreallyhim/awesome-claude-code")));
  assert.ok(links.every((l) => !l.title.startsWith("!")));
  assert.equal(new Set(links.map((l) => l.url)).size, links.length);
});

test("hn: link posts keep the target URL and the thread as discussion", () => {
  const [first] = parseHits(JSON.parse(fixture("hn.json")).hits);
  assert.equal(first.url, "https://corgi.computer/");
  assert.equal(first.discussionUrl, "https://news.ycombinator.com/item?id=50214373");
  assert.deepEqual(first.engagement, { points: 121, comments: 42 });
});

test("hn: Ask HN posts without a URL point at the thread", () => {
  const [entry] = parseHits([{ objectID: "1", title: "Ask HN", url: null, author: "a", points: 50, created_at_i: 0 }]);
  assert.equal(entry.url, "https://news.ycombinator.com/item?id=1");
});

test("reddit: self and media posts use the thread, link posts the target, old and unrefreshed posts dropped", () => {
  const entries = parsePosts(JSON.parse(fixture("reddit-top.json")).data, new Date(1792700000 * 1000));
  assert.deepEqual(
    entries.map((e) => e.url),
    [
      "https://www.reddit.com/r/ClaudeCode/comments/1abc23/hooks_that_block_writes/",
      "https://example.com/worktrees?utm_source=reddit",
      "https://www.reddit.com/r/ClaudeCode/comments/1abc25/look_at_my_statusline/",
    ],
  );
  assert.deepEqual(entries[0].engagement, { points: 212, comments: 40 });
});

test("robots: Disallow prefixes for * only", () => {
  const rules = parseRobots(
    ["User-agent: GPTBot", "Disallow: /", "", "User-agent: *", "Disallow: /admin/", "Disallow: /*.json", "Disallow:"].join(
      "\n",
    ),
  );
  assert.deepEqual(rules, ["/admin/"]);
});

test("withRetries: retries up to the limit, then rethrows", async () => {
  let calls = 0;
  const flaky = async () => {
    if (++calls < 3) throw new Error(`fail ${calls}`);
    return "ok";
  };
  assert.equal(await withRetries(flaky, 2, 0), "ok");
  calls = -10;
  await assert.rejects(withRetries(flaky, 2, 0), /fail -7/);
});

function stubFetch(routes: Record<string, () => Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const route = routes[String(input)];
    if (!route) throw new Error(`unexpected fetch ${String(input)}`);
    return route();
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

test("collectAll: a source returning HTTP 500 is reported as failed and the rest still collect", async (t) => {
  t.after(
    stubFetch({
      "https://ok.test/releases.atom": () => new Response(fixture("releases.atom")),
      "https://broken.test/feed": () => new Response("oops", { status: 500 }),
    }),
  );
  const sources = [
    { id: "ok", name: "OK", tier: 1, enabled: true, adapter: "feed", url: "https://ok.test/releases.atom" },
    { id: "broken", name: "Broken", tier: 2, enabled: true, adapter: "feed", url: "https://broken.test/feed" },
  ] satisfies Source[];
  const results = await collectAll(sources, { since: new Date("2026-10-22T00:00:00Z"), retries: 0, linkSets: {} });
  assert.deepEqual(
    results.map((r) => [r.sourceId, r.entries.length, r.error]),
    [
      ["ok", 3, undefined],
      ["broken", 0, "HTTP 500 for https://broken.test/feed"],
    ],
  );
});

test("feed: relative links resolve against the feed URL, unparseable ones are dropped", async (t) => {
  const rss = `<rss><channel>
    <item><title>Rel</title><link>/p/relative</link><pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>Bad</title><link>https://</link><pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  t.after(stubFetch({ "https://blog.test/feed.xml": () => new Response(rss) }));
  const entries = await collectFeed("https://blog.test/feed.xml", new Date("2026-10-22T00:00:00Z"));
  assert.deepEqual(entries.map((e) => e.url), ["https://blog.test/p/relative"]);
});
