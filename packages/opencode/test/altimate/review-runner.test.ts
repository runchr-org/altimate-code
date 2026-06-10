import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { createDispatcherRunner } from "../../src/altimate/review/runner"
import { Dispatcher } from "../../src/altimate/native"
import { tmpdir } from "../fixture/fixture"

let dispatcherSpy: ReturnType<typeof spyOn> | undefined

afterEach(() => {
  dispatcherSpy?.mockRestore()
  dispatcherSpy = undefined
})

describe("review manifest loading", () => {
  test("loads a valid manifest without initializing the native dispatcher", async () => {
    await using tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { adapter_type: "duckdb" },
        nodes: {
          "model.demo.orders": {
            resource_type: "model",
            name: "orders",
            original_file_path: "models/orders.sql",
            config: { materialized: "table" },
            depends_on: { nodes: [] },
            columns: {},
          },
        },
        sources: {},
      }),
    )

    const runner = createDispatcherRunner({ manifestPath })
    expect(await runner.manifestAvailable?.()).toBe(true)
    expect(await runner.impact("orders")).toEqual({
      hasManifest: true,
      severity: "SAFE",
      directCount: 0,
      transitiveCount: 0,
      testCount: 0,
    })
  })

  test("threads adapter dialect into core equivalence", async () => {
    await using tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { adapter_type: "duckdb" },
        nodes: {
          "model.demo.orders": {
            resource_type: "model",
            name: "orders",
            original_file_path: "models/orders.sql",
            config: { materialized: "table" },
            depends_on: { nodes: [] },
            columns: { id: { name: "id", data_type: "integer" } },
          },
        },
        sources: {},
      }),
    )

    let seenParams: any
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation((async (method: string, params: any) => {
      expect(method).toBe("altimate_core.equivalence")
      seenParams = params
      return {
        success: true,
        data: {
          equivalent: true,
          confidence: 0.95,
          differences: [],
          validation_errors: [],
        },
      }
    }) as any)

    const runner = createDispatcherRunner({ manifestPath })
    const result = await runner.equivalence("select id from orders", "select id from orders", "duckdb")

    expect(result).toEqual({ decided: true, equivalent: true, differences: [], confidence: "high" })
    expect(seenParams.dialect).toBe("duckdb")
  })
})
