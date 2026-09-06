// opencode-push — push notifications for OpenCode V2 (the `opencode2` beta
// with the object/setup plugin API). Fires a push when a MAIN agent session
// finishes its turn (or errors). Subagent (child) sessions are skipped by
// default so background explore/Task runs don't buzz your phone.
//
// URL capture: when a turn ends, the agent's final reply is scanned for
// http(s) URLs (dev-server URLs on a Tailscale IP, GitHub PRs, ...). They
// ride along in the push body, and the Bark/ntfy tap-through opens the
// first non-local one. Best-effort: if messages can't be fetched, the push
// still goes out, just without URLs.
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
//   include_urls      : capture URLs from the final reply (default true)
//                       (env INCLUDE_URLS)
//   max_urls          : max URLs per push, clamped 1-10 (default 3)
//                       (env MAX_URLS)
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
  include_urls?: boolean
  max_urls?: number
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

function toBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    if (["1", "true", "yes", "on"].includes(s)) return true
    if (["0", "false", "no", "off"].includes(s)) return false
  }
  return undefined
}

function toInt(v: unknown, lo: number, hi: number): number | undefined {
  if (typeof v === "string" && v.trim() === "") return undefined
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  if (!Number.isFinite(n)) return undefined
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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

// --- URL capture (see docs/designs/url-notifications/) ---------------------

// Balanced-paren http(s) URLs: parens are excluded from the core match, and
// a parenthesized segment counts as part of the URL only when it closes
// inside the URL, so markdown links like [text](http://a) don't gain a
// trailing ")" and Wikipedia-style .../Foo_(bar) links survive intact.
// The first core segment requires 1+ chars, so a bare "http://" never
// matches.
// @spec URL-EXT-001, URL-EXT-003
const URL_RE =
  /https?:\/\/[^\s<>"'`(){}\[\]\\]+(?:\([^\s<>"'`(){}\[\]\\]*\)[^\s<>"'`(){}\[\]\\]*)*/gi
const URL_DISPLAY_MAX = 200

// Guards the tap-target pool: anything `new URL()` rejects (bare scheme,
// malformed host) is display-worthy noise but never a link.
function isParseableUrl(u: string): boolean {
  try {
    new URL(u)
    return true
  } catch {
    return false
  }
}

// @spec URL-EXT-002
function cleanUrl(raw: string): string {
  let u = raw
  for (;;) {
    const last = u[u.length - 1]
    if (last && ".,;:!? '\"".includes(last)) {
      u = u.slice(0, -1)
      continue
    }
    break
  }
  return u
}

function isLocalUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase()
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]"
  } catch {
    return false
  }
}

// @spec URL-PRS-002, URL-PRS-003
function pickTapTarget(urls: string[]): string | undefined {
  return urls.find((u) => !isLocalUrl(u)) ?? urls[0]
}

function displayUrl(u: string): string {
  return u.length > URL_DISPLAY_MAX ? `${u.slice(0, URL_DISPLAY_MAX - 3)}...` : u
}

// The setup-ctx has no messages accessor and the plugin bus carries no
// message events, so capture reads the server's HTTP API directly:
//   1. discovery: `${state}/opencode/service.json` -> { url, password }
//   2. GET `${url}/api/session/${sid}/message?limit=8` (Basic auth,
//      username "opencode"; verified live on beta-18999)
// The response is { data: [...] }, NEWEST FIRST; assistant rows carry a
// content[] of { type: "text" | "reasoning", ... } entries. Legacy
// { info, parts } rows are accepted defensively for forward compatibility.
// @spec URL-TRG-001, URL-FAIL-001, URL-FAIL-002, URL-FAIL-003, URL-FAIL-004
type ServiceInfo = { url?: string; password?: string }

function loadServiceInfo(): ServiceInfo {
  const base = process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`
  try {
    return JSON.parse(readFileSync(`${base}/opencode/service.json`, "utf8")) as ServiceInfo
  } catch (err: any) {
    log(`url capture: service.json unreadable: ${err?.message || err}`)
    return {}
  }
}

// Reply text of one message row, across the live v2 shape (content[] with
// "text"/"reasoning" entries, flat user "text") and the legacy {parts} shape.
function rowText(row: any): string | undefined {
  const contentText = (Array.isArray(row?.content) ? row.content : [])
    .filter((c: any) => c?.type === "text" && typeof c?.text === "string")
    .map((c: any) => c.text)
    .join("\n")
  if (contentText.trim() !== "") return contentText
  if (typeof row?.text === "string" && row.text.trim() !== "") return row.text
  const partsText = (Array.isArray(row?.parts) ? row.parts : [])
    .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("\n")
  if (partsText.trim() !== "") return partsText
  return undefined
}

async function lastAssistantText(sid: string): Promise<string | undefined> {
  const svc = loadServiceInfo()
  if (!svc.url || typeof svc.url !== "string") return undefined
  const base = svc.url.replace(/\/+$/, "")
  const auth = `Basic ${Buffer.from(`opencode:${svc.password ?? ""}`).toString("base64")}`
  for (let attempt = 1; attempt <= 2; attempt++) {
    let rows: any[]
    try {
      // Time-boxed so a hung service can never stall the notify pipeline.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 3000)
      let res: Response
      try {
        res = await fetch(`${base}/api/session/${sid}/message?limit=8`, {
          headers: { Authorization: auth, Accept: "application/json" },
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body: any = await res.json()
      rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
    } catch (err: any) {
      log(`url capture: messages fetch failed: ${err?.message || err}`)
      return undefined
    }
    // Order-independent: newest assistant messages first by creation time.
    const assistants = rows
      .filter((r: any) => r?.type === "assistant" || r?.info?.role === "assistant")
      .sort(
        (a: any, b: any) =>
          (b?.time?.created ?? b?.info?.time?.created ?? 0) -
          (a?.time?.created ?? a?.info?.time?.created ?? 0),
      )
    // Newest assistant row that actually has visible text (the newest row
    // alone can be tool-call-only or aborted).
    let text: string | undefined
    for (const row of assistants) {
      text = rowText(row)
      if (text) break
    }
    // Nothing usable yet: rows (or the assistant row) may not be persisted
    // right at turn end -> one short retry.
    if (text || attempt === 2) return text
    await wait(250)
  }
  return undefined
}

// @spec URL-EXT-001, URL-EXT-002, URL-EXT-004, URL-EXT-005
async function captureUrls(sid: string, max: number): Promise<string[]> {
  const text = await lastAssistantText(sid)
  if (!text) return []
  const urls: string[] = []
  for (const m of text.matchAll(URL_RE)) {
    const u = cleanUrl(m[0])
    if (u && isParseableUrl(u) && !urls.includes(u)) urls.push(u)
    if (urls.length >= max) break
  }
  return urls
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
      // @spec URL-CFG-001, URL-CFG-002
      includeUrls:
        toBool(options.include_urls) ??
        toBool(process.env.INCLUDE_URLS) ??
        toBool(file.include_urls) ??
        true,
      maxUrls:
        toInt(options.max_urls, 1, 10) ??
        toInt(process.env.MAX_URLS, 1, 10) ??
        toInt(file.max_urls, 1, 10) ??
        3,
    }

    const here = projectName(ctx?.location?.directory || process.cwd())

    // @spec URL-PRS-002, URL-PRS-003, URL-PRS-004
    async function send(title: string, body: string, sid = "unknown", tapUrl?: string) {
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
            // Bark's `url` field = "Url that will jump when click
            // notification" (official API_V2 docs).
            body: JSON.stringify({
              title: fullTitle,
              body,
              group: "opencode",
              ...(tapUrl ? { url: tapUrl } : {}),
            }),
          })
          log(`sent ${sid} "${fullTitle}" | ${body.replace(/\n/g, " / ")} -> ${res.status}`)
        } else if (cfg.backend === "ntfy") {
          if (!cfg.ntfyUrl) {
            log("NTFY_URL not set; skipping notification")
            return
          }
          const res = await fetch(`${cfg.ntfyUrl}/${cfg.ntfyTopic}`, {
            method: "POST",
            headers: {
              Title: fullTitle,
              Tags: "opencode",
              // Header values must stay byte-safe: percent-encode anything
              // non-ASCII (raw unicode URLs) so the push isn't dropped.
              ...(tapUrl ? { Click: encodeURI(tapUrl) } : {}),
            },
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
    log(
      `setup in ${here} (backend=${cfg.backend}, host=${cfg.host || "none"}, ` +
        `urls=${cfg.includeUrls ? cfg.maxUrls : "off"})`,
    )

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

      // @spec URL-TRG-001, URL-TRG-003 — runs after the dedupe/subagent
      // gates; reads messages only, never sends its own push.
      let urls: string[] = []
      if (cfg.includeUrls) {
        try {
          urls = await captureUrls(sid, cfg.maxUrls)
        } catch (err: any) {
          log(`url capture failed: ${err?.message || err}`)
        }
      }
      const tap = pickTapTarget(urls)
      if (urls.length > 0) {
        log(`captured ${urls.length} url(s) for ${sid}; tap=${tap}`)
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
      // @spec URL-PRS-001
      if (urls.length > 0) {
        body += `\n${urls.map(displayUrl).join("\n")}`
      }
      if (succeeded) {
        await send(`opencode finished · ${project}`, body, sid, tap)
      } else {
        await send(`opencode errored · ${project}`, body, sid, tap)
      }
      // Re-arm the dedupe window after the full pipeline: capture + send
      // take time, and legacy-alias events arriving just behind (failed
      // fires as both v2 and legacy names) must stay suppressed.
      dedupe.set(`${dedupeType}:${sid}`, Date.now())
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
