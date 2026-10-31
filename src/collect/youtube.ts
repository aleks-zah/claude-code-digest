import { XMLParser } from "fast-xml-parser";
import { getJson, getText, request } from "../http.ts";
import { collapse, htmlToText, truncate } from "../text.ts";
import type { RawEntry } from "../types.ts";

const API = "https://www.googleapis.com/youtube/v3";
const PAGE = 50;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  isArray: (name) => name === "entry",
});

interface FeedEntry {
  "yt:videoId": string;
  title: string;
  published: string;
  author: { name: string };
  "media:group": {
    "media:description"?: string;
    "media:community"?: { "media:statistics"?: { "@_views": string } };
  };
}

export const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;

export function youtubeVideoId(url: string): string | undefined {
  const u = new URL(url);
  return /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/watch" ? (u.searchParams.get("v") ?? undefined) : undefined;
}

export function parseChannelFeed(xml: string): RawEntry[] {
  const entries = (parser.parse(xml) as { feed?: { entry?: FeedEntry[] } }).feed?.entry ?? [];
  return entries.map((e) => ({
    url: watchUrl(e["yt:videoId"]),
    title: collapse(e.title),
    excerpt: truncate(collapse(e["media:group"]["media:description"] ?? ""), 500),
    publishedAt: new Date(e.published),
    author: e.author.name,
    engagement: { points: Number(e["media:group"]["media:community"]?.["media:statistics"]?.["@_views"] ?? 0) },
  }));
}

export interface Video {
  id: string;
  snippet: { title: string; description: string; publishedAt: string; channelTitle: string };
  statistics: { viewCount?: string; commentCount?: string };
}

export function parseVideos(videos: Video[]): RawEntry[] {
  return videos.map((v) => ({
    url: watchUrl(v.id),
    title: collapse(v.snippet.title),
    excerpt: truncate(collapse(v.snippet.description), 500),
    publishedAt: new Date(v.snippet.publishedAt),
    author: v.snippet.channelTitle,
    engagement: { points: Number(v.statistics.viewCount ?? 0), comments: Number(v.statistics.commentCount ?? 0) },
  }));
}

// Views keep growing for days, and every collected entry is marked seen, so the floor is applied here: a video
// below it stays unseen and is picked up by a later run inside the source's lookback.
const popular = (entries: RawEntry[], minViews: number, since: Date) =>
  entries.filter((e) => e.publishedAt >= since && (e.engagement?.points ?? 0) >= minViews);

export async function collectYoutubeChannels(channelIds: string[], minViews: number, since: Date): Promise<RawEntry[]> {
  const feeds = await Promise.all(
    channelIds.map((id) => getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`)),
  );
  return popular(feeds.flatMap(parseChannelFeed), minViews, since);
}

export async function collectYoutubeSearch(queries: string[], minViews: number, since: Date): Promise<RawEntry[]> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY is not set");
  // In a header, not the query string: request errors carry the URL into logs and committed run state.
  const init = { headers: { "x-goog-api-key": key } };
  const ids = new Set<string>();
  for (const q of queries) {
    const params = new URLSearchParams({
      part: "id",
      type: "video",
      order: "viewCount",
      maxResults: String(PAGE),
      publishedAfter: since.toISOString(),
      relevanceLanguage: "en",
      q,
    });
    const { items } = await getJson<{ items: { id: { videoId: string } }[] }>(`${API}/search?${params}`, init);
    for (const i of items) ids.add(i.id.videoId);
  }
  const videos: Video[] = [];
  const all = [...ids];
  for (let i = 0; i < all.length; i += PAGE) {
    const params = new URLSearchParams({ part: "snippet,statistics", id: all.slice(i, i + PAGE).join(",") });
    videos.push(...(await getJson<{ items: Video[] }>(`${API}/videos?${params}`, init)).items);
  }
  return popular(parseVideos(videos), minViews, since);
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

/** English captions, uploaded before auto-generated (`kind: "asr"`). */
export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
  const english = tracks.filter((t) => t.languageCode.startsWith("en"));
  return english.find((t) => t.kind !== "asr") ?? english[0];
}

export const timedTextToText = (xml: string) => htmlToText(xml.replace(/<head>[\s\S]*?<\/head>/, " "));

/**
 * Not an official API (robots.txt disallows /youtubei/), accepted for a personal digest. The ANDROID client
 * returns caption URLs that work without the proof-of-origin token the web player's URLs now require.
 */
export async function fetchTranscript(videoId: string): Promise<string | undefined> {
  const res = await request("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } }, videoId }),
  });
  const player = (await res.json()) as {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
  };
  const track = pickTrack(player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
  if (!track) return;
  return timedTextToText(await getText(track.baseUrl)) || undefined;
}
