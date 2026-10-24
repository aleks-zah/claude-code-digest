import { getJson } from "../http.ts";
import { collapse, truncate } from "../text.ts";
import type { RawEntry } from "../types.ts";

interface Listing<T> {
  data: { children: { kind: string; data: T }[] };
}

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
}

let token: Promise<string> | undefined;

function fetchToken(): Promise<string> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return Promise.reject(new Error("REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set"));
  return getJson<{ access_token: string }>("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  }).then((r) => r.access_token);
}

async function redditGet<T>(path: string): Promise<T> {
  if (!token) {
    token = fetchToken();
    token.catch(() => (token = undefined));
  }
  return getJson<T>(`https://oauth.reddit.com${path}`, { headers: { authorization: `Bearer ${await token}` } });
}

export function parseListing(listing: Listing<RedditPost>, since: Date): RawEntry[] {
  return listing.data.children
    .map((c) => c.data)
    .filter((p) => p.created_utc * 1000 >= since.getTime())
    .map((p) => {
      const thread = `https://www.reddit.com${p.permalink}`;
      const host = p.is_self ? "" : new URL(p.url).hostname;
      // Image, video and gallery posts point at Reddit's own media hosts; the thread is the content.
      const isMedia = /(^|\.)(redd\.it|reddit\.com)$/.test(host);
      return {
        url: p.is_self || isMedia ? thread : p.url,
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
  const listing = await redditGet<Listing<RedditPost>>(`/r/${subreddit}/top?t=day&limit=25&raw_json=1`);
  return parseListing(listing, since);
}

export async function topRedditComments(threadUrl: string, n: number): Promise<string[]> {
  const id = threadUrl.match(/\/comments\/([a-z0-9]+)/i)?.[1];
  if (!id) return [];
  const [, comments] = await redditGet<[unknown, Listing<{ body?: string }>]>(
    `/comments/${id}?sort=top&limit=${n}&depth=1&raw_json=1`,
  );
  return comments.data.children
    .filter((c) => c.kind === "t1" && c.data.body)
    .slice(0, n)
    .map((c) => truncate(collapse(c.data.body!), 800));
}
