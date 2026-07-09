import type { Plugin } from "@opencode-ai/plugin"

// opencode-push: configurable push notifications for opencode.
// Fires on session.idle (a turn finished) and session.error.
// Backends: "bark" (Apple APNs via api.day.app) or "ntfy" (self-hosted ntfy.sh).
//
// Configuration (plugin options take precedence over env vars):
//   backend     : "bark" | "ntfy"   (env NOTIFY_BACKEND, default "bark")
//   bark_url    : e.g. https://api.day.app/<your-key>   (env BARK_URL)
//   ntfy_url    : e.g. http://gb10                     (env NTFY_URL)
//   ntfy_topic  : topic name                            (env NTFY_TOPIC, default "opencode")
//   host        : label appended to the title, e.g. mac / gb10  (env NOTIFY_HOST)

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

const plugin: Plugin = async ({ $, directory }, options: Options = {}) => {
  const backend = (first(options.backend, process.env.NOTIFY_BACKEND) as Backend) || "bark"
  const barkUrl = first(options.bark_url, process.env.BARK_URL)?.replace(/\/+$/, "")
  const ntfyUrl = first(options.ntfy_url, process.env.NTFY_URL)?.replace(/\/+$/, "")
  const ntfyTopic = first(options.ntfy_topic, process.env.NTFY_TOPIC) || "opencode"
  const host = first(options.host, process.env.NOTIFY_HOST) || ""
  const project = (directory || "").split("/").filter(Boolean).pop() || "opencode"

  async function send(title: string, body: string) {
    const fullTitle = host ? `${title} · ${host}` : title
    try {
      if (backend === "bark") {
        if (!barkUrl) {
          console.error("[opencode-push] BARK_URL not set; skipping notification")
          return
        }
        const url: string = barkUrl
        const payload = JSON.stringify({ title: fullTitle, body, group: "opencode" })
        await $`curl -s -m 10 -X POST -H "Content-Type: application/json" -d ${payload} ${url}`
      } else if (backend === "ntfy") {
        if (!ntfyUrl) {
          console.error("[opencode-push] NTFY_URL not set; skipping notification")
          return
        }
        const endpoint: string = `${ntfyUrl}/${ntfyTopic}`
        const titleHeader: string = `Title: ${fullTitle}`
        await $`curl -s -m 10 -H ${titleHeader} -H "Tags: opencode" -d ${body} ${endpoint}`
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
