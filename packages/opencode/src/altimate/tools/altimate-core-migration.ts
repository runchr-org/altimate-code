import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreMigrationTool = Tool.define("altimate_core_migration", {
  description:
    "Analyze DDL migration safety using the Rust-based altimate-core engine. Detects potential data loss, type narrowing, missing defaults, and other risks in schema migration statements.",
  parameters: z.object({
    old_ddl: z.string().describe("Original DDL (before migration)"),
    new_ddl: z.string().describe("New DDL (after migration)"),
    dialect: z.string().optional().describe("SQL dialect (e.g. snowflake, postgres)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.migration", {
        old_ddl: args.old_ddl,
        new_ddl: args.new_ddl,
        dialect: args.dialect ?? "",
      })
      const data = result.data as Record<string, any>
      // MigrationResult uses "findings" not "risks"
      const findings = data.findings ?? data.risks ?? []
      const riskCount = findings.length
      const isSafe = data.safe ?? (riskCount === 0)
      return {
        title: `Migration: ${isSafe ? "SAFE" : `${riskCount} risk(s)`}`,
        metadata: { success: result.success, risk_count: riskCount },
        output: formatMigration(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Migration: ERROR", metadata: { success: false, risk_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatMigration(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  // MigrationResult uses "findings" with MigrationFinding shape:
  // { risk: MigrationRisk, operation: string, message: string, mitigation?: string, rollback_sql?: string }
  const findings = data.findings ?? data.risks ?? []
  if (!findings.length) return "Migration appears safe. No risks detected."

  const lines: string[] = []
  if (data.overall_risk) lines.push(`Overall risk: ${data.overall_risk}`)
  lines.push(`\nMigration risks (${findings.length}):\n`)
  for (const r of findings) {
    const severity = r.risk ?? r.severity ?? "warning"
    const operation = r.operation ?? r.type ?? "change"
    lines.push(`  [${severity.toUpperCase()}] ${operation}: ${r.message}`)
    if (r.mitigation ?? r.recommendation) {
      lines.push(`    Mitigation: ${r.mitigation ?? r.recommendation}`)
    }
    if (r.rollback_sql) {
      lines.push(`    Rollback: ${r.rollback_sql}`)
    }
  }
  return lines.join("\n")
}
