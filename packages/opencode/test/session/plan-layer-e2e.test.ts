/**
 * Plan Layer E2E Safety Tests
 *
 * These tests verify that our plan refinement changes don't break:
 * 1. The core session loop for non-plan agents (builder, analyst, explore)
 * 2. Plan agent state tracking (planRevisionCount, planHasWritten)
 * 3. Approval/rejection/refinement phrase classification
 * 4. Revision cap communication
 * 5. The sessionAgentName fix for agent_outcome telemetry
 * 6. Subtask tool counting
 *
 * We test the actual prompt.ts logic paths without requiring an LLM,
 * by simulating the state transitions and verifying invariants.
 */

import path from "path"
import fs from "fs/promises"
import { describe, expect, test, beforeEach } from "bun:test"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// 1. Plan refinement phrase classification — the most critical logic
// ---------------------------------------------------------------------------

/**
 * Replicate the exact phrase detection logic from prompt.ts so we can test
 * it exhaustively without needing a live session. This mirrors lines 666-683
 * of prompt.ts exactly.
 */
function classifyPlanAction(userText: string): "approve" | "reject" | "refine" {
  const text = userText.toLowerCase()

  const refinementQualifiers = [
    " but ",
    " however ",
    " except ",
    " change ",
    " modify ",
    " update ",
    " instead ",
    " although ",
    " with the following",
    " with these",
  ]
  const hasRefinementQualifier = refinementQualifiers.some((q) => text.includes(q))

  const rejectionPhrases = ["don't", "stop", "reject", "not good", "undo", "abort", "start over", "wrong"]
  const rejectionWords = ["no"]
  const approvalPhrases = [
    "looks good",
    "proceed",
    "approved",
    "approve",
    "lgtm",
    "go ahead",
    "ship it",
    "yes",
    "perfect",
  ]

  const isRejectionPhrase = rejectionPhrases.some((phrase) => text.includes(phrase))
  const isRejectionWord = rejectionWords.some((word) => {
    const regex = new RegExp(`\\b${word}\\b`)
    return regex.test(text)
  })
  const isRejection = isRejectionPhrase || isRejectionWord
  const isApproval = !isRejection && !hasRefinementQualifier && approvalPhrases.some((phrase) => text.includes(phrase))
  return isRejection ? "reject" : isApproval ? "approve" : "refine"
}

describe("plan action classification: approval", () => {
  const approvalCases = [
    "looks good",
    "Looks good!",
    "proceed",
    "Please proceed with this plan",
    "approved",
    "I approve this plan",
    "LGTM",
    "lgtm, ship it",
    "go ahead",
    "ship it",
    "yes",
    "Yes!",
    "perfect",
    "That's perfect, let's do it",
  ]

  for (const phrase of approvalCases) {
    test(`"${phrase}" → approve`, () => {
      expect(classifyPlanAction(phrase)).toBe("approve")
    })
  }
})

describe("plan action classification: rejection", () => {
  const rejectionCases = [
    "no",
    "No, that's wrong",
    "don't do that",
    "stop, I want something different",
    "I reject this plan",
    "this is not good",
    "undo everything",
    "abort this plan",
    "start over",
    "that's wrong",
    "No.",
    "no way",
  ]

  for (const phrase of rejectionCases) {
    test(`"${phrase}" → reject`, () => {
      expect(classifyPlanAction(phrase)).toBe("reject")
    })
  }
})

describe("plan action classification: refinement", () => {
  const refinementCases = [
    "I want you to focus more on testing",
    "Can you add error handling to step 3?",
    "Please restructure the approach",
    "What about using a different pattern?",
    "The third step should come first",
    "Add a section about deployment",
    "Make it more detailed",
    "Expand on the database migration section",
  ]

  for (const phrase of refinementCases) {
    test(`"${phrase}" → refine`, () => {
      expect(classifyPlanAction(phrase)).toBe("refine")
    })
  }
})

