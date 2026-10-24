import { createHash } from "node:crypto";

const TRACKING_PARAM = /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|igshid|si|_hsenc|_hsmi|mkt_tok)$/i;

export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  const host = u.host.toLowerCase().replace(/^www\./, "");
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  const path = u.pathname.replace(/\/+$/, "");
  return `https://${host}${path}${u.search}`;
}

export function urlId(raw: string): string {
  return createHash("sha256").update(canonicalUrl(raw)).digest("hex").slice(0, 16);
}
