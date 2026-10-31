import assert from "node:assert/strict";
import { test } from "node:test";
import { compose, escapeHtml, TELEGRAM_LIMIT, type DigestInput } from "../src/compose.ts";
import type { ItemScore } from "../src/triage/schema.ts";
import type { Choice } from "../src/triage/score.ts";
import { config, item } from "./helpers.ts";

const names: Record<string, string> = { simon: "Simon Willison", simon2: "Simon Willison", hn: "HN", rel: "Claude Code releases" };

const score = (overrides: Partial<ItemScore> = {}): ItemScore => ({
  id: "x",
  relevance: 3,
  novelty: 3,
  actionability: 3,
  evidence: 3,
  hypeFlags: [],
  category: "workflow",
  summary: "s",
  whyItMatters: "Lets your PR agent refuse writes.",
  confidence: "high",
  ...overrides,
});

const input = (kept: Choice[], overrides: Partial<DigestInput> = {}): DigestInput => ({
  date: new Date("2026-10-24T06:47:00Z"),
  timezone: config.timezone,
  kept,
  scanned: 63,
  dropCounts: { "low-engagement": 19, "low-score": 31, "over-cap": 0 },
  failedSources: [],
  brokenSources: [],
  sourceName: (id) => names[id],
  ...overrides,
});

test("escapeHtml", () => {
  assert.equal(escapeHtml(`<b>"Tom" & Jerry</b>`), `&lt;b&gt;"Tom" &amp; Jerry&lt;/b&gt;`);
});

test("header, one message per item in section order, then the footer", () => {
  const messages = compose(
    input([
      {
        kind: "skim",
        item: item({ url: "https://simonwillison.net/x", title: "Worktrees", sources: ["simon", "simon2", "hn"] }),
        score: score(),
      },
      {
        kind: "must",
        item: item({
          url: "https://github.com/a?x=1&y=2",
          title: "Hooks <block> tool calls",
          sources: ["rel"],
          engagement: { points: 212, comments: 40 },
          discussionUrls: ["https://news.ycombinator.com/item?id=1"],
        }),
        score: score({ category: "release", summary: "Path-glob matchers for hooks.", tryThis: "Add a PreToolUse rule & test it." }),
      },
    ]),
  );
  assert.deepEqual(messages, [
    "📰 <b>Claude Code digest</b> · Sat 24 Oct · 2 of 63 kept",
    [
      "🔥 <b>MUST READ</b> · 🚀 Release",
      `<b><a href="https://github.com/a?x=1&amp;y=2">Hooks &lt;block&gt; tool calls</a></b>`,
      "",
      "📝 Path-glob matchers for hooks.",
      "💡 <b>Why:</b> Lets your PR agent refuse writes.",
      "▶️ <b>Try:</b> Add a PreToolUse rule &amp; test it.",
      "",
      `💬 <a href="https://news.ycombinator.com/item?id=1">Discussion</a>`,
      "📡 Claude Code releases · ⬆️ 212 · 🗨 40",
    ].join("\n"),
    [
      "👀 <b>WORTH A SKIM</b> · 🛠 Workflow",
      `<b><a href="https://simonwillison.net/x">Worktrees</a></b>`,
      "",
      "📝 s",
      "💡 <b>Why:</b> Lets your PR agent refuse writes.",
      "",
      "📡 Simon Willison + HN (2 sources)",
    ].join("\n"),
    "🗑 Dropped 50 · low engagement: 19 · low score: 31",
  ]);
});

test("model text cannot inject markup or attributes", () => {
  const [, msg] = compose(
    input([
      {
        kind: "must",
        item: item({ url: `https://x.test/"><script>`, title: "t", sources: ["hn"] }),
        score: score({ summary: `<b>x</b>`, whyItMatters: `<a href="https://evil.test">click</a>` }),
      },
    ]),
  );
  assert.doesNotMatch(msg, /evil\.test">/);
  assert.doesNotMatch(msg, /<script>/);
  assert.doesNotMatch(msg, /<b>x/);
  assert.equal(msg.match(/<a /g)?.length, 1);
});

test("quiet day: one line plus failures", () => {
  assert.deepEqual(compose(input([], { failedSources: ["r/ClaudeCode"] })), [
    "😴 Nothing worth your time today (63 scanned).\n⚠️ Unavailable: r/ClaudeCode",
  ]);
});

test("an item with maximal model text still fits one Telegram message", () => {
  const long = "word ".repeat(1000);
  const [, msg] = compose(
    input([
      {
        kind: "must",
        item: item({ url: "https://x.test", title: long, sources: ["hn"] }),
        score: score({ summary: long, whyItMatters: long, tryThis: long }),
      },
    ]),
  );
  assert.ok(msg.length <= TELEGRAM_LIMIT, `message is ${msg.length} chars`);
});

test("heuristics-only items have no summary or Why line and the footer says so", () => {
  const [, msg, tail] = compose(
    input([{ kind: "unscored", item: item({ url: "https://x.test", title: "T", sources: ["hn"] }) }], {
      heuristicsNote: "Heuristics only: LLM triage failed.",
    }),
  );
  assert.equal(msg, `❔ <b>UNSCORED</b> (heuristics only)\n<b><a href="https://x.test">T</a></b>\n\n📡 HN`);
  assert.match(tail, /ℹ️ Heuristics only: LLM triage failed\.$/);
});

test("sources failing several runs in a row get a Needs fixing line with the error", () => {
  const [msg] = compose(
    input([], {
      failedSources: ["Addy Osmani", "HN"],
      brokenSources: [{ name: "Addy Osmani", runs: 3, error: "HTTP 403 for https://addyo.substack.com/feed" }],
    }),
  );
  assert.equal(
    msg,
    [
      "😴 Nothing worth your time today (63 scanned).",
      "⚠️ Unavailable: Addy Osmani, HN",
      "🔧 Needs fixing: Addy Osmani failed 3 runs in a row (HTTP 403 for https://addyo.substack.com/feed)",
    ].join("\n"),
  );
});
