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
  dropCounts: { "off-topic": 19, "low-score": 31, noise: 0 },
  failedSources: [],
  sourceName: (id) => names[id],
  ...overrides,
});

test("escapeHtml", () => {
  assert.equal(escapeHtml(`<b>"Tom" & Jerry</b>`), `&lt;b&gt;"Tom" &amp; Jerry&lt;/b&gt;`);
});

test("renders sections, links, why/try lines and cross-posted sources", () => {
  const [msg] = compose(
    input([
      {
        kind: "must",
        item: item({ url: "https://github.com/a?x=1&y=2", title: "Hooks <block> tool calls", sources: ["rel"] }),
        score: score({ category: "release", tryThis: "Add a PreToolUse rule & test it." }),
      },
      {
        kind: "skim",
        item: item({ url: "https://simonwillison.net/x", title: "Worktrees", sources: ["simon", "simon2", "hn"] }),
        score: score(),
      },
    ]),
  );
  assert.equal(
    msg,
    [
      "<b>Claude Code digest</b> · Sat 24 Oct · 2 of 63 kept",
      "",
      "<b>MUST READ</b>",
      `• [Release] <a href="https://github.com/a?x=1&amp;y=2">Hooks &lt;block&gt; tool calls</a>`,
      "  Why: Lets your PR agent refuse writes.",
      "  Try: Add a PreToolUse rule &amp; test it.",
      "  Claude Code releases",
      "",
      "<b>WORTH A SKIM</b>",
      `• [Workflow] <a href="https://simonwillison.net/x">Worktrees</a>`,
      "  Why: Lets your PR agent refuse writes.",
      "  Simon Willison + HN (2 sources)",
      "",
      "Dropped 50 · off-topic: 19 · low score: 31",
    ].join("\n"),
  );
});

test("model text cannot inject markup or attributes", () => {
  const [msg] = compose(
    input([
      {
        kind: "must",
        item: item({ url: `https://x.test/"><script>`, title: "t", sources: ["hn"] }),
        score: score({ whyItMatters: `<a href="https://evil.test">click</a>` }),
      },
    ]),
  );
  assert.doesNotMatch(msg, /evil\.test">/);
  assert.doesNotMatch(msg, /<script>/);
  assert.equal(msg.match(/<a /g)?.length, 1);
});

test("quiet day: one line plus failures", () => {
  assert.deepEqual(compose(input([], { failedSources: ["r/ClaudeCode"] })), [
    "Nothing worth your time today (63 scanned).\nUnavailable: r/ClaudeCode",
  ]);
});

test("splits at item boundaries under 4096 characters", () => {
  const long = "word ".repeat(55);
  const kept: Choice[] = Array.from({ length: 30 }, (_, i) => ({
    kind: "skim",
    item: item({ url: `https://x.test/${i}`, title: `Item ${i} ${long}`, sources: ["hn"] }),
    score: score({ whyItMatters: long, tryThis: long }),
  }));
  const messages = compose(input(kept));
  assert.ok(messages.length > 1);
  for (const m of messages) {
    assert.ok(m.length <= TELEGRAM_LIMIT, `message is ${m.length} chars`);
    assert.match(m, /^(<b>|•)/);
    assert.equal(m.match(/<a /g)?.length, m.match(/<\/a>/g)?.length);
  }
  assert.equal(messages.join("").match(/• /g)?.length, 30);
});

test("heuristics-only items have no Why line and the footer says so", () => {
  const [msg] = compose(
    input([{ kind: "unscored", item: item({ url: "https://x.test", title: "T", sources: ["hn"] }) }], {
      heuristicsNote: "Heuristics only: LLM triage failed.",
    }),
  );
  assert.match(msg, /<b>UNSCORED \(heuristics only\)<\/b>\n• <a href="https:\/\/x.test">T<\/a>\n  HN/);
  assert.match(msg, /Heuristics only: LLM triage failed\.$/);
});
