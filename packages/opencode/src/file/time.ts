import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"
import { Filesystem } from "../util/filesystem"
// altimate_change start — telemetry for FileTime drift measurement
import { Telemetry } from "../altimate/telemetry"
// altimate_change end

export namespace FileTime {
  const log = Log.create({ service: "file.time" })

  // altimate_change start — FileTime clock source change documentation
  //
  // CHANGE: read() now records the file's filesystem mtime instead of Date.now().
  //
  // WHY: The original code used `new Date()` (wall-clock) as the "last read" timestamp,
  // then assert() compared it against `Filesystem.stat(file).mtime`. On WSL (NTFS-over-9P),
  // networked drives, and some macOS APFS mounts, the filesystem clock drifts 400ms–1.2s
  // behind Node.js's clock. This caused mtime > readTime even for the file's own write,
  // triggering false "modified since last read" errors. One user hit 782 consecutive retries.
  //
  // FIX: Both timestamps now come from the same clock (filesystem mtime), eliminating
  // cross-clock skew. The tolerance is kept at 50ms (upstream default) since same-clock
  // comparisons don't need a larger window.
  //
  // TRADE-OFF: On coarse-resolution filesystems (HFS+ = 1s, NFS with stale cache,
  // Docker overlayfs after copy-up), two writes within the same resolution window
  // produce identical mtimes — so we'd miss a real external modification. This is a
  // false-negative risk (missed edit) vs the false-positive risk (retry loop) we're
  // fixing. Acceptable because: (a) the file gets re-read on the next attempt anyway,
  // (b) HFS+ is rare (macOS defaulted to APFS since 2017), and (c) the wall-clock
  // approach was actively causing 782-retry production loops on WSL.
  //
  // MONITORING: filetime_drift telemetry event tracks the gap between wall-clock and mtime
  // at read time. If drift_ms is consistently 0, this change has no effect (good). If
  // drift_ms shows large values, this change is preventing false positives (also good).
  // If file_stale errors increase post-deploy, the tolerance may need adjustment.
  //
  // UPSTREAM: sst/opencode issues #19040, #14183, #20354 track the same problem.
  // Upstream is pursuing processor-level recovery (PR #19099) rather than fixing the clock
  // source. Both approaches are complementary.
  //
  // ROLLBACK: Set OPENCODE_DISABLE_FILETIME_CHECK=true to bypass all checks, or revert
  // this change to restore `new Date()` behavior with a wider tolerance.
  // altimate_change end

  // Per-session read times plus per-file write locks.
  // All tools that overwrite existing files should run their
  // assert/read/write/update sequence inside withLock(filepath, ...)
  // so concurrent writes to the same file are serialized.
  export const state = Instance.state(() => {
    const read: {
      [sessionID: string]: {
        [path: string]: Date | undefined
      }
    } = {}
    const locks = new Map<string, Promise<void>>()
    return {
      read,
      locks,
    }
  })

  export function read(sessionID: string, file: string) {
    log.info("read", { sessionID, file })
    const { read } = state()
    read[sessionID] = read[sessionID] || {}
    // altimate_change start — use filesystem mtime instead of wall-clock (see doc block above)
    const wallClock = new Date()
    const mtime = Filesystem.stat(file)?.mtime
    read[sessionID][file] = mtime ?? wallClock

    // Track drift between wall-clock and filesystem mtime for monitoring.
    // This lets us measure the real-world impact of the clock source change
    // and detect environments where drift is significant.
    if (mtime) {
      const driftMs = Math.abs(wallClock.getTime() - mtime.getTime())
      if (driftMs > 10) {
        // Only emit when drift is non-trivial (>10ms) to avoid noise
        try {
          Telemetry.track({
            type: "filetime_drift",
            timestamp: Date.now(),
            session_id: sessionID,
            drift_ms: driftMs,
            mtime_ahead: mtime.getTime() > wallClock.getTime(),
          })
        } catch {
          // Telemetry must never break file operations
        }
      }
    }
    // altimate_change end
  }

  export function get(sessionID: string, file: string) {
    return state().read[sessionID]?.[file]
  }

  export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    const current = state()
    const currentLock = current.locks.get(filepath) ?? Promise.resolve()
    let release: () => void = () => {}
    const nextLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = currentLock.then(() => nextLock)
    current.locks.set(filepath, chained)
    await currentLock
    try {
      return await fn()
    } finally {
      release()
      if (current.locks.get(filepath) === chained) {
        current.locks.delete(filepath)
      }
    }
  }

  export async function assert(sessionID: string, filepath: string) {
    if (Flag.OPENCODE_DISABLE_FILETIME_CHECK === true) {
      return
    }

    const time = get(sessionID, filepath)
    if (!time) throw new Error(`You must read file ${filepath} before overwriting it. Use the Read tool first`)
    const mtime = Filesystem.stat(filepath)?.mtime
    // altimate_change start — keep upstream's 50ms tolerance (sufficient now that both
    // timestamps come from the same filesystem clock). Track assertion outcomes for monitoring.
    const toleranceMs = 50
    const deltaMs = mtime ? mtime.getTime() - time.getTime() : 0
    if (mtime && deltaMs > toleranceMs) {
      try {
        Telemetry.track({
          type: "filetime_assert",
          timestamp: Date.now(),
          session_id: sessionID,
          outcome: "stale",
          delta_ms: deltaMs,
          tolerance_ms: toleranceMs,
        })
      } catch {
        // Telemetry must never mask the stale-file error
      }
      throw new Error(
        `File ${filepath} has been modified since it was last read.\nLast modification: ${mtime.toISOString()}\nLast read: ${time.toISOString()}\nDelta: ${deltaMs}ms (tolerance: ${toleranceMs}ms)\n\nPlease read the file again before modifying it.`,
      )
    }
    // altimate_change end
  }
}
