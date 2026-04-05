import path from "path"
import os from "os"
import z from "zod"
import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import { NamedError } from "@opencode-ai/util/error"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"

export namespace ConfigPaths {
  export async function projectFiles(name: string, directory: string, worktree: string) {
    const files: string[] = []
    for (const file of [`${name}.jsonc`, `${name}.json`]) {
      const found = await Filesystem.findUp(file, directory, worktree)
      for (const resolved of found.toReversed()) {
        files.push(resolved)
      }
    }
    return files
  }

  export async function directories(directory: string, worktree: string) {
    // altimate_change start - dual config dir support: .altimate-code (primary) + .opencode (fallback)
    const configTargets = [".altimate-code", ".opencode"]
    // altimate_change end
    return [
      Global.Path.config,
      ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? await Array.fromAsync(
            Filesystem.up({
              targets: configTargets,
              start: directory,
              stop: worktree,
            }),
          )
        : []),
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: configTargets,
          start: Global.Path.home,
          stop: Global.Path.home,
        }),
      )),
      ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
    ]
  }

  export function fileInDirectory(dir: string, name: string) {
    return [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)]
  }

  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    }),
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    }),
  )

  /** Read a config file, returning undefined for missing files and throwing JsonError for other failures. */
  export async function readFile(filepath: string) {
    return Filesystem.readText(filepath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return
      throw new JsonError({ path: filepath }, { cause: err })
    })
  }

  type ParseSource = string | { source: string; dir: string }

  function source(input: ParseSource) {
    return typeof input === "string" ? input : input.source
  }

  function dir(input: ParseSource) {
    return typeof input === "string" ? path.dirname(input) : input.dir
  }

  /** Apply {env:VAR} and {file:path} substitutions to config text. */
  async function substitute(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
    // altimate_change start — track interpolation stats for telemetry
    let legacyBraceRefs = 0
    let legacyBraceUnresolved = 0
    text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      legacyBraceRefs++
      const v = process.env[varName]
      if (v === undefined || v === "") legacyBraceUnresolved++
      return v || ""
    })
    // altimate_change end
    // altimate_change start — accept ${VAR} shell/dotenv syntax as alias for {env:VAR}
    // Users arriving from Claude Code / VS Code / dotenv / docker-compose expect this
    // convention. Only matches POSIX identifier names to avoid collisions with random
    // ${...} content. Value is JSON-escaped so it can't break out of the enclosing
    // string — use {env:VAR} for raw unquoted injection. Supports ${VAR:-default}
    // for fallback values (docker-compose / POSIX shell convention: default used when
    // the variable is unset OR empty). Docker-compose convention: $${VAR} escapes to
    // literal ${VAR}. See issue #635.
    let dollarRefs = 0
    let dollarUnresolved = 0
    let dollarDefaulted = 0
    text = text.replace(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, varName, fallback) => {
      dollarRefs++
      const envValue = process.env[varName]
      const resolved = envValue !== undefined && envValue !== ""
      if (!resolved && fallback !== undefined) dollarDefaulted++
      if (!resolved && fallback === undefined) dollarUnresolved++
      const value = resolved ? envValue : (fallback ?? "")
      return JSON.stringify(value).slice(1, -1)
    })
    // Unescape: $${VAR} → ${VAR} (user-authored literal preservation, docker-compose style)
    // Handles both ${VAR} and ${VAR:-default} forms.
    let dollarEscaped = 0
    text = text.replace(/\$\$(\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})/g, (_, rest) => {
      dollarEscaped++
      return "$" + rest
    })
    // Emit telemetry if any env interpolation happened. Dynamic import avoids a
    // circular dep with @/altimate/telemetry (which imports @/config/config).
    if (dollarRefs > 0 || legacyBraceRefs > 0 || dollarEscaped > 0) {
      import("@/altimate/telemetry")
        .then(({ Telemetry }) => {
          Telemetry.track({
            type: "config_env_interpolation",
            timestamp: Date.now(),
            session_id: Telemetry.getContext().sessionId,
            dollar_refs: dollarRefs,
            dollar_unresolved: dollarUnresolved,
            dollar_defaulted: dollarDefaulted,
            dollar_escaped: dollarEscaped,
            legacy_brace_refs: legacyBraceRefs,
            legacy_brace_unresolved: legacyBraceUnresolved,
          })
        })
        .catch(() => {})
    }
    // altimate_change end

    const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
    if (!fileMatches.length) return text

    const configDir = dir(input)
    const configSource = source(input)
    let out = ""
    let cursor = 0

    for (const match of fileMatches) {
      const token = match[0]
      const index = match.index!
      out += text.slice(cursor, index)

      const lineStart = text.lastIndexOf("\n", index - 1) + 1
      const prefix = text.slice(lineStart, index).trimStart()
      if (prefix.startsWith("//")) {
        out += token
        cursor = index + token.length
        continue
      }

      let filePath = token.replace(/^\{file:/, "").replace(/\}$/, "")
      if (filePath.startsWith("~/")) {
        filePath = path.join(os.homedir(), filePath.slice(2))
      }

      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
      const fileContent = (
        await Filesystem.readText(resolvedPath).catch((error: NodeJS.ErrnoException) => {
          if (missing === "empty") return ""

          const errMsg = `bad file reference: "${token}"`
          if (error.code === "ENOENT") {
            throw new InvalidError(
              {
                path: configSource,
                message: errMsg + ` ${resolvedPath} does not exist`,
              },
              { cause: error },
            )
          }
          throw new InvalidError({ path: configSource, message: errMsg }, { cause: error })
        })
      ).trim()

      out += JSON.stringify(fileContent).slice(1, -1)
      cursor = index + token.length
    }

    out += text.slice(cursor)
    return out
  }

  /** Substitute and parse JSONC text, throwing JsonError on syntax errors. */
  export async function parseText(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
    const configSource = source(input)
    text = await substitute(text, input, missing)

    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: configSource,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    return data
  }
}