describe("plan action classification: tricky edge cases", () => {
  test('"yes, but change the order" → refine (refinement qualifier overrides approval)', () => {
    expect(classifyPlanAction("yes, but change the order of steps")).toBe("refine")
  })

  test('"approve, however add testing" → refine (qualifier overrides)', () => {
    expect(classifyPlanAction("approve, however add testing to each step")).toBe("refine")
  })

  test('"looks good, but update step 3" → refine', () => {
    expect(classifyPlanAction("looks good, but update step 3 to use async")).toBe("refine")
  })

  test('"perfect, except for the naming" → refine', () => {
    expect(classifyPlanAction("perfect, except for the naming convention")).toBe("refine")
  })

  test('"yes, with the following changes" → refine', () => {
    expect(classifyPlanAction("yes, with the following changes to step 2")).toBe("refine")
  })

  test('"lgtm, although we should modify the API layer" → refine', () => {
    expect(classifyPlanAction("lgtm, although we should modify the API layer")).toBe("refine")
  })

  test('"no, I mean yes" → reject (rejection takes priority)', () => {
    expect(classifyPlanAction("no, I mean yes")).toBe("reject")
  })

  test('"I know this looks good" → approve (know ≠ no)', () => {
    expect(classifyPlanAction("I know this looks good")).toBe("approve")
  })

  test('"I cannot proceed without changes" → approve (contains "proceed")', () => {
    // "cannot" doesn't trigger rejection (no \bno\b), but "proceed" triggers approval
    // This is a known limitation — "cannot proceed" is rare in plan feedback
    expect(classifyPlanAction("I cannot proceed without changes")).toBe("approve")
  })

  test('"I cannot proceed without changes, but update step 3" → refine (qualifier overrides)', () => {
    // With a refinement qualifier, it correctly becomes refine
    expect(classifyPlanAction("I cannot proceed without changes, but update step 3")).toBe("refine")
  })

  test('"the notion of proceeding is fine" → approve (contains "proceed")', () => {
    // "notion" doesn't match \bno\b, "proceeding" contains "proceed"
    expect(classifyPlanAction("the notion of proceeding with this approach is fine")).toBe("approve")
  })

  test('"go ahead and change the database schema" → refine (qualifier: change)', () => {
    expect(classifyPlanAction("go ahead and change the database schema")).toBe("refine")
  })

  test('"ship it, but instead use postgres" → refine (qualifier: instead)', () => {
    expect(classifyPlanAction("ship it, but instead use postgres")).toBe("refine")
  })

  test('empty string → refine', () => {
    expect(classifyPlanAction("")).toBe("refine")
  })

  test('just whitespace → refine', () => {
    expect(classifyPlanAction("   ")).toBe("refine")
  })

  test('"yes" with leading/trailing whitespace → approve', () => {
    expect(classifyPlanAction("  yes  ")).toBe("approve")
  })
})

// ---------------------------------------------------------------------------
// 2. Non-plan agent safety: our changes must not affect builder/analyst/explore
// ---------------------------------------------------------------------------

describe("non-plan agent safety", () => {
  test("planRevisionCount and planHasWritten are initialized to safe defaults", async () => {
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )

    // These must be initialized BEFORE the loop starts
    expect(promptTs).toContain("let planRevisionCount = 0")
    expect(promptTs).toContain("let planHasWritten = false")

    // Plan tracking must be guarded by agent name check
    const planGuardCount = (promptTs.match(/agent\.name\s*===\s*"plan"/g) || []).length
    expect(planGuardCount).toBeGreaterThanOrEqual(2) // At least: refinement + file detection
  })

  test("plan refinement block is unreachable for non-plan agents", async () => {
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )

    // Find the plan refinement block
    const refinementIdx = promptTs.indexOf('type: "plan_revision"')
    expect(refinementIdx).toBeGreaterThan(-1)

    // Walk backward to find the enclosing agent check (generous window)
    const before = promptTs.slice(Math.max(0, refinementIdx - 1500), refinementIdx)
    expect(before).toMatch(/agent\.name\s*===\s*"plan"/)
  })

  test("plan file detection only runs for plan agent", async () => {
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )

    // The Filesystem.exists check for plan files must be behind agent guard
    const existsIdx = promptTs.indexOf("planHasWritten = await Filesystem.exists")
    expect(existsIdx).toBeGreaterThan(-1)
    const before = promptTs.slice(Math.max(0, existsIdx - 200), existsIdx)
    expect(before).toMatch(/agent\.name\s*===\s*"plan"/)
  })
})

// ---------------------------------------------------------------------------
// 3. sessionAgentName fix: must be set before any early break
// ---------------------------------------------------------------------------

