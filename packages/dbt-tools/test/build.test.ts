import { describe, test, expect, mock } from "bun:test"
import { build } from "../src/commands/build"
import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"

function makeAdapter(overrides: Partial<DBTProjectIntegrationAdapter> = {}): DBTProjectIntegrationAdapter {
  return {
    unsafeBuildModelImmediately: mock(() => Promise.resolve({ stdout: "model built", stderr: "" })),
    unsafeBuildProjectImmediately: mock(() => Promise.resolve({ stdout: "project built", stderr: "" })),
    unsafeRunModelImmediately: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
    unsafeRunModelTestImmediately: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
    dispose: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as DBTProjectIntegrationAdapter
}

describe("build command", () => {
  test("build without --model builds entire project", async () => {
    const adapter = makeAdapter()
    const result = await build(adapter, [])
    expect(adapter.unsafeBuildProjectImmediately).toHaveBeenCalledTimes(1)
    expect(adapter.unsafeBuildModelImmediately).not.toHaveBeenCalled()
    expect(result).toEqual({ stdout: "project built" })
  })

  test("build --model <name> builds single model", async () => {
    const adapter = makeAdapter()
    const result = await build(adapter, ["--model", "orders"])
    expect(adapter.unsafeBuildModelImmediately).toHaveBeenCalledTimes(1)
    expect(adapter.unsafeBuildModelImmediately).toHaveBeenCalledWith({
      plusOperatorLeft: "",
      modelName: "orders",
      plusOperatorRight: "",
    })
    expect(adapter.unsafeBuildProjectImmediately).not.toHaveBeenCalled()
    expect(result).toEqual({ stdout: "model built" })
  })

  test("build --model <name> --downstream sets plusOperatorRight", async () => {
    const adapter = makeAdapter()
    await build(adapter, ["--model", "orders", "--downstream"])
    expect(adapter.unsafeBuildModelImmediately).toHaveBeenCalledWith({
      plusOperatorLeft: "",
      modelName: "orders",
      plusOperatorRight: "+",
    })
  })

  test("build surfaces stderr as error", async () => {
    const adapter = makeAdapter({
      unsafeBuildProjectImmediately: mock(() =>
        Promise.resolve({ stdout: "partial output", stderr: "compilation error" }),
      ),
    })
    const result = await build(adapter, [])
    expect(result).toEqual({ error: "compilation error", stdout: "partial output" })
  })
})
