/**
 * Tool-surface tests for `schema_index` (Tool.define wrapper).
 *
 * Covers regressions raised in the multi-model consensus review for
 * PR #762:
 *   - M1: threshold knobs are forwarded from the public tool through the
 *         dispatcher into the cache.
 *   - M3: the `table_names` formatter truncates large lists.
 *   - M6: invalid threshold params are rejected with clear errors.
 */

import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  spyOn,
  beforeAll,
  afterAll,
} from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { SchemaIndexTool } from "../../src/altimate/tools/schema-index"
import { Telemetry } from "../../src/telemetry"
import { SessionID, MessageID } from "../../src/session/schema"

beforeAll(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})

afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

// Minimal context shape required by Tool.execute().
const ctx = {
  sessionID: SessionID.make("ses_test_idx"),
  messageID: MessageID.make("msg_test_idx"),
  callID: "call_test_idx",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

let dispatcherSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  spyOn(Telemetry, "track").mockImplementation(() => {})
  spyOn(Telemetry, "getContext").mockReturnValue({
    sessionId: "test-session",
    projectId: "",
  } as any)
})

afterEach(() => {
  dispatcherSpy?.mockRestore()
})

// ---------------------------------------------------------------------------
// M1 — threshold knobs propagate through the public tool surface.
// ---------------------------------------------------------------------------

