import { describe, test, expect } from "bun:test"
import { Session } from "../../src/session"
import { Todo } from "../../src/session/todo"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Todo: CRUD lifecycle", () => {
  test("update then get returns todos in order", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const todos = [
          { content: "Fix SQL query", status: "pending", priority: "high" },
          { content: "Add index", status: "in_progress", priority: "medium" },
          { content: "Write docs", status: "completed", priority: "low" },
        ]

        Todo.update({ sessionID: session.id, todos })

        const result = Todo.get(session.id)
        expect(result).toHaveLength(3)
        expect(result[0].content).toBe("Fix SQL query")
        expect(result[0].status).toBe("pending")
        expect(result[0].priority).toBe("high")
        expect(result[1].content).toBe("Add index")
        expect(result[2].content).toBe("Write docs")

        await Session.remove(session.id)
      },
    })
  })

  test("update with empty array clears all todos", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        Todo.update({
          sessionID: session.id,
          todos: [{ content: "Task A", status: "pending", priority: "high" }],
        })
        expect(Todo.get(session.id)).toHaveLength(1)

        Todo.update({ sessionID: session.id, todos: [] })
        expect(Todo.get(session.id)).toHaveLength(0)

        await Session.remove(session.id)
      },
    })
  })

  test("update replaces previous todos entirely", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        Todo.update({
          sessionID: session.id,
          todos: [
            { content: "Old task 1", status: "pending", priority: "high" },
            { content: "Old task 2", status: "pending", priority: "medium" },
          ],
        })
        expect(Todo.get(session.id)).toHaveLength(2)

        Todo.update({
          sessionID: session.id,
          todos: [{ content: "New task", status: "in_progress", priority: "low" }],
        })

        const result = Todo.get(session.id)
        expect(result).toHaveLength(1)
        expect(result[0].content).toBe("New task")
        expect(result[0].status).toBe("in_progress")

        await Session.remove(session.id)
      },
    })
  })

  test("get returns empty array for session with no todos", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const result = Todo.get(session.id)
        expect(result).toEqual([])

        await Session.remove(session.id)
      },
    })
  })

  test("publishes Todo.Event.Updated on update", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        let eventReceived = false
        let receivedTodos: Todo.Info[] = []

        const unsub = Bus.subscribe(Todo.Event.Updated, (event) => {
          if (event.properties.sessionID === session.id) {
            eventReceived = true
            receivedTodos = event.properties.todos
          }
        })

        const todos = [{ content: "Emit test", status: "pending", priority: "high" }]
        Todo.update({ sessionID: session.id, todos })

        // Bus.publish is synchronous — event is delivered immediately
        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedTodos).toHaveLength(1)
        expect(receivedTodos[0].content).toBe("Emit test")

        await Session.remove(session.id)
      },
    })
  })

  test("todos are isolated between sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session1 = await Session.create({})
        const session2 = await Session.create({})

        Todo.update({
          sessionID: session1.id,
          todos: [{ content: "Session 1 task", status: "pending", priority: "high" }],
        })
        Todo.update({
          sessionID: session2.id,
          todos: [
            { content: "Session 2 task A", status: "pending", priority: "medium" },
            { content: "Session 2 task B", status: "completed", priority: "low" },
          ],
        })

        expect(Todo.get(session1.id)).toHaveLength(1)
        expect(Todo.get(session1.id)[0].content).toBe("Session 1 task")
        expect(Todo.get(session2.id)).toHaveLength(2)

        await Session.remove(session1.id)
        await Session.remove(session2.id)
      },
    })
  })
})
