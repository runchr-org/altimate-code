import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const DataDiffTool = Tool.define("data_diff", {
  description: [
    "Compare two database tables or query results row-by-row to find differences.",
    "",
    "Two use cases:",
    "1. Migration validation — compare the same table across two databases:",
    '   source="orders" source_warehouse="postgres_prod" target_warehouse="snowflake_dw"',
    "2. Query optimization — compare results of two SQL queries on the same database:",
    '   source="SELECT id, amount FROM orders WHERE ..." target="SELECT id, amount FROM orders_v2 WHERE ..."',
    "",
    "Algorithms:",
    "- auto: JoinDiff if same dialect, HashDiff if cross-database (default)",
    "- joindiff: FULL OUTER JOIN (fast, same-database only)",
    "- hashdiff: Bisection with checksums (cross-database, any scale)",
    "- profile: Column-level statistics comparison",
  ].join("\n"),
  parameters: z.object({
    source: z.string().describe(
      "Source table name (e.g. 'orders', 'db.schema.orders') or a full SQL query starting with SELECT/WITH",
    ),
    target: z.string().describe(
      "Target table name or SQL query to compare against source",
    ),
    key_columns: z
      .array(z.string())
      .describe("Primary key columns that uniquely identify each row (e.g. ['id'] or ['order_id', 'line_item'])"),
    source_warehouse: z.string().optional().describe("Source warehouse connection name"),
    target_warehouse: z.string().optional().describe(
      "Target warehouse connection name. Omit to use the same warehouse as source (query comparison mode)",
    ),
    extra_columns: z
      .array(z.string())
      .optional()
      .describe("Additional columns to compare beyond the key columns. Omit to compare all columns"),
    algorithm: z
      .enum(["auto", "joindiff", "hashdiff", "profile", "cascade"])
      .optional()
      .default("auto")
      .describe("Comparison algorithm"),
    where_clause: z.string().optional().describe("Optional WHERE filter applied to both tables"),
    numeric_tolerance: z
      .number()
      .optional()
      .describe("Absolute tolerance for numeric comparisons (e.g. 0.01 for cent-level tolerance)"),
    timestamp_tolerance_ms: z
      .number()
      .optional()
      .describe("Tolerance for timestamp comparisons in milliseconds"),
    partition_column: z
      .string()
      .optional()
      .describe(
        "Column to partition on before diffing. Splits the table into groups and diffs each independently. " +
        "Three modes depending on which other params you set:\n" +
        "  • Date column   → set partition_granularity (day/week/month/year). E.g. partition_column='l_shipdate', partition_granularity='month'\n" +
        "  • Numeric column → set partition_bucket_size. E.g. partition_column='l_orderkey', partition_bucket_size=100000\n" +
        "  • Categorical   → set neither. Works for string/enum/boolean columns like 'status', 'region', 'country'. Groups by distinct values.\n" +
        "Results are aggregated with a per-partition breakdown showing which groups have differences.",
      ),
    partition_granularity: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("For date partition columns: truncation granularity. Omit for numeric or categorical columns."),
    partition_bucket_size: z
      .number()
      .optional()
      .describe("For numeric partition columns: size of each bucket. E.g. 100000 splits l_orderkey into ranges of 100K. Omit for date or categorical columns."),
  }),
  async execute(args, ctx) {
    // Require read permission — data diff executes SELECT queries
    await ctx.ask({
      permission: "sql_execute_read",
      patterns: [args.source.slice(0, 120), args.target.slice(0, 120)],
      always: ["*"],
      metadata: {},
    })

    try {
      const result = await Dispatcher.call("data.diff", {
        source: args.source,
        target: args.target,
        key_columns: args.key_columns,
        source_warehouse: args.source_warehouse,
        target_warehouse: args.target_warehouse,
        extra_columns: args.extra_columns,
        algorithm: args.algorithm,
        where_clause: args.where_clause,
        numeric_tolerance: args.numeric_tolerance,
        timestamp_tolerance_ms: args.timestamp_tolerance_ms,
        partition_column: args.partition_column,
        partition_granularity: args.partition_granularity,
        partition_bucket_size: args.partition_bucket_size,
      })

      if (!result.success) {
        return {
          title: "Data diff: ERROR",
          metadata: { success: false, steps: result.steps },
          output: `Data diff failed: ${result.error}`,
        }
      }

      const outcome = result.outcome as any
      let output = formatOutcome(outcome, args.source, args.target)

      if (result.partition_results?.length) {
        output += formatPartitionResults(result.partition_results, args.partition_column!)
      }

      return {
        title: `Data diff: ${summarize(outcome)}`,
        metadata: { success: true, steps: result.steps },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Data diff: ERROR",
        metadata: { success: false, steps: 0, error: msg },
        output: `Data diff failed: ${msg}`,
      }
    }
  },
})

