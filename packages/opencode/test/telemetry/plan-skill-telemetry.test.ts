import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/telemetry"

// ---------------------------------------------------------------------------
// 1. classifySkillTrigger — trigger source classification
// ---------------------------------------------------------------------------
describe("telemetry.classifySkillTrigger", () => {
  test("returns 'llm_selected' when no extra context is provided", () => {
    expect(Telemetry.classifySkillTrigger()).toBe("llm_selected")
    expect(Telemetry.classifySkillTrigger(undefined)).toBe("llm_selected")
  })

  test("returns 'unknown' when extra has no trigger field", () => {
    expect(Telemetry.classifySkillTrigger({})).toBe("unknown")
    expect(Telemetry.classifySkillTrigger({ foo: "bar" })).toBe("unknown")
  })

  test("returns 'user_command' when extra.trigger is 'user_command'", () => {
    expect(Telemetry.classifySkillTrigger({ trigger: "user_command" })).toBe("user_command")
  })

  test("returns 'auto_suggested' when extra.trigger is 'auto_suggested'", () => {
    expect(Telemetry.classifySkillTrigger({ trigger: "auto_suggested" })).toBe("auto_suggested")
  })

  test("returns 'llm_selected' when extra.trigger is 'llm_selected'", () => {
    expect(Telemetry.classifySkillTrigger({ trigger: "llm_selected" })).toBe("llm_selected")
  })

  test("returns 'unknown' for unrecognized trigger values", () => {
    expect(Telemetry.classifySkillTrigger({ trigger: "something_else" })).toBe("unknown")
    expect(Telemetry.classifySkillTrigger({ trigger: 42 })).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// 2. New event types — plan_revision and feature_suggestion are valid
// ---------------------------------------------------------------------------
describe("telemetry.new-event-types", () => {
  test("plan_revision event type is valid and structurally correct", () => {
    const event: Telemetry.Event = {
      type: "plan_revision",
      timestamp: Date.now(),
      session_id: "test-session",
      revision_number: 3,
      action: "refine",
    }
    expect(event.type).toBe("plan_revision")
    expect(event.revision_number).toBe(3)
    expect(event.action).toBe("refine")
    // Runtime verification: track should not throw
    expect(() => Telemetry.track(event)).not.toThrow()
  })

  test("plan_revision supports all action values", () => {
    const actions: Array<"refine" | "approve" | "reject"> = ["refine", "approve", "reject"]
    for (const action of actions) {
      const event: Telemetry.Event = {
        type: "plan_revision",
        timestamp: Date.now(),
        session_id: "test-session",
        revision_number: 1,
        action,
      }
      expect(event.action).toBe(action)
    }
  })

  test("feature_suggestion event type is valid and structurally correct", () => {
    const event: Telemetry.Event = {
      type: "feature_suggestion",
      timestamp: Date.now(),
      session_id: "test-session",
      suggestion_type: "post_warehouse_connect",
      suggestions_shown: ["run_query", "schema_inspect"],
      warehouse_type: "snowflake",
    }
    expect(event.type).toBe("feature_suggestion")
    expect(event.suggestions_shown).toEqual(["run_query", "schema_inspect"])
    // Runtime verification
    expect(() => Telemetry.track(event)).not.toThrow()
  })

  test("feature_suggestion supports all suggestion_type values", () => {
    const types: Array<"post_warehouse_connect" | "dbt_detected" | "progressive_disclosure"> = [
      "post_warehouse_connect",
      "dbt_detected",
      "progressive_disclosure",
    ]
    for (const suggestion_type of types) {
      const event: Telemetry.Event = {
        type: "feature_suggestion",
        timestamp: Date.now(),
        session_id: "test-session",
        suggestion_type,
        suggestions_shown: ["test"],
      }
      expect(event.suggestion_type).toBe(suggestion_type)
    }
  })

  test("feature_suggestion warehouse_type is optional", () => {
    const event: Telemetry.Event = {
      type: "feature_suggestion",
      timestamp: Date.now(),
      session_id: "test-session",
      suggestion_type: "dbt_detected",
      suggestions_shown: ["dbt_build", "dbt_run"],
    }
    expect(event.type).toBe("feature_suggestion")
    expect("warehouse_type" in event).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. skill_used event includes trigger field
// ---------------------------------------------------------------------------
describe("telemetry.skill-used-trigger", () => {
  test("skill_used event accepts trigger field", () => {
    const event: Telemetry.Event = {
      type: "skill_used",
      timestamp: Date.now(),
      session_id: "test-session",
      message_id: "msg-1",
      skill_name: "test-skill",
      skill_source: "builtin",
      duration_ms: 150,
      trigger: "llm_selected",
      has_followups: false,
      followup_count: 0,
    }
    expect(event.trigger).toBe("llm_selected")
  })

  test("skill_used trigger supports all trigger values", () => {
    const triggers: Array<"user_command" | "llm_selected" | "auto_suggested" | "unknown"> = [
      "user_command",
      "llm_selected",
      "auto_suggested",
      "unknown",
    ]
    for (const trigger of triggers) {
      const event: Telemetry.Event = {
        type: "skill_used",
        timestamp: Date.now(),
        session_id: "s",
        message_id: "m",
        skill_name: "test",
        skill_source: "project",
        duration_ms: 10,
        trigger,
        has_followups: true,
        followup_count: 2,
      }
      expect(event.trigger).toBe(trigger)
    }
  })
})

// Regression tests for categorizeToolName, classifyError, bucketCount
// are covered in telemetry.test.ts — not duplicated here to avoid
// cross-file module loading conflicts in Bun's parallel test runner.

// ---------------------------------------------------------------------------
// 5. agent_outcome event structure validation
// ---------------------------------------------------------------------------
describe("telemetry.agent-outcome", () => {
  test("agent_outcome event accepts all outcome values", () => {
    const outcomes: Array<"completed" | "abandoned" | "aborted" | "error"> = [
      "completed",
      "abandoned",
      "aborted",
      "error",
    ]
    for (const outcome of outcomes) {
      const event: Telemetry.Event = {
        type: "agent_outcome",
        timestamp: Date.now(),
        session_id: "test-session",
        agent: "plan",
        tool_calls: 5,
        generations: 3,
        duration_ms: 12000,
        cost: 0.05,
        compactions: 0,
        outcome,
      }
      expect(event.outcome).toBe(outcome)
      expect(event.agent).toBe("plan")
      expect(event.tool_calls).toBe(5)
      expect(event.generations).toBe(3)
      expect(event.duration_ms).toBe(12000)
      expect(event.cost).toBe(0.05)
    }
  })
})
