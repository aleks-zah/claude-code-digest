import { XMLParser } from "fast-xml-parser";
import { getText } from "../http.ts";
import { htmlToText, collapse, truncate } from "../text.ts";
import type { RawEntry } from "../types.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

type Node = string | { "#text"?: string; "@_href"?: string; "@_rel"?: string } | undefined;

interface RssItem {
  title?: Node;
  link?: Node[];
  guid?: Node;
  description?: Node;
  "content:encoded"?: Node;
  pubDate?: Node;
  "dc:date"?: Node;
  "dc:creator"?: Node;
  author?: Node;
}

interface AtomEntry {
  title?: Node;
  link?: Node[];
  summary?: Node;
  content?: Node;
  published?: Node;
  updated?: Node;
  author?: { name?: Node };
}

interface FeedDoc {
  rss?: { channel?: { item?: RssItem[] } };
  feed?: { entry?: AtomEntry[] };
}

const text = (n: Node): string => (typeof n === "object" ? (n["#text"] ?? "") : (n ?? ""));

export function parseFeed(xml: string): RawEntry[] {
  const doc = parser.parse(xml) as FeedDoc;
  if (doc.rss?.channel) return (doc.rss.channel.item ?? []).map(rssEntry);
  if (doc.feed) return (doc.feed.entry ?? []).map(atomEntry);
  throw new Error("response is not an RSS or Atom feed");
}

function rssEntry(item: RssItem): RawEntry {
  return {
    url: text(item.link?.[0]) || text(item.guid),
    title: collapse(htmlToText(text(item.title))),
    excerpt: excerpt(text(item.description) || text(item["content:encoded"])),
    publishedAt: new Date(text(item.pubDate) || text(item["dc:date"])),
    author: text(item["dc:creator"]) || text(item.author) || undefined,
  };
}

function atomEntry(entry: AtomEntry): RawEntry {
  const alternate = (entry.link ?? []).find((l) => typeof l === "object" && (l["@_rel"] ?? "alternate") === "alternate");
  return {
    url: typeof alternate === "object" ? (alternate["@_href"] ?? "") : "",
    title: collapse(htmlToText(text(entry.title))),
    excerpt: excerpt(text(entry.summary) || text(entry.content)),
    publishedAt: new Date(text(entry.published) || text(entry.updated)),
    author: text(entry.author?.name) || undefined,
  };
}

const excerpt = (html: string) => truncate(htmlToText(html), 500);

export async function collectFeed(url: string, since: Date): Promise<RawEntry[]> {
  return parseFeed(await getText(url))
    .filter((e) => e.publishedAt >= since && URL.canParse(e.url, url))
    .map((e) => ({ ...e, url: new URL(e.url, url).href }));
}
