// opencode-push — push notifications for OpenCode V2 (the `opencode2` beta
// with the object/setup plugin API). Fires a push when a MAIN agent session
// finishes its turn (or errors). Subagent (child) sessions are skipped by
// default so background explore/Task runs don't buzz your phone.
//
// Backends: "bark" (Apple APNs via api.day.app) or "ntfy" (self-hosted ntfy).
//
// Events (opencode2 beta-18999 event bus, verified live):
//   session.created              -> records parentID lineage (subagent marker)
//   session.execution.succeeded  -> "finished" push (turn complete)
//   session.execution.failed     -> "errored" push
//   session.error                -> legacy alias, same as failed
// Note: the old v1 names `session.idle` no longer exist on the V2 bus.
//
// Configuration precedence (highest first):
//   1. Plugin options (ctx.options, set via the `plugins` config tuple)
//   2. Environment variables
//   3. Config file (~/.config/opencode-push.json)
//   4. Built-in defaults
//
// Keys (same names in options, env vars, and the config file):
//   backend           : "bark" | "ntfy"        (env NOTIFY_BACKEND, default "bark")
//   bark_url          : https://api.day.app/<key>  (env BARK_URL)
//   ntfy_url          : e.g. http://gb10       (env NTFY_URL)
//   ntfy_topic        : topic name             (env NTFY_TOPIC, default "opencode")
//   host              : label in the title, e.g. mac / gb10  (env NOTIFY_HOST)
//   include_subagents : true to also push for subagent sessions (default false)
//
// Diagnostics: lifecycle and send results are appended to
// ~/.config/opencode-push.log (a few lines per turn; delete at will).

import { appendFileSync, readFileSync } from "node:fs"

type Backend = "bark" | "ntfy"

type Options = {
  backend?: Backend
  bark_url?: string
  ntfy_url?: string
  ntfy_topic?: string
  host?: string
  include_subagents?: boolean
}

const LOG_PATH = `${process.env.HOME}/.config/opencode-push.log`

function log(msg: string) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
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
    return JSON.parse(readFileSync(path, "utf8")) as Options
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log(`failed to read ${path}: ${err?.message || err}`)
    }
    return {}
  }
}

function projectName(directory: string | undefined): string {
  return String(directory || "").split("/").filter(Boolean).pop() || "opencode"
}

// One process, one active subscriber: every plugin instance (one per location)
// sees every event on the bus, and the server fans each event out multiple
// times (once per connected client). These global tables collapse that noise
// so exactly one push goes out per finished turn.
const STATE = Symbol.for("opencode-push.state")

type SessionMeta = { project?: string; title?: string; directory?: string }

const MAX_TRACKED = 500

function trimBounded<T>(map: Map<string, T>) {
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function sleepAbortable(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      signal.removeEventListener("abort", done)
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener("abort", done)
  })
}

