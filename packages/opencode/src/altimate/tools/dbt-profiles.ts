import z from "zod"
import { homedir } from "os"
import { join } from "path"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { isSensitiveField } from "../native/connections/credential-store"

const DEFAULT_DBT_PROFILES = join(homedir(), ".dbt", "profiles.yml")

export const DbtProfilesTool = Tool.define("dbt_profiles", {
  description:
    `Discover dbt profiles from profiles.yml and map them to warehouse connections. Auto-detects Snowflake, BigQuery, Databricks, Postgres, Redshift, MySQL, DuckDB configurations. Searches: explicit path > DBT_PROFILES_DIR env var > project-local profiles.yml > ${DEFAULT_DBT_PROFILES}.`,
  parameters: z.object({
    path: z.string().optional().describe(`Explicit path to profiles.yml. If omitted, checks DBT_PROFILES_DIR, then project directory, then ${DEFAULT_DBT_PROFILES}`),
    projectDir: z.string().optional().describe("dbt project root directory. Used to find project-local profiles.yml next to dbt_project.yml"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("dbt.profiles", {
        path: args.path,
        projectDir: args.projectDir,
      })

      if (!result.success) {
        return {
          title: "dbt Profiles: FAILED",
          metadata: { success: false, connection_count: 0 },
          output: result.error ?? "Failed to parse profiles.yml",
        }
      }

      const connections = result.connections ?? []
      if (connections.length === 0) {
        return {
          title: "dbt Profiles: No connections found",
          metadata: { success: true, connection_count: 0 },
          output: `No dbt profiles found. Ensure profiles.yml exists in your project directory, DBT_PROFILES_DIR, or ${DEFAULT_DBT_PROFILES}.`,
        }
      }

      return {
        title: `dbt Profiles: ${connections.length} connection(s)`,
        metadata: { success: true, connection_count: connections.length },
        output: formatConnections(connections),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "dbt Profiles: ERROR",
        metadata: { success: false, connection_count: 0 },
        output: `Failed: ${msg}`,
      }
    }
  },
})

function formatConnections(connections: Array<{ name: string; type: string; config: Record<string, unknown> }>): string {
  const lines: string[] = []
  for (const conn of connections) {
    lines.push(`${conn.name} (${conn.type})`)
    for (const [key, val] of Object.entries(conn.config)) {
      if (isSensitiveField(key)) {
        lines.push(`  ${key}: ****`)
      } else {
        lines.push(`  ${key}: ${val}`)
      }
    }
    lines.push("")
  }
  return lines.join("\n")
}
