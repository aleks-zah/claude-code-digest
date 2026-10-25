import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { SourceResult } from "./types.ts";

/** Canonical-URL id to the date it was first seen (YYYY-MM-DD). */
export type Seen = Record<string, string>;

export interface RunRecord {
  date: string;
  startedAt: string;
  sinceHours: number;
  counts: Record<string, number>;
  tokens: number;
  failedSources: { id: string; error: string }[];
  heuristicsNote?: string;
  items: Record<string, unknown>[];
}

export class State {
  readonly dir: string;
  constructor(dir = "state") {
    this.dir = dir;
  }

  private read<T>(name: string, fallback: T): T {
    const path = `${this.dir}/${name}`;
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  }

  private write(name: string, data: unknown): void {
    const path = `${this.dir}/${name}`;
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  }

  loadSeen(): Seen {
    return this.read<Seen>("seen.json", {});
  }

  loadLinkSets(): Record<string, string[]> {
    return this.read<Record<string, string[]>>("link-sets.json", {});
  }

  /** Delivered runs before `today`, newest first. */
  loadRunsBefore(today: string, limit: number): RunRecord[] {
    const dir = `${this.dir}/runs`;
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f.slice(0, -5) < today)
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => this.read<RunRecord>(`runs/${f}`, {} as RunRecord));
  }

  /** Called only after the digest was delivered, so a failed send never marks items as seen. */
  save(opts: { seenIds: string[]; results: SourceResult[]; run: RunRecord; today: string; retentionDays: number }): void {
    const cutoff = new Date(Date.parse(opts.today) - opts.retentionDays * 86400_000).toISOString().slice(0, 10);
    const seen = Object.fromEntries(Object.entries(this.loadSeen()).filter(([, d]) => d >= cutoff));
    for (const id of opts.seenIds) seen[id] ??= opts.today;
    this.write("seen.json", seen);

    const linkSets = this.loadLinkSets();
    for (const r of opts.results) if (r.linkSet && !r.error) linkSets[r.sourceId] = r.linkSet;
    this.write("link-sets.json", linkSets);

    this.write(`runs/${opts.today}.json`, opts.run);
  }
}

/**
 * How many delivered runs in a row each of today's failed sources has failed, today included.
 * A run without the source in its failures ends the streak.
 */
export function failureStreaks(failedToday: string[], previousRuns: RunRecord[]): Map<string, number> {
  return new Map(
    failedToday.map((id) => {
      let runs = 1;
      for (const run of previousRuns) {
        if (!run.failedSources.some((f) => f.id === id)) break;
        runs++;
      }
      return [id, runs];
    }),
  );
}
