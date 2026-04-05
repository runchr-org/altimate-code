import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SqlExecuteResult } from "../native/types"
// altimate_change start - SQL write access control + fingerprinting
import { classifyAndCheck, computeSqlFingerprint } from "./sql-classify"
import { Telemetry } from "../telemetry"
// altimate_change end
// altimate_change start — progressive disclosure suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
// altimate_change end
// altimate_change start — pre-execution SQL validation via cached schema
import { getCache } from "../native/schema/cache"
// altimate_change end

export const SqlExecuteTool = Tool.define("sql_execute", {
  description: "Execute SQL against a connected data warehouse. Returns results as a formatted table.",
  parameters: z.object({
    query: z.string().describe("SQL query to execute"),
    warehouse: z.string().optional().describe("Warehouse connection name"),
    limit: z.number().optional().default(100).describe("Max rows to return"),
  }),
  async execute(args, ctx) {
    // altimate_change start - SQL write access control
    // Permission checks OUTSIDE try/catch so denial errors propagate to the framework
    const { queryType, blocked } = classifyAndCheck(args.query)
    if (blocked) {
      throw new Error("DROP DATABASE, DROP SCHEMA, and TRUNCATE are blocked for safety. This cannot be overridden.")
    }
    if (queryType === "write") {
      await ctx.ask({
        permission: "sql_execute_write",
        patterns: [args.query.slice(0, 200)],
        always: ["*"],
        metadata: { queryType },
      })
    }
    // altimate_change end

    // altimate_change start — pre-execution SQL validation via cached schema
    const preValidation = await preValidateSql(args.query, args.warehouse)
    if (preValidation.blocked) {
      return {
        title: "SQL: VALIDATION ERROR",
        metadata: { rowCount: 0, truncated: false, error: preValidation.error },
        output: preValidation.error!,
      }
    }
    // altimate_change end

    try {
      const result = await Dispatcher.call("sql.execute", {
        sql: args.query,
        warehouse: args.warehouse,
        limit: args.limit,
      })

      let output = formatResult(result)
      // altimate_change start — emit SQL structure fingerprint telemetry
      try {
        const fp = computeSqlFingerprint(args.query)
        if (fp) {
          Telemetry.track({
            type: "sql_fingerprint",
            timestamp: Date.now(),
            session_id: ctx.sessionID,
            statement_types: JSON.stringify(fp.statement_types),
            categories: JSON.stringify(fp.categories),
            table_count: fp.table_count,
            function_count: fp.function_count,
            has_subqueries: fp.has_subqueries,
            has_aggregation: fp.has_aggregation,
            has_window_functions: fp.has_window_functions,
            node_count: fp.node_count,
          })
        }
      } catch {
        // Fingerprinting must never break query execution
      }
      // altimate_change end
      // altimate_change start — progressive disclosure suggestions
      const suggestion = PostConnectSuggestions.getProgressiveSuggestion("sql_execute")
      if (suggestion) {
        output += "\n\n" + suggestion
        PostConnectSuggestions.trackSuggestions({
          suggestionType: "progressive_disclosure",
          suggestionsShown: ["sql_analyze"],
          warehouseType: args.warehouse ?? "default",
        })
      }
      // altimate_change end
      return {
        title: `SQL: ${args.query.slice(0, 60)}${args.query.length > 60 ? "..." : ""}`,
        metadata: { rowCount: result.row_count, truncated: result.truncated },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "SQL: ERROR",
        metadata: { rowCount: 0, truncated: false, error: msg },
        output: `Failed to execute SQL: ${msg}\n\nEnsure the dispatcher is running and a warehouse connection is configured.`,
      }
    }
  },
})

// altimate_change start — pre-execution SQL validation via cached schema
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface PreValidationResult {
  blocked: boolean
  error?: string
}