function summarize(outcome: any): string {
  if (!outcome) return "complete"
  if (outcome.Match) return "IDENTICAL ✓"
  if (outcome.Diff) {
    const r = outcome.Diff
    const parts: string[] = []
    if (r.rows_only_in_source > 0) parts.push(`${r.rows_only_in_source} only in source`)
    if (r.rows_only_in_target > 0) parts.push(`${r.rows_only_in_target} only in target`)
    if (r.rows_updated > 0) parts.push(`${r.rows_updated} updated`)
    return parts.length ? parts.join(", ") : "differences found"
  }
  if (outcome.Profile) return "profile complete"
  return "complete"
}

function formatOutcome(outcome: any, source: string, target: string): string {
  if (!outcome) return "Comparison complete."

  const lines: string[] = []

  if (outcome.Match) {
    lines.push(`✓ Tables are IDENTICAL`)
    const m = outcome.Match
    if (m.row_count != null) lines.push(`  Rows checked: ${m.row_count.toLocaleString()}`)
    if (m.algorithm) lines.push(`  Algorithm: ${m.algorithm}`)
    return lines.join("\n")
  }

  if (outcome.Diff) {
    const r = outcome.Diff
    lines.push(`✗ Tables DIFFER`)
    lines.push(``)
    lines.push(`  Source:  ${source}`)
    lines.push(`  Target:  ${target}`)
    lines.push(``)

    if (r.total_source_rows != null) lines.push(`  Source rows:        ${r.total_source_rows.toLocaleString()}`)
    if (r.total_target_rows != null) lines.push(`  Target rows:        ${r.total_target_rows.toLocaleString()}`)
    if (r.rows_only_in_source > 0) lines.push(`  Only in source:     ${r.rows_only_in_source.toLocaleString()}`)
    if (r.rows_only_in_target > 0) lines.push(`  Only in target:     ${r.rows_only_in_target.toLocaleString()}`)
    if (r.rows_updated > 0) lines.push(`  Updated rows:       ${r.rows_updated.toLocaleString()}`)
    if (r.rows_identical > 0) lines.push(`  Identical rows:     ${r.rows_identical.toLocaleString()}`)

    if (r.sample_diffs?.length) {
      lines.push(``)
      lines.push(`  Sample differences (first ${r.sample_diffs.length}):`)
      for (const d of r.sample_diffs.slice(0, 5)) {
        lines.push(`    key=${JSON.stringify(d.key)} col=${d.column}: ${d.source_value} → ${d.target_value}`)
      }
    }

    return lines.join("\n")
  }

  if (outcome.Profile) {
    const p = outcome.Profile
    lines.push(`Column Profile Comparison`)
    lines.push(``)
    for (const col of p.columns ?? []) {
      const verdict = col.verdict === "match" ? "✓" : col.verdict === "within_tolerance" ? "~" : "✗"
      lines.push(`  ${verdict} ${col.column}: ${col.verdict}`)
      if (col.source_stats && col.target_stats) {
        lines.push(`      source: count=${col.source_stats.count} nulls=${col.source_stats.null_count} min=${col.source_stats.min} max=${col.source_stats.max}`)
        lines.push(`      target: count=${col.target_stats.count} nulls=${col.target_stats.null_count} min=${col.target_stats.min} max=${col.target_stats.max}`)
      }
    }
    return lines.join("\n")
  }

  return JSON.stringify(outcome, null, 2)
}

function formatPartitionResults(
  partitions: Array<{ partition: string; rows_source: number; rows_target: number; differences: number; status: string; error?: string }>,
  partitionColumn: string,
): string {
  const lines: string[] = ["", `Partition breakdown (by ${partitionColumn}):`]

  const clean = partitions.filter((p) => p.status === "identical")
  const dirty = partitions.filter((p) => p.status === "differ")
  const errored = partitions.filter((p) => p.status === "error")

  if (dirty.length === 0 && errored.length === 0) {
    lines.push(`  ✓ All ${partitions.length} partitions identical`)
    return lines.join("\n")
  }

  for (const p of dirty) {
    lines.push(`  ✗ ${p.partition}  source=${p.rows_source.toLocaleString()}  target=${p.rows_target.toLocaleString()}  diff=${p.differences.toLocaleString()}`)
  }
  for (const p of errored) {
    lines.push(`  ! ${p.partition}  ERROR: ${p.error}`)
  }
  if (clean.length > 0) {
    lines.push(`  ✓ ${clean.length} partition${clean.length === 1 ? "" : "s"} identical`)
  }

  return lines.join("\n")
}
