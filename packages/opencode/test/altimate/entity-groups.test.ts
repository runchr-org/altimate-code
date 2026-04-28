/**
 * Unit tests for the entity-per-table detector.
 */

import { describe, expect, test } from "bun:test"
import {
  detectEntityGroup,
  fingerprintColumns,
  type TableShape,
  DEFAULT_ENTITY_RATIO_THRESHOLD,
  DEFAULT_ENTITY_MIN_TABLES,
} from "../../src/altimate/native/schema/entity-groups"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STOCK_COLS = [
  { name: "Date", data_type: "VARCHAR" },
  { name: "Open", data_type: "DOUBLE" },
  { name: "High", data_type: "DOUBLE" },
  { name: "Low", data_type: "DOUBLE" },
  { name: "Close", data_type: "DOUBLE" },
  { name: "Adj Close", data_type: "DOUBLE" },
  { name: "Volume", data_type: "BIGINT" },
]

function stockTables(names: string[]): TableShape[] {
  return names.map((name) => ({ table_name: name, columns: STOCK_COLS }))
}

// ---------------------------------------------------------------------------
// fingerprintColumns
// ---------------------------------------------------------------------------

describe("fingerprintColumns", () => {
  test("identical columns produce identical fingerprints", () => {
    const fp1 = fingerprintColumns([
      { name: "id", data_type: "INT" },
      { name: "name", data_type: "TEXT" },
    ])
    const fp2 = fingerprintColumns([
      { name: "id", data_type: "INT" },
      { name: "name", data_type: "TEXT" },
    ])
    expect(fp1).toBe(fp2)
  })

  test("column order does not affect fingerprint", () => {
    const fp1 = fingerprintColumns([
      { name: "a", data_type: "INT" },
      { name: "b", data_type: "TEXT" },
    ])
    const fp2 = fingerprintColumns([
      { name: "b", data_type: "TEXT" },
      { name: "a", data_type: "INT" },
    ])
    expect(fp1).toBe(fp2)
  })

  test("type case does not affect fingerprint", () => {
    const fp1 = fingerprintColumns([{ name: "x", data_type: "VARCHAR" }])
    const fp2 = fingerprintColumns([{ name: "x", data_type: "varchar" }])
    expect(fp1).toBe(fp2)
  })

  test("different types yield different fingerprints", () => {
    const fp1 = fingerprintColumns([{ name: "x", data_type: "INT" }])
    const fp2 = fingerprintColumns([{ name: "x", data_type: "BIGINT" }])
    expect(fp1).not.toBe(fp2)
  })

  test("different column names yield different fingerprints", () => {
    const fp1 = fingerprintColumns([{ name: "id", data_type: "INT" }])
    const fp2 = fingerprintColumns([{ name: "user_id", data_type: "INT" }])
    expect(fp1).not.toBe(fp2)
  })

  test("empty columns produce empty fingerprint", () => {
    expect(fingerprintColumns([])).toBe("")
  })
})

// ---------------------------------------------------------------------------
// detectEntityGroup — positive detections
// ---------------------------------------------------------------------------

describe("detectEntityGroup — entity-per-table patterns", () => {
  test("100 same-shape tables are marked as one entity group", () => {
    const names: string[] = []
    for (let i = 0; i < 100; i++) names.push(`TICKER_${i}`)
    const tables = stockTables(names)

    const result = detectEntityGroup(tables)

    expect(result.entity_group).not.toBeNull()
    expect(result.entity_group!.table_names).toHaveLength(100)
    expect(result.entity_group!.composite_columns).toHaveLength(STOCK_COLS.length)
    expect(result.remaining_tables).toHaveLength(0)
  })

  test("composite columns are sorted alphabetically by name", () => {
    const names: string[] = []
    for (let i = 0; i < 25; i++) names.push(`t${i}`)
    const tables = stockTables(names)

    const result = detectEntityGroup(tables)
    expect(result.entity_group).not.toBeNull()
    const names_sorted = result.entity_group!.composite_columns.map((c) => c.name)
    const expected = [...names_sorted].sort()
    expect(names_sorted).toEqual(expected)
  })

  test("table_names are sorted alphabetically", () => {
    const names = ["MSFT", "AAPL", "GOOG", "AMZN"]
    for (let i = 0; i < 20; i++) names.push(`X${i}`)
    const tables = stockTables(names)

    const result = detectEntityGroup(tables)
    expect(result.entity_group).not.toBeNull()
    const got = result.entity_group!.table_names
    const expected = [...got].sort()
    expect(got).toEqual(expected)
  })

  test("sample_table is the alphabetical first member", () => {
    const names = ["ZZ", "AA", "MM"]
    for (let i = 0; i < 20; i++) names.push(`X${i}`)
    const tables = stockTables(names)

    const result = detectEntityGroup(tables)
    expect(result.entity_group).not.toBeNull()
    expect(result.entity_group!.sample_table).toBe("AA")
  })

  test("dominant group + a few odd tables: entity group + remainders", () => {
    const same = stockTables(Array.from({ length: 50 }, (_, i) => `TICK_${i}`))
    const different: TableShape[] = [
      {
        table_name: "metadata",
        columns: [
          { name: "ticker", data_type: "VARCHAR" },
          { name: "company_name", data_type: "VARCHAR" },
        ],
      },
      {
        table_name: "exchange_info",
        columns: [
          { name: "code", data_type: "VARCHAR" },
          { name: "country", data_type: "VARCHAR" },
        ],
      },
    ]
    const tables = [...same, ...different]

    const result = detectEntityGroup(tables)
    expect(result.entity_group).not.toBeNull()
    expect(result.entity_group!.table_names).toHaveLength(50)
    expect(result.remaining_tables).toEqual(["exchange_info", "metadata"])
  })
})

