// altimate_change start — tests for stale file auto-re-read recovery (#450)
import { describe, test, expect } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import { StaleFileError } from "../../src/file/time"
import { FileTime } from "../../src/file/time"
import { Filesystem } from "../../src/util/filesystem"
import { Instance } from "../../src/project/instance"

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-"))
  return {
    path: dir,
    [Symbol.asyncDispose]: async () => {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

describe("StaleFileError", () => {
  test("extends Error", () => {
    const err = new StaleFileError("/path/to/file.ts", "File was modified")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(StaleFileError)
    expect(err.name).toBe("StaleFileError")
  })

  test("carries filePath property", () => {
    const err = new StaleFileError("/some/path/file.sql", "modified since last read")
    expect(err.filePath).toBe("/some/path/file.sql")
    expect(err.message).toBe("modified since last read")
  })

  test("works with instanceof check", () => {
    const err: Error = new StaleFileError("/test", "msg")
    if (err instanceof StaleFileError) {
      expect(err.filePath).toBe("/test")
    } else {
      throw new Error("instanceof check failed")
    }
  })

  test("preserves stack trace", () => {
    const err = new StaleFileError("/file", "error")
    expect(err.stack).toBeDefined()
    expect(err.stack).toContain("StaleFileError")
  })
})

describe("FileTime.assert throws StaleFileError", () => {
  test("throws StaleFileError when file modified since read", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "test.txt")
    await fs.writeFile(filepath, "original", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        FileTime.read("test-session", filepath)

        // Wait and modify externally
        await new Promise((r) => setTimeout(r, 100))
        await fs.writeFile(filepath, "modified", "utf-8")

        try {
          await FileTime.assert("test-session", filepath)
          throw new Error("should have thrown")
        } catch (e) {
          expect(e).toBeInstanceOf(StaleFileError)
          expect((e as StaleFileError).filePath).toBe(filepath)
          expect((e as StaleFileError).message).toContain("modified since it was last read")
        }
      },
    })
  })

  test("does not throw StaleFileError for unread files", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "test.txt")
    await fs.writeFile(filepath, "content", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          await FileTime.assert("test-session-2", filepath)
          throw new Error("should have thrown")
        } catch (e) {
          // This should be a regular Error, NOT StaleFileError
          expect(e).toBeInstanceOf(Error)
          expect(e).not.toBeInstanceOf(StaleFileError)
          expect((e as Error).message).toContain("You must read file")
        }
      },
    })
  })
})

describe("stale file recovery logic", () => {
  // These tests replicate the recovery logic from processor.ts in isolation,
  // following the same pattern as processor.test.ts for telemetry tests.

  const MAX_AUTO_READ_BYTES = 50 * 1024

  async function simulateRecovery(opts: {
    error: unknown
    sessionID: string
    filePath?: string
    fileContent?: string
    fileSize?: number
    fileExists?: boolean
  }) {
    let errorStr = String(opts.error ?? "Unknown error")

    if (opts.error instanceof StaleFileError) {
      const staleFilePath = opts.error.filePath
      try {
        if (opts.fileExists === false) {
          throw new Error("ENOENT: no such file or directory")
        }
        const size = opts.fileSize ?? Buffer.byteLength(opts.fileContent ?? "", "utf-8")
        if (size > MAX_AUTO_READ_BYTES) {
          errorStr += `\n\nThe file has been modified (${Math.round(size / 1024)}KB). It is too large to include here — please use the Read tool to view it.`
        } else {
          const freshContent = opts.fileContent ?? ""
          const fence = "````"
          errorStr += `\n\nThe file has been auto-re-read. Here is the current content:\n\n${fence}\n${freshContent}\n${fence}`
        }
      } catch (readErr) {
        errorStr += `\n\nAttempted to auto-re-read the file but failed: ${String(readErr)}`
      }
    }

    return errorStr
  }

  test("only triggers for StaleFileError, not regular errors", async () => {
    const regularError = new Error("some other tool error")
    const result = await simulateRecovery({
      error: regularError,
      sessionID: "s1",
    })
    expect(result).toBe("Error: some other tool error")
    expect(result).not.toContain("auto-re-read")
  })

  test("appends file content for small files", async () => {
    const err = new StaleFileError("/test/file.sql", "modified since last read")
    const result = await simulateRecovery({
      error: err,
      sessionID: "s1",
      fileContent: "SELECT * FROM orders;",
    })
    expect(result).toContain("auto-re-read")
    expect(result).toContain("SELECT * FROM orders;")
    expect(result).toContain("````")
  })

  test("rejects large files with size message", async () => {
    const err = new StaleFileError("/test/big.sql", "modified")
    const result = await simulateRecovery({
      error: err,
      sessionID: "s1",
      fileSize: 100 * 1024, // 100KB
    })
    expect(result).toContain("too large to include here")
    expect(result).toContain("please use the Read tool")
    expect(result).not.toContain("auto-re-read")
  })

  test("handles missing file gracefully", async () => {
    const err = new StaleFileError("/test/deleted.sql", "modified")
    const result = await simulateRecovery({
      error: err,
      sessionID: "s1",
      fileExists: false,
    })
    expect(result).toContain("Attempted to auto-re-read the file but failed")
    expect(result).toContain("ENOENT")
  })

  test("handles null/undefined errors safely", async () => {
    // Both null and undefined should produce "Unknown error" via ?? coalescing
    const result1 = await simulateRecovery({ error: null, sessionID: "s1" })
    expect(result1).toBe("Unknown error")

    const result2 = await simulateRecovery({ error: undefined, sessionID: "s1" })
    expect(result2).toBe("Unknown error")
  })

  test("does not trigger for errors with similar text", async () => {
    // A regular Error with stale-file-like text should NOT trigger recovery
    const trickyError = new Error("File /etc/passwd has been modified since it was last read")
    const result = await simulateRecovery({
      error: trickyError,
      sessionID: "s1",
    })
    expect(result).not.toContain("auto-re-read")
    expect(result).not.toContain("too large")
  })

  test("file content with backticks does not break fencing", async () => {
    const err = new StaleFileError("/test/file.md", "modified")
    const content = "```python\nprint('hello')\n```"
    const result = await simulateRecovery({
      error: err,
      sessionID: "s1",
      fileContent: content,
    })
    // Uses ```` (4 backticks) so inner ``` (3 backticks) don't break it
    expect(result).toContain("````")
    expect(result).toContain(content)
  })

  test("filePath is extracted from StaleFileError, not parsed from message", async () => {
    // Path with spaces and special chars
    const weirdPath = "/Users/test user/my project/models/stg orders.sql"
    const err = new StaleFileError(weirdPath, "some error message without the path")
    expect(err.filePath).toBe(weirdPath)
  })
})
// altimate_change end
