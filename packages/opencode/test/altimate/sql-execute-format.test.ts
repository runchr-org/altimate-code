/**
 * SqlExecuteTool — output formatting edge cases.
 *
 * The private `formatResult()` function formats every SQL result the user sees.
 * These tests exercise paths that existing tests don't cover:
 *   - Zero-row result (early return path)
 *   - Truncated result ([truncated] indicator)
 *
 * Pattern matches real-tool-simulation.test.ts: mock Dispatcher, call tool
 * through `.init()`, verify output.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Dispatcher } from "../../src/altimate/native"
import { Log } from "../../src/util/log"

Log.init({ print: false })

function makeCtx() {
  return {
    sessionID: "ses_fmt_test",
    messageID: "msg_fmt_test",
    callID: "call_fmt_test",
    agent: "builder",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
    extra: {},
  } as any
}

beforeEach(async () => {
  Dispatcher.reset()
  const { PostConnectSuggestions } = await import("../../src/altimate/tools/post-connect-suggestions")
  PostConnectSuggestions.resetShownSuggestions()
})

describe("SqlExecuteTool: formatResult output", () => {
  test("zero rows returns '(0 rows)' with no header or separator", async () => {
    Dispatcher.register("sql.execute", async () => ({
      columns: ["id"],
      rows: [],
      row_count: 0,
      truncated: false,
    }))

    const mod = await import("../../src/altimate/tools/sql-execute")
    const tool = await mod.SqlExecuteTool.init()
    const result = await tool.execute({ query: "SELECT id FROM t WHERE false", limit: 100 }, makeCtx())

    // The core output before any progressive suggestion should start with (0 rows)
    expect(result.output).toMatch(/^\(0 rows\)/)
    expect(result.metadata.rowCount).toBe(0)
    // Should NOT contain a header separator
    expect(result.output).not.toContain("---")
  })

  test("truncated result includes [truncated] indicator", async () => {
    Dispatcher.register("sql.execute", async () => ({
      columns: ["id", "value"],
      rows: [[1, "a"], [2, "b"]],
      row_count: 2,
      truncated: true,
    }))

    const mod = await import("../../src/altimate/tools/sql-execute")
    const tool = await mod.SqlExecuteTool.init()
    const result = await tool.execute({ query: "SELECT * FROM big_table", limit: 2 }, makeCtx())

    expect(result.output).toContain("[truncated]")
    expect(result.output).toContain("(2 rows)")
    expect(result.metadata.truncated).toBe(true)
  })
})