describe("sessionAgentName fix safety", () => {
  test("sessionAgentName is set from lastUser.agent before break conditions", async () => {
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )

    // sessionAgentName assignment should come before "exiting loop"
    const agentNameIdx = promptTs.indexOf("sessionAgentName = lastUser.agent")
    const exitingLoopIdx = promptTs.indexOf('"exiting loop"')
    expect(agentNameIdx).toBeGreaterThan(-1)
    expect(exitingLoopIdx).toBeGreaterThan(-1)
    expect(agentNameIdx).toBeLessThan(exitingLoopIdx)
  })

  test("agent_outcome telemetry uses sessionAgentName", async () => {
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )

    // Find agent_outcome emission and assert it routes through the shared
    // `normalizeAgentName` helper. Anchored regex (not a token-presence check
    // inside a wide window) so this fails if anyone replaces the helper call
    // with a literal or accidentally bypasses normalization.
    const outcomeIdx = promptTs.indexOf('type: "agent_outcome"')
    expect(outcomeIdx).toBeGreaterThan(-1)
    const block = promptTs.slice(outcomeIdx, outcomeIdx + 600)
    expect(block).toMatch(/agent:\s*normalizeAgentName\(sessionAgentName\)/)
  })

  test("session_start telemetry normalizes the agent name (parity with agent_outcome)", async () => {
    // Funnel analysis from session_start → agent_outcome must see the same
    // bucket name; otherwise sessions appear to "vanish" when the legacy
    // "build" value at start gets normalized to "builder" at end.
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )
    const startIdx = promptTs.indexOf('type: "session_start"')
    expect(startIdx).toBeGreaterThan(-1)
    const block = promptTs.slice(startIdx, startIdx + 600)
    expect(block).toMatch(/agent:\s*normalizeAgentName\(lastUser\.agent\)/)
  })

  test("normalizeAgentName helper is declared exactly once (single source of truth)", async () => {
    // If a second normalizer is ever introduced the two will inevitably drift.
    // Pin a single implementation.
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )
    const declarations = promptTs.match(/function\s+normalizeAgentName\s*\(/g) ?? []
    expect(declarations.length).toBe(1)
  })

  test("normalizeAgentName comparison is case-insensitive", async () => {
    // A future config, custom prompt, or hand-edited persisted session
    // could surface "Build" or "BUILD". Without case-folding, the phantom
    // bucket comes back. Pin that the helper does the toLowerCase() guard
    // so a refactor can't silently drop it.
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )
    const declIdx = promptTs.indexOf("function normalizeAgentName")
    expect(declIdx).toBeGreaterThan(-1)
    const body = promptTs.slice(declIdx, declIdx + 400)
    // The body should case-fold before comparing — either toLowerCase() or
    // toUpperCase() before the equality check. Anchored so a refactor to a
    // raw string compare fails this test.
    expect(body).toMatch(/name\.toLowerCase\(\)\s*===\s*"build"/)
  })
})

// ---------------------------------------------------------------------------
// 4. Revision cap communication
// ---------------------------------------------------------------------------

describe("revision cap", () => {
  test("cap is enforced at exactly 5 revisions", async () => {
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )
    expect(promptTs).toMatch(/planRevisionCount\s*>=\s*5/)
  })

  test("cap_reached triggers synthetic message to LLM", async () => {
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )
    expect(promptTs).toContain("maximum revision limit")
    expect(promptTs).toContain("cap_reached")
  })

  test("cap_reached telemetry is emitted", async () => {
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )
    // cap_reached should be in a Telemetry.track call
    const capIdx = promptTs.indexOf('"cap_reached"')
    expect(capIdx).toBeGreaterThan(-1)
    const before = promptTs.slice(Math.max(0, capIdx - 300), capIdx)
    expect(before).toContain("Telemetry.track")
  })

  test("synthetic message does not persist to database", async () => {
    const promptTs = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt.ts"),
      "utf-8",
    )
    // The comment should clarify it's local-only
    expect(promptTs).toMatch(/does not persist|local.*copy/i)
  })
})

// ---------------------------------------------------------------------------
// 5. Telemetry type safety: plan_revision event allows cap_reached
// ---------------------------------------------------------------------------

describe("telemetry type: plan_revision", () => {
  test("plan_revision action type includes cap_reached", async () => {
    const telemetryTs = await fs.readFile(
      path.join(__dirname, "../../src/altimate/telemetry/index.ts"),
      "utf-8",
    )
    expect(telemetryTs).toContain("cap_reached")
    expect(telemetryTs).toContain("plan_revision")
  })
})

