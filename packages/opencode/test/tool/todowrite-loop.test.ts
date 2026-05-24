import { describe, test, expect, beforeEach } from "bun:test"
import {
  recordTodoWriteCall,
  clearTodoWriteCounter,
  _resetTodoWriteCounters,
  _getTodoWriteCount,
  TODOWRITE_WARN_THRESHOLD,
  TODOWRITE_REFUSE_THRESHOLD,
} from "../../src/tool/todo"

/**
 * Per-session todowrite runaway detection.
 *
 * Background: telemetry-analysis-2026-05-21 showed machines with 9,139
 * todowrite calls across 28 sessions (top-3 machines = 63% of all 29,562
 * todowrite calls in a 14-day window). The doom-loop detector in
 * session/processor.ts is per-assistant-message scope and was missing the
 * slow-burn pattern. These tests pin the per-session counter that catches it.
 */

beforeEach(() => {
  _resetTodoWriteCounters()
})

describe("recordTodoWriteCall: counter mechanics", () => {
  test("counts each call within a single session", () => {
    expect(_getTodoWriteCount("session-a")).toBe(0)
    expect(recordTodoWriteCall("session-a").count).toBe(1)
    expect(recordTodoWriteCall("session-a").count).toBe(2)
    expect(_getTodoWriteCount("session-a")).toBe(2)
  })

  test("counters are independent across sessions", () => {
    recordTodoWriteCall("session-a")
    recordTodoWriteCall("session-a")
    recordTodoWriteCall("session-b")
    expect(_getTodoWriteCount("session-a")).toBe(2)
    expect(_getTodoWriteCount("session-b")).toBe(1)
  })

  test("counter is cleared by _resetTodoWriteCounters and starts fresh", () => {
    // Renamed from "counter survives reset" which was misleading — the
    // reset clears the counter, it doesn't survive.
    recordTodoWriteCall("session-a")
    recordTodoWriteCall("session-a")
    expect(_getTodoWriteCount("session-a")).toBe(2)
    _resetTodoWriteCounters()
    expect(_getTodoWriteCount("session-a")).toBe(0)
    expect(recordTodoWriteCall("session-a").count).toBe(1)
  })
})

describe("recordTodoWriteCall: decision boundaries", () => {
  test("returns action=ok for calls below the warn threshold", () => {
    for (let i = 1; i < TODOWRITE_WARN_THRESHOLD; i++) {
      const d = recordTodoWriteCall("session-x")
      expect(d.action).toBe("ok")
      expect(d.count).toBe(i)
    }
  })

  test("returns action=warn exactly at the warn threshold", () => {
    for (let i = 1; i < TODOWRITE_WARN_THRESHOLD; i++) {
      recordTodoWriteCall("session-x")
    }
    const d = recordTodoWriteCall("session-x")
    expect(d.action).toBe("warn")
    expect(d.count).toBe(TODOWRITE_WARN_THRESHOLD)
  })

  test("returns action=ok between warn and refuse thresholds", () => {
    for (let i = 1; i <= TODOWRITE_WARN_THRESHOLD; i++) {
      recordTodoWriteCall("session-x")
    }
    // Next call: count = warn + 1
    const d = recordTodoWriteCall("session-x")
    expect(d.action).toBe("ok")
    expect(d.count).toBe(TODOWRITE_WARN_THRESHOLD + 1)
  })

  test("returns action=refuse at the hard threshold", () => {
    for (let i = 1; i < TODOWRITE_REFUSE_THRESHOLD; i++) {
      recordTodoWriteCall("session-x")
    }
    const d = recordTodoWriteCall("session-x")
    expect(d.action).toBe("refuse")
    expect(d.count).toBe(TODOWRITE_REFUSE_THRESHOLD)
  })

  test("returns action=refuse for every call past the hard threshold", () => {
    for (let i = 1; i < TODOWRITE_REFUSE_THRESHOLD; i++) {
      recordTodoWriteCall("session-x")
    }
    // Trip and then push 10 more.
    expect(recordTodoWriteCall("session-x").action).toBe("refuse")
    for (let i = 0; i < 10; i++) {
      expect(recordTodoWriteCall("session-x").action).toBe("refuse")
    }
    expect(_getTodoWriteCount("session-x")).toBe(TODOWRITE_REFUSE_THRESHOLD + 10)
  })

  test("threshold constants are sane and ordered", () => {
    expect(TODOWRITE_WARN_THRESHOLD).toBeGreaterThan(15)
    expect(TODOWRITE_WARN_THRESHOLD).toBeLessThan(TODOWRITE_REFUSE_THRESHOLD)
    expect(TODOWRITE_REFUSE_THRESHOLD).toBeLessThanOrEqual(100)
  })
})

describe("clearTodoWriteCounter: explicit escape hatch", () => {
  test("clearTodoWriteCounter resets a single session without affecting others", () => {
    for (let i = 0; i < 10; i++) recordTodoWriteCall("session-x")
    for (let i = 0; i < 5; i++) recordTodoWriteCall("session-y")
    expect(_getTodoWriteCount("session-x")).toBe(10)
    expect(_getTodoWriteCount("session-y")).toBe(5)

    clearTodoWriteCounter("session-x")

    expect(_getTodoWriteCount("session-x")).toBe(0)
    expect(_getTodoWriteCount("session-y")).toBe(5)
  })

  test("clearTodoWriteCounter unblocks a refused session", () => {
    // Climb to refusal.
    for (let i = 0; i < TODOWRITE_REFUSE_THRESHOLD; i++) {
      recordTodoWriteCall("stuck-session")
    }
    expect(recordTodoWriteCall("stuck-session").action).toBe("refuse")

    // Operator clears.
    clearTodoWriteCounter("stuck-session")

    // Next call is ok again.
    expect(recordTodoWriteCall("stuck-session").action).toBe("ok")
    expect(_getTodoWriteCount("stuck-session")).toBe(1)
  })

  test("clearTodoWriteCounter on an unknown session is a no-op", () => {
    expect(_getTodoWriteCount("never-touched")).toBe(0)
    clearTodoWriteCounter("never-touched")
    expect(_getTodoWriteCount("never-touched")).toBe(0)
  })
})