describe("schema_index tool — M1: threshold overrides reach the dispatcher", () => {
  test("forwards entityRatioThreshold and entityMinTables to schema.index", async () => {
    let captured: { method: string; params: any } | null = null
    const handler = async (method: string, params: any) => {
      captured = { method, params }
      return {
        warehouse: params.warehouse,
        type: "duckdb",
        schemas_indexed: 1,
        tables_indexed: 0,
        columns_indexed: 0,
        timestamp: "2026-04-26T00:00:00Z",
      }
    }
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(handler as any)

    const tool = await SchemaIndexTool.init()
    await tool.execute(
      {
        warehouse: "test-wh",
        entityRatioThreshold: 0.7,
        entityMinTables: 30,
      } as any,
      ctx as any,
    )

    expect(captured).not.toBeNull()
    expect(captured!.method).toBe("schema.index")
    expect(captured!.params.warehouse).toBe("test-wh")
    expect(captured!.params.entityRatioThreshold).toBe(0.7)
    expect(captured!.params.entityMinTables).toBe(30)
  })

  test("omitting overrides leaves them undefined (defaults applied downstream)", async () => {
    let captured: any = null
    const handler = async (_method: string, params: any) => {
      captured = params
      return {
        warehouse: params.warehouse,
        type: "duckdb",
        schemas_indexed: 0,
        tables_indexed: 0,
        columns_indexed: 0,
        timestamp: "2026-04-26T00:00:00Z",
      }
    }
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(handler as any)

    const tool = await SchemaIndexTool.init()
    await tool.execute({ warehouse: "test-wh" } as any, ctx as any)

    expect(captured.warehouse).toBe("test-wh")
    expect(captured.entityRatioThreshold).toBeUndefined()
    expect(captured.entityMinTables).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// M3 — `table_names` is truncated in the formatter for huge groups, but the
// underlying structured result is untouched.
// ---------------------------------------------------------------------------

describe("schema_index tool — M3: large table_names lists are truncated in output", () => {
  test("groups with >55 tables render as head + ellipsis + tail", async () => {
    const tableNames = Array.from({ length: 2754 }, (_, i) => `tenant_${i}`)
    const handler = async (_method: string) => ({
      warehouse: "huge-wh",
      type: "duckdb",
      schemas_indexed: 1,
      tables_indexed: 2754,
      columns_indexed: 2754 * 5,
      timestamp: "2026-04-26T00:00:00Z",
      entity_groups: [
        {
          warehouse: "huge-wh",
          schema_name: "public",
          pattern: "entity-per-table",
          table_count: tableNames.length,
          composite_columns: [
            { name: "id", data_type: "INT" },
            { name: "value", data_type: "DOUBLE" },
          ],
          sample_table: "tenant_0",
          table_names: tableNames,
        },
      ],
    })
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(handler as any)

    const tool = await SchemaIndexTool.init()
    const result = await tool.execute(
      { warehouse: "huge-wh" } as any,
      ctx as any,
    )

    // Output should mention the truncation explicitly.
    expect(result.output).toContain("more (use schema_search to enumerate)")

    // The raw line for table_names must not contain the full list.
    const tableNamesLine = result.output
      .split("\n")
      .find((l) => l.startsWith("table_names:"))
    expect(tableNamesLine).toBeDefined()

    // Sanity: the rendered string must be much smaller than the full list
    // (≈ 2754 names). Allow generous slack for prefix + tail names.
    expect(tableNamesLine!.length).toBeLessThan(2000)

    // Head and tail anchors are present.
    expect(tableNamesLine).toContain("tenant_0")
    expect(tableNamesLine).toContain("tenant_2753")

    // Confirm a clearly-truncated middle entry is NOT present.
    expect(tableNamesLine).not.toContain("tenant_500,")
  })

  test("groups with few tables emit the full list (no truncation noise)", async () => {
    const tableNames = ["A", "B", "C"]
    const handler = async (_method: string) => ({
      warehouse: "small-wh",
      type: "duckdb",
      schemas_indexed: 1,
      tables_indexed: 3,
      columns_indexed: 3,
      timestamp: "2026-04-26T00:00:00Z",
      entity_groups: [
        {
          warehouse: "small-wh",
          schema_name: "public",
          pattern: "entity-per-table",
          table_count: 3,
          composite_columns: [{ name: "v", data_type: "INT" }],
          sample_table: "A",
          table_names: tableNames,
        },
      ],
    })
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(handler as any)

    const tool = await SchemaIndexTool.init()
    const result = await tool.execute(
      { warehouse: "small-wh" } as any,
      ctx as any,
    )

    expect(result.output).toContain("table_names: [A, B, C]")
    expect(result.output).not.toContain("more (use schema_search")
  })
})

// ---------------------------------------------------------------------------
// M6 — Zod validation rejects invalid threshold params.
// ---------------------------------------------------------------------------

describe("schema_index tool — M6: Zod rejects invalid thresholds", () => {
  beforeEach(() => {
    // The Zod parse runs before Dispatcher.call, so we don't need a spy
    // implementation — a no-op suffices to keep type-shape intact.
    dispatcherSpy = spyOn(Dispatcher, "call").mockResolvedValue({
      warehouse: "x",
      type: "duckdb",
      schemas_indexed: 0,
      tables_indexed: 0,
      columns_indexed: 0,
      timestamp: "2026-04-26T00:00:00Z",
    } as any)
  })

  test("rejects entityRatioThreshold = 0", async () => {
    const tool = await SchemaIndexTool.init()
    await expect(
      tool.execute(
        { warehouse: "wh", entityRatioThreshold: 0 } as any,
        ctx as any,
      ),
    ).rejects.toThrow(/invalid arguments|entityRatioThreshold/i)
  })

  test("rejects entityRatioThreshold > 1", async () => {
    const tool = await SchemaIndexTool.init()
    await expect(
      tool.execute(
        { warehouse: "wh", entityRatioThreshold: 1.5 } as any,
        ctx as any,
      ),
    ).rejects.toThrow(/invalid arguments|entityRatioThreshold/i)
  })

  test("rejects entityRatioThreshold < 0", async () => {
    const tool = await SchemaIndexTool.init()
    await expect(
      tool.execute(
        { warehouse: "wh", entityRatioThreshold: -0.1 } as any,
        ctx as any,
      ),
    ).rejects.toThrow(/invalid arguments|entityRatioThreshold/i)
  })

  test("rejects non-integer entityMinTables", async () => {
    const tool = await SchemaIndexTool.init()
    await expect(
      tool.execute(
        { warehouse: "wh", entityMinTables: 3.7 } as any,
        ctx as any,
      ),
    ).rejects.toThrow(/invalid arguments|entityMinTables/i)
  })

  test("rejects entityMinTables < 2", async () => {
    const tool = await SchemaIndexTool.init()
    await expect(
      tool.execute(
        { warehouse: "wh", entityMinTables: 1 } as any,
        ctx as any,
      ),
    ).rejects.toThrow(/invalid arguments|entityMinTables/i)
  })

  test("accepts entityRatioThreshold = 1 and entityMinTables = 2", async () => {
    // Boundary check — must NOT throw for the legal extremes.
    const tool = await SchemaIndexTool.init()
    const result = await tool.execute(
      {
        warehouse: "wh",
        entityRatioThreshold: 1,
        entityMinTables: 2,
      } as any,
      ctx as any,
    )
    expect(result.title).toContain("Schema Indexed")
  })
})
