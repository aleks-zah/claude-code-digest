import type { DropReason } from "./prefilter.ts";
import { truncate } from "./text.ts";
import type { Choice, FinalDropReason } from "./triage/score.ts";

export const TELEGRAM_LIMIT = 4096;

export interface DigestInput {
  date: Date;
  timezone: string;
  kept: Choice[];
  scanned: number;
  dropCounts: Partial<Record<DropReason | FinalDropReason, number>>;
  failedSources: string[];
  /** Sources that have failed several runs in a row, so the endpoint likely needs fixing. */
  brokenSources: { name: string; runs: number; error: string }[];
  sourceName: (id: string) => string;
  /** Set when some or all items skipped the LLM; shown in the footer. */
  heuristicsNote?: string;
}

const SECTIONS = [
  { kind: "must", title: "MUST READ" },
  { kind: "skim", title: "WORTH A SKIM" },
  { kind: "unscored", title: "UNSCORED (heuristics only)" },
] as const;

const DROP_LABELS: Record<DropReason | FinalDropReason, string> = {
  "low-engagement": "low engagement",
  "over-cap": "over candidate cap",
  "low-score": "low score",
  "prompt-injection": "prompt injection",
  "invalid-output": "invalid LLM output",
  "over-limit": "over item limit",
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

function renderChoice(c: Choice, sourceName: (id: string) => string): string {
  const names = [...new Set(c.item.sources.map(sourceName))];
  const tag = c.score ? `[${c.score.category[0].toUpperCase()}${c.score.category.slice(1)}] ` : "";
  const lines = [`• ${tag}<a href="${escapeAttr(c.item.url)}">${escapeHtml(truncate(c.item.title, 200))}</a>`];
  if (c.score) lines.push(`  Why: ${escapeHtml(truncate(c.score.whyItMatters, 300))}`);
  if (c.score?.tryThis) lines.push(`  Try: ${escapeHtml(truncate(c.score.tryThis, 200))}`);
  lines.push(`  ${escapeHtml(names.join(" + "))}${names.length > 1 ? ` (${names.length} sources)` : ""}`);
  return lines.join("\n");
}

function footer(input: DigestInput, keptCount: number): string[] {
  const lines: string[] = [];
  const counts = (Object.entries(input.dropCounts) as [keyof typeof DROP_LABELS, number][]).filter(([, n]) => n > 0);
  if (keptCount > 0 && counts.length) {
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    lines.push([`Dropped ${total}`, ...counts.map(([r, n]) => `${DROP_LABELS[r]}: ${n}`)].join(" · "));
  }
  if (input.failedSources.length) lines.push(`Unavailable: ${escapeHtml(input.failedSources.join(", "))}`);
  for (const b of input.brokenSources) {
    lines.push(`Needs fixing: ${escapeHtml(b.name)} failed ${b.runs} runs in a row (${escapeHtml(truncate(b.error, 120))})`);
  }
  if (input.heuristicsNote) lines.push(escapeHtml(input.heuristicsNote));
  return lines;
}

/** Renders Telegram HTML, split at item boundaries into messages of at most 4096 characters. */
export function compose(input: DigestInput): string[] {
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: input.timezone,
  }).format(input.date);

  if (input.kept.length === 0) {
    return pack([[`Nothing worth your time today (${input.scanned} scanned).`, ...footer(input, 0)].join("\n")]);
  }

  // Each block starts with its separator, so a message can start at any block boundary.
  const blocks = [`<b>Claude Code digest</b> · ${day} · ${input.kept.length} of ${input.scanned} kept`];
  for (const section of SECTIONS) {
    const choices = input.kept.filter((c) => c.kind === section.kind);
    choices.forEach((c, i) => {
      const item = renderChoice(c, input.sourceName);
      blocks.push(i === 0 ? `\n\n<b>${section.title}</b>\n${item}` : `\n${item}`);
    });
  }
  const tail = footer(input, input.kept.length);
  if (tail.length) blocks.push(`\n\n${tail.join("\n")}`);
  return pack(blocks);
}

function pack(blocks: string[]): string[] {
  const messages: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length > TELEGRAM_LIMIT) {
      messages.push(current);
      current = block.trimStart();
    } else {
      current += block;
    }
  }
  if (current) messages.push(current);
  return messages;
}
