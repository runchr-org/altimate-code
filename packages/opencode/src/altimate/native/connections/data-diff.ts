/**
 * DataParity orchestrator — runs the cooperative Rust state machine against
 * live database connections.
 *
 * The Rust engine (DataParitySession) never touches databases — it emits SQL
 * for us to execute, we feed results back, and it decides the next step.
 * This file is the bridge between that engine and altimate-code's drivers.
 */

import type { DataDiffParams, DataDiffResult, PartitionDiffResult } from "../types"
import * as Registry from "./registry"

// ---------------------------------------------------------------------------
// Query-source detection
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = /^\s*(SELECT|WITH|VALUES)\b/i

/**
 * Detect whether a string is an arbitrary SQL query (vs a plain table name).
 * Plain table names may contain dots (schema.table, db.schema.table) but not spaces.
 */
function isQuery(input: string): boolean {
  return SQL_KEYWORDS.test(input)
}

/**
 * If either source or target is an arbitrary query, wrap them in CTEs so the
 * DataParity engine can treat them as tables named `__diff_source` / `__diff_target`.
 *
 * Returns `{ table1Name, table2Name, ctePrefix | null }`.
 *
 * When a CTE prefix is returned, it must be prepended to every SQL task emitted
 * by the engine before execution.
 */
export function resolveTableSources(
  source: string,
  target: string,
): { table1Name: string; table2Name: string; ctePrefix: string | null } {
  const source_is_query = isQuery(source)
  const target_is_query = isQuery(target)

  if (!source_is_query && !target_is_query) {
    // Both are plain table names — pass through unchanged
    return { table1Name: source, table2Name: target, ctePrefix: null }
  }

  // At least one is a query — wrap both in CTEs
  const srcExpr = source_is_query ? source : `SELECT * FROM ${source}`
  const tgtExpr = target_is_query ? target : `SELECT * FROM ${target}`

  const ctePrefix = `WITH __diff_source AS (\n${srcExpr}\n), __diff_target AS (\n${tgtExpr}\n)`
  return {
    table1Name: "__diff_source",
    table2Name: "__diff_target",
    ctePrefix,
  }
}

/**
 * Inject a CTE prefix into a SQL statement from the engine.
 *
 * The engine emits standalone SELECT statements. We need to prepend our CTE
 * definitions so `__diff_source`/`__diff_target` resolve correctly.
 *
 * Handles the case where the engine itself emits CTEs (starts with WITH …):
 *   WITH engine_cte AS (…) SELECT … FROM __diff_source
 * becomes:
 *   WITH __diff_source AS (…), __diff_target AS (…), engine_cte AS (…) SELECT …
 */
