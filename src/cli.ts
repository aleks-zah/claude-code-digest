import { parseArgs } from "node:util";
import { collectAll } from "./collect/index.ts";
import { loadConfig, loadSources } from "./config.ts";
import { configureHttp } from "./http.ts";
import { log } from "./log.ts";
import { loadLinkSets } from "./state.ts";

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
const sources = loadSources().filter((s) => (values.source ? s.id === values.source : s.enabled));
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

for (const r of results) {
  const links = r.linkSet ? ` (${r.linkSet.length} links on page)` : "";
  console.log(`${r.sourceId.padEnd(30)} ${r.error ? `FAILED: ${r.error}` : `${r.entries.length}${links}`}`);
}
