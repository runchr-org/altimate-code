import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreEquivalenceTool = Tool.define("altimate_core_equivalence", {
  description:
    "Check semantic equivalence of two SQL queries. Determines if two queries produce the same result set regardless of syntactic differences. Provide schema_context or schema_path for accurate table/column resolution.",
  parameters: z.object({
    sql1: z.string().describe("First SQL query"),
    sql2: z.string().describe("Second SQL query"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.equivalence", {
        sql1: args.sql1,
        sql2: args.sql2,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const error = result.error ?? data.error ?? extractEquivalenceErrors(data)
      return {
        title: `Equivalence: ${data.equivalent ? "EQUIVALENT" : "DIFFERENT"}`,
        metadata: { success: result.success, equivalent: data.equivalent, error },
        output: formatEquivalence(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Equivalence: ERROR", metadata: { success: false, equivalent: false, error: msg }, output: `Failed: ${msg}` }
    }
  },
})

function extractEquivalenceErrors(data: Record<string, any>): string | undefined {
  if (Array.isArray(data.validation_errors) && data.validation_errors.length > 0) {
    return data.validation_errors.join("; ")
  }
  return undefined
}

function formatEquivalence(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  lines.push(data.equivalent ? "Queries are semantically equivalent." : "Queries produce different results.")
  if (data.differences?.length) {
    lines.push("\nDifferences:")
    for (const d of data.differences) {
      lines.push(`  - ${d.description ?? d}`)
    }
  }
  if (data.confidence) lines.push(`\nConfidence: ${data.confidence}`)
  return lines.join("\n")
}
