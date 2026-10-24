import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { log } from "../log.ts";
import type { Item } from "../types.ts";
import { ItemScore, TriageOutput } from "./schema.ts";

// Claude Code's validator has no draft 2020-12 meta-schema, so it rejects a schema that declares one.
const { $schema: _, ...jsonSchema } = z.toJSONSchema(TriageOutput);
const outputSchema = JSON.stringify(jsonSchema);

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
export function parseResults(output: unknown, ids: Set<string>): { valid: ItemScore[]; problems: string[] } {
  const results = (output as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return { valid: [], problems: ["output has no results array"] };
  const problems: string[] = [];
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

/** Runs `claude` with the given args and stdin, resolving with stdout even on a non-zero exit. */
export type ClaudeRunner = (args: string[], input: string) => Promise<string>;

const execFileAsync = promisify(execFile);

export const runClaude: ClaudeRunner = async (args, input) => {
  // Running outside the repo keeps project files out of reach even if a tool slipped through.
  const call = execFileAsync("claude", args, { cwd: tmpdir(), timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  call.child.stdin?.end(input);
  try {
    return (await call).stdout;
  } catch (err) {
    const { stdout, stderr, code } = err as { stdout?: string; stderr?: string; code?: number | string };
    if (stdout) return stdout;
    // The default message repeats the whole command line, system prompt included.
    throw new Error(`claude exited with ${code}: ${(stderr ?? "").trim().slice(0, 300)}`);
  }
};

interface ClaudeResult {
  is_error: boolean;
  subtype: string;
  result?: string;
  structured_output?: unknown;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface TriageOptions {
  model: string;
  system: string;
  batchSize: number;
  tokenBudget: number;
  sourceName: (id: string) => string;
  run?: ClaudeRunner;
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

/**
 * Runs on the Claude subscription via `claude -p` (CLAUDE_CODE_OAUTH_TOKEN). Item text is
 * untrusted, so every tool, MCP server, hook, plugin and CLAUDE.md is switched off.
 */
async function callOnce(items: Item[], opts: TriageOptions) {
  const args = [
    "-p",
    "--model", opts.model,
    "--effort", "low",
    "--system-prompt", opts.system,
    "--tools", "",
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format", "json",
    "--json-schema", outputSchema,
  ];
  const stdout = await (opts.run ?? runClaude)(args, renderItems(items, opts.sourceName));
  let res: ClaudeResult;
  try {
    res = JSON.parse(stdout) as ClaudeResult;
  } catch {
    throw new Error(`claude printed non-JSON output: ${stdout.slice(0, 200)}`);
  }
  const u = res.usage;
  const tokens = u
    ? u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + u.output_tokens
    : 0;
  log("triage.call", {
    items: items.length,
    subtype: res.subtype,
    input: u?.input_tokens,
    cacheRead: u?.cache_read_input_tokens,
    cacheWrite: u?.cache_creation_input_tokens,
    output: u?.output_tokens,
  });
  if (res.is_error) return { valid: [], problems: [], tokens, error: `claude ${res.subtype}: ${(res.result ?? "").slice(0, 200)}` };
  return { ...parseResults(res.structured_output, new Set(items.map((i) => i.id))), tokens, error: undefined };
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
  let callErrors = 0;

  for (let start = 0; start < items.length; start += opts.batchSize) {
    let pending = items.slice(start, start + opts.batchSize);
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      if (result.tokens >= opts.tokenBudget) {
        result.budgetHit = true;
        break;
      }
      try {
        const { valid, problems, tokens, error } = await callOnce(pending, opts);
        result.tokens += tokens;
        for (const s of valid) result.scores.set(s.id, s);
        if (problems.length) log("triage.schema_problems", { attempt, problems });
        if (error) throw new Error(error);
      } catch (err) {
        callErrors++;
        log("triage.call_error", { attempt, error: String(err) });
      }
      pending = pending.filter((i) => !result.scores.has(i.id));
    }
    if (result.budgetHit) {
      result.unscored.push(...pending, ...items.slice(start + opts.batchSize));
      break;
    }
    result.failed.push(...pending);
  }

  if (result.scores.size === 0 && callErrors > 0) {
    result.llmFailed = true;
    result.unscored = items;
    result.failed = [];
  } else if (result.failed.length) {
    log("triage.dropped", { ids: result.failed.map((i) => i.id), titles: result.failed.map((i) => i.title) });
  }
  return result;
}
