import { describe, expect, test } from "bun:test"
import { Lock } from "../../src/util/lock"

function tick() {
  return new Promise<void>((r) => queueMicrotask(r))
}

async function flush(n = 5) {
  for (let i = 0; i < n; i++) await tick()
}

describe("util.lock", () => {
  test("writer exclusivity: blocks reads and other writes while held", async () => {
    const key = "lock:" + Math.random().toString(36).slice(2)

    const state = {
      writer2: false,
      reader: false,
      writers: 0,
    }

    // Acquire writer1
    using writer1 = await Lock.write(key)
    state.writers++
    expect(state.writers).toBe(1)

    // Start writer2 candidate (should block)
    const writer2Task = (async () => {
      const w = await Lock.write(key)
      state.writers++
      expect(state.writers).toBe(1)
      state.writer2 = true
      // Hold for a tick so reader cannot slip in
      await tick()
      return w
    })()

    // Start reader candidate (should block)
    const readerTask = (async () => {
      const r = await Lock.read(key)
      state.reader = true
      return r
    })()

    // Flush microtasks and assert neither acquired
    await flush()
    expect(state.writer2).toBe(false)
    expect(state.reader).toBe(false)

    // Release writer1
    writer1[Symbol.dispose]()
    state.writers--

    // writer2 should acquire next
    const writer2 = await writer2Task
    expect(state.writer2).toBe(true)

    // Reader still blocked while writer2 held
    await flush()
    expect(state.reader).toBe(false)

    // Release writer2
    writer2[Symbol.dispose]()
    state.writers--

    // Reader should now acquire
    const reader = await readerTask
    expect(state.reader).toBe(true)

    reader[Symbol.dispose]()
  })

  test("concurrent readers: multiple readers can hold the lock simultaneously", async () => {
    const key = "lock:" + Math.random().toString(36).slice(2)
    const timeline: string[] = []

    const r1 = await Lock.read(key)
    timeline.push("r1-acquired")

    const r2 = await Lock.read(key)
    timeline.push("r2-acquired")

    // Both acquired without blocking — readers are concurrent
    expect(timeline).toEqual(["r1-acquired", "r2-acquired"])

    r1[Symbol.dispose]()
    r2[Symbol.dispose]()
  })

  test("writer starvation prevention: waiting writer blocks new readers", async () => {
    const key = "lock:" + Math.random().toString(36).slice(2)
    const timeline: string[] = []

    // Acquire a reader
    const r1 = await Lock.read(key)
    timeline.push("r1-acquired")

    // Queue a writer (blocks because r1 is held)
    let writerResolved = false
    const writerTask = Lock.write(key).then((w) => {
      writerResolved = true
      timeline.push("writer-acquired")
      return w
    })

    await flush()
    expect(writerResolved).toBe(false)

    // Queue a second reader (should block because a writer is waiting —
    // the source's process() prioritizes waitingWriters over waitingReaders)
    let reader2Resolved = false
    const reader2Task = Lock.read(key).then((r) => {
      reader2Resolved = true
      timeline.push("r2-acquired")
      return r
    })

    await flush()
    expect(reader2Resolved).toBe(false)

    // Release r1 — writer goes next (not reader2).
    // process() calls the writer callback synchronously via shift()+nextWriter(),
    // which resolves the writer promise on the next microtask.  reader2 remains
    // queued in waitingReaders until the writer releases.
    r1[Symbol.dispose]()

    const writer = await writerTask
    expect(writerResolved).toBe(true)
    expect(reader2Resolved).toBe(false)

    // Release writer — now reader2 can proceed
    writer[Symbol.dispose]()
    const r2 = await reader2Task
    expect(reader2Resolved).toBe(true)

    expect(timeline).toEqual(["r1-acquired", "writer-acquired", "r2-acquired"])

    r2[Symbol.dispose]()
  })
})