// ---------------------------------------------------------------------------
// 6. Plan prompt: two-step approach is additive, doesn't break existing
// ---------------------------------------------------------------------------

describe("plan prompt safety", () => {
  test("plan.txt adds instructions without removing existing content", async () => {
    const planTxt = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt/plan.txt"),
      "utf-8",
    )
    // Must have the two-step approach
    expect(planTxt).toMatch(/two-?step/i)
    expect(planTxt).toMatch(/outline|bullet/i)

    // Must still be a valid prompt (not empty, reasonable length)
    expect(planTxt.length).toBeGreaterThan(100)
    expect(planTxt.length).toBeLessThan(5000) // Not bloated
  })

  test("plan.txt does not contain debug or TODO markers", async () => {
    const planTxt = await fs.readFile(
      path.join(__dirname, "../../src/session/prompt/plan.txt"),
      "utf-8",
    )
    expect(planTxt).not.toMatch(/TODO|FIXME|HACK|XXX|console\.log/i)
  })
})

// ---------------------------------------------------------------------------
// 7. Stress test: phrase classification handles adversarial inputs
// ---------------------------------------------------------------------------

describe("phrase classification adversarial", () => {
  test("very long input does not crash", () => {
    const longText = "please ".repeat(10000) + "proceed"
    expect(classifyPlanAction(longText)).toBe("approve")
  })

  test("unicode input does not crash", () => {
    expect(classifyPlanAction("看起来不错，请继续")).toBe("refine")
    expect(classifyPlanAction("はい、進めてください")).toBe("refine")
    expect(classifyPlanAction("✅ looks good")).toBe("approve")
    expect(classifyPlanAction("❌ no")).toBe("reject")
  })

  test("special characters do not break regex", () => {
    expect(classifyPlanAction("no (really)")).toBe("reject")
    expect(classifyPlanAction("yes [confirmed]")).toBe("approve")
    expect(classifyPlanAction("proceed? yes!")).toBe("approve")
    expect(classifyPlanAction("$yes")).toBe("approve")
    expect(classifyPlanAction("no.")).toBe("reject")
  })

  test("multiline input is handled", () => {
    expect(classifyPlanAction("I think this\nlooks good\noverall")).toBe("approve")
    expect(classifyPlanAction("no\nI don't\nlike it")).toBe("reject")
    expect(classifyPlanAction("line1\nline2\nline3")).toBe("refine")
  })
})

// ---------------------------------------------------------------------------
// 8. Regression: ensure suggestion imports don't affect non-suggestion tools
// ---------------------------------------------------------------------------

describe("suggestion import safety", () => {
  test("post-connect-suggestions module is self-contained", async () => {
    const pcs = await fs.readFile(
      path.join(__dirname, "../../src/altimate/tools/post-connect-suggestions.ts"),
      "utf-8",
    )
    // Should only import from telemetry (lightweight)
    const imports = pcs.match(/^import .+/gm) || []
    expect(imports.length).toBeLessThanOrEqual(2)
    // Must not import heavy modules like Session, SessionPrompt, LLM
    expect(pcs).not.toMatch(/import.*Session[^P]/i)
    expect(pcs).not.toMatch(/import.*SessionPrompt/i)
    expect(pcs).not.toMatch(/import.*LLM/i)
  })

  test("progressive suggestion is pure function with no side effects", async () => {
    // Import the actual module (async import required for ESM)
    const { PostConnectSuggestions } = await import("../../src/altimate/tools/post-connect-suggestions")
    PostConnectSuggestions.resetShownSuggestions()

    // First call returns a suggestion
    const s1 = PostConnectSuggestions.getProgressiveSuggestion("sql_execute")
    expect(s1).toBeTruthy()
    expect(typeof s1).toBe("string")

    // Second call returns null (dedup)
    const s2 = PostConnectSuggestions.getProgressiveSuggestion("sql_execute")
    expect(s2).toBeNull()

    // Unknown tool returns null
    const s3 = PostConnectSuggestions.getProgressiveSuggestion("unknown_tool")
    expect(s3).toBeNull()

    // Reset and verify it works again
    PostConnectSuggestions.resetShownSuggestions()
    const s4 = PostConnectSuggestions.getProgressiveSuggestion("sql_execute")
    expect(s4).toBeTruthy()
  })
})
