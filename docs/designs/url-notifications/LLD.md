# URL Notifications - Low-Level Design

**Created**: 2026-09-06
**HLD Link**: ../../high-level-design.md

## Overview

Capture http(s) URLs from the agent's final reply when a main-session turn
ends, append them to the push body, and set the backend tap-through target
(Bark `url` field, ntfy `Click` header). Default-on; best-effort; never
blocks or drops the underlying notification.

## Verified API Surface

Checked live against the local opencode2 service (beta-18999). The setup-ctx
exposes neither the SDK client nor a messages accessor, so capture reads the
server's HTTP API directly:

- Setup ctx namespaces: `app, location, options, agent, aisdk, catalog,
  command, event, experimental, generate, integration, mcp, permission,
  plugin, reference, rpc, skill, storage, tool, vcs, websearch, session,
  shell`. `ctx.session` offers only hook/create/get/switch*/prompt/
  generate/command/synthetic/interrupt/rename/move/wait/context — no
  messages. The plugin event bus carries no message/part events
  (verified by enumerating a full turn).
- Discovery: `~/.local/state/opencode/service.json` (respects
  `XDG_STATE_HOME`) provides `{ url, password }` for the background
  service. API routes require HTTP Basic auth, username `opencode`,
  password from that file.
- Messages: `GET ${url}/api/session/{sessionID}/message?limit=8` returns
  `{ data: [...], cursor }`, newest first. Assistant rows carry
  `content: [{ type: "text" | "reasoning", text, ... }]`; the reply text
  is the `type: "text"` entries (reasoning entries skipped). `user` rows
  carry a flat `text` field.
- Defensive: legacy `{ info: { role }, parts: [{ type: "text" }] }` rows
  are also accepted; row order is resolved via `time.created` (newest
  assistant row wins), so any ordering change stays safe.

## Pipeline Integration

URL capture is a stage inside the existing `handle()` notify pipeline,
after the dedupe/subagent gates and meta lookup, before `send()`. It runs
for both succeeded and failed turns (a URL printed before a crash is still
useful). It reads messages only; it cannot create extra pushes.

```text
handle(ev): succeeded/failed, deduped, main session
  -> meta lookup (existing)
  -> urls = captureUrls(sid, cfg.maxUrls)        [NEW, best-effort]
       HTTP fetch via service.json auth (limit=8)
       -> newest assistant row -> text content entries
       -> regex extract -> trim trailing punctuation
       -> dedupe (first-seen order) -> cap at maxUrls
  -> body += "\n" + urls (display-truncated)
  -> tap  = first non-local URL, else first URL, else none
  -> send(title, body, sid, tap)
```

## Configuration

Same precedence as every other key: plugin options > env > config file >
defaults.

| Key | Env | Type | Default | Meaning |
| ---- | ---- | ---- | ---- | ---- |
| `include_urls` | `INCLUDE_URLS` | bool | `true` | Master switch for capture |
| `max_urls` | `MAX_URLS` | int | `3` | Max URLs per push (clamped 1-10) |

Bool env parsing accepts `1/true/yes/on` and `0/false/no/off`
(case-insensitive). `max_urls` is rounded and clamped to 1-10.

## Extraction Rules

```text
regex:  /https?:\/\/[^\s<>"'`(){}\[\]\\]*
         (?:\([^\s<>"'`(){}\[\]\\]*\)[^\s<>"'`(){}\[\]\\]*)*/gi
trim:   repeatedly strip one trailing char in  . , ; : ! ? space ' "
```

Parens are excluded from the core match; a parenthesized segment counts
as part of the URL only when it closes inside the URL (balanced), so
markdown links like `[text](http://a)` never gain a trailing `)` and
Wikipedia-style `.../Foo_(bar)` links survive intact.

- Scope: the newest assistant message that has visible text (the newest
  row can be tool-call-only), within the last 8 messages; text content
  entries joined with newlines.
- Dedupe by exact string; preserve first-seen order; cap at `max_urls`.
- Display truncation: a URL longer than 200 chars renders as its first 197
  chars plus `...`; the tap-through target always uses the full URL.
- Unbalanced-paren URLs (e.g. `.../Foo_(bar` with no closing paren) drop
  the paren segment; balanced ones survive.

## Tap-Through Selection

- Parse each URL with `new URL()`; a URL is "local" when its hostname is
  `localhost`, `127.0.0.1`, `::1`, or `[::1]` (phone-unreachable).
- `tap = first non-local URL`, else `urls[0]`, else undefined.
- Bark: JSON body gains `url: tap` only when tap exists. ntfy: request
  gains `Click: tap` header only when tap exists.
- Bark field per official API V2 docs (`url`: "Url that will jump when
  click notification"). ntfy `Click` header: verify delivery live.

## Notification Format

```text
opencode finished · myproject · mac      <- title (unchanged)
Session title — /Users/ericmjl/github/myproject
http://100.101.102.103:4173/             <- NEW: captured URLs, one per line
https://github.com/owner/repo/pull/42
```

Order in the body: directory/title line (existing), error text for failed
turns (existing), then captured URLs.

## Error Handling

| Condition | Behavior |
| ---- | ---- |
| `service.json` missing / unreadable | Log; push without URLs |
| messages HTTP fetch fails (non-2xx, network, >3s) | Log; push without URLs |
| No rows yet or no assistant row yet | Retry once after 250 ms, then give up |
| No assistant row with text content | Push without URLs |
| Unparseable URL (bare scheme, bad host) | Dropped by the validity check |
| Capture code path throws unexpectedly | Outer try/catch logs; push proceeds |

## Edge Cases

- **Subagent sessions**: gated upstream by the existing subagent skip, so
  no capture (and no push) happens for them.
- **Race at turn end**: `execution.succeeded` should imply persisted
  messages; the single 250 ms retry covers a persist lag.
- **Multiple identical URLs**: collapsed by dedupe.
- **Very long URLs**: display-truncated at 200 chars; tap target is full.

## Testing Strategy

The repo is a single-file plugin with no test framework; the "tests" tier
of the intent chain is a verification protocol plus `@spec` annotations:

1. Module loads: `bun -e "import('./index.ts')"` succeeds.
2. Live turn: run a one-shot opencode2 session whose reply contains a URL;
   assert the log line `captured N url(s)` lists them and the push fires.
3. Tap-through: manual - tap the Bark notification on the iPhone and
   confirm the URL opens.

## Dependencies

- opencode2 background service HTTP API (`/api/session/{id}/message`) with
  discovery + credentials from `service.json` — no new package deps.
- Bark server API V2 `url` field (verified, see HLD Decision 4).
- ntfy `Click` header (verify live during implementation).

## Related Documents

- [High-Level Design](../../high-level-design.md)
- [URL Capture EARS](./url-capture-EARS.md)
