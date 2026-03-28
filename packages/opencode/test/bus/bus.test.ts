import { describe, test, expect } from "bun:test"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const TestEvent = BusEvent.define("__test_bus_pub_sub", z.object({ value: z.string() }))
const OtherEvent = BusEvent.define("__test_bus_other_type", z.object({ n: z.number() }))

describe("Bus: publish and subscribe", () => {
  test("subscriber receives published event", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const received: any[] = []
        const unsub = Bus.subscribe(TestEvent, (e) => received.push(e))
        await Bus.publish(TestEvent, { value: "hello" })
        expect(received).toHaveLength(1)
        expect(received[0].properties.value).toBe("hello")
        unsub()
      },
    })
  })

  test("unsubscribe stops receiving events", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const received: any[] = []
        const unsub = Bus.subscribe(TestEvent, (e) => received.push(e))
        await Bus.publish(TestEvent, { value: "first" })
        unsub()
        await Bus.publish(TestEvent, { value: "second" })
        expect(received).toHaveLength(1)
      },
    })
  })

  test("multiple subscribers receive the same event", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a: any[] = []
        const b: any[] = []
        const unsub1 = Bus.subscribe(TestEvent, (e) => a.push(e))
        const unsub2 = Bus.subscribe(TestEvent, (e) => b.push(e))
        await Bus.publish(TestEvent, { value: "shared" })
        expect(a).toHaveLength(1)
        expect(b).toHaveLength(1)
        unsub1()
        unsub2()
      },
    })
  })

  test("subscriber only receives matching event type", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const received: any[] = []
        const unsub = Bus.subscribe(TestEvent, (e) => received.push(e))
        await Bus.publish(OtherEvent, { n: 42 })
        expect(received).toHaveLength(0)
        unsub()
      },
    })
  })
})

describe("Bus: subscribeAll wildcard", () => {
  test("wildcard subscriber receives all event types", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const received: any[] = []
        const unsub = Bus.subscribeAll((e) => received.push(e))
        await Bus.publish(TestEvent, { value: "a" })
        await Bus.publish(OtherEvent, { n: 1 })
        expect(received).toHaveLength(2)
        unsub()
      },
    })
  })
})

describe("Bus: once", () => {
  test("once unsubscribes after callback returns 'done'", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        let count = 0
        Bus.once(TestEvent, () => {
          count++
          return "done"
        })
        await Bus.publish(TestEvent, { value: "first" })
        await Bus.publish(TestEvent, { value: "second" })
        expect(count).toBe(1)
      },
    })
  })

  test("once continues if callback returns undefined", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        let count = 0
        Bus.once(TestEvent, () => {
          count++
          return count >= 2 ? "done" : undefined
        })
        await Bus.publish(TestEvent, { value: "1" })
        await Bus.publish(TestEvent, { value: "2" })
        await Bus.publish(TestEvent, { value: "3" })
        expect(count).toBe(2)
      },
    })
  })
})
