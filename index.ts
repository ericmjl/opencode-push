import type { Plugin } from "@opencode-ai/plugin"

// opencode-push: configurable push notifications for opencode.
// Fires on session.idle (a turn finished) and session.error.
// Backends: "bark" (Apple APNs via api.day.app) or "ntfy" (self-hosted ntfy.sh).
//
// Configuration precedence (highest first):
//   1. Plugin options (npm install: ["opencode-push", {...}])
//   2. Environment variables (see below)
//   3. Config file (~/.config/opencode-push.json)
//   4. Built-in defaults
//
// Keys (same names in plugin options, env vars, and the config file):
//   backend     : "bark" | "ntfy"   (env NOTIFY_BACKEND, default "bark")
//   bark_url    : e.g. https://api.day.app/<your-key>   (env BARK_URL)
//   ntfy_url    : e.g. http://gb10                     (env NTFY_URL)
//   ntfy_topic  : topic name                            (env NTFY_TOPIC, default "opencode")
//   host        : label appended to the title, e.g. mac / gb10  (env NOTIFY_HOST)
//
// The config file is the recommended way to keep secrets out of the shell
// environment and to make the plugin work under any launcher (TUI, launchd,
// GUI), since the plugin reads the file itself at load time.

type Backend = "bark" | "ntfy"

type Options = {
  backend?: Backend
  bark_url?: string
  ntfy_url?: string
  ntfy_topic?: string
  host?: string
}

function first(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim()
  }
  return undefined
}

async function loadConfigFile(): Promise<Options> {
  const path = `${process.env.HOME}/.config/opencode-push.json`
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return {}
    return (await file.json()) as Options
  } catch (err) {
    console.error(`[opencode-push] failed to read ${path}:`, err)
    return {}
  }
}

const plugin: Plugin = async ({ directory }, options: Options = {}) => {
  const cfg = await loadConfigFile()
  const backend = (first(options.backend, process.env.NOTIFY_BACKEND, cfg.backend) as Backend) || "bark"
  const barkUrl = first(options.bark_url, process.env.BARK_URL, cfg.bark_url)?.replace(/\/+$/, "")
  const ntfyUrl = first(options.ntfy_url, process.env.NTFY_URL, cfg.ntfy_url)?.replace(/\/+$/, "")
  const ntfyTopic = first(options.ntfy_topic, process.env.NTFY_TOPIC, cfg.ntfy_topic) || "opencode"
  const host = first(options.host, process.env.NOTIFY_HOST, cfg.host) || ""
  const project = (directory || "").split("/").filter(Boolean).pop() || "opencode"

  async function send(title: string, body: string) {
    const fullTitle = host ? `${title} · ${host}` : title
    try {
      if (backend === "bark") {
        if (!barkUrl) {
          console.error("[opencode-push] BARK_URL not set; skipping notification")
          return
        }
        await fetch(barkUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: fullTitle, body, group: "opencode" }),
        })
      } else if (backend === "ntfy") {
        if (!ntfyUrl) {
          console.error("[opencode-push] NTFY_URL not set; skipping notification")
          return
        }
        await fetch(`${ntfyUrl}/${ntfyTopic}`, {
          method: "POST",
          headers: { Title: fullTitle, Tags: "opencode" },
          body,
        })
      }
    } catch (err) {
      console.error("[opencode-push] notification failed:", err)
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await send("opencode finished", `Turn complete in ${project}`)
      } else if (event.type === "session.error") {
        await send("opencode errored", `Session error in ${project}`)
      }
    },
  }
}

export default plugin
