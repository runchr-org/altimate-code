import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreCompareTool = Tool.define("altimate_core_compare", {
  description:
    "Structurally compare two SQL queries using the Rust-based altimate-core engine. Identifies differences in table references, join conditions, filters, projections, and aggregations.",
  parameters: z.object({
    left_sql: z.string().describe("First SQL query"),
    right_sql: z.string().describe("Second SQL query"),
    dialect: z.string().optional().describe("SQL dialect"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.compare", {
        left_sql: args.left_sql,
        right_sql: args.right_sql,
        dialect: args.dialect ?? "",
      })
      const data = result.data as Record<string, any>
      const diffs = data.diffs ?? data.differences ?? []
      const diffCount = diffs.length
      const isIdentical = data.identical ?? (diffCount === 0)
      return {
        title: `Compare: ${isIdentical ? "IDENTICAL" : `${diffCount} difference(s)`}`,
        metadata: { success: result.success, difference_count: diffCount },
        output: formatCompare(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Compare: ERROR", metadata: { success: false, difference_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatCompare(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  // CompareResult uses "diffs" field, not "differences"
  const diffs = data.diffs ?? data.differences ?? []
  const isIdentical = data.identical ?? (diffs.length === 0)
  if (isIdentical && diffs.length === 0) return "Queries are structurally identical."
  const lines = [`Structural differences (${diffs.length}):\n`]
  for (const d of diffs) {
    lines.push(`  [${d.change_type ?? d.type ?? "change"}] ${d.description ?? d.message ?? d}`)
  }
  return lines.join("\n")
}
