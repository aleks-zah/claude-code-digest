import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dropSeen } from "../src/dedup.ts";
import { failureStreaks, State, type RunRecord } from "../src/state.ts";
import { sendMessage } from "../src/telegram.ts";
import { item } from "./helpers.ts";

const run: RunRecord = { date: "2026-10-24", startedAt: "", sinceHours: 36, counts: {}, tokens: 0, failedSources: [], items: [] };

test("state: a second run sees everything the first one saved; old entries are pruned", () => {
  const state = new State(mkdtempSync(join(tmpdir(), "digest-")));
  state.save({
    seenIds: ["a", "b"],
    results: [
      { sourceId: "news", entries: [], linkSet: ["https://n.test/1"] },
      { sourceId: "broken", entries: [], linkSet: [], error: "HTTP 500" },
    ],
    run,
    today: "2026-08-01",
    retentionDays: 45,
  });
  state.save({ seenIds: ["b", "c"], results: [], run, today: "2026-10-24", retentionDays: 45 });

  assert.deepEqual(state.loadSeen(), { b: "2026-10-24", c: "2026-10-24" });
  assert.deepEqual(state.loadLinkSets(), { news: ["https://n.test/1"] });
  assert.equal(JSON.parse(readFileSync(join(state.dir, "runs/2026-10-24.json"), "utf8")).date, "2026-10-24");

  state.save({ seenIds: ["d"], results: [], run, today: "2026-10-25", retentionDays: 45 });
  const again = [item({ url: "c", id: "c" }), item({ url: "d", id: "d" }), item({ url: "e", id: "e" })];
  assert.deepEqual(dropSeen(again, state.loadSeen()).map((i) => i.id), ["e"]);
  assert.equal(state.loadSeen().c, "2026-10-24");
});

function fakeFetch(responses: { status: number; body: object }[]) {
  const bodies: Record<string, unknown>[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fn, bodies };
}

test("telegram: HTML mode, previews off, retries 429 after retry_after", async () => {
  const { fn, bodies } = fakeFetch([
    { status: 429, body: { ok: false, parameters: { retry_after: 0 } } },
    { status: 200, body: { ok: true } },
  ]);
  await sendMessage({ token: "t", chatId: "42" }, "<b>hi</b>", true, fn);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], {
    chat_id: "42",
    text: "<b>hi</b>",
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
});

test("telegram: other errors fail without leaking the token", async () => {
  const { fn } = fakeFetch([{ status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } }]);
  await assert.rejects(sendMessage({ token: "secret-token", chatId: "1" }, "x", false, fn), (err: Error) => {
    assert.match(err.message, /HTTP 400 Bad Request: can't parse entities/);
    assert.doesNotMatch(err.message, /secret-token/);
    return true;
  });
});

test("failure streaks count consecutive delivered runs before today, plus today", () => {
  const state = new State(mkdtempSync(join(tmpdir(), "digest-")));
  const failing = (date: string, ...ids: string[]) =>
    state.save({
      seenIds: [],
      results: [],
      run: { ...run, date, failedSources: ids.map((id) => ({ id, error: "HTTP 403" })) },
      today: date,
      retentionDays: 45,
    });
  failing("2026-10-20", "a");
  failing("2026-10-21", "b");
  failing("2026-10-22", "a", "b");
  failing("2026-10-23", "a", "b");
  // A rerun on the same day must not count today's earlier run twice.
  failing("2026-10-24", "a");

  const previous = state.loadRunsBefore("2026-10-24", 10);
  assert.deepEqual(previous.map((r) => r.date), ["2026-10-23", "2026-10-22", "2026-10-21", "2026-10-20"]);
  assert.deepEqual(
    Object.fromEntries(failureStreaks(["a", "b", "c"], previous)),
    { a: 3, b: 4, c: 1 },
  );
  assert.deepEqual(state.loadRunsBefore("2026-10-24", 2).map((r) => r.date), ["2026-10-23", "2026-10-22"]);
  assert.deepEqual(new State(mkdtempSync(join(tmpdir(), "digest-"))).loadRunsBefore("2026-10-24", 2), []);
});