export function injectCte(sql: string, ctePrefix: string): string {
  const trimmed = sql.trimStart()
  const withMatch = trimmed.match(/^WITH\s+/i)

  if (withMatch) {
    // Engine also has CTEs — merge them: our CTEs first, then engine CTEs
    const afterWith = trimmed.slice(withMatch[0].length)
    // ctePrefix already starts with "WITH …" — strip "WITH " and append ", "
    const ourDefs = ctePrefix.replace(/^WITH\s+/i, "")
    return `WITH ${ourDefs},\n${afterWith}`
  }

  // Plain SELECT — just prepend our CTE block
  return `${ctePrefix}\n${trimmed}`
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type Rows = (string | null)[][]

/**
 * Execute a SQL statement against a named warehouse and return rows as string[][].
 */
async function executeQuery(sql: string, warehouseName: string | undefined): Promise<Rows> {
  let connector
  if (warehouseName) {
    connector = await Registry.get(warehouseName)
  } else {
    const warehouses = Registry.list().warehouses
    if (warehouses.length === 0) {
      throw new Error("No default warehouse configured.")
    }
    connector = await Registry.get(warehouses[0].name)
  }

  const result = await connector.execute(sql)

  // Normalise to string[][] — drivers return mixed types
  return result.rows.map((row: unknown[]) =>
    row.map((v) => (v === null || v === undefined ? null : String(v))),
  )
}

// ---------------------------------------------------------------------------
// Column auto-discovery and audit column exclusion
// ---------------------------------------------------------------------------

/**
 * Patterns that match audit/timestamp columns which should be excluded from
 * value comparison by default. These columns typically differ between source
 * and target due to ETL timing, sync metadata, or pipeline bookkeeping —
 * not because of actual data discrepancies.
 */
const AUDIT_COLUMN_PATTERNS = [
  // Exact common names
  /^(created|updated|modified|inserted|deleted|synced|published|ingested|loaded|extracted|refreshed)_(at|on|date|time|timestamp|ts|dt|epoch)$/i,
  // Suffix patterns: *_at, *_on with temporal prefix
  /_(created|updated|modified|inserted|deleted|synced|published|ingested|loaded|extracted|refreshed)$/i,
  // ETL metadata columns
  /^(etl|elt|dbt|pipeline|batch|sync|publish|ingest)_(created|updated|modified|loaded|run|timestamp|ts|time|at|epoch)/i,
  /^(_sdc_|_airbyte_|_fivetran_|_stitch_|__hevo_)/i,
  // Generic timestamp metadata
  /^(last_updated|last_modified|date_updated|date_modified|date_created|row_updated|row_created)$/i,
  /^(publisher_last_updated|publisher_updated)/i,
  // Epoch variants
  /(updated|modified|created|inserted|published|loaded|synced)_epoch/i,
  /epoch_ms$/i,
]

/**
 * Check whether a column name matches known audit/timestamp patterns.
 */
function isAuditColumn(columnName: string): boolean {
  return AUDIT_COLUMN_PATTERNS.some((pattern) => pattern.test(columnName))
}

/**
 * Build a query to discover column names for a table, appropriate for the dialect.
 */
function buildColumnDiscoverySQL(tableName: string, dialect: string): string {
  // Parse schema.table or db.schema.table
  const parts = tableName.split(".")
  let schemaFilter = ""
  let tableFilter = ""

  if (parts.length === 3) {
    schemaFilter = `table_schema = '${parts[1]}'`
    tableFilter = `table_name = '${parts[2]}'`
  } else if (parts.length === 2) {
    schemaFilter = `table_schema = '${parts[0]}'`
    tableFilter = `table_name = '${parts[1]}'`
  } else {
    tableFilter = `table_name = '${parts[0]}'`
  }

  switch (dialect) {
    case "clickhouse":
      return `DESCRIBE TABLE ${tableName}`
    case "snowflake":
      return `SHOW COLUMNS IN TABLE ${tableName}`
    default: {
      // Postgres, MySQL, Redshift, DuckDB, etc. — use information_schema
      const conditions = [tableFilter]
      if (schemaFilter) conditions.push(schemaFilter)
      return `SELECT column_name FROM information_schema.columns WHERE ${conditions.join(" AND ")} ORDER BY ordinal_position`
    }
  }
}

/**
 * Parse column names from the discovery query result, handling dialect differences.
 */
function parseColumnNames(rows: (string | null)[][], dialect: string): string[] {
  switch (dialect) {
    case "clickhouse":
      // DESCRIBE returns: name, type, default_type, default_expression, ...
      return rows.map((r) => r[0] ?? "").filter(Boolean)
    case "snowflake":
      // SHOW COLUMNS returns: table_name, schema_name, column_name, data_type, ...
      // column_name is at index 2
      return rows.map((r) => r[2] ?? "").filter(Boolean)
    default:
      // information_schema returns: column_name
      return rows.map((r) => r[0] ?? "").filter(Boolean)
  }
}

/**
 * Auto-discover non-key, non-audit columns for a table.
 *
 * When the caller omits `extra_columns`, we query the source table's schema to
 * find all columns, then exclude:
 *   1. Key columns (already used for matching)
 *   2. Audit/timestamp columns (updated_at, created_at, etc.) that typically
 *      differ between source and target due to ETL timing
 *
 * Returns the list of columns to compare, or undefined if discovery fails
 * (in which case the engine falls back to key-only comparison).
 */
async function discoverExtraColumns(
  tableName: string,
  keyColumns: string[],
  dialect: string,
  warehouseName: string | undefined,
): Promise<{ columns: string[]; excludedAudit: string[] } | undefined> {
  // Only works for plain table names, not SQL queries
  if (SQL_KEYWORDS.test(tableName)) return undefined

  try {
    const sql = buildColumnDiscoverySQL(tableName, dialect)
    const rows = await executeQuery(sql, warehouseName)
    const allColumns = parseColumnNames(rows, dialect)

    if (allColumns.length === 0) return undefined

    const keySet = new Set(keyColumns.map((k) => k.toLowerCase()))
    const extraColumns: string[] = []
    const excludedAudit: string[] = []

    for (const col of allColumns) {
      if (keySet.has(col.toLowerCase())) continue
      if (isAuditColumn(col)) {
        excludedAudit.push(col)
      } else {
        extraColumns.push(col)
      }
    }

    return { columns: extraColumns, excludedAudit }
  } catch {
    // Schema discovery failed — fall back to engine default (key-only)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

const MAX_STEPS = 200

// ---------------------------------------------------------------------------
// Partition support
// ---------------------------------------------------------------------------

/**
 * Build a DATE_TRUNC expression appropriate for the warehouse dialect.
 */
function dateTruncExpr(granularity: string, column: string, dialect: string): string {
  const g = granularity.toLowerCase()
  switch (dialect) {
    case "bigquery":
      return `DATE_TRUNC(${column}, ${g.toUpperCase()})`
    case "clickhouse":
      return `toStartOf${g.charAt(0).toUpperCase() + g.slice(1)}(${column})`
    case "mysql":
    case "mariadb": {
      const fmt = { day: "%Y-%m-%d", week: "%Y-%u", month: "%Y-%m-01", year: "%Y-01-01" }[g] ?? "%Y-%m-01"
      return `DATE_FORMAT(${column}, '${fmt}')`
    }
    default:
      // Postgres, Snowflake, Redshift, DuckDB, etc.
      return `DATE_TRUNC('${g}', ${column})`
  }
}

/**
 * Determine the partition mode based on which params are provided.
 * - "date"        → partition_granularity is set (or column looks like a date)
 * - "numeric"     → partition_bucket_size is set
 * - "categorical" → neither — use DISTINCT values directly (string, enum, boolean)
 */
function partitionMode(
  granularity: string | undefined,
  bucketSize: number | undefined,
): "date" | "numeric" | "categorical" {
  if (bucketSize != null) return "numeric"
  if (granularity != null) return "date"
  return "categorical"
}

/**
 * Build SQL to discover distinct partition values from the source table.
 */
function buildPartitionDiscoverySQL(
  table: string,
  partitionColumn: string,
  granularity: string | undefined,
  bucketSize: number | undefined,
  dialect: string,
  whereClause?: string,
): string {
  const where = whereClause ? `WHERE ${whereClause}` : ""
  const mode = partitionMode(granularity, bucketSize)

  let expr: string
  if (mode === "numeric") {
    expr = `FLOOR(${partitionColumn} / ${bucketSize}) * ${bucketSize}`
  } else if (mode === "date") {
    expr = dateTruncExpr(granularity!, partitionColumn, dialect)
  } else {
    // categorical — raw distinct values, no transformation
    expr = partitionColumn
  }

  return `SELECT DISTINCT ${expr} AS _p FROM ${table} ${where} ORDER BY _p`
}

/**
 * Build a WHERE clause that scopes to a single partition.
 */
function buildPartitionWhereClause(
  partitionColumn: string,
  partitionValue: string,
  granularity: string | undefined,
  bucketSize: number | undefined,
  dialect: string,
): string {
  const mode = partitionMode(granularity, bucketSize)

  if (mode === "numeric") {
    const lo = Number(partitionValue)
    const hi = lo + bucketSize!
    return `${partitionColumn} >= ${lo} AND ${partitionColumn} < ${hi}`
  }

  if (mode === "categorical") {
    // Quote the value — works for strings, enums, booleans
    const escaped = partitionValue.replace(/'/g, "''")
    return `${partitionColumn} = '${escaped}'`
  }

  // date mode
  const expr = dateTruncExpr(granularity!, partitionColumn, dialect)

  // Cast the literal appropriately per dialect
  switch (dialect) {
    case "bigquery":
      return `${expr} = '${partitionValue}'`
    case "clickhouse":
      return `${expr} = toDate('${partitionValue}')`
    case "mysql":
    case "mariadb":
      return `${expr} = '${partitionValue}'`
    default:
      return `${expr} = '${partitionValue}'`
  }
}

/**
 * Extract DiffStats from a successful outcome (if present).
 *
 * Rust serializes ReladiffOutcome as: {mode: "diff", diff_rows: [...], stats: {...}}
 * stats fields: rows_table1, rows_table2, exclusive_table1, exclusive_table2, updated, unchanged
 */
function extractStats(outcome: unknown): {
  rows_source: number
  rows_target: number
  differences: number
  status: "identical" | "differ"
} {
  const o = outcome as any
  if (!o) return { rows_source: 0, rows_target: 0, differences: 0, status: "identical" }

  if (o.mode === "diff") {
    const s = o.stats ?? {}
    const exclusive1 = Number(s.exclusive_table1 ?? 0)
    const exclusive2 = Number(s.exclusive_table2 ?? 0)
    const updated = Number(s.updated ?? 0)
    const differences = exclusive1 + exclusive2 + updated
    return {
      rows_source: Number(s.rows_table1 ?? 0),
      rows_target: Number(s.rows_table2 ?? 0),
      differences,
      status: differences > 0 ? "differ" : "identical",
    }
  }

  return { rows_source: 0, rows_target: 0, differences: 0, status: "identical" }
}

/**
 * Merge two diff outcomes into one aggregated outcome.
 *
 * Both outcomes use the Rust shape: {mode: "diff", diff_rows: [...], stats: {...}}
 */
function mergeOutcomes(accumulated: unknown, next: unknown): unknown {
  if (!accumulated) return next
  if (!next) return accumulated

  const a = accumulated as any
  const n = next as any

  const aS = a.stats ?? {}
  const nS = n.stats ?? {}

  const rows_table1 = (Number(aS.rows_table1) || 0) + (Number(nS.rows_table1) || 0)
  const rows_table2 = (Number(aS.rows_table2) || 0) + (Number(nS.rows_table2) || 0)
  const exclusive_table1 = (Number(aS.exclusive_table1) || 0) + (Number(nS.exclusive_table1) || 0)
  const exclusive_table2 = (Number(aS.exclusive_table2) || 0) + (Number(nS.exclusive_table2) || 0)
  const updated = (Number(aS.updated) || 0) + (Number(nS.updated) || 0)
  const unchanged = (Number(aS.unchanged) || 0) + (Number(nS.unchanged) || 0)

  const totalRows = rows_table1 + rows_table2
  const totalDiff = exclusive_table1 + exclusive_table2 + updated
  const diff_percent = totalRows > 0 ? (totalDiff / totalRows) * 100 : 0

  return {
    mode: "diff",
    diff_rows: [...(a.diff_rows ?? []), ...(n.diff_rows ?? [])].slice(0, 100),
    stats: { rows_table1, rows_table2, exclusive_table1, exclusive_table2, updated, unchanged, diff_percent },
  }
}

/**
 * Run a partitioned diff: discover partition values, diff each partition independently,
 * then aggregate results.
 */
async function runPartitionedDiff(params: DataDiffParams): Promise<DataDiffResult> {
  const resolveDialect = (warehouse: string | undefined): string => {
    if (warehouse) {
      const cfg = Registry.getConfig(warehouse)
      return cfg?.type ?? "generic"
    }
    const warehouses = Registry.list().warehouses
    return warehouses[0]?.type ?? "generic"
  }

  const sourceDialect = resolveDialect(params.source_warehouse)
  const { table1Name } = resolveTableSources(params.source, params.target)

  // Discover partition values from source
  const discoverySql = buildPartitionDiscoverySQL(
    table1Name,
    params.partition_column!,
    params.partition_granularity,
    params.partition_bucket_size,
    sourceDialect,
    params.where_clause,
  )

  let partitionValues: string[]
  try {
    const rows = await executeQuery(discoverySql, params.source_warehouse)
    partitionValues = rows.map((r) => String(r[0] ?? "")).filter(Boolean)
  } catch (e) {
    return { success: false, error: `Partition discovery failed: ${e}`, steps: 0 }
  }

  if (partitionValues.length === 0) {
    return { success: true, steps: 1, outcome: { Match: { row_count: 0, algorithm: "partitioned" } }, partition_results: [] }
  }

  // Diff each partition
  const partitionResults: PartitionDiffResult[] = []
  let aggregatedOutcome: unknown = null
  let totalSteps = 1

  for (const pVal of partitionValues) {
    const partWhere = buildPartitionWhereClause(
      params.partition_column!,
      pVal,
      params.partition_granularity,
      params.partition_bucket_size,
      sourceDialect,
    )
    const fullWhere = params.where_clause ? `(${params.where_clause}) AND (${partWhere})` : partWhere

    const result = await runDataDiff({
      ...params,
      where_clause: fullWhere,
      partition_column: undefined, // prevent recursion
    })

    totalSteps += result.steps

    if (!result.success) {
      partitionResults.push({ partition: pVal, rows_source: 0, rows_target: 0, differences: 0, status: "error", error: result.error })
      continue
    }

    const stats = extractStats(result.outcome)
    partitionResults.push({ partition: pVal, ...stats })
    aggregatedOutcome = aggregatedOutcome == null ? result.outcome : mergeOutcomes(aggregatedOutcome, result.outcome)
  }

  return {
    success: true,
    steps: totalSteps,
    outcome: aggregatedOutcome ?? { Match: { row_count: 0, algorithm: "partitioned" } },
    partition_results: partitionResults,
  }
}

export async function runDataDiff(params: DataDiffParams): Promise<DataDiffResult> {
  // Dispatch to partitioned diff if partition_column is set
  if (params.partition_column) {
    return runPartitionedDiff(params)
  }

  // Dynamically import NAPI module (not available in test environments without the binary)
  let DataParitySession: new (specJson: string) => {
    start(): string
    step(responsesJson: string): string
  }

  try {
    const core = await import("@altimateai/altimate-core")
    DataParitySession = (core as any).DataParitySession
    if (!DataParitySession) throw new Error("DataParitySession not exported from @altimateai/altimate-core")
  } catch (e) {
    return {
      success: false,
      error: `altimate-core NAPI module unavailable: ${e}`,
      steps: 0,
    }
  }

  // Resolve sources (plain table names vs arbitrary queries)
  const { table1Name, table2Name, ctePrefix } = resolveTableSources(
    params.source,
    params.target,
  )

  // Parse optional qualified names: "db.schema.table" → { database, schema, table }
  const parseQualified = (name: string) => {
    const parts = name.split(".")
    if (parts.length === 3) return { database: parts[0], schema: parts[1], table: parts[2] }
    if (parts.length === 2) return { schema: parts[0], table: parts[1] }
    return { table: name }
  }

  const table1Ref = parseQualified(table1Name)
  const table2Ref = parseQualified(table2Name)

  // Resolve dialect from warehouse config
  const resolveDialect = (warehouse: string | undefined): string => {
    if (warehouse) {
      const cfg = Registry.getConfig(warehouse)
      return cfg?.type ?? "generic"
    }
    const warehouses = Registry.list().warehouses
    return warehouses[0]?.type ?? "generic"
  }

  const dialect1 = resolveDialect(params.source_warehouse)
  const dialect2 = resolveDialect(params.target_warehouse ?? params.source_warehouse)

  // Auto-discover extra_columns when not explicitly provided.
  // The Rust engine only compares columns listed in extra_columns — if the list is
  // empty, it compares key existence only and reports all matched rows as "identical"
  // even when non-key values differ. This auto-discovery prevents that silent bug.
  let extraColumns = params.extra_columns
  let excludedAuditColumns: string[] = []

  if (!extraColumns || extraColumns.length === 0) {
    const discovered = await discoverExtraColumns(
      params.source,
      params.key_columns,
      dialect1,
      params.source_warehouse,
    )
    if (discovered) {
      extraColumns = discovered.columns
      excludedAuditColumns = discovered.excludedAudit
    }
  }

  // Build session spec
  const spec = {
    table1: table1Ref,
    table2: table2Ref,
    dialect1,
    dialect2,
    config: {
      algorithm: params.algorithm ?? "auto",
      key_columns: params.key_columns,
      extra_columns: extraColumns ?? [],
      ...(params.where_clause ? { where_clause: params.where_clause } : {}),
      ...(params.numeric_tolerance != null ? { numeric_tolerance: params.numeric_tolerance } : {}),
      ...(params.timestamp_tolerance_ms != null
        ? { timestamp_tolerance_ms: params.timestamp_tolerance_ms }
        : {}),
    },
  }

  // Create session
  let session: InstanceType<typeof DataParitySession>
  try {
    session = new DataParitySession(JSON.stringify(spec))
  } catch (e) {
    return {
      success: false,
      error: `Failed to create DataParitySession: ${e}`,
      steps: 0,
    }
  }

  // Route SQL tasks to the correct warehouse
  const warehouseFor = (tableSide: string): string | undefined =>
    tableSide === "Table2" ? (params.target_warehouse ?? params.source_warehouse) : params.source_warehouse

  // Cooperative loop
  let actionJson = session.start()
  let stepCount = 0

  while (stepCount < MAX_STEPS) {
    const action = JSON.parse(actionJson) as {
      type: string
      tasks?: Array<{ id: string; table_side: string; sql: string; expected_shape: string }>
      outcome?: unknown
      message?: string
    }

    if (action.type === "Done") {
      return {
        success: true,
        steps: stepCount,
        outcome: action.outcome,
        ...(excludedAuditColumns.length > 0 ? { excluded_audit_columns: excludedAuditColumns } : {}),
      }
    }

    if (action.type === "Error") {
      return {
        success: false,
        error: action.message ?? "Unknown engine error",
        steps: stepCount,
      }
    }

    if (action.type !== "ExecuteSql") {
      return {
        success: false,
        error: `Unexpected action type: ${action.type}`,
        steps: stepCount,
      }
    }

    stepCount++

    // Execute all SQL tasks in parallel
    const tasks = action.tasks ?? []
    const responses = await Promise.all(
      tasks.map(async (task) => {
        const warehouse = warehouseFor(task.table_side)
        // Inject CTE definitions if we're in query-comparison mode
        const sql = ctePrefix ? injectCte(task.sql, ctePrefix) : task.sql
        try {
          const rows = await executeQuery(sql, warehouse)
          return { id: task.id, rows }
        } catch (e) {
          // Return error shape — engine will produce an Error action on next step
          return { id: task.id, rows: [], error: String(e) }
        }
      }),
    )

    actionJson = session.step(JSON.stringify(responses))
  }

  return {
    success: false,
    error: `Exceeded maximum step limit (${MAX_STEPS}). The diff may require more iterations for this table size.`,
    steps: stepCount,
  }
}
