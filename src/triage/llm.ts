import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { parse } from "yaml";
import { log } from "../log.ts";
import type { Item } from "../types.ts";
import { ItemScore, TriageOutput } from "./schema.ts";

const outputFormat = zodOutputFormat(TriageOutput);

interface Example {
  note: string;
  item: { source: string; tier: number; title: string; excerpt: string };
  expected: Record<string, unknown>;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildSystemPrompt(dir = "."): string {
  const examples = (parse(readFileSync(`${dir}/triage/examples.yaml`, "utf8")) as Example[])
    .map(
      (e) =>
        `<example note="${escapeXml(e.note)}">\n` +
        `<item source="${escapeXml(e.item.source)}" tier="${e.item.tier}">\n` +
        `<title>${escapeXml(e.item.title)}</title>\n<excerpt>${escapeXml(e.item.excerpt)}</excerpt>\n</item>\n` +
        `Expected: ${JSON.stringify(e.expected)}\n</example>`,
    )
    .join("\n\n");
  return readFileSync(`${dir}/triage/system-prompt.md`, "utf8")
    .replace("{{profile}}", readFileSync(`${dir}/profile.md`, "utf8").trim())
    .replace("{{examples}}", examples);
}

export function renderItems(items: Item[], sourceName: (id: string) => string): string {
  return items
    .map((i) => {
      const names = [...new Set(i.sources.map(sourceName))].join(", ");
      const parts = [`<title>${escapeXml(i.title)}</title>`];
      if (i.excerpt) parts.push(`<excerpt>${escapeXml(i.excerpt)}</excerpt>`);
      if (i.text) parts.push(`<text>${escapeXml(i.text)}</text>`);
      for (const c of i.comments ?? []) parts.push(`<comment>${escapeXml(c)}</comment>`);
      return `<item id="${i.id}" source="${escapeXml(names)}" tier="${i.tier}">\n${parts.join("\n")}\n</item>`;
    })
    .join("\n\n");
}

/** Validates each result on its own, so one malformed result only fails its own item. */
export function parseResults(text: string, ids: Set<string>): { valid: ItemScore[]; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { valid: [], problems: ["response is not valid JSON"] };
  }
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return { valid: [], problems: ["response has no results array"] };
  const valid = new Map<string, ItemScore>();
  for (const r of results) {
    const parsed = ItemScore.safeParse(r);
    const id = (r as { id?: unknown })?.id;
    if (!parsed.success) problems.push(`invalid result for ${String(id)}: ${parsed.error.issues[0]?.message}`);
    else if (!ids.has(parsed.data.id)) problems.push(`unknown id ${parsed.data.id}`);
    else if (!valid.has(parsed.data.id)) valid.set(parsed.data.id, parsed.data);
  }
  return { valid: [...valid.values()], problems };
}

export interface TriageOptions {
  client: Pick<Anthropic, "messages">;
  model: string;
  system: string;
  batchSize: number;
  tokenBudget: number;
  sourceName: (id: string) => string;
}

export interface TriageResult {
  scores: Map<string, ItemScore>;
  /** Failed the schema twice: dropped and logged. */
  failed: Item[];
  /** Not sent because the token budget ran out, or every LLM call failed: heuristics only. */
  unscored: Item[];
  tokens: number;
  budgetHit: boolean;
  llmFailed: boolean;
}

async function callOnce(items: Item[], opts: TriageOptions) {
  const response = await opts.client.messages.create({
    model: opts.model,
    max_tokens: 16000,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: outputFormat },
    messages: [{ role: "user", content: renderItems(items, opts.sourceName) }],
  });
  const u = response.usage;
  const tokens =
    u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + u.output_tokens;
  log("triage.call", {
    items: items.length,
    stop: response.stop_reason,
    input: u.input_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
    output: u.output_tokens,
  });
  // Haiku 5.5 has no server-side refusal fallback, so a refusal fails the batch like a bad schema.
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    return { valid: [], problems: [`stop_reason ${response.stop_reason}`], tokens };
  }
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return { ...parseResults(text, new Set(items.map((i) => i.id))), tokens };
}

export async function triage(items: Item[], opts: TriageOptions): Promise<TriageResult> {
  const result: TriageResult = {
    scores: new Map(),
    failed: [],
    unscored: [],
    tokens: 0,
    budgetHit: false,
    llmFailed: false,
  };
  let apiErrors = 0;

  for (let start = 0; start < items.length; start += opts.batchSize) {
    let pending = items.slice(start, start + opts.batchSize);
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      if (result.tokens >= opts.tokenBudget) {
        result.budgetHit = true;
        break;
      }
      try {
        const { valid, problems, tokens } = await callOnce(pending, opts);
        result.tokens += tokens;
        for (const s of valid) result.scores.set(s.id, s);
        if (problems.length) log("triage.schema_problems", { attempt, problems });
      } catch (err) {
        apiErrors++;
        log("triage.api_error", { attempt, error: String(err) });
      }
      pending = pending.filter((i) => !result.scores.has(i.id));
    }
    if (result.budgetHit) {
      result.unscored.push(...pending, ...items.slice(start + opts.batchSize));
      break;
    }
    result.failed.push(...pending);
  }

  if (result.scores.size === 0 && apiErrors > 0) {
    result.llmFailed = true;
    result.unscored = items;
    result.failed = [];
  } else if (result.failed.length) {
    log("triage.dropped", { ids: result.failed.map((i) => i.id), titles: result.failed.map((i) => i.title) });
  }
  return result;
}
