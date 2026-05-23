import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
// altimate_change start — telemetry hook for session-level todowrite runaway detection
import { Telemetry } from "@/altimate/telemetry"
// altimate_change end

// altimate_change start — session-level todowrite call counters
// The doom-loop detector in session/processor.ts is per-assistant-message
// scope: its counter resets every time a new assistant message starts. Real
// telemetry (telemetry-analysis-2026-05-21) shows machines with 9,139
// todowrite calls across 28 sessions — ~325 per session, each turn under the
// processor threshold but total runaway. This per-session counter catches the
// slow-burn pattern by accumulating across all turns within a session.
//
// In-memory Map is fine because:
// - Sessions don't survive process restart anyway (the loop would end naturally).
// - Stale entries are harmless because the counter is keyed per sessionID; a
//   new session simply starts at 0 regardless of any old entries.
const todoWriteCallsBySession = new Map<string, number>()
export const TODOWRITE_WARN_THRESHOLD = 25
export const TODOWRITE_REFUSE_THRESHOLD = 50

/**
 * Record one todowrite call for the session and return a decision about how
 * the tool should respond.
 *
 * Exported so unit tests can drive the same code path the tool uses, without
 * needing the full Tool.define() initialization context.
 */
export function recordTodoWriteCall(sessionID: string): {
  action: "ok" | "warn" | "refuse"
  count: number
} {
  const prev = todoWriteCallsBySession.get(sessionID) ?? 0
  const count = prev + 1
  todoWriteCallsBySession.set(sessionID, count)

  if (count >= TODOWRITE_REFUSE_THRESHOLD) return { action: "refuse", count }
  if (count === TODOWRITE_WARN_THRESHOLD) return { action: "warn", count }
  return { action: "ok", count }
}

/** Reset all per-session counters (testing only). */
export function _resetTodoWriteCounters(): void {
  todoWriteCallsBySession.clear()
}

/** Read the current count for a session (testing only). */
export function _getTodoWriteCount(sessionID: string): number {
  return todoWriteCallsBySession.get(sessionID) ?? 0
}
// altimate_change end

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    // altimate_change start — session-level runaway detection
    const decision = recordTodoWriteCall(ctx.sessionID)

    if (decision.action === "refuse") {
      Telemetry.track({
        type: "doom_loop_detected",
        timestamp: Date.now(),
        session_id: ctx.sessionID,
        tool_name: "todowrite",
        repeat_count: decision.count,
      })
      return {
        title: `todowrite blocked: ${decision.count} calls this session`,
        output:
          `todowrite has been called ${decision.count} times this session, far beyond normal usage ` +
          `(typically 5-15 calls). Refusing further updates to break the loop. ` +
          `Continue with the work you were doing — the todo list is already tracked. ` +
          `If you genuinely need to update the list, summarise the remaining tasks in your ` +
          `next response instead of calling todowrite again.`,
        metadata: {
          todos: await Todo.get(ctx.sessionID),
          refused: true,
          call_count: decision.count,
        },
      }
    }
    // altimate_change end

    await Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
    })

    const remainingTodos = params.todos.filter((x) => x.status !== "completed").length

    // altimate_change start — gentle warning at the soft threshold
    if (decision.action === "warn") {
      Telemetry.track({
        type: "doom_loop_detected",
        timestamp: Date.now(),
        session_id: ctx.sessionID,
        tool_name: "todowrite",
        repeat_count: decision.count,
      })
      return {
        title: `${remainingTodos} todos (warning: ${decision.count} updates this session)`,
        output:
          `${JSON.stringify(params.todos, null, 2)}\n\n` +
          `WARNING: todowrite has been called ${decision.count} times this session. ` +
          `Typical usage is 5-15 calls. Consider whether you're updating the list ` +
          `more often than needed — the list will be discarded if you exceed ` +
          `${TODOWRITE_REFUSE_THRESHOLD} calls.`,
        metadata: {
          todos: params.todos,
          warning_emitted: true,
          call_count: decision.count,
        },
      }
    }
    // altimate_change end

    return {
      title: `${remainingTodos} todos`,
      output: JSON.stringify(params.todos, null, 2),
      metadata: {
        todos: params.todos,
        // altimate_change start — expose count so observability sees the climb
        call_count: decision.count,
        // altimate_change end
      },
    }
  },
})

export const TodoReadTool = Tool.define("todoread", {
  description: "Use this tool to read your todo list",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "todoread",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const todos = await Todo.get(ctx.sessionID)
    return {
      title: `${todos.filter((x) => x.status !== "completed").length} todos`,
      metadata: {
        todos,
      },
      output: JSON.stringify(todos, null, 2),
    }
  },
})
