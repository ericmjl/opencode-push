# opencode-push - High-Level Design

**Created**: 2026-09-06

## Problem Statement

Long agent turns mean the user walks away from the machine and only learns a
turn finished (or failed) when they come back. opencode-push solves the "tell
me when it's done" half: the plugin subscribes to the opencode2 event bus and
pushes via Bark (iOS/APNs) or ntfy when a main session's turn succeeds or
errors.

The missing half is *actability*. A finished turn often ends with something
the user wants to open immediately:

- a local dev/preview server the agent just started, reachable from the phone
  via the machine's Tailscale IP (e.g. `http://100.x.y.z:4173/`);
- a GitHub pull request the agent just opened.

Today those URLs die inside the TUI transcript. The push should carry them,
and tapping the push on iOS should open the URL.

## Goals

1. **Turn-completion pushes** - (existing, keep) push on main-session turn
   success/failure; subagent sessions skipped by default.
2. **URL capture by default** - when the agent's reply contains http(s)
   URLs, they appear in the push body. No per-session flag to flip.
3. **Tap-through on iOS** - tapping the Bark notification opens the best
   URL; ntfy gets the equivalent click URL.
4. **Zero agent cooperation** - capture is deterministic and plugin-side;
   it must not depend on the model remembering to call a tool.
5. **Backend parity** - URL behavior works on both bark and ntfy, degrading
   gracefully where a backend lacks a feature.
6. **Same ops profile** - single file, no new runtime dependencies, config
   precedence and log diagnostics unchanged.

## Non-Goals

- **Mid-turn pushes** - pushing a URL before the turn ends (e.g. "server is
  up" while the turn continues). Revisit later via a plugin-registered tool
  (the v2 API supports `Hooks.tool`).
- **URL rewriting** - mapping `localhost` to a Tailscale IP or public host.
- **Intent detection** - deciding whether the user *asked for* a URL. v1
  treats any URL in the final reply as push-worthy.
- **Notification action buttons** - ntfy `Actions` buttons, Bark multi-
  action menus.

## Target Users

- **Eric**, the only user today: drives several machines (mac, gb10) from an
  iPhone; Bark for APNs delivery anywhere, ntfy for LAN-only boxes. Values
  notifications that are glanceable *and* actionable.

## Architecture Overview

The plugin stays a single-file, dependency-free opencode2 plugin. URL
capture is a new stage inside the existing notify pipeline, not a new
surface:

```text
opencode2 event bus (ctx.event.subscribe)
  session.created  -> lineage (skip subagents)
  session.renamed  -> auto-title tracking
  session.execution.succeeded / failed
        |
        v
notify pipeline (deduped per session+event)
  1. session meta lookup (project, directory, title)
  2. URL capture (NEW):
       fetch messages via server HTTP API (service.json auth)
       -> newest assistant message with visible text
       -> extract http(s) URLs -> dedupe -> cap
  3. compose title + body (+ URL lines)
        |
        v
backend send
  bark: { title, body, group, url }        # url = tap-through
  ntfy: { Title, Tags } + Click header     # Click = tap-through
```

## Key Design Decisions

### Decision 1: Passive capture at turn end, not an agent-callable tool

**Choice**: extract URLs from the agent's final reply at
`session.execution.succeeded` time.

**Rationale**: when the user asks for a URL (dev server, PR link), that URL
is always present in the agent's final reply — it is how the user receives
it in the TUI. Passive extraction therefore covers the stated use cases
deterministically. A tool shifts the burden to the model (it must remember
to call it), adds prompt/tool-registration surface, and fails silently.

**Alternatives considered**:

- Agent-callable tool (`notify(url=...)`): nondeterministic; works in demos,
  silently skipped in practice; redundant with the reply content.
- Prompt convention (agent writes a `notify-url:` marker line): same
  discipline problem, plus cross-model fragility.

### Decision 2: URLs come from the agent's final reply

**Choice**: fetch the turn's last assistant message from the opencode
server's HTTP API (endpoint and credentials discovered from the local
`service.json`) and scan its text for http(s) URLs.

**Rationale**: the final reply is what the user reads; tool output is noisy
(error traces, dependency listings). The beta's setup-ctx exposes no
messages accessor, so the plugin talks HTTP directly, time-boxed, with
log-and-degrade fallback: if the fetch fails, the push still goes out,
just without URLs.

### Decision 3: Tap-through target = first non-local URL; all URLs in body

**Choice**: every extracted URL appears in the push body (capped); the
tap-through field gets the first URL that is not localhost/127.0.0.1.

**Rationale**: `localhost` links are dead on a phone; the Tailscale IP URL
is the one worth tapping. Keeping all URLs in the body preserves the full
information even where tap-through fails.

### Decision 4: Backend tap-through fields

**Choice**: Bark gets a `url` JSON field; ntfy gets a `Click` header.

**Rationale**: Bark's official server API documents `url` as "Url that
will jump when click notification" — additive to the JSON the plugin
already POSTs. Source: `docs/API_V2.md` in the Finb/bark-server repo:
<https://github.com/Finb/bark-server/blob/master/docs/API_V2.md>
ntfy's `Click` header is the equivalent; verified live during
implementation.

### Decision 5: Default-on, config-shaped

**Choice**: `include_urls` (default `true`), `max_urls` (default `3`), same
config precedence as every other key (options > env > file > defaults).

**Rationale**: the user wants this always, not per session. A cap keeps
notifications glanceable.

## Risks and Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Beta API drift on message fetch | Defensive typing; degrade to no URLs |
| URL noise in the body | Scope to final reply; `max_urls` cap |
| localhost tap useless on phone | Prefer non-local URL for tap-through |
| Oversized notifications | Cap URLs; keep error-text truncation |
| Dedupe/single-push regression | Capture only reads; send path unchanged |

## Related Designs

- [URL Notifications LLD](./designs/url-notifications/LLD.md)
