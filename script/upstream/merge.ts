#!/usr/bin/env bun
/**
 * Upstream Merge Tool
 *
 * Merges upstream opencode releases into our fork with automatic conflict resolution.
 *
 * Usage:
 *   bun run script/upstream/merge.ts --version v1.2.19
 *   bun run script/upstream/merge.ts --version v1.2.19 --report-only
 *
 * Steps:
 *   1. Validate prerequisites (clean working tree, version tag exists)
 *   2. Create merge branch
 *   3. Start git merge (expect conflicts)
 *   4. Resolve keepOurs files (our custom code)
 *   5. Resolve skipFiles (unused upstream packages)
 *   6. Resolve lock files (accept ours, regenerate later)
 *   7. Report remaining conflicts for manual resolution
 *   8. After manual resolution: regenerate lock file
 */

import { parseArgs } from "util"
import { git, gitSafe, tagExists, currentBranch, hasUncommittedChanges, conflictedFiles } from "./utils/git"
import { loadConfig, repoRoot } from "./utils/config"
import { resolveKeepOurs } from "./transforms/keep-ours"
import { resolveSkipFiles, cleanSkippedPackages } from "./transforms/skip-files"
import { resolveLockFiles, regenerateLockFile } from "./transforms/lock-files"

const { values: args } = parseArgs({
  options: {
    version: { type: "string", short: "v" },
    "report-only": { type: "boolean", default: false },
    continue: { type: "boolean", default: false },
  },
})

async function main() {
  const config = loadConfig()

  if (args.continue) {
    await continueAfterManualResolution()
    return
  }

  const version = args.version
  if (!version) {
    console.error("Error: --version is required (e.g., --version v1.2.19)")
    process.exit(1)
  }

  // Step 1: Validate
  console.log("Step 1: Validating prerequisites...")

  // Fetch upstream tags
  console.log(`  Fetching ${config.upstreamRemote}...`)
  git(`fetch ${config.upstreamRemote} --tags`)

  if (!tagExists(version)) {
    console.error(`Error: Tag ${version} does not exist on ${config.upstreamRemote}`)
    console.error(`  Available tags: ${git("tag -l 'v1.2.*' --sort=-v:refname").split("\n").slice(0, 5).join(", ")}`)
    process.exit(1)
  }

  if (hasUncommittedChanges()) {
    console.error("Error: Working tree has uncommitted changes. Commit or stash first.")
    process.exit(1)
  }

  const branch = currentBranch()
  console.log(`  Current branch: ${branch}`)
  console.log(`  Target version: ${version}`)

  // Report-only mode: dry-run analysis
  if (args["report-only"]) {
    await reportOnly(version, config)
    return
  }

  // Step 2: Create merge branch
  const mergeBranch = `merge/upstream-${version}`
  console.log(`\nStep 2: Creating merge branch ${mergeBranch}...`)
  git(`checkout -b ${mergeBranch}`)

  // Step 3: Start merge
  console.log(`\nStep 3: Starting merge with ${version}...`)
  const mergeResult = gitSafe(`merge ${version} --no-edit`)

  if (mergeResult !== null) {
    console.log("  Merge completed without conflicts!")
    await postMerge(config)
    return
  }

  console.log("  Merge has conflicts (expected). Resolving...")

  // Step 4: Resolve keepOurs
  console.log("\nStep 4: Resolving keepOurs files...")
  const keepOursResult = resolveKeepOurs()
  console.log(`  Resolved ${keepOursResult.resolved.length} files (kept ours)`)
  for (const f of keepOursResult.resolved) console.log(`    ✓ ${f}`)

  // Step 5: Resolve skipFiles
  console.log("\nStep 5: Resolving skipFiles (unused packages)...")
  const skipResult = resolveSkipFiles()
  console.log(`  Resolved ${skipResult.resolved.length} files (removed)`)

  // Step 6: Resolve lock files
  console.log("\nStep 6: Resolving lock files...")
  const lockResult = resolveLockFiles()
  console.log(`  Resolved ${lockResult.length} lock files`)

  // Step 7: Report remaining conflicts
  const remaining = conflictedFiles()
  if (remaining.length === 0) {
    console.log("\nAll conflicts resolved automatically!")
    git("commit --no-edit")
    await postMerge(config)
  } else {
    console.log(`\nStep 7: ${remaining.length} files need manual resolution:`)
    for (const f of remaining) {
      console.log(`  ⚠ ${f}`)
    }
    console.log("\nManual steps:")
    console.log("  1. Resolve the conflicts above")
    console.log("  2. git add <resolved files>")
    console.log("  3. bun run script/upstream/merge.ts --continue")
  }
}

