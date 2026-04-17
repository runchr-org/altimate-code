/**
 * CLI-level integration tests for pack activation/deactivation/removal lifecycle.
 * Exercises the cleanupPackActivation helper directly — ownership-aware MCP
 * cleanup, canonical-name plugin refcounting, sidecar roundtrip, and the
 * legacy-fallback path when the sidecar is missing.
 */
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Pack } from "../../src/pack"
import { Instance } from "../../src/project/instance"
import { cleanupPackActivation } from "../../src/cli/cmd/pack"
import { tmpdir } from "../fixture/fixture"

async function writeOpenCodeConfig(rootDir: string, config: Record<string, unknown>): Promise<string> {
  const dir = path.join(rootDir, ".opencode")
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, "opencode.json")
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8")
  return filePath
}

async function readConfig(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(filePath, "utf-8")
  return JSON.parse(raw)
}

async function writePack(
  rootDir: string,
  name: string,
  body: string,
): Promise<string> {
  const packDir = path.join(rootDir, ".opencode", "packs", name)
  await fs.mkdir(packDir, { recursive: true })
  const packFile = path.join(packDir, "PACK.yaml")
  await fs.writeFile(packFile, body, "utf-8")
  return packFile
}

describe("cleanupPackActivation — MCP ownership (sidecar present)", () => {
  test("removes only MCP entries the pack wrote when config matches sidecar record", async () => {
    await using tmp = await tmpdir({ git: true })
    const configPath = await writeOpenCodeConfig(tmp.path, {
      mcp: {
        "pack-mcp": { type: "local", command: ["uvx", "pack-server"] },
        "user-mcp": { type: "local", command: ["my-personal-server"] },
      },
    })
    await Pack.writeActivationSidecar(tmp.path, {
      pack_name: "test-pack",
      activated_at: new Date().toISOString(),
      mcp: [
        ["pack-mcp", JSON.stringify({ type: "local", command: ["uvx", "pack-server"] })],
      ],
      plugins: [],
      instructions_file: null,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await cleanupPackActivation(tmp.path, undefined, "test-pack", [])
        expect(result.mcpCleaned).toBe(1)
        expect(result.skippedMcpKeys).toEqual([])

        const config = await readConfig(configPath)
        const mcp = config.mcp as Record<string, unknown>
        expect(mcp["pack-mcp"]).toBeUndefined()
        expect(mcp["user-mcp"]).toBeDefined()
      },
    })
  })

  test("preserves MCP entries that the user modified after activation (skippedMcpKeys reports them)", async () => {
    await using tmp = await tmpdir({ git: true })
    const configPath = await writeOpenCodeConfig(tmp.path, {
      mcp: {
        "pack-mcp": {
          // User edited the command after pack activated.
          type: "local",
          command: ["uvx", "pack-server", "--custom-flag"],
        },
      },
    })
    await Pack.writeActivationSidecar(tmp.path, {
      pack_name: "test-pack",
      activated_at: new Date().toISOString(),
      mcp: [
        ["pack-mcp", JSON.stringify({ type: "local", command: ["uvx", "pack-server"] })],
      ],
      plugins: [],
      instructions_file: null,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await cleanupPackActivation(tmp.path, undefined, "test-pack", [])
        expect(result.mcpCleaned).toBe(0)
        expect(result.skippedMcpKeys).toEqual(["pack-mcp"])

        const config = await readConfig(configPath)
        const mcp = config.mcp as Record<string, unknown>
        expect(mcp["pack-mcp"]).toBeDefined()
      },
    })
  })
})

describe("cleanupPackActivation — plugin refcount by canonical name", () => {
  test("keeps plugins that another active pack still lists (same canonical name, different version specs)", async () => {
    await using tmp = await tmpdir({ git: true })
    const configPath = await writeOpenCodeConfig(tmp.path, {
      plugin: ["@scope/plugin@^1.0", "@scope/plugin@1.2.3", "@other/plugin@^2.0"],
    })
    // Pack A owns @scope/plugin@^1.0; Pack B (still active) also uses it via a
    // different version spec. Deactivating A should leave the plugin in place
    // because canonical @scope/plugin is still needed.
    await Pack.writeActivationSidecar(tmp.path, {
      pack_name: "pack-a",
      activated_at: new Date().toISOString(),
      mcp: [],
      plugins: ["@scope/plugin@^1.0"],
      instructions_file: null,
    })

    const packB: Pack.Info = {
      name: "pack-b",
      description: "shares the plugin",
      version: "1.0.0",
      location: "/nonexistent/pack-b/PACK.yaml",
      tier: "community",
      skills: [],
      skill_groups: {},
      mcp: {},
      plugins: ["@scope/plugin@1.2.3"],
      instructions: undefined,
      detect: [],
      content: "",
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await cleanupPackActivation(tmp.path, undefined, "pack-a", [packB])
        // Canonical @scope/plugin still needed by pack-b → keep it.
        expect(result.pluginsCleaned).toBe(0)

        const config = await readConfig(configPath)
        expect(config.plugin).toEqual(["@scope/plugin@^1.0", "@scope/plugin@1.2.3", "@other/plugin@^2.0"])
      },
    })
  })

  test("removes plugins when no other active pack needs the canonical name", async () => {
    await using tmp = await tmpdir({ git: true })
    const configPath = await writeOpenCodeConfig(tmp.path, {
      plugin: ["@scope/plugin@^1.0", "@other/plugin@^2.0"],
    })
    await Pack.writeActivationSidecar(tmp.path, {
      pack_name: "pack-a",
      activated_at: new Date().toISOString(),
      mcp: [],
      plugins: ["@scope/plugin@^1.0"],
      instructions_file: null,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await cleanupPackActivation(tmp.path, undefined, "pack-a", [])
        expect(result.pluginsCleaned).toBe(1)

        const config = await readConfig(configPath)
        expect(config.plugin).toEqual(["@other/plugin@^2.0"])
      },
    })
  })
})

