/**
 * Tests that tool error messages propagate to metadata.error
 * so telemetry can extract them (instead of logging "unknown error").
 *
 * Verifies the fix for AI-5975: 6,905 "unknown error" entries in telemetry
 * caused by tools not setting metadata.error on failure paths.
 *
 * Strategy: register mock dispatcher handlers that return real failure shapes
 * (copied from actual production responses), then call the tool's execute()
 * and assert metadata.error is populated.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// Disable telemetry so tests don't need AppInsights
beforeAll(() => { process.env.ALTIMATE_TELEMETRY_DISABLED = "true" })
afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

// Stub context — tools need a Context object but only use metadata()
function stubCtx(): any {
  return {
    sessionID: "test",
    messageID: "test",
    agent: "test",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  }
}

// ---------------------------------------------------------------------------
// Helper: mirrors telemetry extraction logic from tool.ts (lines 142-146)
// ---------------------------------------------------------------------------
function telemetryWouldExtract(metadata: Record<string, any>): string {
  return typeof metadata?.error === "string" ? metadata.error : "unknown error"
}

// ---------------------------------------------------------------------------
// altimate_core_validate — errors in data.errors[].message
// ---------------------------------------------------------------------------
describe("altimate_core_validate error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces 'Table not found' from data.errors[]", async () => {
    Dispatcher.register("altimate_core.validate" as any, async () => ({
      success: false,
      data: {
        valid: false,
        errors: [{ code: "E001", kind: { type: "TableNotFound", table: "users" }, message: "Table 'users' not found", suggestions: [] }],
        warnings: [],
        metadata: { complexity: "low", has_aggregation: false, has_subquery: false, join_count: 0, tables_referenced: [] },
      },
    }))

    const { AltimateCoreValidateTool } = await import("../../src/altimate/tools/altimate-core-validate")
    const tool = await AltimateCoreValidateTool.init()
    const result = await tool.execute({ sql: "SELECT * FROM users" }, stubCtx())

    expect(result.metadata.error).toBe("Table 'users' not found")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })

  test("surfaces dispatcher-level error", async () => {
    Dispatcher.register("altimate_core.validate" as any, async () => ({
      success: false,
      data: { valid: false, errors: [], warnings: [] },
      error: "Failed to recover Schema type from napi value",
    }))

    const { AltimateCoreValidateTool } = await import("../../src/altimate/tools/altimate-core-validate")
    const tool = await AltimateCoreValidateTool.init()
    const result = await tool.execute({ sql: "SELECT 1" }, stubCtx())

    expect(result.metadata.error).toBe("Failed to recover Schema type from napi value")
  })
})

// ---------------------------------------------------------------------------
// altimate_core_semantics — errors in data.validation_errors[]
// ---------------------------------------------------------------------------
describe("altimate_core_semantics error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces 'Table not found' from data.validation_errors[]", async () => {
    Dispatcher.register("altimate_core.semantics" as any, async () => ({
      success: false,
      data: {
        valid: false,
        findings: [],
        passed_checks: [],
        semantic_score: 0,
        validation_errors: ["Table 'users' not found"],
      },
    }))

    const { AltimateCoreSemanticsTool } = await import("../../src/altimate/tools/altimate-core-semantics")
    const tool = await AltimateCoreSemanticsTool.init()
    const result = await tool.execute({ sql: "SELECT * FROM users" }, stubCtx())

    expect(result.metadata.error).toBe("Table 'users' not found")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// altimate_core_equivalence — errors in data.validation_errors[]
// ---------------------------------------------------------------------------
describe("altimate_core_equivalence error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces validation errors from data.validation_errors[]", async () => {
    Dispatcher.register("altimate_core.equivalence" as any, async () => ({
      success: false,
      data: {
        equivalent: false,
        confidence: 0,
        differences: [],
        output_compatible: false,
        validation_errors: [
          "Query A failed validation: Table 'users' not found",
          "Query B failed validation: Table 'users' not found",
        ],
      },
    }))

    const { AltimateCoreEquivalenceTool } = await import("../../src/altimate/tools/altimate-core-equivalence")
    const tool = await AltimateCoreEquivalenceTool.init()
    const result = await tool.execute({ sql1: "SELECT * FROM users", sql2: "SELECT * FROM users" }, stubCtx())

    expect(result.metadata.error).toContain("Table 'users' not found")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// altimate_core_fix — errors in data.unfixable_errors[].error.message
// ---------------------------------------------------------------------------
describe("altimate_core_fix error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces unfixable syntax errors from nested structure", async () => {
    Dispatcher.register("altimate_core.fix" as any, async () => ({
      success: false,
      data: {
        fixed: false,
        fixed_sql: "SELCT * FORM users",
        original_sql: "SELCT * FORM users",
        fixes_applied: [],
        iterations: 1,
        fix_time_ms: 0,
        post_fix_valid: false,
        unfixable_errors: [{
          error: { code: "E000", kind: { type: "SyntaxError" }, message: "Syntax error: Expected an SQL statement, found: SELCT", suggestions: [] },
          reason: "No automatic fix available for E000",
        }],
      },
    }))

    const { AltimateCoreFixTool } = await import("../../src/altimate/tools/altimate-core-fix")
    const tool = await AltimateCoreFixTool.init()
    const result = await tool.execute({ sql: "SELCT * FORM users" }, stubCtx())

    expect(result.metadata.error).toContain("Syntax error")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// altimate_core_correct — errors in data.final_validation.errors[]
// ---------------------------------------------------------------------------
describe("altimate_core_correct error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces errors from data.final_validation.errors[]", async () => {
    Dispatcher.register("altimate_core.correct" as any, async () => ({
      success: false,
      data: {
        original_sql: "SELCT * FORM users",
        status: "unfixable",
        total_time_ms: 1,
        iterations: [{ iteration: 1, input_sql: "SELCT * FORM users", result: "skipped", validation_errors: ["Syntax error"] }],
        final_validation: {
          valid: false,
          errors: [{ code: "E000", kind: { type: "SyntaxError" }, message: "Syntax error: Expected an SQL statement, found: SELCT", suggestions: [] }],
          warnings: [],
        },
        final_score: { syntax_valid: true, lint_score: 1, safety_score: 1, complexity_score: 1, overall: 1 },
      },
    }))

    const { AltimateCoreCorrectTool } = await import("../../src/altimate/tools/altimate-core-correct")
    const tool = await AltimateCoreCorrectTool.init()
    const result = await tool.execute({ sql: "SELCT * FORM users" }, stubCtx())

    expect(result.metadata.error).toContain("Syntax error")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// sql_explain — error from dispatcher result.error
// ---------------------------------------------------------------------------
describe("sql_explain error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces missing password error", async () => {
    Dispatcher.register("sql.explain" as any, async () => ({
      success: false,
      plan_rows: [],
      error: "MissingParameterError: A password must be specified.",
      analyzed: false,
    }))

    const { SqlExplainTool } = await import("../../src/altimate/tools/sql-explain")
    const tool = await SqlExplainTool.init()
    const result = await tool.execute({ sql: "SELECT 1", analyze: false }, stubCtx())

    expect(result.metadata.error).toBe("MissingParameterError: A password must be specified.")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// finops_query_history — error from result.error
// ---------------------------------------------------------------------------
describe("finops_query_history error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces 'not available for unknown warehouses' error", async () => {
    Dispatcher.register("finops.query_history" as any, async () => ({
      success: false,
      queries: [],
      summary: {},
      error: "Query history is not available for unknown warehouses.",
    }))

    const { FinopsQueryHistoryTool } = await import("../../src/altimate/tools/finops-query-history")
    const tool = await FinopsQueryHistoryTool.init()
    const result = await tool.execute({ warehouse: "default", days: 7, limit: 10 }, stubCtx())

    expect(result.metadata.error).toBe("Query history is not available for unknown warehouses.")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// finops_expensive_queries — error from result.error
// ---------------------------------------------------------------------------
describe("finops_expensive_queries error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces error on failure path", async () => {
    Dispatcher.register("finops.expensive_queries" as any, async () => ({
      success: false,
      queries: [],
      query_count: 0,
      error: "No warehouse connection configured.",
    }))

    const { FinopsExpensiveQueriesTool } = await import("../../src/altimate/tools/finops-expensive-queries")
    const tool = await FinopsExpensiveQueriesTool.init()
    const result = await tool.execute({ warehouse: "default", days: 7, limit: 20 }, stubCtx())

    expect(result.metadata.error).toBe("No warehouse connection configured.")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// finops_analyze_credits — error on both !result.success and catch paths
// ---------------------------------------------------------------------------
describe("finops_analyze_credits error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces error on failure path", async () => {
    Dispatcher.register("finops.analyze_credits" as any, async () => ({
      success: false,
      total_credits: 0,
      error: "ACCOUNT_USAGE access denied.",
    }))

    const { FinopsAnalyzeCreditsTool } = await import("../../src/altimate/tools/finops-analyze-credits")
    const tool = await FinopsAnalyzeCreditsTool.init()
    const result = await tool.execute({ warehouse: "default", days: 30, limit: 50 }, stubCtx())

    expect(result.metadata.error).toBe("ACCOUNT_USAGE access denied.")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })

  test("surfaces error on catch path", async () => {
    Dispatcher.register("finops.analyze_credits" as any, async () => { throw new Error("Connection refused") })

    const { FinopsAnalyzeCreditsTool } = await import("../../src/altimate/tools/finops-analyze-credits")
    const tool = await FinopsAnalyzeCreditsTool.init()
    const result = await tool.execute({ warehouse: "default", days: 30, limit: 50 }, stubCtx())

    expect(result.metadata.error).toBe("Connection refused")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// finops_unused_resources — error from result.error
// ---------------------------------------------------------------------------
describe("finops_unused_resources error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces error on failure path", async () => {
    Dispatcher.register("finops.unused_resources" as any, async () => ({
      success: false,
      summary: {},
      unused_tables: [],
      idle_warehouses: [],
      error: "Insufficient privileges.",
    }))

    const { FinopsUnusedResourcesTool } = await import("../../src/altimate/tools/finops-unused-resources")
    const tool = await FinopsUnusedResourcesTool.init()
    const result = await tool.execute({ warehouse: "default", days: 30, limit: 50 }, stubCtx())

    expect(result.metadata.error).toBe("Insufficient privileges.")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// finops_warehouse_advice — error on both paths
// ---------------------------------------------------------------------------
describe("finops_warehouse_advice error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("surfaces error on failure path", async () => {
    Dispatcher.register("finops.warehouse_advice" as any, async () => ({
      success: false,
      recommendations: [],
      warehouse_load: [],
      warehouse_performance: [],
      error: "Warehouse not found.",
    }))

    const { FinopsWarehouseAdviceTool } = await import("../../src/altimate/tools/finops-warehouse-advice")
    const tool = await FinopsWarehouseAdviceTool.init()
    const result = await tool.execute({ warehouse: "default", days: 14 }, stubCtx())

    expect(result.metadata.error).toBe("Warehouse not found.")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })

  test("surfaces error on catch path", async () => {
    Dispatcher.register("finops.warehouse_advice" as any, async () => { throw new Error("Timeout") })

    const { FinopsWarehouseAdviceTool } = await import("../../src/altimate/tools/finops-warehouse-advice")
    const tool = await FinopsWarehouseAdviceTool.init()
    const result = await tool.execute({ warehouse: "default", days: 14 }, stubCtx())

    expect(result.metadata.error).toBe("Timeout")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// Regression guard: telemetry extraction logic
// ---------------------------------------------------------------------------
describe("telemetry extraction logic (regression guard)", () => {
  test("extracts string error", () => {
    expect(telemetryWouldExtract({ error: "real error" })).toBe("real error")
  })

  test("falls back to 'unknown error' when error is missing", () => {
    expect(telemetryWouldExtract({ success: false })).toBe("unknown error")
  })

  test("falls back to 'unknown error' when error is non-string", () => {
    expect(telemetryWouldExtract({ error: 42 })).toBe("unknown error")
  })

  test("falls back to 'unknown error' when metadata is undefined", () => {
    expect(telemetryWouldExtract(undefined as any)).toBe("unknown error")
  })
})
