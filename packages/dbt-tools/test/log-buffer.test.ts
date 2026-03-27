import { describe, test, expect, beforeEach } from "bun:test"
import { bufferLog, getRecentDbtLogs, clearDbtLogs } from "../src/log-buffer"

describe("dbt log-buffer", () => {
  beforeEach(() => {
    clearDbtLogs()
  })

  test("buffers log messages in insertion order", () => {
    bufferLog("first")
    bufferLog("second")
    bufferLog("third")
    expect(getRecentDbtLogs()).toEqual(["first", "second", "third"])
  })

  test("evicts oldest entries when buffer exceeds 100", () => {
    for (let i = 0; i < 105; i++) {
      bufferLog(`msg-${i}`)
    }
    const logs = getRecentDbtLogs()
    expect(logs).toHaveLength(100)
    expect(logs[0]).toBe("msg-5")
    expect(logs[99]).toBe("msg-104")
  })

  test("clearDbtLogs empties the buffer", () => {
    bufferLog("something")
    clearDbtLogs()
    expect(getRecentDbtLogs()).toEqual([])
  })

  test("getRecentDbtLogs returns a copy, not a reference", () => {
    bufferLog("original")
    const copy = getRecentDbtLogs()
    copy.push("injected")
    expect(getRecentDbtLogs()).toEqual(["original"])
  })

  test("handles empty buffer", () => {
    expect(getRecentDbtLogs()).toEqual([])
  })

  test("buffer stays at exactly 100 after repeated overflow", () => {
    for (let i = 0; i < 200; i++) {
      bufferLog(`msg-${i}`)
    }
    expect(getRecentDbtLogs()).toHaveLength(100)
    expect(getRecentDbtLogs()[0]).toBe("msg-100")
    expect(getRecentDbtLogs()[99]).toBe("msg-199")
  })
})
