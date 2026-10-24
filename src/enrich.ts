import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { topHnComments } from "./collect/hn.ts";
import { topRedditComments } from "./collect/reddit.ts";
import { getScraped } from "./http.ts";
import { log } from "./log.ts";
import { collapse, truncate } from "./text.ts";
import type { Item } from "./types.ts";

const DISCUSSION_HOST = /(^|\.)(reddit\.com|news\.ycombinator\.com)$/;

export function extractArticle(html: string): { title?: string; text: string } | undefined {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 200 }).parse();
  if (!article?.textContent) return;
  return { title: article.title ? collapse(article.title) : undefined, text: collapse(article.textContent) };
}

async function enrichOne(item: Item, maxChars: number, topComments: number): Promise<Item> {
  const out = { ...item };
  if (!out.text && !DISCUSSION_HOST.test(new URL(out.url).hostname)) {
    try {
      const article = extractArticle(await getScraped(out.url));
      if (article) {
        out.text = truncate(article.text, maxChars);
        if (out.titleFromIndex && article.title) out.title = article.title;
      }
    } catch (err) {
      log("enrich.page_failed", { url: out.url, error: String(err) });
    }
  }
  const thread = out.discussionUrls[0];
  if (thread && topComments > 0) {
    try {
      out.comments = thread.includes("ycombinator")
        ? await topHnComments(thread, topComments)
        : await topRedditComments(thread, topComments);
    } catch (err) {
      log("enrich.comments_failed", { url: thread, error: String(err) });
    }
  }
  return out;
}

export async function enrich(items: Item[], maxChars: number, topComments: number, concurrency = 6): Promise<Item[]> {
  const out: Item[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await enrichOne(items[i], maxChars, topComments);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
