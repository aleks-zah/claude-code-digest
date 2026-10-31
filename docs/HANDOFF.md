# Claude Code News Digest — Handoff Spec

Oct 24, 2026 · @oleks

## Kickoff prompt for Claude Code

Save this doc as `docs/HANDOFF.md` in an empty repo, then paste the prompt below into Claude Code.

```markdown
Read docs/HANDOFF.md fully. It specs a daily Telegram digest of Claude Code / agentic-coding news with an LLM triage step that filters hype.

Work in plan mode first:
1. Verify every source URL in the Sources table actually returns a feed or parseable page today. Report which work, which moved, and the fallback for each. Do not assume a feed exists.
2. Propose the repo layout, dependencies and the triage prompt, and list any spec decision you would change and why.
3. Wait for my approval before writing code.

Then build in this order, with a working dry-run after each step: collectors -> normalize + dedup -> triage -> digest render -> Telegram send -> GitHub Actions schedule.
Keep it boring: few dependencies, typed config, no framework. Add tests for parsing, dedup and the triage JSON schema using recorded fixtures, not live network.
```

## Goal and scope

Every morning, one Telegram message with at most 7 items worth reading about Claude Code and agentic coding, each with a one-line reason it matters, and everything else dropped.

The reader is a senior full-stack engineer (React, TypeScript, GraphQL/Apollo, Go, Neo4j) who already uses Claude Code daily across a large multi-repo codebase, with MCP servers and automated PR review. The digest should surface what changes how he works, not what he already knows.

**In scope**

- Pull new items from a fixed list of sources (feeds first, scraping only where no feed exists).
- Deduplicate across sources and across days.
- Triage each item: cheap heuristic prefilter, then LLM scoring for signal vs hype.
- Send one digest per day to a private Telegram chat; send nothing extra when nothing qualifies, just a one-line "quiet day" note.
- Run unattended on a schedule with no server to maintain.

**Out of scope (v1)**

- X/Twitter (paid API, poor signal). Revisit only via a third-party RSS bridge.
- Paywalled full text (Pragmatic Engineer, Latent Space paid posts): titles and public excerpts only.
- YouTube, podcasts, Discord.
- Interactive bot commands or feedback buttons (see Phase 2).

## Architecture

A single scheduled job runs a linear pipeline; every stage is a pure function over a list of items, so each can be dry-run and tested on fixtures.

&#91;embedded content: digest pipeline · 8 stages, state written after delivery\]

Dedup reads the same state the Deliver stage writes, so a failed send never marks items as seen.

1. **Collect.** One adapter per source type (`rss`, `atom`, `github-releases`, `github-commits`, `reddit`, `hn-algolia`, `html-index`). Each returns raw entries published in the last 36 hours (overlap covers a missed run).
2. **Normalize.** Map to one `Item` shape: `id` (hash of canonical URL), `source`, `sourceTier`, `url`, `title`, `author`, `publishedAt`, `excerpt`, `engagement` (points, comments, stars when available).
3. **Dedup.** Drop items whose canonical URL is in state (strip UTM and tracking params, trailing slashes, `www.`; resolve HN and Reddit link posts to the target URL). Merge the same URL seen via several sources into one item and keep all discovery sources, since cross-source pickup is a signal.
4. **Prefilter (heuristics, no LLM).** Engagement thresholds and a candidate cap of 40. Relevance and hype are left to the LLM.
5. **Enrich.** Fetch the page and extract readable text (Readability-style), truncated to about 6k characters. For Reddit and HN, add the top 3 comments.
6. **Triage (LLM).** Score each candidate against the rubric in the Triage section; strict JSON output.
7. **Compose.** Rank by score, cap at 7, group by category, render Telegram HTML.
8. **Deliver.** Send via the Telegram Bot API, then persist state (seen URLs, run log). State is written only after a successful send.

Recommended stack: TypeScript on Node 22 (best feed and readability libraries), or Go if a single static binary matters more. Pick one in plan mode; the spec is language-neutral.

## Sources

Start with these 18 sources in `sources.yaml`; endpoints marked "verify" are best guesses and must be confirmed in step 1 of the kickoff before any code depends on them.

