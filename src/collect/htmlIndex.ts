import { parseHTML } from "linkedom";
import { getScraped } from "../http.ts";
import { collapse, truncate } from "../text.ts";
import type { RawEntry } from "../types.ts";

export interface IndexLink {
  url: string;
  title: string;
  excerpt?: string;
}

export function extractIndexLinks(html: string, pageUrl: string, pattern: RegExp): IndexLink[] {
  const { document } = parseHTML(html);
  const host = new URL(pageUrl).host;
  const links = new Map<string, string>();
  for (const a of document.querySelectorAll("a[href]")) {
    let url: URL;
    try {
      url = new URL(a.getAttribute("href") ?? "", pageUrl);
    } catch {
      continue;
    }
    if (url.host !== host || !pattern.test(url.pathname)) continue;
    const href = url.origin + url.pathname;
    if (!links.get(href)) links.set(href, truncate(collapse(a.textContent ?? ""), 200));
  }
  return [...links].map(([url, title]) => ({ url, title }));
}

/** Diffs links against the previous run's link set; the first run only records a baseline. */
export function diffLinks(links: IndexLink[], previous: string[] | undefined, fromIndex: boolean): RawEntry[] {
  if (!previous) return [];
  const seen = new Set(previous);
  const now = new Date();
  return links
    .filter((l) => !seen.has(l.url))
    .map((l) => ({
      url: l.url,
      title: l.title || l.url,
      excerpt: l.excerpt ?? "",
      publishedAt: now,
      ...(fromIndex && { titleFromIndex: true }),
    }));
}

export async function collectHtmlIndex(url: string, linkPattern: string, previous: string[] | undefined) {
  const links = extractIndexLinks(await getScraped(url), url, new RegExp(linkPattern));
  if (links.length === 0) throw new Error("no article links found, page layout may have changed");
  return { entries: diffLinks(links, previous, true), linkSet: links.map((l) => l.url) };
}
