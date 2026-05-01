import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
// altimate_change start — upstream_fix: bridge merge wired routes to the new Effect-TS Permission service,
// but every runtime ask in session/processor and session/prompt still calls PermissionNext. The two modules
// have separate pending maps, so replies hit an empty map and tool calls never unblock. Route the HTTP
// surface to the same module that owns the asks until the runtime is migrated.
import { PermissionNext } from "@/permission/next"
// altimate_change end
import { PermissionID } from "@/permission/schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const PermissionRoutes = lazy(() =>
  new Hono()
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Respond to permission request",
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.reply",
        responses: {
          200: {
            description: "Permission processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: PermissionID.zod,
        }),
      ),
      // altimate_change start — upstream_fix: see header note
      validator("json", z.object({ reply: PermissionNext.Reply, message: z.string().optional() })),
      async (c) => {
        const params = c.req.valid("param")
        const json = c.req.valid("json")
        await PermissionNext.reply({
          requestID: params.requestID,
          reply: json.reply,
          message: json.message,
        })
        return c.json(true)
      },
      // altimate_change end
    )
    .get(
      "/",
      describeRoute({
        summary: "List pending permissions",
        description: "Get all pending permission requests across all sessions.",
        operationId: "permission.list",
        responses: {
          200: {
            description: "List of pending permissions",
            content: {
              "application/json": {
                // altimate_change start — upstream_fix: see header note
                schema: resolver(PermissionNext.Request.array()),
                // altimate_change end
              },
            },
          },
        },
      }),
      async (c) => {
        // altimate_change start — upstream_fix: see header note
        const permissions = await PermissionNext.list()
        // altimate_change end
        return c.json(permissions)
      },
    ),
)
