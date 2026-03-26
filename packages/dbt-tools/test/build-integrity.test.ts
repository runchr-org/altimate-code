import { describe, test, expect, beforeAll } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { $ } from "bun"

const dist = join(import.meta.dir, "../dist")

describe("build integrity", () => {
  beforeAll(async () => {
    // Rebuild to test the actual build output
    await $`bun run build`.cwd(join(import.meta.dir, ".."))
  })

  test("node_python_bridge.py exists in dist", () => {
    expect(existsSync(join(dist, "node_python_bridge.py"))).toBe(true)
  })

  test("no hardcoded CI runner paths in bundle", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    expect(code).not.toContain("home/runner")
  })

  test("__dirname is patched to runtime resolution", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    expect(code).toContain("import.meta.dirname")
    expect(code).not.toMatch(/var __dirname\s*=\s*"\//)
  })
})