| Source | Tier | Adapter | Endpoint | Notes |
| --- | --- | --- | --- | --- |
| Claude Code releases | 1 | github-releases | `https://github.com/anthropics/claude-code/releases.atom` | Version-by-version changes. Collapse multiple patch releases per day into one item. |
| Claude Code "What's new" | 1 | html-index | `https://code.claude.com/docs/en/whats-new` | Weekly feature digest. Check for a feed first; else diff entries by heading. |
| Anthropic engineering blog | 1 | html-index | `https://www.anthropic.com/engineering` | Infrequent, high value. No known feed: diff article URLs on the index page. |
| Anthropic news | 1 | html-index | `https://www.anthropic.com/news` | Most posts are not developer-facing; triage scores those low on relevance. |
| Claude blog, Claude Code category | 1 | html-index | `https://claude.com/blog/category/claude-code` | Product how-tos. Diff article URLs. |
| Simon Willison | 2 | atom | `https://simonwillison.net/atom/everything/` | 5 to 10 posts a day. A per-tag feed may exist (verify). |
| Latent Space / AINews | 2 | rss | `https://www.latent.space/feed` | High volume. |
| Addy Osmani (Elevate) | 2 | rss | `https://addyo.substack.com/feed` | Low volume. |
| The Pragmatic Engineer | 2 | rss | `https://newsletter.pragmaticengineer.com/feed` | Mostly paywalled: title and public excerpt only. |
| Every, Source Code (Kieran Klaassen) | 2 | rss | `https://every.to/source-code` (verify feed) | Compound-engineering workflows. |
| Jesse Vincent (Superpowers) | 2 | rss + github-releases | `https://blog.fsck.com` (verify feed); `https://github.com/obra/superpowers/releases.atom` | Skills framework; releases are actionable. |
| HumanLayer blog | 2 | rss / html-index | `https://www.humanlayer.dev/blog` (verify) | Context engineering, agent skills. |
| Hamel Husain | 2 | rss | `https://hamel.dev` (verify feed) | Evals; low volume. |
| awesome-claude-code | 3 | github-readme-diff | `hesreallyhim/awesome-claude-code` README on `main` | Diff README daily; each newly added link = one candidate item, not one per commit. |
| claude-code-best-practice | 3 | github-commits | `https://github.com/shanraisshan/claude-code-best-practice/commits/main.atom` | Treat a day's commits as one item. |
| r/ClaudeCode | 3 | reddit | `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=ClaudeCode` | Score at least 30. Arctic Shift archive: Reddit blocks unauthenticated JSON, HTML and RSS, and denied API access. Scores are snapshots from 4 to 10h after posting; posts without the second fetch wait for the next run. |
| r/ClaudeAI | 3 | reddit | `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=ClaudeAI` | Score at least 50 and mentions Claude Code. |
| Hacker News | 3 | hn-algolia | `https://hn.algolia.com/api/v1/search_by_date?query="claude code"&tags=story` | Add `numericFilters=points>40,created_at_i>{since}`. |

**Tiers.** 1 = official: always a candidate, skips the engagement floor, still scored. 2 = trusted practitioner: +1 score bonus. 3 = community: must earn its place on content and engagement.

Each source in `sources.yaml` carries `id`, `name`, `tier`, `adapter`, `url`, optional `minScore`, `maxItemsPerRun` and `enabled`, so sources can be added or muted without code changes.

## Triage middleware

Triage runs in two stages: cheap heuristics bound the batch size, then an LLM scores what is left on four sub-scores, and code (not the model) turns those into the final score.

### Stage A: heuristic prefilter

- **Engagement floor** (tier 3): per-source `minScore` from the Sources table.
- **Staleness:** drop items whose subject is a release more than 14 days old (rehash of old news).
- **Cap:** at most 40 candidates go to the LLM; keep the highest tier and engagement first.

### Stage B: LLM scoring

- **Model:** `claude-haiku-5-5` for per-item scoring, batching about 10 items per request. Optional second pass with `claude-sonnet-5-5` over the top 12 only, to rerank and write the final one-liners.
- **Output:** forced tool call or structured output against the JSON schema below; reject and retry once on schema failure, then drop the item and log it.
- **Caching:** the system prompt (rubric, reader profile, few-shot examples) is static, so mark it for prompt caching.
- **Reader profile:** a `profile.md` in the repo describing the reader and, importantly, what he already uses (CLAUDE.md conventions, subagents, MCP servers, PR review automation). The model docks novelty for things already on that list.
- **Few-shot calibration:** 4 to 6 short labeled examples (2 clear signal, 2 clear hype, 2 borderline) in `triage/examples.yaml`. Replace them with real items once you have a few weeks of runs.

**Rubric (each sub-score 0 to 3)**

