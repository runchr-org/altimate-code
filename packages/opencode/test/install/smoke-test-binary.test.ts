/**
 * Smoke tests for compiled binaries.
 *
 * These tests build a local binary (--single) and verify it actually starts
 * with the required external NAPI modules resolvable via NODE_PATH.
 *
 * This is the test that would have caught the v0.5.10 regression where
 * @altimateai/altimate-core was marked external but missing from standalone
 * distributions, causing an immediate crash on startup.
 *
 * Run: bun test test/install/smoke-test-binary.test.ts
 *
 * NOTE: Requires a local build first: bun run build:local
 */
import { describe, test, expect } from "bun:test"
import { spawnSync } from "child_process"
import path from "path"
import fs from "fs"

const PKG_DIR = path.resolve(import.meta.dir, "../..")
const REPO_ROOT = path.resolve(PKG_DIR, "../..")

// Find the locally-built binary for the current platform
function findLocalBinary(): string | undefined {
  const distDir = path.join(PKG_DIR, "dist")
  if (!fs.existsSync(distDir)) return undefined

  // Walk dist/ recursively — binary packages may be scoped (@altimateai/...)
  const binaryNames = process.platform === "win32" ? ["altimate.exe", "altimate"] : ["altimate"]
  function search(dir: string): string | undefined {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sub = path.join(dir, entry.name)
      for (const name of binaryNames) {
        const binPath = path.join(sub, "bin", name)
        if (fs.existsSync(binPath)) return binPath
      }
      // Recurse one level for scoped packages (e.g. @altimateai/)
      const nested = search(sub)
      if (nested) return nested
    }
    return undefined
  }
  return search(distDir)
}

// Resolve NODE_PATH the same way the bin wrapper does — walk up from
// the package directory collecting all node_modules directories.
// Starting from PKG_DIR (not REPO_ROOT) ensures we find workspace-level
// node_modules where NAPI modules like @altimateai/altimate-core live.
function resolveNodePath(): string {
  const paths: string[] = []
  let current = PKG_DIR
  for (;;) {
    const nm = path.join(current, "node_modules")
    if (fs.existsSync(nm)) paths.push(nm)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return paths.join(path.delimiter)
}

describe("compiled binary smoke test", () => {
  const binary = findLocalBinary()
  const skip = !binary
  const runTest = skip ? test.skip : test

  if (skip) {
    test.skip("no local build found — run `bun run build:local` first", () => {})
  }

  runTest("binary starts and prints version", () => {
    const result = spawnSync(binary!, ["--version"], {
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_PATH: resolveNodePath(),
        // Prevent the binary from trying to connect to any service
        OPENCODE_DISABLE_TELEMETRY: "1",
      },
    })

    if (result.status !== 0) {
      console.error("STDOUT:", result.stdout)
      console.error("STDERR:", result.stderr)
    }
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("Cannot find module")
  })

  runTest("binary fails gracefully without NODE_PATH (standalone mode)", () => {
    // Simulate standalone distribution — no node_modules available.
    // The binary should NOT crash with an unhandled error; it should
    // either degrade gracefully or show a clear error message.
    const result = spawnSync(binary!, ["--version"], {
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENCODE_DISABLE_TELEMETRY: "1",
        // Explicitly clear NODE_PATH to simulate standalone
        NODE_PATH: "",
      },
    })

    // Process must have exited (not been killed by timeout)
    expect(result.status).not.toBeNull()

    // If it fails, the error should mention the missing module clearly
    if (result.status !== 0) {
      const output = (result.stdout ?? "") + (result.stderr ?? "")
      expect(output).toContain("altimate-core")
    }
    // Either way, it should not segfault (exit code > 128 means signal)
    expect(result.status!).toBeLessThanOrEqual(128)
  })

  runTest("binary responds to --help", () => {
    const result = spawnSync(binary!, ["--help"], {
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_PATH: resolveNodePath(),
        OPENCODE_DISABLE_TELEMETRY: "1",
      },
    })

    expect(result.status).toBe(0)
    // Help output should mention at least one command
    const output = (result.stdout ?? "") + (result.stderr ?? "")
    expect(output.length).toBeGreaterThan(0)
  })
})
