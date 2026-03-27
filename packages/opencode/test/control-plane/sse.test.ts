import { afterEach, describe, expect, test } from "bun:test"
import { parseSSE } from "../../src/control-plane/sse"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await resetDatabase()
})

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)))
      controller.close()
    },
  })
}

describe("control-plane/sse", () => {
  test("parses JSON events with CRLF and multiline data blocks", async () => {
    const events: unknown[] = []
    const stop = new AbortController()

    await parseSSE(
      stream([
        'data: {"type":"one","properties":{"ok":true}}\r\n\r\n',
        'data: {"type":"two",\r\ndata: "properties":{"n":2}}\r\n\r\n',
      ]),
      stop.signal,
      (event) => events.push(event),
    )

    expect(events).toEqual([
      { type: "one", properties: { ok: true } },
      { type: "two", properties: { n: 2 } },
    ])
  })

  test("falls back to sse.message for non-json payload", async () => {
    const events: unknown[] = []
    const stop = new AbortController()

    await parseSSE(stream(["id: abc\nretry: 1500\ndata: hello world\n\n"]), stop.signal, (event) => events.push(event))

    expect(events).toEqual([
      {
        type: "sse.message",
        properties: {
          data: "hello world",
          id: "abc",
          retry: 1500,
        },
      },
    ])
  })

  test("handles events split across chunk boundaries", async () => {
    const events: unknown[] = []
    const stop = new AbortController()

    await parseSSE(
      stream(['data: {"type":"spl', 'it"}\n\n']),
      stop.signal,
      (event) => events.push(event),
    )

    expect(events).toEqual([{ type: "split" }])
  })

  test("handles double newline split across chunks", async () => {
    const events: unknown[] = []
    const stop = new AbortController()

    await parseSSE(
      stream(['data: {"type":"boundary"}\n', '\ndata: {"type":"next"}\n\n']),
      stop.signal,
      (event) => events.push(event),
    )

    expect(events).toEqual([{ type: "boundary" }, { type: "next" }])
  })

  test("ignores empty events (double newline with no data)", async () => {
    const events: unknown[] = []
    const stop = new AbortController()

    await parseSSE(
      stream(['\n\ndata: {"type":"real"}\n\n']),
      stop.signal,
      (event) => events.push(event),
    )

    expect(events).toEqual([{ type: "real" }])
  })

  test("abort signal stops processing mid-stream", async () => {
    const events: unknown[] = []
    const stop = new AbortController()

    // Stream that delivers chunks on demand via pull(); abort fires
    // between the first and second read.
    let pullCount = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const encoder = new TextEncoder()
        pullCount++
        if (pullCount === 1) {
          controller.enqueue(encoder.encode('data: {"type":"first"}\n\n'))
          // Abort before next pull delivers second event
          stop.abort()
        } else {
          controller.enqueue(encoder.encode('data: {"type":"second"}\n\n'))
          controller.close()
        }
      },
    })

    await parseSSE(body, stop.signal, (event) => events.push(event))

    expect(events).toEqual([{ type: "first" }])
  })

  test("handles bare \\r line endings", async () => {
    const events: unknown[] = []
    const stop = new AbortController()

    await parseSSE(
      stream(['data: {"type":"cr"}\r\r']),
      stop.signal,
      (event) => events.push(event),
    )

    expect(events).toEqual([{ type: "cr" }])
  })
})
