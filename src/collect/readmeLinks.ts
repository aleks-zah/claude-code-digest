import { getText } from "../http.ts";
import { collapse, truncate } from "../text.ts";
import { diffLinks, type IndexLink } from "./htmlIndex.ts";

const LINK = /(?<!!)\[([^\][]+)\]\((https?:\/\/[^)\s]+)\)/g;

export function extractReadmeLinks(markdown: string, selfUrl: string): IndexLink[] {
  const links = new Map<string, IndexLink>();
  for (const line of markdown.split("\n")) {
    for (const [, title, url] of line.matchAll(LINK)) {
      if (url.startsWith(selfUrl) || links.has(url)) continue;
      const rest = line.replace(LINK, "$1").replace(/^[\s>*+-]+/, "").replace(/[*_`]/g, "");
      links.set(url, { url, title: collapse(title.replace(/[*_`]/g, "")), excerpt: truncate(collapse(rest), 300) });
    }
  }
  return [...links.values()];
}

export async function collectReadmeLinks(url: string, previous: string[] | undefined) {
  const [, owner, repo] = new URL(url).pathname.split("/");
  const links = extractReadmeLinks(await getText(url), `https://github.com/${owner}/${repo}`);
  if (links.length === 0) throw new Error("no links found in README");
  return { entries: diffLinks(links, previous, false), linkSet: links.map((l) => l.url) };
}
