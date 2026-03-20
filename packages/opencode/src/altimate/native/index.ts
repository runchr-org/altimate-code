import { setRegistrationHook } from "./dispatcher"

export * as Dispatcher from "./dispatcher"

// Lazy handler registration — modules are loaded on first Dispatcher.call(),
// not at import time. This prevents @altimateai/altimate-core napi binary
// from loading in test environments where it's not needed.
// altimate_change start — graceful degradation when native binding unavailable
function isNativeBindingError(e: any): boolean {
  const msg = String(e?.message || e)
  return msg.includes("native binding") || msg.includes("GLIBC") || msg.includes("ERR_DLOPEN_FAILED")
}

setRegistrationHook(async () => {
  // altimate-core napi-rs binding may fail on systems with older GLIBC.
  // Load it separately so other handlers still register.
  try {
    await import("./altimate-core")
  } catch (e: any) {
    if (isNativeBindingError(e)) {
      // Swallowed here — dispatcher.ts logs the user-facing warning
    } else {
      throw e
    }
  }

  // These modules transitively import @altimateai/altimate-core (via pii-detector,
  // lineage, test-local, or directly). Wrap each so a native binding failure in one
  // doesn't prevent the others from registering.
  const coreDependent = [
    () => import("./sql/register"),
    () => import("./schema/register"),
    () => import("./dbt/register"),
    () => import("./local/register"),
  ]
  for (const load of coreDependent) {
    try {
      await load()
    } catch (e: any) {
      if (isNativeBindingError(e)) {
        // Core-dependent module failed — skip silently, main warning already logged
      } else {
        throw e
      }
    }
  }

  // These modules don't depend on altimate-core and should always load.
  await import("./connections/register")
  await import("./finops/register")
})
// altimate_change end
