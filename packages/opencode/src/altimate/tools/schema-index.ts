import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SchemaIndexResult } from "../native/types"
// altimate_change start — progressive disclosure suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
// altimate_change end

export const SchemaIndexTool = Tool.define("schema_index", {
  description:
    "Index a warehouse's schema metadata (databases, schemas, tables, columns) into a local cache for fast search. Run this after connecting to a new warehouse or when schema changes occur. Schemas with many same-shape tables (e.g. one table per ticker/tenant/region) are auto-collapsed into a single composite digest. NOTE: at most one entity-per-table group is detected per schema; a schema with two distinct patterns has only the dominant one collapsed and the secondary pattern's tables emitted per-table.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name from connections.json"),
    entityRatioThreshold: z
      .number()
      .gt(0)
      .lte(1)
      .optional()
      .describe(
        "Override the entity-per-table detection ratio threshold (default 0.5 = 50%). Must be in (0, 1].",
      ),
    entityMinTables: z
      .number()
      .int()
      .min(2)
      .optional()
      .describe(
        "Override the minimum table count for an entity-per-table group (default 20). Must be an integer >= 2.",
      ),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("schema.index", {
        warehouse: args.warehouse,
        entityRatioThreshold: args.entityRatioThreshold,
        entityMinTables: args.entityMinTables,
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
        metadata: { schemas: 0, tables: 0, columns: 0, entity_groups: 0 },
        output: `Failed to index warehouse schema: ${msg}\n\nEnsure the warehouse connection is configured in connections.json and the dispatcher is running.`,
      }
    }
  },
})

/**
 * Maximum number of leading + trailing entity-group member names included in
 * the `schema_index` formatter output. The full list is preserved on the
 * structured result; truncation is purely for the human/LLM-facing string.
 *
 * The whole point of collapsing entity-per-table groups is to keep
 * `schema_index` output bounded; emitting all 5,000+ names defeats that.
 */
const TABLE_NAMES_HEAD_LIMIT = 50
const TABLE_NAMES_TAIL_LIMIT = 5

/**
 * Format a possibly-large `table_names` list for display. Programmatic
 * callers should read `result.entity_groups[i].table_names` directly off the
 * structured response — that field is never truncated.
 */
function formatTableNames(tableNames: string[]): string {
  if (tableNames.length <= TABLE_NAMES_HEAD_LIMIT + TABLE_NAMES_TAIL_LIMIT) {
    return `[${tableNames.join(", ")}]`
  }
  const head = tableNames.slice(0, TABLE_NAMES_HEAD_LIMIT)
  const tail = tableNames.slice(-TABLE_NAMES_TAIL_LIMIT)
  const omitted = tableNames.length - head.length - tail.length
  return `[${head.join(", ")}, ... +${omitted} more (use schema_search to enumerate), ${tail.join(", ")}]`
}

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
      // table_names is potentially huge (thousands of per-tenant tables);
      // truncate the rendered string but keep the full list intact on the
      // structured result for programmatic readers.
      lines.push(`table_names: ${formatTableNames(g.table_names)}`)
    }
  }

  lines.push("")
  lines.push(
    "Schema cache is now ready. Use schema_search to find tables and columns by name or description.",
  )
  return lines.join("\n")
}
