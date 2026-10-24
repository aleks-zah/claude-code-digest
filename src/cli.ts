import { parseArgs } from "node:util";
import { collectAll } from "./collect/index.ts";
import { loadConfig, loadSources } from "./config.ts";
import { collapseByDay, dropSeen, mergeSources, toItems } from "./dedup.ts";
import { enrich } from "./enrich.ts";
import { configureHttp } from "./http.ts";
import { log } from "./log.ts";
import { prefilter } from "./prefilter.ts";
import { loadLinkSets, loadSeen } from "./state.ts";

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
  console.error(`unknown command: ${command}\nusage: digest run [--dry-run] [--source <id>] [--since <hours>] [--no-llm]`);
  process.exit(2);
}

const config = loadConfig();
const allSources = loadSources();
const sourcesById = new Map(allSources.map((s) => [s.id, s]));
const sources = allSources.filter((s) => (values.source ? s.id === values.source : s.enabled));
if (sources.length === 0) throw new Error(`no enabled source matches ${values.source ?? "sources.yaml"}`);
const sinceHours = values.since ? Number(values.since) : config.lookbackHours;
if (!(sinceHours > 0)) throw new Error(`--since must be a positive number of hours, got ${values.since}`);

configureHttp({ userAgent: config.userAgent, timeoutMs: config.fetch.timeoutMs });
const since = new Date(Date.now() - sinceHours * 3600_000);

const t0 = Date.now();
const results = await collectAll(sources, { since, retries: config.fetch.retries, linkSets: loadLinkSets() });
log("collect", {
  ms: Date.now() - t0,
  out: results.reduce((n, r) => n + r.entries.length, 0),
  failed: results.filter((r) => r.error).map((r) => r.sourceId),
});

for (const r of results) if (r.error) log("collect.source_failed", { source: r.sourceId, error: r.error });

const fresh = mergeSources(
  collapseByDay(dropSeen(toItems(results, sourcesById), loadSeen()), sourcesById, config.enrich.maxChars),
);
const { candidates: preCandidates, dropped } = prefilter(fresh, sourcesById, config);
log("prefilter", { in: fresh.length, out: preCandidates.length, dropped: dropped.length });

const t1 = Date.now();
const candidates = await enrich(preCandidates, config.enrich.maxChars, config.enrich.topComments);
log("enrich", { ms: Date.now() - t1, withText: candidates.filter((c) => c.text).length, out: candidates.length });

for (const c of candidates) {
  const names = c.sources.map((id) => sourcesById.get(id)!.name).join(" + ");
  console.log(`[T${c.tier}] ${c.title}\n     ${names} · ${c.url} · text ${c.text?.length ?? 0} · comments ${c.comments?.length ?? 0}`);
}
