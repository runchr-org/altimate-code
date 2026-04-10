/**
 * Dispatcher — lazy registration hook tests.
 *
 * The existing dispatcher.test.ts explicitly nulls the hook in beforeEach
 * and never tests the actual lazy-init pathway. These tests exercise the
 * _ensureRegistered code path (dispatcher.ts lines 40-44):
 *   - Hook fires on first call() and registers handlers
 *   - Hook fires exactly once across multiple calls
 *   - Hook is cleared before await, so a failed init doesn't retry
 */

import { describe, test, expect, beforeEach, mock, beforeAll, afterAll } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// Disable telemetry so track() calls don't reach the real exporter
beforeAll(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})
afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

describe("Dispatcher: lazy registration hook", () => {
  beforeEach(() => {
    Dispatcher.reset()
  })

  test("fires registration hook on first call and registers handler", async () => {
    const hookFn = mock(async () => {
      Dispatcher.register("ping" as any, async () => ({ status: "ok" }))
    })
    Dispatcher.setRegistrationHook(hookFn)

    const result = await Dispatcher.call("ping" as any, {} as any)
    expect(result).toEqual({ status: "ok" })
    expect(hookFn).toHaveBeenCalledTimes(1)
  })

  test("hook fires only once across multiple sequential calls", async () => {
    const hookFn = mock(async () => {
      Dispatcher.register("ping" as any, async () => ({ status: "ok" }))
    })
    Dispatcher.setRegistrationHook(hookFn)

    await Dispatcher.call("ping" as any, {} as any)
    await Dispatcher.call("ping" as any, {} as any)
    await Dispatcher.call("ping" as any, {} as any)
    expect(hookFn).toHaveBeenCalledTimes(1)
  })

  test("hook is cleared before await — failed init does not retry on next call", async () => {
    // Verifies that _ensureRegistered = null (line 42) happens before
    // await fn() (line 43). If the ordering were reversed, a failed hook
    // would fire on every subsequent call() — a real performance bug.
    Dispatcher.setRegistrationHook(async () => {
      throw new Error("init failed")
    })

    // First call: hook fires and throws
    await expect(Dispatcher.call("ping" as any, {} as any)).rejects.toThrow("init failed")

    // Second call: hook was already cleared, so we get "no handler" instead
    // of the init error repeating
    await expect(Dispatcher.call("ping" as any, {} as any)).rejects.toThrow("No native handler for ping")
  })
})