async function continueAfterManualResolution() {
  const config = loadConfig()
  const remaining = conflictedFiles()

  if (remaining.length > 0) {
    console.error(`Error: ${remaining.length} files still have conflicts:`)
    for (const f of remaining) console.error(`  ⚠ ${f}`)
    process.exit(1)
  }

  console.log("All conflicts resolved. Continuing merge...")
  git("commit --no-edit")
  await postMerge(config)
}

async function postMerge(config: ReturnType<typeof loadConfig>) {
  // Clean up skipped packages that might have been added by upstream
  console.log("\nPost-merge: Cleaning skipped packages...")
  const cleaned = cleanSkippedPackages()
  if (cleaned.length > 0) {
    console.log(`  Removed ${cleaned.length} skipped directories`)
    git('commit -m "chore: remove unused upstream packages after merge"')
  }

  // Regenerate lock file
  console.log("\nPost-merge: Regenerating lock file...")
  regenerateLockFile()
  git('commit -m "chore: regenerate bun.lock after upstream merge"')

  console.log("\n✅ Merge complete!")
  console.log("Next steps:")
  console.log("  1. bun run build")
  console.log("  2. bun test")
  console.log("  3. Review changes: git log --oneline HEAD~5..HEAD")
}

async function reportOnly(version: string, config: ReturnType<typeof loadConfig>) {
  console.log(`\n--- Dry-run conflict analysis for ${version} ---\n`)

  // Get list of files that would change
  const diffFiles = git(`diff --name-only HEAD...${version}`).split("\n").filter(Boolean)
  console.log(`Total files changed in upstream: ${diffFiles.length}`)

  // Categorize
  const { minimatch } = await import("minimatch")
  const keepOurs: string[] = []
  const skipFiles: string[] = []
  const potentialConflicts: string[] = []
  const safeUpdates: string[] = []

  for (const file of diffFiles) {
    if (config.keepOurs.some((p) => minimatch(file, p))) {
      keepOurs.push(file)
    } else if (config.skipFiles.some((p) => minimatch(file, p))) {
      skipFiles.push(file)
    } else {
      // Check if we've modified this file
      const ourDiff = gitSafe(`diff HEAD -- ${file}`)
      if (ourDiff && ourDiff.length > 0) {
        potentialConflicts.push(file)
      } else {
        safeUpdates.push(file)
      }
    }
  }

  console.log(`\nKeepOurs (auto-resolved): ${keepOurs.length}`)
  console.log(`SkipFiles (auto-removed): ${skipFiles.length}`)
  console.log(`Safe updates (no conflict): ${safeUpdates.length}`)
  console.log(`Potential conflicts (manual review): ${potentialConflicts.length}`)

  if (potentialConflicts.length > 0) {
    console.log("\nFiles likely to conflict:")
    for (const f of potentialConflicts) {
      console.log(`  ⚠ ${f}`)
    }
  }

  // Check for altimate_change markers in potentially conflicted files
  const markerFiles: string[] = []
  for (const file of potentialConflicts) {
    const content = gitSafe(`show HEAD:${file}`)
    if (content && content.includes(config.changeMarker)) {
      markerFiles.push(file)
    }
  }

  if (markerFiles.length > 0) {
    console.log(`\nFiles with ${config.changeMarker} markers (need careful review):`)
    for (const f of markerFiles) console.log(`  📝 ${f}`)
  }
}

main().catch((e) => {
  console.error("Merge failed:", e)
  process.exit(1)
})
