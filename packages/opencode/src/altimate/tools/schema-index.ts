import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SchemaIndexResult } from "../native/types"
// altimate_change start — progressive disclosure suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
// altimate_change end

export const SchemaIndexTool = Tool.define("schema_index", {
  description:
    "Index a warehouse's schema metadata (databases, schemas, tables, columns) into a local cache for fast search. Run this after connecting to a new warehouse or when schema changes occur.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name from connections.json"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("schema.index", {
        warehouse: args.warehouse,
      })

      // altimate_change start — progressive disclosure suggestions
      let output = formatIndexResult(result)
      const suggestion = PostConnectSuggestions.getProgressiveSuggestion("schema_index")
      if (suggestion) {
        output += "\n\n" + suggestion
        PostConnectSuggestions.trackSuggestions({
          suggestionType: "progressive_disclosure",
          suggestionsShown: ["sql_analyze", "schema_inspect", "lineage_check"],
          warehouseType: result.type,
        })
      }
      // altimate_change end
      return {
        title: `Schema Indexed: ${result.warehouse}`,
        metadata: {
          schemas: result.schemas_indexed,
          tables: result.tables_indexed,
          columns: result.columns_indexed,
          entity_groups: result.entity_groups?.length ?? 0,
        },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Schema Index: ERROR",
        metadata: { schemas: 0, tables: 0, columns: 0 },
        output: `Failed to index warehouse schema: ${msg}\n\nEnsure the warehouse connection is configured in connections.json and the dispatcher is running.`,
      }
    }
  },
})

function formatIndexResult(result: SchemaIndexResult): string {
  const lines: string[] = [
    `Warehouse: ${result.warehouse} (${result.type})`,
    `Schemas indexed: ${result.schemas_indexed}`,
    `Tables indexed: ${result.tables_indexed}`,
    `Columns indexed: ${result.columns_indexed}`,
    `Timestamp: ${result.timestamp}`,
  ]

  if (result.entity_groups && result.entity_groups.length > 0) {
    lines.push("")
    lines.push(`Entity-per-table groups detected: ${result.entity_groups.length}`)
    for (const g of result.entity_groups) {
      const fqSchema = g.database ? `${g.database}.${g.schema_name}` : g.schema_name
      lines.push("")
      lines.push(`schema: ${fqSchema}`)
      lines.push(`pattern: ${g.pattern}`)
      lines.push(`table_count: ${g.table_count}`)
      const cols = g.composite_columns
        .map((c) => `{name: "${c.name}", type: "${c.data_type}"}`)
        .join(", ")
      lines.push(`composite_columns: [${cols}]`)
      lines.push(`sample_table: ${g.sample_table}`)
      // table_names can be very long; emit comma-separated. Agent can grep.
      lines.push(`table_names: [${g.table_names.join(", ")}]`)
    }
  }

  lines.push("")
  lines.push(
    "Schema cache is now ready. Use schema_search to find tables and columns by name or description.",
  )
  return lines.join("\n")
}
