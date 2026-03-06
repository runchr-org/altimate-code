import { minimatch } from "minimatch"
import { git, conflictedFiles } from "../utils/git"
import { loadConfig } from "../utils/config"

/**
 * For conflicted files matching skipFiles patterns, resolve by removing them.
 * These are upstream packages we don't use (e.g., packages/app/**, packages/desktop/**).
 */
export function resolveSkipFiles(): { resolved: string[]; skipped: string[] } {
  const config = loadConfig()
  const conflicts = conflictedFiles()
  const resolved: string[] = []
  const skipped: string[] = []

  for (const file of conflicts) {
    const shouldSkip = config.skipFiles.some((pattern) => minimatch(file, pattern))
    if (shouldSkip) {
      git(`rm --force "${file}"`)
      resolved.push(file)
    } else {
      skipped.push(file)
    }
  }

  return { resolved, skipped }
}

/**
 * After merge, remove any new files from skipped packages that upstream added.
 */
export function cleanSkippedPackages(): string[] {
  const config = loadConfig()
  const cleaned: string[] = []

  for (const pattern of config.skipFiles) {
    // Only clean directory-level patterns
    if (!pattern.endsWith("/**")) continue
    const dir = pattern.replace("/**", "")
    try {
      git(`rm -rf "${dir}"`)
      cleaned.push(dir)
    } catch {
      // Directory doesn't exist, skip
    }
  }

  return cleaned
}