const plugin = {
  id: "opencode-push",

  async setup(ctx: any, options: Options = {}) {
    const file = await loadConfigFile()
    const cfg = {
      backend: (first(options.backend, process.env.NOTIFY_BACKEND, file.backend) as Backend) || "bark",
      barkUrl: first(options.bark_url, process.env.BARK_URL, file.bark_url)?.replace(/\/+$/, ""),
      ntfyUrl: first(options.ntfy_url, process.env.NTFY_URL, file.ntfy_url)?.replace(/\/+$/, ""),
      ntfyTopic: first(options.ntfy_topic, process.env.NTFY_TOPIC, file.ntfy_topic) || "opencode",
      host: first(options.host, process.env.NOTIFY_HOST, file.host) || "",
      includeSubagents: options.include_subagents ?? file.include_subagents ?? false,
    }

    const here = projectName(ctx?.location?.directory || process.cwd())

    async function send(title: string, body: string, sid = "unknown") {
      const fullTitle = cfg.host ? `${title} · ${cfg.host}` : title
      try {
        if (cfg.backend === "bark") {
          if (!cfg.barkUrl) {
            log("BARK_URL not set; skipping notification")
            return
          }
          const res = await fetch(cfg.barkUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: fullTitle, body, group: "opencode" }),
          })
          log(`sent ${sid} "${fullTitle}" | ${body.replace(/\n/g, " / ")} -> ${res.status}`)
        } else if (cfg.backend === "ntfy") {
          if (!cfg.ntfyUrl) {
            log("NTFY_URL not set; skipping notification")
            return
          }
          const res = await fetch(`${cfg.ntfyUrl}/${cfg.ntfyTopic}`, {
            method: "POST",
            headers: { Title: fullTitle, Tags: "opencode" },
            body,
          })
          log(`sent ${sid} "${fullTitle}" | ${body.replace(/\n/g, " / ")} -> ${res.status}`)
        } else {
          log(`unknown backend "${cfg.backend}"; skipping notification`)
        }
      } catch (err: any) {
        log(`notification failed: ${err?.message || err}`)
      }
    }

    // Global claim + dedupe shared by every plugin instance in this process.
    const g = globalThis as any
    const state = (g[STATE] ??= {
      controller: null as AbortController | null,
      dedupe: new Map<string, number>(),
      subagents: new Set<string>(),
      meta: new Map<string, SessionMeta>(),
    })
    const { dedupe, subagents, meta } = state

    if (state.controller) {
      log(`setup skipped in ${here}: another instance already owns the event stream`)
      return
    }
    const controller = new AbortController()
    state.controller = controller
    log(`setup in ${here} (backend=${cfg.backend}, host=${cfg.host || "none"})`)

    const shouldNotify = (key: string): boolean => {
      const now = Date.now()
      const last = dedupe.get(key) || 0
      if (now - last < 2000) return false
      dedupe.set(key, now)
      trimBounded(dedupe)
      return true
    }

    const handle = async (ev: any) => {
      const type: string = ev?.type
      const data: any = ev?.properties ?? ev?.data ?? {}

      if (type === "session.created") {
        if (data?.sessionID) {
          if (data?.parentID) {
            subagents.add(data.sessionID)
            if (subagents.size > MAX_TRACKED) subagents.delete(subagents.values().next().value)
          }
          meta.set(data.sessionID, {
            project: projectName(data?.location?.directory),
            directory: typeof data?.location?.directory === "string" ? data.location.directory : undefined,
          })
          trimBounded(meta)
        }
        return
      }

      // Auto-titling lags the turn (session.renamed fires after the first
      // response), so track renames to keep the push informative.
      if (type === "session.renamed") {
        if (data?.sessionID && typeof data?.title === "string" && data.title.trim() !== "") {
          const m = meta.get(data.sessionID) ?? {}
          m.title = data.title
          meta.set(data.sessionID, m)
          trimBounded(meta)
        }
        return
      }

      const succeeded = type === "session.execution.succeeded" || type === "session.idle"
      const failed = type === "session.execution.failed" || type === "session.error"
      if (!succeeded && !failed) return

      const sid: string = data?.sessionID || "unknown"
      // failure events may arrive under both the v2 and legacy names; one push.
      const dedupeType = succeeded ? "finished" : "failed"
      if (!shouldNotify(`${dedupeType}:${sid}`)) return

      if (!cfg.includeSubagents && (subagents.has(sid) || data?.parentID)) {
        log(`skipped subagent session ${sid} (${type})`)
        return
      }
      log(`notify main session ${sid} (${dedupeType})`)

      let m = meta.get(sid)

      // Sessions created before we owned the stream (e.g. a long-running TUI
      // session) have no meta; fetch it from the server. This also catches
      // subagents whose session.created we missed.
      if (!m || (!m.title && !m.directory)) {
        try {
          const info = await ctx.session.get({ sessionID: sid })
          if (info?.parentID && !cfg.includeSubagents) {
            subagents.add(sid)
            log(`skipped subagent session ${sid} (${type}, via lookup)`)
            return
          }
          m = {
            project: projectName(info?.location?.directory) || m?.project,
            directory: typeof info?.location?.directory === "string" ? info.location.directory : m?.directory,
            title: typeof info?.title === "string" && info.title.trim() !== "" ? info.title : m?.title,
          }
          meta.set(sid, m)
          trimBounded(meta)
        } catch (err: any) {
          log(`session lookup failed for ${sid}: ${err?.message || err}`)
        }
      }

      // Title tells you WHERE at a glance; body has the session name and the
      // full directory (distinguishes worktree checkouts).
      const project = m?.project || here
      const name = m?.title ? `${m.title} — ` : ""
      let body = m?.directory ? `${name}${m.directory}` : `${name}${project}`
      if (failed) {
        const errText =
          typeof data?.error === "string"
            ? data.error
            : (data?.error?.message ?? data?.message)
        if (typeof errText === "string" && errText.trim() !== "") {
          body += `\n${errText.trim().slice(0, 300)}`
        }
      }
      if (succeeded) {
        await send(`opencode finished · ${project}`, body, sid)
      } else {
        await send(`opencode errored · ${project}`, body, sid)
      }
    }

    // Self-healing subscription: if the stream errors or ends while we are
    // still loaded, release the claim and resubscribe (the previous plugin's
    // fire-once claim is what silenced it permanently after an update).
    void (async () => {
      let backoff = 1000
      while (!controller.signal.aborted) {
        try {
          for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
            backoff = 1000
            try {
              await handle(ev)
            } catch (err: any) {
              log(`handler error: ${err?.message || err}`)
            }
          }
          break
        } catch (err: any) {
          if (controller.signal.aborted) break
          log(`event stream error: ${err?.message || err}; resubscribing in ${backoff}ms`)
          await sleepAbortable(backoff, controller.signal)
          backoff = Math.min(backoff * 2, 30000)
        }
      }
      if (state.controller === controller) state.controller = null
      if (!controller.signal.aborted) log("event stream ended")
    })()

    return () => {
      controller.abort()
      if (state.controller === controller) state.controller = null
      log(`cleanup in ${here}`)
    }
  },
}

export default plugin