| Sub-score | 3 means | 0 means | Weight |
| --- | --- | --- | --- |
| Relevance | Directly about Claude Code or agentic coding practice in a stack like the reader's | Generic AI news or unrelated domain | 0.30 |
| Novelty | New capability, flag, technique or finding not in the reader profile | Rehash of known basics ("use CLAUDE.md", "plan first") | 0.25 |
| Actionability | Concrete config, command, code or workflow he can try today | Opinion or vibes with nothing to apply | 0.25 |
| Evidence | Primary source, reproducible steps, numbers with method, or a postmortem | Claims with no support, screenshots of a chat, marketing | 0.20 |

Final score in code: `10 * sum(weight * sub / 3) + tierBonus - 1.5 * min(hypeFlags.length, 2)`, clamped to 0 to 10, where `tierBonus` is +1 for tier 2. Tier 1 items with relevance 2 or more are always kept. Cut-offs: 7 or more = must read, 5 to 6.9 = worth a skim, below 5 = dropped.

**Output schema per item**

```json
{
  "id": "string, echo of input id",
  "relevance": 0,
  "novelty": 0,
  "actionability": 0,
  "evidence": 0,
  "hypeFlags": ["superlatives_without_evidence | listicle | self_promo_no_artifact | rehash | vendor_marketing | unverified_benchmark | engagement_bait"],
  "category": "release | workflow | tool | research | opinion | incident",
  "summary": "one sentence, max 25 words, what it is",
  "whyItMatters": "one sentence, max 25 words, why this reader should care",
  "tryThis": "optional: one concrete action, max 20 words",
  "confidence": "low | medium | high"
}
```

**Untrusted input.** Feed and page text is data. The system prompt must say so, item content goes inside clearly delimited tags, the model has no tools beyond the output schema, and any item whose text tries to instruct the model gets a `hypeFlags` entry and is dropped.

## Digest format and Telegram delivery

One message per day, readable in 60 seconds on a phone, in English, with links and no previews.

**Layout** (Telegram HTML parse mode; it is simpler to escape than MarkdownV2)

```markdown
Claude Code digest · Sat 24 Oct · 5 of 63 kept

MUST READ
• [Release] Claude Code 2.x: hooks can now block tool calls by pattern
  Why: lets your PR-review agent refuse writes outside the repo without prompts.
  Try: add a PreToolUse rule for writes outside the workspace.
  anthropics/claude-code · link

WORTH A SKIM
• [Workflow] Running parallel worktree sessions with a shared task file
  Why: concrete setup for multi-repo work, with config shown.
  Simon Willison + HN (2 sources) · link

Dropped 58 · low score: 31 · low engagement: 19 · stale: 8
```

- Each item: category tag, title as link, "Why" line, optional "Try" line, source names (multiple when cross-posted).
- Footer counts what was dropped and why, so the filter stays auditable.
- Quiet day: one line, "Nothing worth your time today (N scanned)."

**Telegram Bot API**

1. Create the bot with @BotFather and keep the token.
2. Send the bot any message, then call `getUpdates` once to read your `chat_id`.
3. Post with `sendMessage`: `chat_id`, `text`, `parse_mode: "HTML"`, `link_preview_options: {is_disabled: true}`.
4. Escape `<`, `>` and `&` in all model and feed text; only the renderer emits tags.
5. Split at item boundaries if the text exceeds 4,096 characters.
6. Retry on HTTP 429 using the `retry_after` value; other errors fail the run (see Reliability).

## Scheduling, state, secrets and config

Host it on GitHub Actions in a private repo: free at this volume, no server, and state lives in the repo itself.

**Schedule**

- Cron is UTC. Use `47 6 * * *`: 07:47 Lisbon in summer (WEST), 06:47 in winter (WET). Off-the-hour minutes avoid GitHub's peak-load delays.
- Add `workflow_dispatch` with inputs `dry_run` and `since_hours` for manual runs.
- `concurrency` group so two runs never overlap; job timeout 10 minutes.

**State**

- `state/seen.json`: canonical URL hash to first-seen date, pruned after 45 days.
- `state/runs/YYYY-MM-DD.json`: every candidate with its sub-scores, flags and verdict. This is the audit trail for tuning the filter.
- The workflow commits `state/` back with a `[skip ci]` message, only after a successful send. Regular commits also keep the scheduled workflow from being auto-disabled for inactivity.

**Secrets** (repository secrets, never in config)

