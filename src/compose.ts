import type { DropReason } from "./prefilter.ts";
import { truncate } from "./text.ts";
import type { ItemScore } from "./triage/schema.ts";
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
  { kind: "must", title: "🔥 <b>MUST READ</b>" },
  { kind: "skim", title: "👀 <b>WORTH A SKIM</b>" },
  { kind: "unscored", title: "❔ <b>UNSCORED</b> (heuristics only)" },
] as const;

const CATEGORY_LABELS: Record<ItemScore["category"], string> = {
  release: "🚀 Release",
  workflow: "🛠 Workflow",
  tool: "🧰 Tool",
  research: "🔬 Research",
  opinion: "💭 Opinion",
  incident: "🚨 Incident",
};

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

function renderChoice(c: Choice, sectionTitle: string, sourceName: (id: string) => string): string {
  const { item, score } = c;
  const lines = [score ? `${sectionTitle} · ${CATEGORY_LABELS[score.category]}` : sectionTitle];
  lines.push(`<b><a href="${escapeAttr(item.url)}">${escapeHtml(truncate(item.title, 200))}</a></b>`, "");
  if (score) {
    lines.push(`📝 ${escapeHtml(truncate(score.summary, 2000))}`);
    lines.push(`💡 <b>Why:</b> ${escapeHtml(truncate(score.whyItMatters, 300))}`);
    if (score.tryThis) lines.push(`▶️ <b>Try:</b> ${escapeHtml(truncate(score.tryThis, 200))}`);
    lines.push("");
  }
  const thread = item.discussionUrls.find((u) => u !== item.url);
  if (thread) lines.push(`💬 <a href="${escapeAttr(thread)}">Discussion</a>`);
  const names = [...new Set(item.sources.map(sourceName))];
  const meta = [`📡 ${escapeHtml(names.join(" + "))}${names.length > 1 ? ` (${names.length} sources)` : ""}`];
  if (item.engagement?.points !== undefined) meta.push(`⬆️ ${item.engagement.points}`);
  if (item.engagement?.comments !== undefined) meta.push(`🗨 ${item.engagement.comments}`);
  lines.push(meta.join(" · "));
  return lines.join("\n").replace(/\n+$/, "");
}

function footer(input: DigestInput, keptCount: number): string[] {
  const lines: string[] = [];
  const counts = (Object.entries(input.dropCounts) as [keyof typeof DROP_LABELS, number][]).filter(([, n]) => n > 0);
  if (keptCount > 0 && counts.length) {
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    lines.push([`🗑 Dropped ${total}`, ...counts.map(([r, n]) => `${DROP_LABELS[r]}: ${n}`)].join(" · "));
  }
  if (input.failedSources.length) lines.push(`⚠️ Unavailable: ${escapeHtml(input.failedSources.join(", "))}`);
  for (const b of input.brokenSources) {
    lines.push(`🔧 Needs fixing: ${escapeHtml(b.name)} failed ${b.runs} runs in a row (${escapeHtml(truncate(b.error, 120))})`);
  }
  if (input.heuristicsNote) lines.push(`ℹ️ ${escapeHtml(input.heuristicsNote)}`);
  return lines;
}

/** Renders Telegram HTML: a header, one message per kept item, then the footer when it has anything. */
export function compose(input: DigestInput): string[] {
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: input.timezone,
  }).format(input.date);

  if (input.kept.length === 0) {
    return [[`😴 Nothing worth your time today (${input.scanned} scanned).`, ...footer(input, 0)].join("\n")];
  }

  const messages = [`📰 <b>Claude Code digest</b> · ${day} · ${input.kept.length} of ${input.scanned} kept`];
  for (const section of SECTIONS) {
    for (const c of input.kept.filter((k) => k.kind === section.kind)) {
      messages.push(renderChoice(c, section.title, input.sourceName));
    }
  }
  const tail = footer(input, input.kept.length);
  if (tail.length) messages.push(tail.join("\n"));
  return messages;
}
