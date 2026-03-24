/**
 * Tests for SqlAnalyzeTool title construction and formatAnalysis output.
 *
 * These test the formatting logic patterns used in sql-analyze.ts.
 * Since formatAnalysis is not exported, we replicate its logic here —
 * same approach as tool-formatters.test.ts. This means these tests
 * will not catch changes to the real function unless the test copy
 * is also updated. This is an accepted tradeoff in this codebase.
 */

import { describe, test, expect } from "bun:test"

describe("SqlAnalyzeTool: title construction", () => {
  // Replicates the title template from sql-analyze.ts execute() line 25
  function buildTitle(result: { error?: string; issue_count: number; confidence: string }) {
    return `Analyze: ${result.error ? "PARSE ERROR" : `${result.issue_count} issue${result.issue_count !== 1 ? "s" : ""}`} [${result.confidence}]`
  }

  test("zero issues shows '0 issues'", () => {
    expect(buildTitle({ issue_count: 0, confidence: "high" })).toBe("Analyze: 0 issues [high]")
  })

  test("one issue shows singular '1 issue'", () => {
    expect(buildTitle({ issue_count: 1, confidence: "high" })).toBe("Analyze: 1 issue [high]")
  })

  test("multiple issues shows plural", () => {
    expect(buildTitle({ issue_count: 5, confidence: "medium" })).toBe("Analyze: 5 issues [medium]")
  })

  test("error present shows PARSE ERROR", () => {
    expect(buildTitle({ error: "syntax error", issue_count: 0, confidence: "low" })).toBe(
      "Analyze: PARSE ERROR [low]",
    )
  })
})

describe("SqlAnalyzeTool: formatAnalysis output", () => {
  // Replicates formatAnalysis() from sql-analyze.ts lines 45-70
  function formatAnalysis(result: {
    error?: string
    issues: Array<{
      type: string
      severity: string
      message: string
      recommendation: string
      location?: string
      confidence: string
    }>
    issue_count: number
    confidence: string
    confidence_factors: string[]
  }): string {
    if (result.error) return `Analysis failed: ${result.error}`
    if (result.issues.length === 0) return "No anti-patterns or issues detected."

    const lines: string[] = [
      `Found ${result.issue_count} issue${result.issue_count !== 1 ? "s" : ""} (confidence: ${result.confidence}):`,
    ]
    if (result.confidence_factors.length > 0) {
      lines.push(`  Note: ${result.confidence_factors.join("; ")}`)
    }
    lines.push("")

    for (const issue of result.issues) {
      const loc = issue.location ? ` \u2014 ${issue.location}` : ""
      const conf = issue.confidence !== "high" ? ` [${issue.confidence} confidence]` : ""
      lines.push(`  [${issue.severity.toUpperCase()}] ${issue.type}${conf}`)
      lines.push(`    ${issue.message}${loc}`)
      lines.push(`    \u2192 ${issue.recommendation}`)
      lines.push("")
    }

    return lines.join("\n")
  }

  test("error result returns failure message", () => {
    const output = formatAnalysis({
      error: "parse error at line 5",
      issues: [],
      issue_count: 0,
      confidence: "low",
      confidence_factors: [],
    })
    expect(output).toBe("Analysis failed: parse error at line 5")
  })

  test("zero issues returns clean message", () => {
    const output = formatAnalysis({
      issues: [],
      issue_count: 0,
      confidence: "high",
      confidence_factors: [],
    })
    expect(output).toBe("No anti-patterns or issues detected.")
  })

  test("issues are formatted with severity, type, location", () => {
    const output = formatAnalysis({
      issues: [
        {
          type: "lint",
          severity: "warning",
          message: "SELECT * detected",
          recommendation: "Use explicit columns",
          location: "line 1",
          confidence: "high",
        },
      ],
      issue_count: 1,
      confidence: "high",
      confidence_factors: ["lint"],
    })
    expect(output).toContain("[WARNING] lint")
    expect(output).toContain("SELECT * detected \u2014 line 1")
    expect(output).toContain("\u2192 Use explicit columns")
  })

  test("non-high confidence issues show confidence tag", () => {
    const output = formatAnalysis({
      issues: [
        {
          type: "semantic",
          severity: "info",
          message: "Possible unused join",
          recommendation: "Review join necessity",
          confidence: "medium",
        },
      ],
      issue_count: 1,
      confidence: "medium",
      confidence_factors: ["semantics"],
    })
    expect(output).toContain("[medium confidence]")
  })

  test("high confidence issues omit confidence tag", () => {
    const output = formatAnalysis({
      issues: [
        {
          type: "safety",
          severity: "high",
          message: "SQL injection risk",
          recommendation: "Use parameterized queries",
          confidence: "high",
        },
      ],
      issue_count: 1,
      confidence: "high",
      confidence_factors: ["safety"],
    })
    expect(output).not.toContain("[high confidence]")
  })

  test("confidence factors are listed in Note line", () => {
    const output = formatAnalysis({
      issues: [
        {
          type: "lint",
          severity: "warning",
          message: "Missing LIMIT",
          recommendation: "Add LIMIT clause",
          confidence: "high",
        },
      ],
      issue_count: 1,
      confidence: "high",
      confidence_factors: ["lint", "semantics", "safety"],
    })
    expect(output).toContain("Note: lint; semantics; safety")
  })
})
