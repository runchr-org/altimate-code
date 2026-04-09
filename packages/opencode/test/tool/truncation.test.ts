import { describe, test, expect } from "bun:test"
import { Truncate } from "../../src/tool/truncation"
import { Filesystem } from "../../src/util/filesystem"
import path from "path"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")

describe("Truncate", () => {
  describe("output", () => {
    test("truncates large json file by bytes", async () => {
      const content = await Filesystem.readText(path.join(FIXTURES_DIR, "models-api.json"))
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("truncated...")
      if (result.truncated) expect(result.outputPath).toBeDefined()
    })

    test("returns content unchanged when under limits", async () => {
      const content = "line1\nline2\nline3"
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(false)
      expect(result.content).toBe(content)
    })

    test("truncates by line count", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("...90 lines truncated...")
    })

    test("truncates by byte count", async () => {
      const content = "a".repeat(1000)
      const result = await Truncate.output(content, { maxBytes: 100 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("truncated...")
    })

    test("truncates from head by default", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 3 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("line0")
      expect(result.content).toContain("line1")
      expect(result.content).toContain("line2")
      expect(result.content).not.toContain("line9")
    })

    test("truncates from tail when direction is tail", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 3, direction: "tail" })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("line7")
      expect(result.content).toContain("line8")
      expect(result.content).toContain("line9")
      expect(result.content).not.toContain("line0")
    })

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(2000)
      expect(Truncate.MAX_BYTES).toBe(50 * 1024)
    })

    test("large single-line file truncates with byte message", async () => {
      const content = await Filesystem.readText(path.join(FIXTURES_DIR, "models-api.json"))
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("bytes truncated...")
      expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
    })

    test("writes full output to file when truncated", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("The tool call succeeded but the output was truncated")
      expect(result.content).toContain("Grep")
      if (!result.truncated) throw new Error("expected truncated")
      expect(result.outputPath).toBeDefined()
      expect(result.outputPath).toContain("tool_")

      const written = await Filesystem.readText(result.outputPath!)
      expect(written).toBe(lines)
    })

    test("suggests Task tool when agent has task permission", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const agent = { permission: [{ permission: "task", pattern: "*", action: "allow" as const }] }
      const result = await Truncate.output(lines, { maxLines: 10 }, agent as any)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("Grep")
      expect(result.content).toContain("Task tool")
    })

    test("omits Task tool hint when agent lacks task permission", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const agent = { permission: [{ permission: "task", pattern: "*", action: "deny" as const }] }
      const result = await Truncate.output(lines, { maxLines: 10 }, agent as any)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("Grep")
      expect(result.content).not.toContain("Task tool")
    })

    test("does not write file when not truncated", async () => {
      const content = "short content"
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(false)
      if (result.truncated) throw new Error("expected not truncated")
      expect("outputPath" in result).toBe(false)
    })

    test("truncates correctly with multi-byte UTF-8 characters", async () => {
      // Each emoji is 4 bytes in UTF-8. 10 emojis + 9 newlines = 49 bytes
      // With maxBytes=30, byte limit triggers mid-way through the lines
      const lines = Array.from({ length: 10 }, () => "🔥").join("\n")
      const result = await Truncate.output(lines, { maxBytes: 30 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("🔥")
      expect(result.content).toContain("bytes truncated...")
      if (result.truncated) {
        const written = await Filesystem.readText(result.outputPath)
        expect(written).toBe(lines) // Full content preserved in file
      }
    })

    test("tail direction with multi-byte characters hits byte limit", async () => {
      // 10 lines of "你好" (6 bytes each), plus 9 newlines = 69 total bytes
      // maxBytes=25 triggers byte limit from the tail end
      const lines = Array.from({ length: 10 }, () => "你好").join("\n")
      const result = await Truncate.output(lines, { maxBytes: 25, direction: "tail" })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("你好")
      expect(result.content).toContain("bytes truncated...")
      // Tail direction: truncation message comes BEFORE the preview
      expect(result.content).toMatch(/bytes truncated.*你好/s)
    })

    test("line limit wins when it triggers before byte limit", async () => {
      // 50 lines of 9 bytes each (total ~499 bytes with newlines)
      // maxLines=5 triggers first; maxBytes=600 is never reached
      const lines = Array.from({ length: 50 }, (_, i) => `row-${String(i).padStart(5, "0")}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 5, maxBytes: 600 })

      expect(result.truncated).toBe(true)
      // Line limit triggered, so unit should be "lines" not "bytes"
      expect(result.content).toContain("45 lines truncated...")
      expect(result.content).not.toContain("bytes truncated")
      // Head direction: first 5 lines should be present
      expect(result.content).toContain("row-00000")
      expect(result.content).toContain("row-00004")
      expect(result.content).not.toContain("row-00005")
    })
  })

})
