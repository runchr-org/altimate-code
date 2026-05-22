/**
 * Shared warehouse resolution for finops.* handlers.
 *
 * The finops tools (analyze_credits, query_history, etc.) all need to map a
 * caller-supplied warehouse name to a configured connection and validate that
 * its driver type supports the requested operation. Before this helper, each
 * handler returned `{ success: false, error: "Credit analysis is not available
 * for unknown warehouses." }` when the warehouse was missing or unknown —
 * which the LLM cannot fix because the error doesn't say which warehouses are
 * available or how to add one.
 *
 * Telemetry (memory/telemetry-analysis-2026-05-21.md) showed `finops_*` tools
 * at 100% error rate. The dominant failure mode was the LLM passing an
 * unconfigured warehouse name and getting a dead-end response. This helper
 * fixes both: it falls back to the first compatible warehouse when none is
 * specified, and produces actionable errors when resolution fails.
 */

import * as Registry from "../connections/registry"

export type FinopsWarehouseResolution =
  | { kind: "ok"; warehouse: string; type: string; autoPicked: boolean }
  | { kind: "error"; error: string }

export interface ResolveOptions {
  /** Caller-supplied warehouse name. May be empty/undefined. */
  requested?: string
  /** Driver types this finops operation supports (e.g. ["snowflake", "bigquery", "databricks"]). */
  supportedTypes: readonly string[]
  /** Operation name for error messages (e.g. "Credit analysis"). */
  operationName: string
}

/**
 * Resolve a warehouse for a finops operation.
 *
 * Resolution order:
 * 1. If `requested` is provided and configured AND its type is supported -> ok.
 * 2. If `requested` is provided but not configured -> error listing available.
 * 3. If `requested` is provided and configured but the type is unsupported -> error.
 * 4. If `requested` is not provided -> auto-pick first warehouse with a supported type.
 * 5. If no warehouses are configured at all -> error pointing at warehouse_add.
 */
export function resolveFinopsWarehouse(opts: ResolveOptions): FinopsWarehouseResolution {
  const { requested, supportedTypes, operationName } = opts
  const all = Registry.list().warehouses
  const supportedList = supportedTypes.join(", ")

  if (all.length === 0) {
    return {
      kind: "error",
      error:
        `${operationName} requires a configured warehouse, but none are set up. ` +
        `Add one with the warehouse_add tool, or via your altimate-code config. ` +
        `Supported types for this operation: ${supportedList}.`,
    }
  }

  if (requested && requested.trim() !== "") {
    const match = all.find((w) => w.name === requested)
    if (!match) {
      const availableNames = all.map((w) => w.name).join(", ")
      return {
        kind: "error",
        error:
          `Warehouse ${JSON.stringify(requested)} is not configured. ` +
          `Available warehouses: ${availableNames}. ` +
          `Pass one of those as the 'warehouse' parameter, or omit it to use the default.`,
      }
    }
    if (!supportedTypes.includes(match.type)) {
      const compatible = all.filter((w) => supportedTypes.includes(w.type)).map((w) => w.name)
      const hint =
        compatible.length > 0
          ? `Try one of: ${compatible.join(", ")}.`
          : `Add a warehouse of one of these types: ${supportedList}.`
      return {
        kind: "error",
        error: `${operationName} is not available for ${match.type} warehouses. ${hint}`,
      }
    }
    return { kind: "ok", warehouse: match.name, type: match.type, autoPicked: false }
  }

  // No requested warehouse — auto-pick first compatible.
  const compatible = all.find((w) => supportedTypes.includes(w.type))
  if (!compatible) {
    const availableTypes = Array.from(new Set(all.map((w) => w.type))).join(", ") || "(none)"
    return {
      kind: "error",
      error:
        `${operationName} is not supported by any of your configured warehouses ` +
        `(${availableTypes}). Supported types: ${supportedList}. ` +
        `Add a compatible warehouse with the warehouse_add tool.`,
    }
  }
  return { kind: "ok", warehouse: compatible.name, type: compatible.type, autoPicked: true }
}
