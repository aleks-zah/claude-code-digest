import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalUrl, urlId } from "../src/canonical.ts";

test("strips www, tracking params, fragments and trailing slashes", () => {
  assert.equal(
    canonicalUrl("http://WWW.Example.com/post/?utm_source=hn&utm_medium=x&ref=foo&id=3#comments"),
    "https://example.com/post?id=3",
  );
});

test("keeps meaningful params, sorted", () => {
  assert.equal(canonicalUrl("https://news.ycombinator.com/item?id=1&b=2"), "https://news.ycombinator.com/item?b=2&id=1");
});

test("root path has no trailing slash", () => {
  assert.equal(canonicalUrl("https://corgi.computer/"), "https://corgi.computer");
});

test("id is stable across URL variants", () => {
  assert.equal(urlId("https://simonwillison.net/2026/Oct/20/x/"), urlId("http://www.simonwillison.net/2026/Oct/20/x?utm_campaign=y"));
  assert.notEqual(urlId("https://a.test/1"), urlId("https://a.test/2"));
});