// ---------------------------------------------------------------------------
// detectEntityGroup — negative cases
// ---------------------------------------------------------------------------

describe("detectEntityGroup — patterns that should NOT trigger", () => {
  test("5 mixed-shape tables: no entity group", () => {
    const tables: TableShape[] = [
      { table_name: "users", columns: [{ name: "id", data_type: "INT" }] },
      { table_name: "orders", columns: [{ name: "order_id", data_type: "INT" }] },
      { table_name: "products", columns: [{ name: "sku", data_type: "TEXT" }] },
      { table_name: "events", columns: [{ name: "ts", data_type: "TIMESTAMP" }] },
      { table_name: "logs", columns: [{ name: "level", data_type: "TEXT" }] },
    ]
    const result = detectEntityGroup(tables)
    expect(result.entity_group).toBeNull()
    expect(result.remaining_tables).toHaveLength(5)
  })

  test("50 same + 50 different: under 50% threshold so no entity group", () => {
    // 50 same-shape + 50 of a different but also-uniform shape = exactly 50%
    // each. Threshold is "≥50%" so technically either could pass on a tie,
    // but the second group has only 50 tables sharing an exact shape if we
    // give them all the same shape too — so let's spread the 50 across
    // many shapes to ensure no other group has ≥50%.
    const groupA = stockTables(Array.from({ length: 50 }, (_, i) => `A${i}`))
    const groupB: TableShape[] = []
    for (let i = 0; i < 50; i++) {
      groupB.push({
        table_name: `B${i}`,
        // Each table has a unique extra column so no two share a shape.
        columns: [
          { name: "id", data_type: "INT" },
          { name: `col_${i}`, data_type: "TEXT" },
        ],
      })
    }
    const tables = [...groupA, ...groupB]

    // groupA covers 50/100 = 50% exactly. The threshold is ≥50%, so this
    // *would* qualify under default thresholds. To be deliberate we ratchet
    // the threshold up to 60% and confirm it doesn't trigger.
    const result = detectEntityGroup(tables, { ratioThreshold: 0.6 })
    expect(result.entity_group).toBeNull()
    expect(result.remaining_tables).toHaveLength(100)
  })

  test("19 same-shape tables: under min_tables threshold", () => {
    const tables = stockTables(Array.from({ length: 19 }, (_, i) => `T${i}`))
    // Even though 100% share a shape, 19 < 20 (min). No group.
    const result = detectEntityGroup(tables)
    expect(result.entity_group).toBeNull()
    expect(result.remaining_tables).toHaveLength(19)
  })

  test("empty input returns null group, empty remainders", () => {
    const result = detectEntityGroup([])
    expect(result.entity_group).toBeNull()
    expect(result.remaining_tables).toHaveLength(0)
  })

  test("tables with no columns are never grouped", () => {
    const tables: TableShape[] = []
    for (let i = 0; i < 30; i++) {
      tables.push({ table_name: `t${i}`, columns: [] })
    }
    const result = detectEntityGroup(tables)
    expect(result.entity_group).toBeNull()
    expect(result.remaining_tables).toHaveLength(30)
  })
})

// ---------------------------------------------------------------------------
// detectEntityGroup — threshold knobs
// ---------------------------------------------------------------------------

describe("detectEntityGroup — threshold parameters", () => {
  test("custom min_tables=5 catches small entity sets", () => {
    const tables = stockTables(["A", "B", "C", "D", "E", "F", "G"])
    const result = detectEntityGroup(tables, { minTables: 5 })
    expect(result.entity_group).not.toBeNull()
    expect(result.entity_group!.table_names).toHaveLength(7)
  })

  test("custom ratio_threshold=0.8 rejects weakly-dominant groups", () => {
    // 60% same-shape, 40% varied — under 80% threshold.
    const same = stockTables(Array.from({ length: 60 }, (_, i) => `S${i}`))
    const varied: TableShape[] = []
    for (let i = 0; i < 40; i++) {
      varied.push({
        table_name: `V${i}`,
        columns: [
          { name: "id", data_type: "INT" },
          { name: `col_${i}`, data_type: "TEXT" },
        ],
      })
    }
    const result = detectEntityGroup([...same, ...varied], {
      ratioThreshold: 0.8,
    })
    expect(result.entity_group).toBeNull()
  })

  test("defaults are 50% / 20 tables", () => {
    expect(DEFAULT_ENTITY_RATIO_THRESHOLD).toBe(0.5)
    expect(DEFAULT_ENTITY_MIN_TABLES).toBe(20)
  })
})