async function preValidateSql(sql: string, warehouse?: string): Promise<PreValidationResult> {
  const startTime = Date.now()
  try {
    const cache = await getCache()
    const status = cache.cacheStatus()

    // Find the target warehouse in cache
    const warehouseName = warehouse || status.warehouses[0]?.name
    if (!warehouseName) {
      trackPreValidation("skipped", "no_cache", 0, Date.now() - startTime)
      return { blocked: false }
    }

    const warehouseStatus = status.warehouses.find((w) => w.name === warehouseName)
    if (!warehouseStatus?.last_indexed) {
      trackPreValidation("skipped", "no_cache", 0, Date.now() - startTime)
      return { blocked: false }
    }

    // Check cache freshness
    const cacheAge = Date.now() - new Date(warehouseStatus.last_indexed).getTime()
    if (cacheAge > CACHE_TTL_MS) {
      trackPreValidation("skipped", "stale_cache", 0, Date.now() - startTime)
      return { blocked: false }
    }

    // Build schema context from cached columns
    const columns = cache.listColumns(warehouseName, 10_000)
    if (columns.length === 0) {
      trackPreValidation("skipped", "empty_cache", 0, Date.now() - startTime)
      return { blocked: false }
    }

    const schemaContext: Record<string, any> = {}
    for (const col of columns) {
      const tableName = col.schema_name ? `${col.schema_name}.${col.table}` : col.table
      if (!schemaContext[tableName]) {
        schemaContext[tableName] = []
      }
      schemaContext[tableName].push({
        name: col.name,
        type: col.data_type || "VARCHAR",
        nullable: col.nullable,
      })
    }

    // Validate SQL against cached schema
    const validationResult = await Dispatcher.call("altimate_core.validate", {
      sql,
      schema_path: "",
      schema_context: schemaContext,
    })

    const data = (validationResult.data ?? {}) as Record<string, any>
    const errors = Array.isArray(data.errors) ? data.errors : []
    const isValid = data.valid !== false && errors.length === 0

    if (isValid) {
      trackPreValidation("passed", "valid", columns.length, Date.now() - startTime)
      return { blocked: false }
    }

    // Only block on high-confidence structural errors
    const structuralErrors = errors.filter((e: any) => {
      const msg = (e.message ?? "").toLowerCase()
      return msg.includes("column") || msg.includes("table") || msg.includes("not found") || msg.includes("does not exist")
    })

    if (structuralErrors.length === 0) {
      // Non-structural errors (ambiguous cases) — let them through
      trackPreValidation("passed", "non_structural", columns.length, Date.now() - startTime)
      return { blocked: false }
    }

    // Build helpful error with available columns
    const errorMsgs = structuralErrors.map((e: any) => e.message).join("\n")
    const referencedTables = Object.keys(schemaContext).slice(0, 10)
    const availableColumns = referencedTables
      .map((t) => `${t}: ${schemaContext[t].map((c: any) => c.name).join(", ")}`)
      .join("\n")

    const errorOutput = [
      `Pre-execution validation failed (validated against cached schema):`,
      ``,
      errorMsgs,
      ``,
      `Available tables and columns:`,
      availableColumns,
      ``,
      `Fix the query and retry. If the schema cache is outdated, run schema_index to refresh it.`,
    ].join("\n")

    trackPreValidation("blocked", "structural_error", columns.length, Date.now() - startTime, errorMsgs)
    return { blocked: true, error: errorOutput }
  } catch {
    // Validation failure should never block execution
    trackPreValidation("error", "validation_exception", 0, Date.now() - startTime)
    return { blocked: false }
  }
}

function trackPreValidation(
  outcome: "skipped" | "passed" | "blocked" | "error",
  reason: string,
  schema_columns: number,
  duration_ms: number,
  error_message?: string,
) {
  Telemetry.track({
    type: "sql_pre_validation",
    timestamp: Date.now(),
    session_id: Telemetry.getContext().sessionId,
    outcome,
    reason,
    schema_columns,
    duration_ms,
    ...(error_message && { error_message: error_message.slice(0, 500) }),
  })
}
// altimate_change end

function formatResult(result: SqlExecuteResult): string {
  if (result.row_count === 0) return "(0 rows)"

  const header = result.columns.join(" | ")
  const separator = result.columns.map((c) => "-".repeat(Math.max(c.length, 4))).join("-+-")
  const rows = result.rows.map((r) => r.map((v) => (v === null ? "NULL" : String(v))).join(" | ")).join("\n")

  let output = `${header}\n${separator}\n${rows}\n\n(${result.row_count} rows)`
  if (result.truncated) output += " [truncated]"
  return output
}