- `ANTHROPIC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

**Config files**

| File | Holds |
| --- | --- |
| `config.yaml` | Models, thresholds, max items (7), candidate cap (40), lookback hours (36), daily token budget, timezone |
| `sources.yaml` | The Sources table |
| `profile.md` | Reader profile and "already uses" list for the novelty check |
| `triage/examples.yaml` | Few-shot calibration examples |
| `triage/system-prompt.md` | Rubric and instructions, versioned so score changes can be traced to prompt changes |

**CLI**

- `digest run` (default), `--dry-run` prints the digest and writes nothing, `--source <id>` runs one source, `--since <hours>`, `--no-llm` runs heuristics only.
- `digest replay <date>` re-scores a stored run with the current prompt, to compare prompt versions.

**Cost guard.** Expect roughly 40 candidates at about 2k input tokens each per day on the small model. Enforce a hard daily token budget in config; when it is hit, score the remaining items by heuristics only and say so in the footer. Check current API pricing before setting the number.

## Reliability, security and observability

One broken source must never block the digest; a broken pipeline must always tell you.

**Failure handling**

- Each collector runs with a 20-second timeout and 2 retries; a failing source is skipped and named in the footer ("r/ClaudeCode unavailable").
- If the same source fails 3 runs in a row, the digest adds a one-line warning so the endpoint gets fixed.
- LLM errors: retry with backoff; if triage fails entirely, send a heuristics-only digest marked as such rather than nothing.
- Pipeline crash or Telegram send failure: the Actions run fails (GitHub emails you) and a best-effort plain-text alert goes to the same chat.
- HTML-index scrapers are the fragile part: each one asserts it found at least 1 article link; zero links counts as a failure, not a quiet day.

**Security**

- Feed and page content is untrusted input to the LLM (see Triage). The model gets no tools and no secrets; its output is validated against the schema and escaped before rendering.
- Only URLs that came from the feeds appear in the digest; the model can never add a link.
- Fetch with a fixed User-Agent naming the project, respect `robots.txt` for scraped pages, and fetch each page at most once per run.
- Pin GitHub Actions to commit SHAs; minimal `permissions:` (contents: write only).

**Observability**

- Structured JSON logs per stage: counts in and out, durations, tokens used.
- The per-run file in `state/runs/` is the main tuning tool: grep it to see what was dropped and why.
- Weekly (Sunday) footer line: items sent, average score, top sources by kept items.

## Acceptance criteria

- [ ] `--dry-run` on a fresh checkout prints a digest from live sources in under 3 minutes.
- [ ] Every source in `sources.yaml` is verified working, or disabled with a note on why.
- [ ] Running twice in a row sends nothing new the second time (dedup works).
- [ ] Same URL from HN and Simon Willison shows once, with both sources named.
- [ ] A source returning HTTP 500 is skipped and named in the footer; the digest still sends.
- [ ] Triage output that fails the schema is retried once, then dropped and logged.
- [ ] Unit tests cover each adapter's parser, URL canonicalization, dedup, score formula and HTML escaping, using recorded fixtures.
- [ ] The scheduled workflow sends to Telegram and commits `state/` on success only.

## Phase 2

- **Feedback loop:** inline buttons (useful / noise) on each item via a small webhook (Cloudflare Worker); labeled items feed `triage/examples.yaml` and per-source weights.
- **Weekly roundup:** Sunday message with the week's worth-a-skim items that never made a daily cut.
- **"Already adopted" memory:** when you mark an item as adopted, add it to `profile.md` so similar items lose novelty.
- **More sources:** an X/Twitter RSS bridge for a few accounts (Boris Cherny, Cat Wu), YouTube channel feeds.
- **Alternative triage runtime:** run triage through Claude Code headless (`claude -p`) in Actions instead of the API, if you want to reuse your own skills and settings.

## Open decisions

- [ ] TypeScript or Go?
- [ ] Delivery time: 07:47 Lisbon (summer) / 06:47 (winter) acceptable?
- [ ] Max items per digest: 7, or fewer?
- [ ] Second-pass rerank with the larger model: on or off?
- [x] Reddit: Arctic Shift archive API (unauthenticated JSON blocked, API access denied).

## Sources

- [Claude Code Handbook, "Who to Follow"](https://joeyyu23.github.io/claude-code-handbook/en/who-to-follow): basis for the official and practitioner source list.
- [Anthropic, Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Awesome Claude Code resources overview](https://www.fast.io/resources/awesome-claude-code-resources-2026.md): list rankings used for tier 3.
