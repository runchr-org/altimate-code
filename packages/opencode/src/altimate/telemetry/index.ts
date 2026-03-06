import { Control } from "@/control"
import { Config } from "@/config/config"
import { Installation } from "@/installation"
import { Log } from "@/util/log"

const log = Log.create({ service: "telemetry" })

export namespace Telemetry {
  const FLUSH_INTERVAL_MS = 5_000
  const MAX_BUFFER_SIZE = 200
  const REQUEST_TIMEOUT_MS = 10_000

  export type TokensPayload = {
    input: number
    output: number
    reasoning: number
    cache_read: number
    cache_write: number
  }

  export type Event =
    | {
        type: "session_start"
        timestamp: number
        session_id: string
        model_id: string
        provider_id: string
        agent: string
        project_id: string
      }
    | {
        type: "session_end"
        timestamp: number
        session_id: string
        total_cost: number
        total_tokens: number
        tool_call_count: number
        duration_ms: number
      }
    | {
        type: "generation"
        timestamp: number
        session_id: string
        message_id: string
        model_id: string
        provider_id: string
        agent: string
        finish_reason: string
        tokens: TokensPayload
        cost: number
        duration_ms: number
      }
    | {
        type: "tool_call"
        timestamp: number
        session_id: string
        message_id: string
        tool_name: string
        tool_type: "standard" | "mcp"
        status: "success" | "error"
        duration_ms: number
        error?: string
      }
    | {
        type: "bridge_call"
        timestamp: number
        session_id: string
        method: string
        status: "success" | "error"
        duration_ms: number
        error?: string
      }
    | {
        type: "error"
        timestamp: number
        session_id: string
        error_name: string
        error_message: string
        context: string
      }
    | {
        type: "command"
        timestamp: number
        session_id: string
        command_name: string
        command_source: "command" | "mcp" | "skill" | "unknown"
        message_id: string
      }
    | {
        type: "context_overflow_recovered"
        timestamp: number
        session_id: string
        model_id: string
        provider_id: string
        tokens_used: number
      }
    | {
        type: "compaction_triggered"
        timestamp: number
        session_id: string
        trigger: "overflow_detection" | "error_recovery"
        attempt: number
      }
    | {
        type: "tool_outputs_pruned"
        timestamp: number
        session_id: string
        count: number
        tokens_pruned: number
      }

  type AppInsightsConfig = {
    iKey: string
    endpoint: string // e.g. https://xxx.applicationinsights.azure.com/v2/track
  }

  let enabled = false
  let buffer: Event[] = []
  let flushTimer: ReturnType<typeof setInterval> | undefined
  let userEmail = ""
  let sessionId = ""
  let projectId = ""
  let appInsights: AppInsightsConfig | undefined

  function parseConnectionString(cs: string): AppInsightsConfig | undefined {
    const parts: Record<string, string> = {}
    for (const segment of cs.split(";")) {
      const idx = segment.indexOf("=")
      if (idx === -1) continue
      parts[segment.slice(0, idx).trim()] = segment.slice(idx + 1).trim()
    }
    const iKey = parts["InstrumentationKey"]
    const ingestionEndpoint = parts["IngestionEndpoint"]
    if (!iKey || !ingestionEndpoint) return undefined
    const base = ingestionEndpoint.endsWith("/") ? ingestionEndpoint : ingestionEndpoint + "/"
    return { iKey, endpoint: `${base}v2/track` }
  }

  function toAppInsightsEnvelopes(events: Event[], cfg: AppInsightsConfig): object[] {
    return events.map((event) => {
      const { type, timestamp, ...fields } = event as any
      const sid: string = fields.session_id ?? sessionId

      const properties: Record<string, string> = {
        cli_version: Installation.VERSION,
        project_id: fields.project_id ?? projectId,
      }
      const measurements: Record<string, number> = {}

      // Flatten all fields — nested `tokens` object gets prefixed keys
      for (const [k, v] of Object.entries(fields)) {
        if (k === "session_id" || k === "project_id") continue
        if (k === "tokens" && typeof v === "object" && v !== null) {
          for (const [tk, tv] of Object.entries(v as Record<string, unknown>)) {
            if (typeof tv === "number") measurements[`tokens_${tk}`] = tv
          }
        } else if (typeof v === "number") {
          measurements[k] = v
        } else if (v !== undefined && v !== null) {
          properties[k] = typeof v === "object" ? JSON.stringify(v) : String(v)
        }
      }

      return {
        name: `Microsoft.ApplicationInsights.${cfg.iKey}.Event`,
        time: new Date(timestamp).toISOString(),
        iKey: cfg.iKey,
        tags: {
          "ai.session.id": sid,
          "ai.user.id": userEmail,
          "ai.cloud.role": "altimate-code",
          "ai.application.ver": Installation.VERSION,
        },
        data: {
          baseType: "EventData",
          baseData: {
            ver: 2,
            name: type,
            properties,
            measurements,
          },
        },
      }
    })
  }

  // Instrumentation key is intentionally public — safe to hardcode in client-side tooling.
  // Override with APPLICATIONINSIGHTS_CONNECTION_STRING env var for local dev / testing.
  const DEFAULT_CONNECTION_STRING =
    "InstrumentationKey=5095f5e6-477e-4262-b7ae-2118de18550d;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=6564474f-329b-4b7d-849e-e70cb4181294"

  export async function init() {
    if (enabled || flushTimer) return
    const userConfig = await Config.get()
    if (userConfig.telemetry?.disabled) return
    try {
      // App Insights: env var overrides default (for dev/testing), otherwise use the baked-in key
      const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ?? DEFAULT_CONNECTION_STRING
      const cfg = parseConnectionString(connectionString)
      if (!cfg) {
        enabled = false
        return
      }
      appInsights = cfg
      const account = Control.account()
      if (account) userEmail = account.email
      enabled = true
      log.info("telemetry initialized", { mode: "appinsights" })
      const timer = setInterval(flush, FLUSH_INTERVAL_MS)
      if (typeof timer === "object" && timer && "unref" in timer) (timer as any).unref()
      flushTimer = timer
    } catch {
      enabled = false
    }
  }

  export function setContext(opts: { sessionId: string; projectId: string }) {
    sessionId = opts.sessionId
    projectId = opts.projectId
  }

  export function getContext() {
    return { sessionId, projectId }
  }

  export function track(event: Event) {
    if (!enabled) return
    buffer.push(event)
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.shift()
    }
  }

  export async function flush() {
    if (!enabled || buffer.length === 0 || !appInsights) return

    const events = buffer.splice(0, buffer.length)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(appInsights.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toAppInsightsEnvelopes(events, appInsights)),
        signal: controller.signal,
      })
      if (!response.ok) {
        log.debug("telemetry flush failed", { status: response.status })
      }
    } catch {
      // Silently drop on failure — telemetry must never break the CLI
    } finally {
      clearTimeout(timeout)
    }
  }

  export async function shutdown() {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = undefined
    }
    await flush()
    enabled = false
    appInsights = undefined
    buffer = []
    sessionId = ""
    projectId = ""
  }
}
