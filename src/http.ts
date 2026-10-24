export interface HttpOptions {
  userAgent: string;
  timeoutMs: number;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(url: string, status: number) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

let options: HttpOptions = { userAgent: "claude-code-digest/0.1", timeoutMs: 20000 };
const pageCache = new Map<string, Promise<string>>();
const robotsCache = new Map<string, Promise<string[]>>();

export function configureHttp(opts: HttpOptions): void {
  options = opts;
}

export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": options.userAgent, ...init.headers },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!res.ok) throw new HttpError(url, res.status);
  return res;
}

/** GET with a per-run cache, so no page is fetched twice in one run. */
export function getText(url: string): Promise<string> {
  let page = pageCache.get(url);
  if (!page) {
    page = request(url).then((r) => r.text());
    page.catch(() => pageCache.delete(url));
    pageCache.set(url, page);
  }
  return page;
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await request(url, init)).json() as Promise<T>;
}

/** For scraped pages only; feeds and APIs are meant to be fetched by programs. */
export async function getScraped(url: string): Promise<string> {
  if (!(await allowedByRobots(url))) throw new Error(`robots.txt disallows ${url}`);
  return getText(url);
}

async function allowedByRobots(url: string): Promise<boolean> {
  const { origin, pathname, search } = new URL(url);
  let rules = robotsCache.get(origin);
  if (!rules) {
    rules = getText(`${origin}/robots.txt`).then(parseRobots, () => []);
    robotsCache.set(origin, rules);
  }
  const path = pathname + search;
  return !(await rules).some((prefix) => path.startsWith(prefix));
}

/**
 * Disallow prefixes from the `User-agent: *` groups. Allow lines are ignored (errs toward
 * skipping a page); Disallow rules with a mid-path wildcard are ignored too.
 */
export function parseRobots(text: string): string[] {
  const disallow: string[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, value] = m;
    const field = key.toLowerCase();
    if (field === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
    } else {
      inRules = true;
      if (field !== "disallow" || !value || !agents.includes("*")) continue;
      const prefix = value.replace(/\$$/, "").replace(/\*$/, "");
      if (!prefix.includes("*")) disallow.push(prefix);
    }
  }
  return disallow;
}

export async function withRetries<T>(fn: () => Promise<T>, retries: number, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
