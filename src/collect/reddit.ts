import { getJson } from "../http.ts";
import { collapse, truncate } from "../text.ts";
import type { RawEntry } from "../types.ts";

const API = "https://arctic-shift.photon-reddit.com/api";
const PAGE = 100;

export interface RedditPost {
  title: string;
  url: string;
  permalink: string;
  is_self: boolean;
  selftext?: string;
  author: string;
  score: number;
  num_comments: number;
  created_utc: number;
  _meta?: { retrieved_2nd_on?: number };
}

export function parsePosts(posts: RedditPost[], since: Date): RawEntry[] {
  return posts
    // Arctic Shift stores the score from post time until a second fetch hours later. Every fresh item is
    // marked seen, so judging the early score would drop the post for good; the lookback picks it up next run.
    .filter((p) => p.created_utc * 1000 >= since.getTime() && p._meta?.retrieved_2nd_on)
    .map((p) => {
      const thread = `https://www.reddit.com${p.permalink}`;
      const host = p.is_self ? "" : new URL(p.url, "https://www.reddit.com").hostname;
      // Image, video and gallery posts point at Reddit's own media hosts; the thread is the content.
      const isMedia = /(^|\.)(redd\.it|reddit\.com)$/.test(host);
      return {
        url: p.is_self || isMedia ? thread : new URL(p.url, "https://www.reddit.com").href,
        title: p.title,
        excerpt: truncate(collapse(p.selftext ?? ""), 500),
        publishedAt: new Date(p.created_utc * 1000),
        author: p.author,
        engagement: { points: p.score, comments: p.num_comments },
        discussionUrl: thread,
      };
    });
}

export async function collectReddit(subreddit: string, since: Date): Promise<RawEntry[]> {
  const posts: RedditPost[] = [];
  let cursor = "";
  for (;;) {
    const { data } = await getJson<{ data: RedditPost[] }>(
      `${API}/posts/search?subreddit=${subreddit}&after=${Math.floor(since.getTime() / 1000)}&limit=${PAGE}&sort=desc${cursor}`,
    );
    posts.push(...data);
    if (data.length < PAGE) return parsePosts(posts, since);
    cursor = `&before=${data.at(-1)!.created_utc}`;
  }
}

export async function topRedditComments(threadUrl: string, n: number): Promise<string[]> {
  const id = threadUrl.match(/\/comments\/([a-z0-9]+)/i)?.[1];
  if (!id) return [];
  const { data } = await getJson<{ data: { body: string; parent_id: string; score: number }[] }>(
    `${API}/comments/search?link_id=${id}&limit=100`,
  );
  return data
    .filter((c) => c.parent_id.startsWith("t3_"))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((c) => truncate(collapse(c.body), 800));
}
