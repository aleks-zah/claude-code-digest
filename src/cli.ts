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
import { loadLinkSets, loadSeen } from "./state.ts";
import { buildSystemPrompt, triage, type TriageResult } from "./triage/llm.ts";
import { select } from "./triage/score.ts";

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

const config = loadConfig();
const allSources = loadSources();
const sourcesById = new Map(allSources.map((s) => [s.id, s]));
const sourceName = (id: string) => sourcesById.get(id)!.name;
const sources = allSources.filter((s) => (values.source ? s.id === values.source : s.enabled));
if (sources.length === 0) throw new Error(`no enabled source matches ${values.source ?? "sources.yaml"}`);
const sinceHours = values.since ? Number(values.since) : config.lookbackHours;
if (!(sinceHours > 0)) throw new Error(`--since must be a positive number of hours, got ${values.since}`);

configureHttp({ userAgent: config.userAgent, timeoutMs: config.fetch.timeoutMs });
const now = new Date();
const since = new Date(now.getTime() - sinceHours * 3600_000);

let t = Date.now();
const results = await collectAll(sources, { since, retries: config.fetch.retries, linkSets: loadLinkSets() });
const failedSources = results.filter((r) => r.error);
log("collect", {
  ms: Date.now() - t,
  out: results.reduce((n, r) => n + r.entries.length, 0),
  failed: failedSources.map((r) => r.sourceId),
});
for (const r of failedSources) log("collect.source_failed", { source: r.sourceId, error: r.error });

const fresh = mergeSources(
  collapseByDay(dropSeen(toItems(results, sourcesById), loadSeen()), sourcesById, config.enrich.maxChars),
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

console.log(messages.join("\n\n----- message break -----\n\n"));
