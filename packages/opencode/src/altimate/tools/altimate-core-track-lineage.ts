import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreTrackLineageTool = Tool.define("altimate_core_track_lineage", {
  description:
    "Track lineage across multiple SQL queries using the Rust-based altimate-core engine. Builds a combined lineage graph from a sequence of queries. Requires altimate_core.init() with API key.",
  parameters: z.object({
    queries: z.array(z.string()).describe("List of SQL queries to track lineage across"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.track_lineage", {
        queries: args.queries,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      // LineageResult has queries[].edges, not root-level edges
      const allEdges = extractAllEdges(data)
      const edgeCount = allEdges.length
      return {
        title: `Track Lineage: ${edgeCount} edge(s) across ${args.queries.length} queries`,
        metadata: { success: result.success, edge_count: edgeCount },
        output: formatTrackLineage(data, allEdges),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Track Lineage: ERROR", metadata: { success: false, edge_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

/**
 * Extract all edges from LineageResult's nested queries[].edges structure.
 */
function extractAllEdges(data: Record<string, any>): Array<Record<string, any>> {
  // Try root-level edges first (in case format changes)
  if (data.edges?.length) return data.edges

  // Extract from queries[].edges (LineageResult structure)
  const allEdges: Array<Record<string, any>> = []
  if (Array.isArray(data.queries)) {
    for (const q of data.queries) {
      for (const edge of q.edges ?? []) {
        allEdges.push(edge)
      }
    }
  }

  // Also include impact_map entries as cross-query edges
  if (Array.isArray(data.impact_map)) {
    for (const entry of data.impact_map) {
      const src = entry.source
      for (const affected of entry.affected ?? []) {
        allEdges.push({
          source: src,
          target: affected,
          transform_type: "cross_query",
        })
      }
    }
  }

  return allEdges
}

function formatEdgeRef(ref: any): string {
  if (typeof ref === "string") return ref
  if (ref?.table && ref?.column) return `${ref.table}.${ref.column}`
  return JSON.stringify(ref)
}

function formatTrackLineage(data: Record<string, any>, allEdges: Array<Record<string, any>>): string {
  if (data.error) return `Error: ${data.error}`
  if (allEdges.length === 0) return "No lineage edges found across queries."

  const lines: string[] = []

  // Show dependency order if available
  if (data.dependency_order?.length) {
    lines.push(`Dependency order: ${data.dependency_order.join(" → ")}`)
    lines.push("")
  }

  lines.push("Lineage graph:\n")
  for (const edge of allEdges) {
    const src = formatEdgeRef(edge.source)
    const tgt = formatEdgeRef(edge.target)
    const transform = edge.transform_type ?? edge.transform ?? ""
    lines.push(`  ${src} -> ${tgt}${transform ? ` (${transform})` : ""}`)
  }
  return lines.join("\n")
}
