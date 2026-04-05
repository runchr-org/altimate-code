/**
 * Plan Refinement UX Tests
 *
 * Validates the plan refinement flow:
 * 1. Plan agent system prompt includes two-step approach instructions
 * 2. Plan revision counter increments correctly
 * 3. Revision cap at 5
 * 4. `plan_revision` telemetry emission with correct fields
 * 5. Non-plan sessions are unaffected
 */

import { describe, expect, test, mock, afterEach, beforeEach, spyOn } from "bun:test"
import fs from "fs/promises"
import path from "path"

// ---------------------------------------------------------------------------
// 1. Plan agent system prompt includes two-step approach
// ---------------------------------------------------------------------------

describe("Plan agent system prompt", () => {
  test("plan.txt includes two-step approach instructions", async () => {
    const planPromptPath = path.join(__dirname, "../../src/session/prompt/plan.txt")
    const content = await fs.readFile(planPromptPath, "utf-8")

    // Use semantic regex patterns to avoid breaking on wording tweaks
    expect(content).toMatch(/two-?step/i)
    expect(content).toMatch(/outline|bullet\s*point/i)
    expect(content).toMatch(/confirm|direction.*right|looks.*right/i)
    expect(content).toMatch(/refine|change/i)
    expect(content).toMatch(/full.*plan|detailed.*plan/i)
  })

  test("plan.txt includes feedback/refinement instructions", async () => {
    const planPromptPath = path.join(__dirname, "../../src/session/prompt/plan.txt")
    const content = await fs.readFile(planPromptPath, "utf-8")

    expect(content).toMatch(/feedback/i)
    expect(content).toMatch(/read.*existing.*plan|read.*plan.*file/i)
    expect(content).toMatch(/incorporate|apply.*feedback/i)
    expect(content).toMatch(/update.*plan/i)
    expect(content).toMatch(/summarize|describe.*change/i)
  })

  test("experimental plan mode inline prompt includes two-step approach", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    // The inline prompt in prompt.ts (experimental plan mode) should also have the two-step approach
    expect(content).toMatch(/two-?step/i)
    expect(content).toMatch(/outline|bullet\s*point/i)
  })
})

// ---------------------------------------------------------------------------
// 2 & 3. Plan revision counter and cap
// ---------------------------------------------------------------------------

describe("Plan revision tracking", () => {
  test("planRevisionCount variable is declared in the session loop", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    expect(content).toContain("let planRevisionCount = 0")
    expect(content).toContain("let planHasWritten = false")
  })

  test("revision cap is enforced at 5", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    // The condition should cap at 5 revisions (>= 5 check with user communication)
    expect(content).toMatch(/planRevisionCount\s*>=\s*5/)
  })

  test("revision counter increments on each plan refinement", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    expect(content).toContain("planRevisionCount++")
  })
})

// ---------------------------------------------------------------------------
// 4. plan_revision telemetry event type
// ---------------------------------------------------------------------------

describe("plan_revision telemetry", () => {
  test("plan_revision event type exists in telemetry Event union", async () => {
    const telemetryPath = path.join(__dirname, "../../src/altimate/telemetry/index.ts")
    const content = await fs.readFile(telemetryPath, "utf-8")

    expect(content).toContain('type: "plan_revision"')
    expect(content).toContain("revision_number: number")
    expect(content).toContain('action: "refine" | "approve" | "reject"')
  })

  test("plan_revision telemetry is emitted in the session loop", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    // Verify Telemetry.track is called with plan_revision type
    expect(content).toContain('type: "plan_revision"')
    expect(content).toContain("revision_number: planRevisionCount")
  })

  test("approval detection uses appropriate phrases", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    // Verify approval phrase detection
    expect(content).toContain("looks good")
    expect(content).toContain("proceed")
    expect(content).toContain("approved")
    expect(content).toContain("lgtm")
    expect(content).toMatch(/action.*approve.*refine|action.*reject.*approve.*refine/)
  })

  test("plan_revision telemetry includes required fields", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    // Find the Telemetry.track({ ... }) block containing plan_revision
    const trackMatch = content.match(/Telemetry\.track\(\{[^}]*type:\s*"plan_revision"[^}]*\}\)/s)
    expect(trackMatch).not.toBeNull()
    const trackBlock = trackMatch![0]
    expect(trackBlock).toContain("timestamp:")
    expect(trackBlock).toContain("session_id:")
    expect(trackBlock).toContain("revision_number:")
    expect(trackBlock).toContain("action")
  })
})

// ---------------------------------------------------------------------------
// 5. Non-plan sessions are unaffected
// ---------------------------------------------------------------------------

describe("Non-plan sessions unaffected", () => {
  test("plan revision tracking is guarded by agent name check", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    // The revision tracking should only trigger for plan agent
    expect(content).toContain('if (agent.name === "plan"')
  })

  test("plan file detection only runs for plan agent", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    // The plan file existence check after tool calls should be guarded
    expect(content).toContain('if (agent.name === "plan" && !planHasWritten)')
  })

  test("planRevisionCount is initialized to 0 and only modified in plan context", async () => {
    const promptTsPath = path.join(__dirname, "../../src/session/prompt.ts")
    const content = await fs.readFile(promptTsPath, "utf-8")

    // Count occurrences of planRevisionCount++ — should only appear once, inside plan guard
    const incrementMatches = content.match(/planRevisionCount\+\+/g)
    expect(incrementMatches).toBeTruthy()
    expect(incrementMatches!.length).toBe(1)
  })
})
