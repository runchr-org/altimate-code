import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import {
  parseGitLabMRUrl,
  REVIEW_MARKER,
  fetchMRMetadata,
  fetchMRChanges,
  fetchMRNotes,
  _buildReviewPrompt as buildReviewPrompt,
  _maskToken as maskToken,
  _resolveToken as resolveToken,
} from "../../src/cli/cmd/gitlab"

// ---------------------------------------------------------------------------
// E2E: Real GitLab API (public project, no auth needed)
// ---------------------------------------------------------------------------
// These tests hit the real gitlab.com API against the public gitlab-org/gitlab-runner
// project. They validate that our API helpers correctly parse real GitLab responses.
// They are skipped if gitlab.com is unreachable (CI without internet, rate limits).

const GITLAB_INSTANCE = "https://gitlab.com"
const PUBLIC_PROJECT = "gitlab-org%2Fgitlab-runner" // URL-encoded
const PUBLIC_MR_IID = 6591 // A merged MR with 1 change

async function gitlabReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${GITLAB_INSTANCE}/api/v4/projects/${PUBLIC_PROJECT}`, {
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

describe("E2E: fetchMRChanges against real gitlab.com", () => {
  let reachable: boolean

  beforeEach(async () => {
    reachable = await gitlabReachable()
  })

  test("fetches real MR changes from gitlab-org/gitlab-runner", async () => {
    if (!reachable) {
      console.log("Skipping: gitlab.com not reachable")
      return
    }

    // No token needed for public projects — pass empty string (API ignores invalid tokens on public endpoints)
    const result = await fetchMRChanges(GITLAB_INSTANCE, PUBLIC_PROJECT, PUBLIC_MR_IID, "")

    // Verify the response has the expected shape
    expect(result.title).toBe("Change the concrete helper image to use shell-form CMD")
    expect(result.state).toBe("merged")
    expect(result.author.username).toBe("cam_swords")
    expect(result.source_branch).toBe("cam/concrete-uses-exec-form-of-cmd")
    expect(result.target_branch).toBe("main")
    expect(result.web_url).toContain("gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/6591")

    // Verify changes array
    expect(Array.isArray(result.changes)).toBe(true)
    expect(result.changes.length).toBeGreaterThan(0)

    // Verify each change has the expected fields
    const change = result.changes[0]
    expect(typeof change.old_path).toBe("string")
    expect(typeof change.new_path).toBe("string")
    expect(typeof change.diff).toBe("string")
    expect(typeof change.new_file).toBe("boolean")
    expect(typeof change.deleted_file).toBe("boolean")
    expect(typeof change.renamed_file).toBe("boolean")
    expect(change.diff.length).toBeGreaterThan(0)
  })

  test("fetches real MR metadata from gitlab-org/gitlab-runner", async () => {
    if (!reachable) {
      console.log("Skipping: gitlab.com not reachable")
      return
    }

    const result = await fetchMRMetadata(GITLAB_INSTANCE, PUBLIC_PROJECT, PUBLIC_MR_IID, "")

    expect(result.title).toBe("Change the concrete helper image to use shell-form CMD")
    expect(result.state).toBe("merged")
    expect(result.author.username).toBe("cam_swords")
    expect(typeof result.sha).toBe("string")
    expect(result.sha.length).toBeGreaterThan(0)
  })

  test("returns 404 for non-existent MR", async () => {
    if (!reachable) {
      console.log("Skipping: gitlab.com not reachable")
      return
    }

    try {
      await fetchMRChanges(GITLAB_INSTANCE, PUBLIC_PROJECT, 999999999, "")
      expect(true).toBe(false) // should not reach here
    } catch (e: unknown) {
      expect((e as Error).message).toContain("404")
    }
  })

  test("returns error for non-existent project", async () => {
    if (!reachable) {
      console.log("Skipping: gitlab.com not reachable")
      return
    }

    try {
      await fetchMRChanges(GITLAB_INSTANCE, "this-project-does-not-exist-999", 1, "")
      expect(true).toBe(false) // should not reach here
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/404|not found/i)
    }
  })

  test("notes endpoint returns 401 for public project without token", async () => {
    if (!reachable) {
      console.log("Skipping: gitlab.com not reachable")
      return
    }

    // GitLab requires auth for notes even on public projects
    try {
      await fetchMRNotes(GITLAB_INSTANCE, PUBLIC_PROJECT, PUBLIC_MR_IID, "")
      // If this succeeds, notes are public on this project — that's fine too
    } catch (e: unknown) {
      expect((e as Error).message).toContain("401")
    }
  })
})

describe("E2E: full pipeline — URL parse → API fetch → prompt build", () => {
  let reachable: boolean

  beforeEach(async () => {
    reachable = await gitlabReachable()
  })

  test("parses a real MR URL, fetches data, and builds a review prompt", async () => {
    if (!reachable) {
      console.log("Skipping: gitlab.com not reachable")
      return
    }

    // Step 1: Parse URL
    const parsed = parseGitLabMRUrl("https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/6591")
    expect(parsed).not.toBeNull()
    expect(parsed!.instanceUrl).toBe("https://gitlab.com")
    expect(parsed!.projectPath).toBe("gitlab-org/gitlab-runner")
    expect(parsed!.mrIid).toBe(6591)

    // Step 2: Fetch real data
    const projectId = encodeURIComponent(parsed!.projectPath)
    const mrData = await fetchMRChanges(parsed!.instanceUrl, projectId, parsed!.mrIid, "")

    expect(mrData.title).toBeTruthy()
    expect(mrData.changes.length).toBeGreaterThan(0)

    // Step 3: Build prompt from real data (with empty notes since notes require auth)
    const prompt = buildReviewPrompt(mrData, [])

    // Verify prompt contains real data
    expect(prompt).toContain(mrData.title)
    expect(prompt).toContain(mrData.author.username)
    expect(prompt).toContain(mrData.source_branch)
    expect(prompt).toContain(mrData.target_branch)
    expect(prompt).toContain("<merge_request>")
    expect(prompt).toContain("<diffs>")
    expect(prompt).toContain("</diffs>")
    expect(prompt).toContain(mrData.changes[0].new_path)

    // Verify prompt has actual diff content
    expect(prompt).toContain(mrData.changes[0].diff.slice(0, 50))
  })

  test("handles URL parse → API fetch for nested group project", async () => {
    if (!reachable) {
      console.log("Skipping: gitlab.com not reachable")
      return
    }

    // gitlab-org/gitlab-runner is at the top level — test the URL encoding works
    const parsed = parseGitLabMRUrl("https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/6591")
    expect(parsed).not.toBeNull()

    const projectId = encodeURIComponent(parsed!.projectPath)
    expect(projectId).toBe("gitlab-org%2Fgitlab-runner")

    // The encoded project ID should work with the API
    const mrData = await fetchMRChanges(parsed!.instanceUrl, projectId, parsed!.mrIid, "")
    expect(mrData.title).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// E2E: API error handling (real network calls to bad endpoints)
// ---------------------------------------------------------------------------

describe("E2E: API error handling with real network calls", () => {
  let reachable: boolean

  beforeEach(async () => {
    reachable = await gitlabReachable()
  })

  test("connection to non-existent host times out or errors", async () => {
    try {
      // Use a port that's almost certainly not listening — should ECONNREFUSED quickly
      await fetchMRMetadata("http://127.0.0.1:1", "project", 1, "fake-token")
      expect(true).toBe(false) // should not reach here
    } catch (e: unknown) {
      // Should get a network error (ECONNREFUSED, timeout, etc.)
      expect(e).toBeInstanceOf(Error)
    }
  })

  test("invalid instance URL produces clear error", async () => {
    if (!reachable) {
      console.log("Skipping: gitlab.com not reachable")
      return
    }

    try {
      // Valid host but wrong API path — will 404
      await fetchMRMetadata("https://gitlab.com", "nonexistent%2Fproject%2Fpath", 1, "")
      expect(true).toBe(false)
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/404|not found/i)
    }
  })
})

// ---------------------------------------------------------------------------
// parseGitLabMRUrl — comprehensive tests
// ---------------------------------------------------------------------------

describe("parseGitLabMRUrl", () => {
  test("parses standard gitlab.com MR URL", () => {
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/123")).toEqual({
      instanceUrl: "https://gitlab.com",
      projectPath: "org/repo",
      mrIid: 123,
    })
  })

  test("parses nested group MR URL", () => {
    expect(parseGitLabMRUrl("https://gitlab.com/org/group/subgroup/repo/-/merge_requests/42")).toEqual({
      instanceUrl: "https://gitlab.com",
      projectPath: "org/group/subgroup/repo",
      mrIid: 42,
    })
  })

  test("parses self-hosted instance URL", () => {
    expect(parseGitLabMRUrl("https://gitlab.example.com/team/project/-/merge_requests/7")).toEqual({
      instanceUrl: "https://gitlab.example.com",
      projectPath: "team/project",
      mrIid: 7,
    })
  })

  test("parses URL with fragment (note anchor)", () => {
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/99#note_456")).toEqual({
      instanceUrl: "https://gitlab.com",
      projectPath: "org/repo",
      mrIid: 99,
    })
  })

  test("parses http URL", () => {
    expect(parseGitLabMRUrl("http://gitlab.internal/team/repo/-/merge_requests/1")).toEqual({
      instanceUrl: "http://gitlab.internal",
      projectPath: "team/repo",
      mrIid: 1,
    })
  })

  test("parses URL with port", () => {
    expect(parseGitLabMRUrl("https://gitlab.local:8443/org/repo/-/merge_requests/5")).toEqual({
      instanceUrl: "https://gitlab.local:8443",
      projectPath: "org/repo",
      mrIid: 5,
    })
  })

  test("parses URL with query parameters", () => {
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/10?tab=diffs")).toEqual({
      instanceUrl: "https://gitlab.com",
      projectPath: "org/repo",
      mrIid: 10,
    })
  })

  test("parses deeply nested group (4 levels)", () => {
    expect(parseGitLabMRUrl("https://gitlab.com/a/b/c/d/repo/-/merge_requests/1")).toEqual({
      instanceUrl: "https://gitlab.com",
      projectPath: "a/b/c/d/repo",
      mrIid: 1,
    })
  })

  test("parses URL with dots and hyphens in project path", () => {
    expect(parseGitLabMRUrl("https://gitlab.com/my-org/my.project-name/-/merge_requests/1")).toEqual({
      instanceUrl: "https://gitlab.com",
      projectPath: "my-org/my.project-name",
      mrIid: 1,
    })
  })

  test("handles large MR IID numbers", () => {
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/99999")).toEqual({
      instanceUrl: "https://gitlab.com",
      projectPath: "org/repo",
      mrIid: 99999,
    })
  })

  test("returns null for GitHub URLs", () => {
    expect(parseGitLabMRUrl("https://github.com/owner/repo/pull/123")).toBeNull()
  })

  test("returns null for non-MR GitLab URLs", () => {
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/issues/10")).toBeNull()
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/pipelines/50")).toBeNull()
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo")).toBeNull()
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/commits/main")).toBeNull()
  })

  test("returns null for invalid URLs", () => {
    expect(parseGitLabMRUrl("not-a-url")).toBeNull()
    expect(parseGitLabMRUrl("")).toBeNull()
    expect(parseGitLabMRUrl("gitlab.com/org/repo/-/merge_requests/1")).toBeNull()
  })

  test("returns null for MR URL without IID", () => {
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/")).toBeNull()
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests")).toBeNull()
  })

  test("returns null for MR URL with non-numeric IID", () => {
    expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/abc")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// maskToken
// ---------------------------------------------------------------------------

describe("maskToken", () => {
  test("masks long tokens showing first 4 and last 4 chars", () => {
    expect(maskToken("glpat-abcdefghijklmnopqrst")).toBe("glpa****qrst")
  })

  test("fully masks short tokens (8 chars or less)", () => {
    expect(maskToken("12345678")).toBe("****")
    expect(maskToken("short")).toBe("****")
    expect(maskToken("a")).toBe("****")
  })

  test("masks exactly 9 char token", () => {
    expect(maskToken("123456789")).toBe("1234****6789")
  })

  test("masks typical GitLab PAT", () => {
    const pat = "glpat-xYz123ABcdef456"
    const masked = maskToken(pat)
    expect(masked).toContain("****")
    expect(masked.startsWith("glpa")).toBe(true)
    expect(masked.endsWith("f456")).toBe(true)
    expect(masked).not.toBe(pat)
  })
})

// ---------------------------------------------------------------------------
// resolveToken
// ---------------------------------------------------------------------------

describe("resolveToken", () => {
  const savedPAT = process.env["GITLAB_PERSONAL_ACCESS_TOKEN"]
  const savedToken = process.env["GITLAB_TOKEN"]

  beforeEach(() => {
    delete process.env["GITLAB_PERSONAL_ACCESS_TOKEN"]
    delete process.env["GITLAB_TOKEN"]
  })

  afterEach(() => {
    // Restore original values
    if (savedPAT !== undefined) process.env["GITLAB_PERSONAL_ACCESS_TOKEN"] = savedPAT
    else delete process.env["GITLAB_PERSONAL_ACCESS_TOKEN"]
    if (savedToken !== undefined) process.env["GITLAB_TOKEN"] = savedToken
    else delete process.env["GITLAB_TOKEN"]
  })

  test("prefers GITLAB_PERSONAL_ACCESS_TOKEN over GITLAB_TOKEN", () => {
    process.env["GITLAB_PERSONAL_ACCESS_TOKEN"] = "pat-token"
    process.env["GITLAB_TOKEN"] = "generic-token"
    expect(resolveToken()).toBe("pat-token")
  })

  test("falls back to GITLAB_TOKEN when PAT not set", () => {
    process.env["GITLAB_TOKEN"] = "generic-token"
    expect(resolveToken()).toBe("generic-token")
  })

  test("throws when no token is set", () => {
    expect(() => resolveToken()).toThrow("GitLab token not found")
  })

  test("throws when tokens are empty strings", () => {
    process.env["GITLAB_PERSONAL_ACCESS_TOKEN"] = ""
    process.env["GITLAB_TOKEN"] = ""
    expect(() => resolveToken()).toThrow("GitLab token not found")
  })

  test("error message includes instructions for creating a token", () => {
    try {
      resolveToken()
    } catch (e: unknown) {
      const msg = (e as Error).message
      expect(msg).toContain("GITLAB_PERSONAL_ACCESS_TOKEN")
      expect(msg).toContain("GITLAB_TOKEN")
      expect(msg).toContain("personal_access_tokens")
      expect(msg).toContain("scope: api")
    }
  })
})

// ---------------------------------------------------------------------------
// REVIEW_MARKER constant
// ---------------------------------------------------------------------------

describe("REVIEW_MARKER", () => {
  test("is an HTML comment", () => {
    expect(REVIEW_MARKER).toMatch(/^<!--.*-->$/)
  })

  test("contains altimate-code-review identifier", () => {
    expect(REVIEW_MARKER).toContain("altimate-code-review")
  })
})

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

describe("buildReviewPrompt", () => {
  const baseMR = {
    title: "Add feature X",
    description: "This adds feature X to the system",
    author: { username: "testuser" },
    source_branch: "feat/x",
    target_branch: "main",
    state: "opened",
    web_url: "https://gitlab.com/org/repo/-/merge_requests/1",
    sha: "abc123",
    diff_refs: { base_sha: "aaa", head_sha: "bbb", start_sha: "ccc" },
    changes: [
      {
        old_path: "src/foo.ts",
        new_path: "src/foo.ts",
        new_file: false,
        renamed_file: false,
        deleted_file: false,
        diff: "@@ -1,3 +1,4 @@\n import { a } from 'b'\n+import { c } from 'd'\n const x = 1",
      },
    ],
  }

  test("includes MR title and author", () => {
    const prompt = buildReviewPrompt(baseMR, [])
    expect(prompt).toContain("Title: Add feature X")
    expect(prompt).toContain("Author: testuser")
  })

  test("includes branch info", () => {
    const prompt = buildReviewPrompt(baseMR, [])
    expect(prompt).toContain("Source Branch: feat/x")
    expect(prompt).toContain("Target Branch: main")
  })

  test("includes changed file list with correct status labels", () => {
    const prompt = buildReviewPrompt(baseMR, [])
    expect(prompt).toContain("- src/foo.ts (modified)")
  })

  test("marks new files as added", () => {
    const mr = { ...baseMR, changes: [{ ...baseMR.changes[0], new_file: true }] }
    expect(buildReviewPrompt(mr, [])).toContain("(added)")
  })

  test("marks deleted files", () => {
    const mr = { ...baseMR, changes: [{ ...baseMR.changes[0], deleted_file: true }] }
    expect(buildReviewPrompt(mr, [])).toContain("(deleted)")
  })

  test("marks renamed files", () => {
    const mr = { ...baseMR, changes: [{ ...baseMR.changes[0], renamed_file: true }] }
    expect(buildReviewPrompt(mr, [])).toContain("(renamed)")
  })

  test("includes diff content in prompt", () => {
    const prompt = buildReviewPrompt(baseMR, [])
    expect(prompt).toContain("--- src/foo.ts")
    expect(prompt).toContain("+++ src/foo.ts")
    expect(prompt).toContain("import { c } from 'd'")
  })

  test("handles empty description gracefully", () => {
    const mr = { ...baseMR, description: "" }
    expect(buildReviewPrompt(mr, [])).toContain("Description: (no description)")
  })

  test("includes user notes but filters system notes", () => {
    const notes = [
      { id: 1, body: "This looks good!", author: { username: "reviewer" }, created_at: "2026-01-01T00:00:00Z", system: false },
      { id: 2, body: "assigned to @reviewer", author: { username: "system" }, created_at: "2026-01-01T00:00:00Z", system: true },
    ]
    const prompt = buildReviewPrompt(baseMR, notes)
    expect(prompt).toContain("This looks good!")
    expect(prompt).not.toContain("assigned to @reviewer")
  })

  test("filters out existing review marker notes", () => {
    const notes = [
      { id: 1, body: `${REVIEW_MARKER}\nPrevious review`, author: { username: "bot" }, created_at: "2026-01-01T00:00:00Z" },
      { id: 2, body: "Please fix this", author: { username: "reviewer" }, created_at: "2026-01-02T00:00:00Z" },
    ]
    const prompt = buildReviewPrompt(baseMR, notes)
    expect(prompt).not.toContain("Previous review")
    expect(prompt).toContain("Please fix this")
  })

  test("omits comments section when no notes", () => {
    expect(buildReviewPrompt(baseMR, [])).not.toContain("<existing_comments>")
  })

  test("includes comments section when notes exist", () => {
    const notes = [{ id: 1, body: "A comment", author: { username: "user1" }, created_at: "2026-01-01T00:00:00Z" }]
    const prompt = buildReviewPrompt(baseMR, notes)
    expect(prompt).toContain("<existing_comments>")
    expect(prompt).toContain("</existing_comments>")
  })

  test("truncates diffs when exceeding maxSize", () => {
    const largeDiff = "x".repeat(60000)
    const mr = {
      ...baseMR,
      changes: [
        { ...baseMR.changes[0], diff: largeDiff },
        { ...baseMR.changes[0], new_path: "src/bar.ts", old_path: "src/bar.ts", diff: largeDiff },
        { ...baseMR.changes[0], new_path: "src/baz.ts", old_path: "src/baz.ts", diff: largeDiff },
      ],
    }
    const prompt = buildReviewPrompt(mr, [], 100000)
    expect(prompt).toContain("[Additional")
    expect(prompt).toContain("truncated due to size limit")
    // File list should still show ALL files
    expect(prompt).toContain("src/foo.ts")
    expect(prompt).toContain("src/bar.ts")
    expect(prompt).toContain("src/baz.ts")
  })

  test("includes all diffs when within maxSize", () => {
    expect(buildReviewPrompt(baseMR, [], 100000)).not.toContain("truncated")
  })

  test("handles MR with 50 changed files", () => {
    const changes = Array.from({ length: 50 }, (_, i) => ({
      old_path: `src/file${i}.ts`,
      new_path: `src/file${i}.ts`,
      new_file: i % 3 === 0,
      renamed_file: false,
      deleted_file: i % 5 === 0,
      diff: `@@ -1 +1 @@\n-old${i}\n+new${i}`,
    }))
    const prompt = buildReviewPrompt({ ...baseMR, changes }, [])
    for (let i = 0; i < 50; i++) {
      expect(prompt).toContain(`src/file${i}.ts`)
    }
  })

  test("handles notes with undefined system field (backwards compat)", () => {
    const notes = [{ id: 1, body: "A normal comment", author: { username: "user1" }, created_at: "2026-01-01T00:00:00Z" }]
    expect(buildReviewPrompt(baseMR, notes)).toContain("A normal comment")
  })

  test("wraps content in expected XML tags", () => {
    const prompt = buildReviewPrompt(baseMR, [])
    expect(prompt).toContain("<merge_request>")
    expect(prompt).toContain("</merge_request>")
    expect(prompt).toContain("<diffs>")
    expect(prompt).toContain("</diffs>")
    expect(prompt).toContain("<changed_files>")
    expect(prompt).toContain("</changed_files>")
  })

  test("includes review focus instructions", () => {
    const prompt = buildReviewPrompt(baseMR, [])
    expect(prompt).toContain("Bugs, logic errors, and edge cases")
    expect(prompt).toContain("Security issues")
  })
})