describe("cleanupPackActivation — sidecar missing (legacy fallback)", () => {
  test("falls back to name-only MCP removal from the pack definition and flags sidecarMissing", async () => {
    await using tmp = await tmpdir({ git: true })
    const configPath = await writeOpenCodeConfig(tmp.path, {
      mcp: { "legacy-mcp": { type: "local", command: ["foo"] } },
    })
    const pack: Pack.Info = {
      name: "legacy-pack",
      description: "no sidecar",
      version: "1.0.0",
      location: "/nonexistent/legacy/PACK.yaml",
      tier: "community",
      skills: [],
      skill_groups: {},
      mcp: {
        "legacy-mcp": { type: "stdio", command: ["foo"] },
      },
      plugins: [],
      instructions: undefined,
      detect: [],
      content: "",
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await cleanupPackActivation(tmp.path, pack, "legacy-pack", [])
        expect(result.sidecarMissing).toBe(true)
        expect(result.mcpCleaned).toBe(1)

        const config = await readConfig(configPath)
        const mcp = config.mcp as Record<string, unknown>
        expect(mcp["legacy-mcp"]).toBeUndefined()
      },
    })
  })

  test("no-ops gracefully when there is no config file at all", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await cleanupPackActivation(tmp.path, undefined, "nonexistent-pack", [])
        expect(result.mcpCleaned).toBe(0)
        expect(result.pluginsCleaned).toBe(0)
        expect(result.sidecarMissing).toBe(true)
        // Importantly: we don't scaffold a fresh config file just to clean up
        // nothing. Assert no .opencode/opencode.json was created.
        const configPath = path.join(tmp.path, ".opencode", "opencode.json")
        await expect(fs.access(configPath)).rejects.toThrow()
      },
    })
  })
})

describe("cleanupPackActivation — instructions file", () => {
  test("removes pack-scoped instructions file and reports it", async () => {
    await using tmp = await tmpdir({ git: true })
    const instructionsDir = path.join(tmp.path, ".opencode", "instructions")
    await fs.mkdir(instructionsDir, { recursive: true })
    const instructionsFile = path.join(instructionsDir, "pack-docs-pack.md")
    await fs.writeFile(instructionsFile, "Test instructions", "utf-8")

    await Pack.writeActivationSidecar(tmp.path, {
      pack_name: "docs-pack",
      activated_at: new Date().toISOString(),
      mcp: [],
      plugins: [],
      instructions_file: path.relative(tmp.path, instructionsFile),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await cleanupPackActivation(tmp.path, undefined, "docs-pack", [])
        expect(result.instructionsCleaned).toBe(true)
        await expect(fs.access(instructionsFile)).rejects.toThrow()
      },
    })
  })
})

describe("Pack activation sidecar roundtrip", () => {
  test("writeActivationSidecar → readActivationSidecar preserves all fields", async () => {
    await using tmp = await tmpdir({ git: true })
    const sidecar: Pack.ActivationSidecar = {
      pack_name: "rt-pack",
      activated_at: "2026-04-17T12:00:00.000Z",
      mcp: [
        ["server-a", JSON.stringify({ type: "local", command: ["a"] })],
        ["server-b", JSON.stringify({ type: "remote", url: "https://b.example" })],
      ],
      plugins: ["@x/plugin@^1.0", "file:///local/plugin"],
      instructions_file: ".opencode/instructions/pack-rt-pack.md",
    }
    await Pack.writeActivationSidecar(tmp.path, sidecar)
    const round = await Pack.readActivationSidecar(tmp.path, "rt-pack")
    expect(round).toEqual(sidecar)
  })

  test("deleteActivationSidecar removes the file and is idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Pack.writeActivationSidecar(tmp.path, {
      pack_name: "gone-pack",
      activated_at: new Date().toISOString(),
      mcp: [],
      plugins: [],
      instructions_file: null,
    })
    await Pack.deleteActivationSidecar(tmp.path, "gone-pack")
    const after = await Pack.readActivationSidecar(tmp.path, "gone-pack")
    expect(after).toBeUndefined()

    // Second delete should not throw.
    await Pack.deleteActivationSidecar(tmp.path, "gone-pack")
  })

  test("readActivationSidecar returns undefined for malformed JSON", async () => {
    await using tmp = await tmpdir({ git: true })
    const sidecarDir = path.join(tmp.path, ".opencode", "pack-state")
    await fs.mkdir(sidecarDir, { recursive: true })
    await fs.writeFile(path.join(sidecarDir, "bad.json"), "{ not: valid json }", "utf-8")
    const result = await Pack.readActivationSidecar(tmp.path, "bad")
    expect(result).toBeUndefined()
  })
})

describe("Pack.deactivate — legacy .altimate-code fallback", () => {
  test("finds and updates active-packs in .altimate-code/ when .opencode/ has none", async () => {
    await using tmp = await tmpdir({ git: true })
    // Only populate the legacy location.
    const legacyDir = path.join(tmp.path, ".altimate-code")
    await fs.mkdir(legacyDir, { recursive: true })
    const legacyFile = path.join(legacyDir, "active-packs")
    await fs.writeFile(legacyFile, "legacy-pack\nother-pack\n", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Pack.deactivate("legacy-pack")
        const content = await fs.readFile(legacyFile, "utf-8")
        expect(content.trim()).toBe("other-pack")
      },
    })
  })
})
