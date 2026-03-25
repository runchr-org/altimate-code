#!/usr/bin/env bun

/**
 * Pre-release sanity check — run BEFORE tagging a release.
 *
 * Verifies:
 * 1. All required external NAPI modules are in package.json dependencies
 * 2. The publish script will include them in the wrapper package
 * 3. A local build produces a binary that actually starts
 *
 * Usage: bun run packages/opencode/script/pre-release-check.ts
 */

import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(__dirname, "..")
const repoRoot = path.resolve(pkgDir, "../..")

const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"))

let failures = 0

function pass(msg: string) {
  console.log(`  ✓ ${msg}`)
}

function fail(msg: string) {
  console.error(`  ✗ ${msg}`)
  failures++
}

// ---------------------------------------------------------------------------
// Check 1: Required externals are in package.json dependencies
// ---------------------------------------------------------------------------
console.log("\n[1/4] Checking required externals in package.json...")

const requiredExternals = ["@altimateai/altimate-core"]

for (const ext of requiredExternals) {
  if (pkg.dependencies?.[ext]) {
    pass(`${ext} is in dependencies (${pkg.dependencies[ext]})`)
  } else {
    fail(`${ext} is NOT in dependencies — binary will crash at runtime`)
  }
}

// ---------------------------------------------------------------------------
// Check 2: Required externals are resolvable in node_modules
// ---------------------------------------------------------------------------
console.log("\n[2/4] Checking required externals are installed...")

for (const ext of requiredExternals) {
  try {
    require.resolve(ext)
    pass(`${ext} resolves from node_modules`)
  } catch {
    fail(`${ext} is NOT installed — run \`bun install\``)
  }
}

// ---------------------------------------------------------------------------
// Check 3: Build and smoke-test the binary
// ---------------------------------------------------------------------------
console.log("\n[3/4] Building local binary...")

const buildResult = spawnSync("bun", ["run", "build:local"], {
  cwd: pkgDir,
  encoding: "utf-8",
  timeout: 120_000,
  env: {
    ...process.env,
    MODELS_DEV_API_JSON: path.join(pkgDir, "test/tool/fixtures/models-api.json"),
  },
})

if (buildResult.status !== 0) {
  fail(`Build failed:\n${buildResult.stderr}`)
} else {
  pass("Local build succeeded")

  // Find the binary — walk recursively for scoped packages (@altimateai/...)
  const distDir = path.join(pkgDir, "dist")
  let binaryPath: string | undefined
  const binaryNames = process.platform === "win32" ? ["altimate.exe", "altimate"] : ["altimate"]
  function searchDist(dir: string): string | undefined {
    if (!fs.existsSync(dir)) return undefined
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sub = path.join(dir, entry.name)
      for (const name of binaryNames) {
        const candidate = path.join(sub, "bin", name)
        if (fs.existsSync(candidate)) return candidate
      }
      const nested = searchDist(sub)
      if (nested) return nested
    }
    return undefined
  }
  binaryPath = searchDist(distDir)

  if (!binaryPath) {
    fail("No binary found in dist/ after build")
  } else {
    console.log("\n[4/4] Smoke-testing compiled binary...")

    // Resolve NODE_PATH like the bin wrapper does — start from pkgDir
    // to include workspace-level node_modules where NAPI modules live
    const nodePaths: string[] = []
    let current = pkgDir
    for (;;) {
      const nm = path.join(current, "node_modules")
      if (fs.existsSync(nm)) nodePaths.push(nm)
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }

    const smokeResult = spawnSync(binaryPath, ["--version"], {
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_PATH: nodePaths.join(path.delimiter),
        OPENCODE_DISABLE_TELEMETRY: "1",
      },
    })

    if (smokeResult.status === 0) {
      const version = (smokeResult.stdout ?? "").trim()
      pass(`Binary starts successfully (${version})`)
    } else {
      const output = (smokeResult.stdout ?? "") + (smokeResult.stderr ?? "")
      fail(`Binary crashed on startup:\n${output}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("")
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s) failed. Do NOT tag a release.`)
  process.exit(1)
} else {
  console.log("ALL CHECKS PASSED. Safe to tag a release.")
}
