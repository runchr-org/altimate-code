import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreValidateTool = Tool.define("altimate_core_validate", {
  description:
    "Validate SQL syntax and schema references. Checks if tables/columns exist in the schema and if SQL is valid for the target dialect. IMPORTANT: Provide schema_context or schema_path — without schema, all table/column references will report as 'not found'.",
  parameters: z.object({
    sql: z.string().describe("SQL query to validate"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.validate", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const error = result.error ?? data.error ?? extractValidationErrors(data)
      const noSchema = !args.schema_path && !args.schema_context
      let output = error ? `Error: ${error}` : formatValidate(data)
      const hasSchemaErrors = data.errors?.some((e: any) =>
        e.kind?.type === "TableNotFound" || e.kind?.type === "ColumnNotFound"
      )
      if (!data.valid && noSchema && hasSchemaErrors) {
        output += "\n\nNote: No schema context was provided. Table/column references cannot be resolved without schema_context or schema_path. Provide the database schema for accurate validation."
      }
      return {
        title: `Validate: ${data.valid ? "VALID" : "INVALID"}`,
        metadata: { success: result.success, valid: data.valid, error },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Validate: ERROR", metadata: { success: false, valid: false, error: msg }, output: `Failed: ${msg}` }
    }
  },
})

function extractValidationErrors(data: Record<string, any>): string | undefined {
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    return data.errors.map((e: any) => e.message ?? String(e)).join("; ")
  }
  return undefined
}

function formatValidate(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.valid) return "SQL is valid."

  const lines = ["Validation failed:\n"]
  for (const err of data.errors ?? []) {
    lines.push(`  • ${err.message}`)
    if (err.location) lines.push(`    at line ${err.location.line}`)
  }
  return lines.join("\n")
}
