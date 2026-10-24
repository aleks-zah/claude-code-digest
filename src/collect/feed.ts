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
type XmlRecord = Record<string, any>;

const text = (n: Node): string => (typeof n === "object" ? (n["#text"] ?? "") : (n ?? ""));

export function parseFeed(xml: string): RawEntry[] {
  const doc = parser.parse(xml) as XmlRecord;
  if (doc.rss?.channel) return ((doc.rss.channel.item ?? []) as XmlRecord[]).map(rssEntry);
  if (doc.feed) return ((doc.feed.entry ?? []) as XmlRecord[]).map(atomEntry);
  throw new Error("response is not an RSS or Atom feed");
}

function rssEntry(item: XmlRecord): RawEntry {
  const guid = item.guid as Node;
  return {
    url: text(item.link?.[0]) || text(guid),
    title: collapse(htmlToText(text(item.title))),
    excerpt: excerpt(text(item.description) || text(item["content:encoded"])),
    publishedAt: new Date(text(item.pubDate) || text(item["dc:date"])),
    author: text(item["dc:creator"]) || text(item.author) || undefined,
  };
}

function atomEntry(entry: XmlRecord): RawEntry {
  const links = (entry.link ?? []) as Node[];
  const alternate = links.find((l) => typeof l === "object" && (l["@_rel"] ?? "alternate") === "alternate");
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
  return parseFeed(await getText(url)).filter((e) => e.url && e.publishedAt >= since);
}
