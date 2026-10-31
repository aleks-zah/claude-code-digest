import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  collectYoutubeChannels,
  collectYoutubeSearch,
  parseChannelFeed,
  pickTrack,
  timedTextToText,
  youtubeVideoId,
} from "../src/collect/youtube.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

function stubFetch(handler: (url: URL, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(new URL(String(input)), init)) as typeof fetch;
  return () => (globalThis.fetch = original);
}

test("youtube channel feed: watch URL, channel as author, views as points", () => {
  const [first] = parseChannelFeed(fixture("youtube-channel.xml"));
  assert.equal(first.url, "https://www.youtube.com/watch?v=k2zgcTDq4aQ");
  assert.equal(first.title, "When should you NOT use /grill-me?");
  assert.equal(first.author, "Matt Pocock");
  assert.equal(first.publishedAt.toISOString(), "2026-10-16T12:53:09.000Z");
  assert.deepEqual(first.engagement, { points: 49275 });
});

test("youtube channels: drops videos below the view floor and before since", async (t) => {
  t.after(stubFetch(() => new Response(fixture("youtube-channel.xml"))));
  const entries = await collectYoutubeChannels(["UCswG6FSbgZjbWtdf_hMLaow"], 3000, new Date("2026-10-16T11:00:00Z"));
  assert.deepEqual(entries.map((e) => e.url), ["https://www.youtube.com/watch?v=k2zgcTDq4aQ"]);
});

test("youtube search: key goes in a header, view floor applies", async (t) => {
  process.env.YOUTUBE_API_KEY = "secret";
  t.after(() => delete process.env.YOUTUBE_API_KEY);
  const urls: string[] = [];
  t.after(
    stubFetch((url, init) => {
      urls.push(url.href);
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "secret");
      if (url.pathname.endsWith("/search")) return Response.json({ items: [{ id: { videoId: "a" } }, { id: { videoId: "b" } }] });
      assert.equal(url.searchParams.get("id"), "a,b");
      const video = (id: string, views: string) => ({
        id,
        snippet: { title: id, description: "", publishedAt: "2026-10-30T10:00:00Z", channelTitle: "C" },
        statistics: { viewCount: views },
      });
      return Response.json({ items: [video("a", "5000"), video("b", "200")] });
    }),
  );
  const entries = await collectYoutubeSearch(['"claude code"'], 3000, new Date("2026-10-29T00:00:00Z"));
  assert.deepEqual(entries.map((e) => e.url), ["https://www.youtube.com/watch?v=a"]);
  assert.ok(urls.every((u) => !u.includes("secret")));
});

test("youtube search: fails without an API key", async () => {
  await assert.rejects(collectYoutubeSearch(["q"], 0, new Date()), /YOUTUBE_API_KEY is not set/);
});

test("transcript: English uploaded captions before auto-generated, none without English", () => {
  const track = (languageCode: string, kind?: string) => ({ baseUrl: `${languageCode}-${kind}`, languageCode, kind });
  assert.equal(pickTrack([track("en", "asr"), track("de"), track("en-GB")])?.baseUrl, "en-GB-undefined");
  assert.equal(pickTrack([track("de"), track("en", "asr")])?.baseUrl, "en-asr");
  assert.equal(pickTrack([track("de")]), undefined);
});

test("transcript: timedtext XML to plain text", () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head><ws id="0"/></head><body>
<p t="0" d="1670" w="1"><s>people</s><s t="280"> ask</s></p>
<p t="1670" d="2010" w="1" a="1">
</p>
<p t="1680" d="3640" w="1"><s>it&#39;s</s><s t="360"> &quot;fine&quot;</s></p></body></timedtext>`;
  assert.equal(timedTextToText(xml), `people ask it's "fine"`);
});

test("youtubeVideoId: watch URLs only", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=abc"), "abc");
  assert.equal(youtubeVideoId("https://example.com/watch?v=abc"), undefined);
  assert.equal(youtubeVideoId("https://www.youtube.com/channel/UCx"), undefined);
});
