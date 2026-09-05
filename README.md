# opencode-push

A configurable push-notification plugin for [OpenCode](https://opencode.ai) V2
(the `opencode2` beta with the object/`setup` plugin API). Get a push on your
phone when a **main agent session** finishes its turn (or errors out) —
subagent runs are skipped by default so background explore/Task work doesn't
buzz you.

Two backends:

- **Bark** (default) pushes via Apple APNs through `api.day.app`, so it reaches
  an iPhone instantly from anywhere (no self-hosting, no Tailscale needed).
- **ntfy** pushes to a self-hosted [ntfy.sh](https://ntfy.sh) server.

## What triggers a notification

The plugin subscribes to the opencode2 event bus via `ctx.event.subscribe()`:

- `session.execution.succeeded` -> "finished" push (a turn completed)
- `session.execution.failed` (and legacy `session.error`) -> "errored" push
- `session.created` -> records `parentID` lineage, used to skip subagent
  sessions (any session with a parent is a subagent run)

Notes from live testing on `opencode2 v0.0.0-beta-18999`:

- The old v1 event `session.idle` **no longer exists** on the V2 bus. If your
  notification plugin went silent after an update, this is probably why.
- The bus fans each event out once per connected client, and one plugin
  instance is loaded per location, so the plugin deduplicates sends per
  `(event, session)` within a 2s window and only lets one instance per process
  own the stream.
- The subscription self-heals: if the stream errors or ends, the plugin logs it
  and resubscribes with backoff instead of going silent forever.

## Install (OpenCode V2)

Copy the single file into the global plugins directory — no config entry, no
dependencies:

```bash
git clone https://github.com/ericmjl/opencode-push ~/github/opencode-push
cp ~/github/opencode-push/index.ts ~/.config/opencode/plugins/opencode-push.ts
```

The repo stays the source of truth; re-copy after pulling updates. Restart
opencode (or just start a new session — the plugin watcher hot-reloads file
changes) after installing.

> Install as `.ts`. A `.js` copy is parsed as plain JavaScript and the
> TypeScript annotations will fail to build.

> This build targets the V2 plugin API only. V1 (`opencode` 1.x) plugins use a
> different contract and won't load on `opencode2`; see the
> [migration guide](https://opencode.ai/v2/docs/migrate-v1).

## Configure

Configuration is read with the following precedence (highest first):

1. **Plugin options** (`ctx.options`, via the `plugins` config tuple)
2. **Environment variables** (`BARK_URL`, `NTFY_URL`, `NTFY_TOPIC`,
   `NOTIFY_BACKEND`, `NOTIFY_HOST`)
3. **Config file** (`~/.config/opencode-push.json`)
4. Built-in defaults

All sources use the same key names: `backend`, `bark_url`, `ntfy_url`,
`ntfy_topic`, `host`, `include_subagents`.

### Config file (recommended)

Create `~/.config/opencode-push.json` (mode 600):

```json
{
  "backend": "bark",
  "bark_url": "https://api.day.app/<your-key>",
  "host": "mac",
  "include_subagents": false
}
```

The config file keeps secrets (your Bark key) out of the shell environment and
works under any launcher — TUI, scheduler, GUI — because the plugin reads it
itself at setup. Env vars in a shell rc are only seen by processes launched
from that shell; the opencode2 background service may or may not inherit them.

`include_subagents` (default `false`) also pushes for subagent sessions when
set to `true`.

### Environment variables

Env vars override the config file:

```bash
export BARK_URL="https://api.day.app/<your-key>"   # from the Bark iOS app
export NOTIFY_HOST="mac"                            # optional label per machine
```

`NOTIFY_BACKEND` defaults to `bark`.

ntfy:

```bash
export NOTIFY_BACKEND="ntfy"
export NTFY_URL="http://gb10"      # your ntfy server, no trailing slash
export NTFY_TOPIC="opencode"       # default: opencode
export NOTIFY_HOST="gb10"          # optional
```

### Plugin options

```json
{
  "plugins": [
    {
      "package": "opencode-push",
      "options": { "backend": "bark", "host": "mac" }
    }
  ]
}
```

## Diagnostics

The plugin appends a few lines per turn to `~/.config/opencode-push.log`:
setup/claim decisions, each send with its HTTP status, skipped subagent
sessions, and stream errors. If pushes ever go quiet again, read that file
first.

## Per-machine setup

The same `bark_url` (Bark key) is used on every machine, because they all push
to the same phone. Set `host` differently per machine (`mac`, `gb10`) so the
notification tells you which one finished. Each machine has its own config
file (`~/.config/opencode-push.json`) for that.

## Notes

- Bark is recommended for iOS: it uses APNs, so pushes arrive on cell data or
  WiFi without the phone being on any particular network.
- ntfy is useful if you want everything self-hosted; for iOS instant delivery
  from a self-hosted ntfy server, configure ntfy's `upstream-base-url`.
- The plugin has no runtime dependencies (it uses `node:fs` and native
  `fetch`), so the single-file install needs no `bun install`.

## License

MIT
