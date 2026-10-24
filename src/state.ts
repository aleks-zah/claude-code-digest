import { existsSync, readFileSync } from "node:fs";

const STATE_DIR = "state";

function readJson<T>(name: string, fallback: T): T {
  const path = `${STATE_DIR}/${name}`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

/** Canonical-URL id to the date it was first seen (YYYY-MM-DD). */
export type Seen = Record<string, string>;

export const loadSeen = () => readJson<Seen>("seen.json", {});
export const loadLinkSets = () => readJson<Record<string, string[]>>("link-sets.json", {});
