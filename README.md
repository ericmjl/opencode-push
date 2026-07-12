# opencode-push

A configurable push-notification plugin for [opencode](https://opencode.ai).
Get a push on your phone when opencode finishes a turn (or errors out).
Works from any machine opencode runs on.

Two backends:

- **Bark** (default) pushes via Apple APNs through `api.day.app`, so it reaches
  an iPhone instantly from anywhere (no self-hosting, no Tailscale needed).
- **ntfy** pushes to a self-hosted [ntfy.sh](https://ntfy.sh) server.

## What triggers a notification

The plugin listens to opencode's event bus:

- `session.idle` (a turn finished, opencode is waiting for input) -> "finished"
- `session.error` (the session errored) -> "errored"

## Install

### From source (local)

```bash
git clone https://github.com/ericmjl/opencode-push ~/github/opencode-push
mkdir -p ~/.config/opencode/plugins
ln -s ~/github/opencode-push/index.ts ~/.config/opencode/plugins/opencode-push.ts
```

opencode auto-loads `*.ts` files from `~/.config/opencode/plugins/` at startup, so
restart opencode after linking. The repo stays the source of truth via the symlink.

### From npm (once published)

Add to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-push"]
}
```

## Configure

Configuration is read with the following precedence (highest first):

1. **Plugin options** (npm install, via the config `plugin` tuple)
2. **Environment variables** (`BARK_URL`, `NTFY_URL`, `NTFY_TOPIC`,
   `NOTIFY_BACKEND`, `NOTIFY_HOST`)
3. **Config file** (`~/.config/opencode-push.json`)
4. Built-in defaults

All three sources use the same key names: `backend`, `bark_url`, `ntfy_url`,
`ntfy_topic`, `host`.

### Config file (recommended)

Create `~/.config/opencode-push.json`:

```json
{
  "backend": "bark",
  "bark_url": "https://api.day.app/<your-key>",
  "host": "mac"
}
```

The config file is the recommended way to configure the plugin:

- It keeps secrets (your Bark key) out of the shell environment.
- It works under **any launcher**. opencode invocations from a TUI, from a
  scheduler such as [opencode-scheduler](https://github.com/ericmjl/opencode-scheduler)
  (launchd/systemd), or from a GUI app all read the same file, because the
  plugin opens it itself at load time. Env vars in a shell rc are not seen by
  non-shell launchers.

See `config.example.json` for a template.

### Environment variables

Env vars override the config file, which is useful for CI or one-off overrides:

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

### Plugin options (npm install only)

```json
{
  "plugin": [
    ["opencode-push", {
      "backend": "bark",
      "bark_url": "https://api.day.app/<your-key>",
      "host": "mac"
    }]
  ]
}
```

The same keys exist for ntfy: `ntfy_url`, `ntfy_topic`.

## Per-machine setup

The same `bark_url` (Bark key) is used on every machine, because they all push
to the same phone. Set `host` differently per machine (`mac`, `gb10`) so the
notification tells you which one finished. Each machine has its own config file
(`~/.config/opencode-push.json`) for that.

## Notes

- Bark is recommended for iOS: it uses APNs, so pushes arrive on cell data or
  WiFi without the phone being on any particular network.
- ntfy is useful if you want everything self-hosted; for iOS instant delivery
  from a self-hosted ntfy server, configure ntfy's `upstream-base-url`.
- The plugin has no runtime dependencies (only a type-only import from
  `@opencode-ai/plugin`), so the from-source single-file install needs no
  `bun install`.

## License

MIT
