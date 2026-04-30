/**
 * Entity-per-table pattern detector.
 *
 * Many warehouses have N tables that share the same column structure (one
 * ticker per table, one tenant per table, time-partitioned tables, per-region
 * tables). Naively cached per-table this wastes context and gets truncated.
 *
 * This module detects such groups by fingerprinting each table's column
 * structure and looking for fingerprints that dominate a schema. When found,
 * the cache emits a single composite digest (with full table_names list)
 * instead of N near-identical per-table entries.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A column as needed for fingerprinting. */
export interface FingerprintColumn {
  name: string
  data_type: string
}

/** Input row: one table with its column shape. */
export interface TableShape {
  table_name: string
  columns: FingerprintColumn[]
}

/** A detected entity-per-table group, dense and ready for digest emission. */
export interface EntityGroup {
  /** Stable string fingerprint identifying the shared column shape. */
  fingerprint: string
  /** Canonical column list (sorted by name). */
  composite_columns: FingerprintColumn[]
  /** Full list of tables that share this fingerprint. */
  table_names: string[]
  /** Picked sample table (alphabetical first) for users wanting a peek. */
  sample_table: string
}

/**
 * Result of running detection over one schema's tables.
 *
 * NOTE: At most ONE entity group is returned per schema — the one with the
 * largest member bucket among fingerprints that meet both the ratio and
 * minTables thresholds. Schemas that contain two or more distinct entity
 * patterns (e.g. 100 per-ticker tables AND 80 per-region tables) will only
 * have the dominant pattern collapsed; the other pattern's tables fall into
 * `remaining_tables` and are emitted per-table by the cache.
 *
 * This is a deliberate scope choice: the cache UNIQUE on
 * `(warehouse, database, schema, fingerprint)` allows multiple groups per
 * schema, but multi-group detection is left for a follow-up to keep the
 * rollout backwards-compatible. Callers needing all groups for a schema
 * should call `detectEntityGroup` repeatedly on `remaining_tables`.
 */
export interface EntityGroupDetection {
  /** Detected entity group, or null if no group passed the threshold. */
  entity_group: EntityGroup | null
  /** Tables NOT covered by the entity group — emit per-table as before. */
  remaining_tables: string[]
}

// ---------------------------------------------------------------------------
// Heuristic parameters
// ---------------------------------------------------------------------------

/**
 * Minimum share of tables a single fingerprint must cover to be considered
 * an "entity-per-table" pattern. Default: 50%.
 */
export const DEFAULT_ENTITY_RATIO_THRESHOLD = 0.5

/**
 * Minimum absolute number of tables in the dominant group. Below this we
 * stay with per-table emission — the cost saving isn't worth a new format.
 */
export const DEFAULT_ENTITY_MIN_TABLES = 20

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Sentinel marker for columns whose data_type is null/undefined. Distinct from
 * the empty string so a real type of "" (drivers may legitimately return that)
 * does not collide with a missing type.
 */
const NULL_TYPE_SENTINEL = "\u0000__null_type__\u0000"

/**
 * Build a stable fingerprint of a table's column shape.
 *
 * Sorted by column name so identical structures collide regardless of the
 * order the source database returns columns in. Type is lowercased so
 * `VARCHAR` and `varchar` match.
 *
 * Encoding uses `JSON.stringify` per (name, type) tuple joined by a unit
 * separator (\x1F). That keeps the fingerprint delimiter-safe even when
 * column names contain `:` or `|` (legal in quoted Postgres/Snowflake/
 * BigQuery identifiers). Null/undefined `data_type` values are mapped to a
 * dedicated sentinel so two tables that differ only in "missing type vs real
 * type" do not collide.
 */
export function fingerprintColumns(columns: FingerprintColumn[]): string {
  if (columns.length === 0) return ""
  const sorted = [...columns]
    .map((c) => ({
      name: c.name,
      data_type:
        c.data_type == null
          ? NULL_TYPE_SENTINEL
          : c.data_type.toLowerCase(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return sorted.map((c) => JSON.stringify([c.name, c.data_type])).join("\x1F")
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Group tables by column-structure fingerprint and detect an entity-per-table
 * group. A fingerprint group qualifies when it covers
 *   - at least `ratioThreshold` of all tables in the input, AND
 *   - at least `minTables` tables in absolute terms.
 *
 * Tables with empty column lists are ignored for grouping (they can't be
 * fingerprinted reliably) and always end up in `remaining_tables`.
 */
export function detectEntityGroup(
  tables: TableShape[],
  options: { ratioThreshold?: number; minTables?: number } = {},
): EntityGroupDetection {
  const ratioThreshold = options.ratioThreshold ?? DEFAULT_ENTITY_RATIO_THRESHOLD
  const minTables = options.minTables ?? DEFAULT_ENTITY_MIN_TABLES

  // Reject obviously-bad threshold inputs so silent miscalibrations from
  // upstream callers (NaN, negative, fractional minTables) fail loudly.
  if (
    typeof ratioThreshold !== "number" ||
    !Number.isFinite(ratioThreshold) ||
    ratioThreshold <= 0 ||
    ratioThreshold > 1
  ) {
    throw new Error(
      `entity-groups: ratioThreshold must be a number in (0, 1]; got ${ratioThreshold}`,
    )
  }
  if (!Number.isInteger(minTables) || minTables < 2) {
    throw new Error(
      `entity-groups: minTables must be an integer >= 2; got ${minTables}`,
    )
  }

  if (tables.length === 0) {
    return { entity_group: null, remaining_tables: [] }
  }

  // Bucket tables by fingerprint.
  const buckets = new Map<string, TableShape[]>()
  const noFingerprint: string[] = []
  for (const t of tables) {
    if (!t.columns || t.columns.length === 0) {
      noFingerprint.push(t.table_name)
      continue
    }
    const fp = fingerprintColumns(t.columns)
    const bucket = buckets.get(fp)
    if (bucket) {
      bucket.push(t)
    } else {
      buckets.set(fp, [t])
    }
  }

  if (buckets.size === 0) {
    return { entity_group: null, remaining_tables: noFingerprint }
  }

  // Pick the largest bucket.
  let bestFp: string | null = null
  let bestBucket: TableShape[] = []
  for (const [fp, bucket] of buckets) {
    if (bucket.length > bestBucket.length) {
      bestFp = fp
      bestBucket = bucket
    }
  }

  // Threshold check uses total fingerprintable + non-fingerprintable tables
  // — i.e. the full input — so a schema dominated by empty-column tables
  // can't tip the ratio.
  const totalTables = tables.length
  const meetsRatio = bestBucket.length / totalTables >= ratioThreshold
  const meetsMin = bestBucket.length >= minTables
  if (!bestFp || !meetsRatio || !meetsMin) {
    const remaining = tables.map((t) => t.table_name)
    return { entity_group: null, remaining_tables: remaining }
  }

  // Build the canonical composite column list from the first table in the
  // bucket. Sort by name so output is stable and matches the fingerprint.
  const compositeColumns: FingerprintColumn[] = [...bestBucket[0].columns]
    .map((c) => ({ name: c.name, data_type: c.data_type }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const tableNames = bestBucket.map((t) => t.table_name).sort()
  const inGroup = new Set(tableNames)

  const remaining: string[] = []
  for (const t of tables) {
    if (!inGroup.has(t.table_name)) remaining.push(t.table_name)
  }

  return {
    entity_group: {
      fingerprint: bestFp,
      composite_columns: compositeColumns,
      table_names: tableNames,
      sample_table: tableNames[0],
    },
    remaining_tables: remaining.sort(),
  }
}
