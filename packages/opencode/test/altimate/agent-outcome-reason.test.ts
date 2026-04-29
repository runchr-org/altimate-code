/**
 * Unit tests for Telemetry.deriveAgentOutcomeReason — the helper that
 * populates the diagnostic fields (final_tool, error_class, reason)
 * on the agent_outcome telemetry event.
 *
 * Why these tests matter: ~30% of builder runs end with outcome != completed,
 * and before this helper existed the event payload had empty diagnostic fields
 * for all of them, making the failures undiagnosable from telemetry alone.
 */
import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"

const baseInput = {
  lastToolName: null as string | null,
  lastMessageError: null as string | null,
  abortReason: null as string | null,
  lastErrorClass: "",
}

describe("deriveAgentOutcomeReason", () => {
  test("completed outcome: empty diagnostic fields, final_tool preserved", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "completed",
      lastToolName: "edit",
    })
    expect(out.final_tool).toBe("edit")
    expect(out.error_class).toBe("")
    expect(out.reason).toBe("")
  })

  test("completed outcome with no tool: final_tool empty", () => {
    const out = Telemetry.deriveAgentOutcomeReason({ ...baseInput, outcome: "completed" })
    expect(out.final_tool).toBe("")
    expect(out.error_class).toBe("")
    expect(out.reason).toBe("")
  })

  test("abandoned outcome: reason is 'no_tools_invoked'", () => {
    const out = Telemetry.deriveAgentOutcomeReason({ ...baseInput, outcome: "abandoned" })
    expect(out.final_tool).toBe("")
    expect(out.error_class).toBe("")
    expect(out.reason).toBe("no_tools_invoked")
  })

  test("aborted with explicit reason: reason carried through (masked)", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "aborted",
      lastToolName: "sql_execute",
      abortReason: "user pressed escape",
    })
    expect(out.final_tool).toBe("sql_execute")
    expect(out.error_class).toBe("")
    expect(out.reason).toBe("user pressed escape")
  })

  test("aborted without reason: defaults to 'user_cancelled'", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "aborted",
      lastToolName: "edit",
    })
    expect(out.final_tool).toBe("edit")
    expect(out.reason).toBe("user_cancelled")
  })

  test("aborted reason is masked (quoted secrets stripped)", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "aborted",
      abortReason: 'cancel because "sk-secret-token-12345"',
    })
    expect(out.reason).not.toContain("sk-secret-token-12345")
  })

  test("aborted reason is truncated to 200 chars", () => {
    const longReason = "x".repeat(500)
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "aborted",
      abortReason: longReason,
    })
    expect(out.reason.length).toBe(200)
  })

  test("aborted with prior tool error: surfaces lastErrorClass", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "aborted",
      lastToolName: "data_diff",
      lastErrorClass: "connection",
      abortReason: "user_cancelled",
    })
    expect(out.error_class).toBe("connection")
  })

  test("error outcome with file_not_found message: classified", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "error",
      lastToolName: "read",
      lastMessageError: "ENOENT: no such file or directory",
    })
    expect(out.final_tool).toBe("read")
    expect(out.error_class).toBe("file_not_found")
    expect(out.reason).toContain("ENOENT")
  })

  test("error outcome with edit_mismatch message: classified", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "error",
      lastToolName: "edit",
      lastMessageError: "could not find oldString in file",
    })
    expect(out.error_class).toBe("edit_mismatch")
  })

  test("error outcome with unknown message: classified as 'unknown'", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "error",
      lastMessageError: "something weird happened that nobody anticipated",
    })
    expect(out.error_class).toBe("unknown")
  })

  test("error outcome with empty message: error_class is 'unknown'", () => {
    const out = Telemetry.deriveAgentOutcomeReason({ ...baseInput, outcome: "error" })
    expect(out.error_class).toBe("unknown")
    expect(out.reason).toBe("")
  })

  test("error reason masking: quoted API key is stripped", () => {
    const errMsg = 'request failed with "sk-abcdef0123456789"'
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "error",
      lastMessageError: errMsg,
    })
    expect(out.reason).not.toContain("sk-abcdef0123456789")
    expect(out.reason.length).toBeLessThanOrEqual(500)
  })

  test("error reason: truncated to 500 chars", () => {
    const longErr = "boom: ".concat("a".repeat(1000))
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "error",
      lastMessageError: longErr,
    })
    expect(out.reason.length).toBeLessThanOrEqual(500)
  })

  test("MCP-namespaced tool name preserved verbatim in final_tool", () => {
    const out = Telemetry.deriveAgentOutcomeReason({
      ...baseInput,
      outcome: "completed",
      lastToolName: "mcp__playwright__navigate",
    })
    expect(out.final_tool).toBe("mcp__playwright__navigate")
  })

  test("all four outcomes always populate the three fields (no undefined)", () => {
    const outcomes = ["completed", "abandoned", "aborted", "error"] as const
    for (const outcome of outcomes) {
      const out = Telemetry.deriveAgentOutcomeReason({
        outcome,
        lastToolName: "x",
        lastMessageError: "fail",
        abortReason: "cancel",
        lastErrorClass: "unknown",
      })
      expect(typeof out.final_tool).toBe("string")
      expect(typeof out.error_class).toBe("string")
      expect(typeof out.reason).toBe("string")
    }
  })
})
