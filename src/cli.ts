import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { collectAll } from "./collect/index.ts";
import { compose } from "./compose.ts";
import { loadConfig, loadSources } from "./config.ts";
import { collapseByDay, dropSeen, mergeSources, toItems } from "./dedup.ts";
import { enrich } from "./enrich.ts";
import { configureHttp } from "./http.ts";
import { log } from "./log.ts";
import { prefilter } from "./prefilter.ts";
import { State, type RunRecord } from "./state.ts";
import { sendMessage, telegramTarget } from "./telegram.ts";
import { buildSystemPrompt, triage, type TriageResult } from "./triage/llm.ts";
import type { ItemScore } from "./triage/schema.ts";
import { select } from "./triage/score.ts";
import type { Item } from "./types.ts";

const USAGE = "usage: digest run [--dry-run] [--source <id>] [--since <hours>] [--no-llm]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    "no-llm": { type: "boolean", default: false },
    source: { type: "string" },
    since: { type: "string" },
  },
});

const command = positionals[0] ?? "run";
if (command !== "run") {
  console.error(`unknown command: ${command}\n${USAGE}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const dryRun = values["dry-run"];
  const config = loadConfig();
  const allSources = loadSources();
  const sourcesById = new Map(allSources.map((s) => [s.id, s]));
  const sourceName = (id: string) => sourcesById.get(id)!.name;
  const sources = allSources.filter((s) => (values.source ? s.id === values.source : s.enabled));
  if (sources.length === 0) throw new Error(`no enabled source matches ${values.source ?? "sources.yaml"}`);
  const sinceHours = values.since ? Number(values.since) : config.lookbackHours;
  if (!(sinceHours > 0)) throw new Error(`--since must be a positive number of hours, got ${values.since}`);

  const telegram = telegramTarget();
  if (!dryRun && !telegram) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set (or use --dry-run)");
  const state = new State();

  configureHttp({ userAgent: config.userAgent, timeoutMs: config.fetch.timeoutMs });
  const now = new Date();
  const since = new Date(now.getTime() - sinceHours * 3600_000);

  let t = Date.now();
  const results = await collectAll(sources, { since, retries: config.fetch.retries, linkSets: state.loadLinkSets() });
  const failedSources = results.filter((r) => r.error);
  log("collect", {
    ms: Date.now() - t,
    out: results.reduce((n, r) => n + r.entries.length, 0),
    failed: failedSources.map((r) => r.sourceId),
  });
  for (const r of failedSources) log("collect.source_failed", { source: r.sourceId, error: r.error });

  const fresh = mergeSources(
    collapseByDay(dropSeen(toItems(results, sourcesById), state.loadSeen()), sourcesById, config.enrich.maxChars),
  );
  const pre = prefilter(fresh, sourcesById, config);
  log("prefilter", { in: fresh.length, out: pre.candidates.length, dropped: pre.dropped.length });

  t = Date.now();
  const candidates = await enrich(pre.candidates, config.enrich.maxChars, config.enrich.topComments);
  log("enrich", { ms: Date.now() - t, withText: candidates.filter((c) => c.text).length, out: candidates.length });

  let triaged: TriageResult | undefined;
  if (!values["no-llm"] && candidates.length > 0) {
    t = Date.now();
    triaged = await triage(candidates, {
      client: new Anthropic({ maxRetries: 3 }),
      model: config.triage.model,
      system: buildSystemPrompt(),
      batchSize: config.triage.batchSize,
      tokenBudget: config.triage.dailyTokenBudget,
      sourceName,
    });
    log("triage", {
      ms: Date.now() - t,
      scored: triaged.scores.size,
      failed: triaged.failed.length,
      unscored: triaged.unscored.length,
      tokens: triaged.tokens,
    });
  }

  const unscored = new Set((triaged ? triaged.unscored : candidates).map((c) => c.id));
  const selection = select(candidates, triaged?.scores ?? new Map(), unscored, config);

  const dropCounts: Record<string, number> = {};
  for (const { reason } of [...pre.dropped, ...selection.dropped]) dropCounts[reason] = (dropCounts[reason] ?? 0) + 1;

  let heuristicsNote: string | undefined;
  if (values["no-llm"]) heuristicsNote = "Heuristics only (--no-llm).";
  else if (triaged?.llmFailed) heuristicsNote = "Heuristics only: LLM triage failed.";
  else if (triaged?.budgetHit) heuristicsNote = `Token budget hit: ${triaged.unscored.length} items ranked by heuristics only.`;

  const messages = compose({
    date: now,
    timezone: config.timezone,
    kept: selection.kept,
    scanned: fresh.length,
    dropCounts,
    failedSources: failedSources.map((r) => sourceName(r.sourceId)),
    sourceName,
    heuristicsNote,
  });
  log("compose", { kept: selection.kept.length, messages: messages.length });

  if (dryRun) {
    console.log(messages.join("\n\n----- message break -----\n\n"));
    return;
  }

  for (const m of messages) await sendMessage(telegram!, m, true);
  log("deliver", { messages: messages.length });

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(now);
  const outcomes: { item: Item; verdict: string; reason?: string; score?: ItemScore; final?: number }[] = [
    ...pre.dropped.map((d) => ({ item: d.item, verdict: "drop", reason: d.reason })),
    ...selection.dropped.map((d) => ({ item: d.item, verdict: "drop", reason: d.reason, score: d.score, final: d.verdict?.score })),
    ...selection.kept.map((c) => ({ item: c.item, verdict: c.kind, score: c.score, final: c.verdict?.score })),
  ];
  const run: RunRecord = {
    date: today,
    startedAt: now.toISOString(),
    sinceHours,
    counts: { fresh: fresh.length, candidates: candidates.length, kept: selection.kept.length, ...dropCounts },
    tokens: triaged?.tokens ?? 0,
    failedSources: failedSources.map((r) => ({ id: r.sourceId, error: r.error! })),
    heuristicsNote,
    items: outcomes.map(({ item, ...outcome }) => ({
      id: item.id,
      url: item.url,
      title: item.title,
      sources: item.sources,
      tier: item.tier,
      engagement: item.engagement,
      ...outcome,
    })),
  };
  state.save({ seenIds: fresh.flatMap((i) => i.seenIds), results, run, today, retentionDays: config.seenRetentionDays });
  log("state", { seen: fresh.length, run: `runs/${today}.json` });
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  log("crash", { error: message });
  const telegram = telegramTarget();
  if (telegram && !values["dry-run"]) {
    const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = process.env;
    const link = server && repo && runId ? `\n${server}/${repo}/actions/runs/${runId}` : "";
    await sendMessage(telegram, `Claude Code digest failed: ${message}${link}`, false).catch((e) =>
      log("crash.alert_failed", { error: String(e) }),
    );
  }
  process.exitCode = 1;
}
