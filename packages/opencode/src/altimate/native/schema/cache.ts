/**
 * Schema cache — indexes warehouse metadata into SQLite for fast search.
 *
 * Uses bun:sqlite (built into the Bun runtime) to build a local FTS-ready
 * cache of warehouse schemas, tables, and columns.
 * Cache location: ~/.altimate-code/schema-cache.db
 */

import { Database } from "bun:sqlite"
import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import type { Connector } from "@altimateai/drivers"
import type {
  SchemaIndexResult,
  SchemaSearchResult,
  SchemaCacheStatusResult,
  SchemaCacheWarehouseStatus,
  SchemaSearchTableResult,
  SchemaSearchColumnResult,
  SchemaEntityGroupSummary,
  SchemaSearchEntityGroupResult,
} from "../types"
import {
  detectEntityGroup,
  type TableShape,
  DEFAULT_ENTITY_RATIO_THRESHOLD,
  DEFAULT_ENTITY_MIN_TABLES,
} from "./entity-groups"

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS warehouses (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    last_indexed TEXT,
    databases_count INTEGER DEFAULT 0,
    schemas_count INTEGER DEFAULT 0,
    tables_count INTEGER DEFAULT 0,
    columns_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tables_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT NOT NULL,
    database_name TEXT,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    table_type TEXT DEFAULT 'TABLE',
    row_count INTEGER,
    comment TEXT,
    search_text TEXT NOT NULL,
    UNIQUE(warehouse, database_name, schema_name, table_name)
);

CREATE TABLE IF NOT EXISTS columns_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT NOT NULL,
    database_name TEXT,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    data_type TEXT,
    nullable INTEGER DEFAULT 1,
    comment TEXT,
    search_text TEXT NOT NULL,
    UNIQUE(warehouse, database_name, schema_name, table_name, column_name)
);

CREATE INDEX IF NOT EXISTS idx_tables_search ON tables_cache(search_text);
CREATE INDEX IF NOT EXISTS idx_columns_search ON columns_cache(search_text);
CREATE INDEX IF NOT EXISTS idx_tables_warehouse ON tables_cache(warehouse);
CREATE INDEX IF NOT EXISTS idx_columns_warehouse ON columns_cache(warehouse);
CREATE INDEX IF NOT EXISTS idx_columns_table ON columns_cache(warehouse, schema_name, table_name, column_name);

CREATE TABLE IF NOT EXISTS entity_groups_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT NOT NULL,
    database_name TEXT,
    schema_name TEXT NOT NULL,
    pattern TEXT NOT NULL DEFAULT 'entity-per-table',
    fingerprint TEXT NOT NULL,
    table_count INTEGER NOT NULL,
    sample_table TEXT,
    composite_columns_json TEXT NOT NULL,
    table_names_json TEXT NOT NULL,
    search_text TEXT NOT NULL,
    UNIQUE(warehouse, database_name, schema_name, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_entity_groups_search ON entity_groups_cache(search_text);
CREATE INDEX IF NOT EXISTS idx_entity_groups_warehouse ON entity_groups_cache(warehouse);
`

// ---------------------------------------------------------------------------
// Stop words for search tokenization
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
  "about", "from", "that", "which", "where", "what", "how",
  "find", "show", "get", "list", "all", "any",
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultCachePath(): string {
  const dir = path.join(os.homedir(), ".altimate-code")
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, "schema-cache.db")
}

function makeSearchText(...parts: (string | null | undefined)[]): string {
  const tokens: string[] = []
  for (const p of parts) {
    if (p) {
      tokens.push(p.toLowerCase())
      if (p.includes("_")) {
        tokens.push(...p.toLowerCase().split("_"))
      }
    }
  }
  return tokens.join(" ")
}

function tokenizeQuery(query: string): string[] {
  const rawTokens = query.toLowerCase().match(/[a-zA-Z0-9_]+/g) || []
  const filtered = rawTokens.filter((t) => !STOP_WORDS.has(t))
  return filtered.length > 0 ? filtered : rawTokens.slice(0, 1)
}

// ---------------------------------------------------------------------------
// SchemaCache class
// ---------------------------------------------------------------------------

/** SQLite-backed schema metadata cache for fast warehouse search. */
export class SchemaCache {
  private db: Database
  private dbPath: string

  private constructor(db: Database, dbPath: string) {
    this.db = db
    this.dbPath = dbPath
  }

  /** Create a SchemaCache instance backed by a file on disk. */
  static create(dbPath?: string): SchemaCache {
    const resolvedPath = dbPath || defaultCachePath()
    const db = new Database(resolvedPath, { create: true })
    db.exec(CREATE_TABLES_SQL)
    return new SchemaCache(db, resolvedPath)
  }

  /** Create a SchemaCache with an in-memory database (for testing). */
  static createInMemory(): SchemaCache {
    const db = new Database(":memory:")
    db.exec(CREATE_TABLES_SQL)
    return new SchemaCache(db, ":memory:")
  }

  /**
   * Crawl a warehouse and index all schemas/tables/columns.
   *
   * For each schema, runs entity-per-table detection: if ≥50% of tables share
   * the same column structure and the group has at least 20 tables, emits a
   * single composite digest row in `entity_groups_cache` instead of N
   * near-identical per-table rows. Tables outside the group still get their
   * normal per-table entries.
   */
  async indexWarehouse(
    warehouseName: string,
    warehouseType: string,
    connector: Connector,
    options: {
      entityRatioThreshold?: number
      entityMinTables?: number
    } = {},
  ): Promise<SchemaIndexResult> {
    const now = new Date().toISOString()
    const ratioThreshold = options.entityRatioThreshold ?? DEFAULT_ENTITY_RATIO_THRESHOLD
    const minTables = options.entityMinTables ?? DEFAULT_ENTITY_MIN_TABLES

    // Clear existing data
    this.db.prepare("DELETE FROM columns_cache WHERE warehouse = ?").run(warehouseName)
    this.db.prepare("DELETE FROM tables_cache WHERE warehouse = ?").run(warehouseName)
    this.db.prepare("DELETE FROM entity_groups_cache WHERE warehouse = ?").run(warehouseName)

    let totalSchemas = 0
    let totalTables = 0
    let totalColumns = 0
    const databaseName: string | null = null
    const entityGroupsEmitted: SchemaEntityGroupSummary[] = []

    let schemas: string[] = []
    try {
      schemas = await connector.listSchemas()
    } catch {
      // ignore
    }

    const insertTable = this.db.prepare(
      `INSERT OR REPLACE INTO tables_cache
       (warehouse, database_name, schema_name, table_name, table_type, search_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )

    const insertColumn = this.db.prepare(
      `INSERT OR REPLACE INTO columns_cache
       (warehouse, database_name, schema_name, table_name, column_name, data_type, nullable, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    const insertEntityGroup = this.db.prepare(
      `INSERT OR REPLACE INTO entity_groups_cache
       (warehouse, database_name, schema_name, pattern, fingerprint, table_count,
        sample_table, composite_columns_json, table_names_json, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    // Batch inserts per-table inside a transaction to avoid per-statement disk fsyncs.
    // The async connector calls (listTables, describeTable) run outside the transaction;
    // only the synchronous SQLite inserts are wrapped.
    const insertTableBatch = this.db.transaction(
      (tableArgs: any[], columnArgsBatch: any[][]) => {
        insertTable.run(...tableArgs)
        for (const colArgs of columnArgsBatch) {
          insertColumn.run(...colArgs)
        }
      },
    )

    for (const schemaName of schemas) {
      if (schemaName.toUpperCase() === "INFORMATION_SCHEMA") continue
      totalSchemas++

      let tables: Array<{ name: string; type: string }> = []
      try {
        tables = await connector.listTables(schemaName)
      } catch {
        continue
      }

      // Collect every table's columns first so the entity-group detector
      // can see the whole schema at once. We also retain the table_type and
      // raw column rows for downstream insert.
      type TableSnapshot = {
        name: string
        type: string
        columns: Array<{ name: string; data_type: string; nullable: boolean }>
      }
      const snapshots: TableSnapshot[] = []
      for (const tableInfo of tables) {
        let columns: Array<{ name: string; data_type: string; nullable: boolean }> = []
        try {
          columns = await connector.describeTable(schemaName, tableInfo.name)
        } catch {
          // continue with empty columns
        }
        snapshots.push({ name: tableInfo.name, type: tableInfo.type, columns })
      }

      const shapes: TableShape[] = snapshots.map((s) => ({
        table_name: s.name,
        columns: s.columns.map((c) => ({ name: c.name, data_type: c.data_type })),
      }))
      const detection = detectEntityGroup(shapes, { ratioThreshold, minTables })

      const inGroup = new Set<string>(
        detection.entity_group ? detection.entity_group.table_names : [],
      )

      for (const snap of snapshots) {
        totalTables++

        if (inGroup.has(snap.name)) {
          // Tables inside the entity group are NOT emitted per-table.
          // Their columns are still counted toward totalColumns so the index
          // result accurately reflects the warehouse, but they live inside
          // the composite digest (and the entity_groups_cache row below).
          totalColumns += snap.columns.length
          continue
        }

        const searchText = makeSearchText(databaseName, schemaName, snap.name, snap.type)
        const columnArgsBatch: any[][] = []
        for (const col of snap.columns) {
          totalColumns++
          const colSearch = makeSearchText(
            databaseName, schemaName, snap.name, col.name, col.data_type,
          )
          columnArgsBatch.push([
            warehouseName, databaseName, schemaName, snap.name,
            col.name, col.data_type, col.nullable ? 1 : 0, colSearch,
          ])
        }

        insertTableBatch(
          [warehouseName, databaseName, schemaName, snap.name, snap.type, searchText],
          columnArgsBatch,
        )
      }

      // Persist the entity group for this schema, if one was detected.
      if (detection.entity_group) {
        const eg = detection.entity_group
        const compositeColumns = eg.composite_columns
        const groupSearchText = makeSearchText(
          databaseName,
          schemaName,
          eg.sample_table,
          ...eg.table_names,
          ...compositeColumns.map((c) => c.name),
          ...compositeColumns.map((c) => c.data_type),
        )
        insertEntityGroup.run(
          warehouseName,
          databaseName,
          schemaName,
          "entity-per-table",
          eg.fingerprint,
          eg.table_names.length,
          eg.sample_table,
          JSON.stringify(compositeColumns),
          JSON.stringify(eg.table_names),
          groupSearchText,
        )
        entityGroupsEmitted.push({
          warehouse: warehouseName,
          database: databaseName ?? undefined,
          schema_name: schemaName,
          pattern: "entity-per-table",
          table_count: eg.table_names.length,
          composite_columns: compositeColumns,
          sample_table: eg.sample_table,
          table_names: eg.table_names,
        })
      }
    }

    // Update warehouse summary
    this.db.prepare(
      `INSERT OR REPLACE INTO warehouses
       (name, type, last_indexed, databases_count, schemas_count, tables_count, columns_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      warehouseName, warehouseType, now,
      databaseName ? 1 : 0, totalSchemas, totalTables, totalColumns,
    )

    return {
      warehouse: warehouseName,
      type: warehouseType,
      schemas_indexed: totalSchemas,
      tables_indexed: totalTables,
      columns_indexed: totalColumns,
      timestamp: now,
      entity_groups: entityGroupsEmitted.length > 0 ? entityGroupsEmitted : undefined,
    }
  }

  /**
   * Search indexed schema metadata using natural language-style queries.
   */
  search(
    query: string,
    warehouse?: string,
    limit: number = 20,
  ): SchemaSearchResult {
    const tokens = tokenizeQuery(query)
    if (tokens.length === 0) {
      return { tables: [], columns: [], query, match_count: 0 }
    }

    const whereClauses = tokens.map(() => "search_text LIKE ?")
    const searchParams = tokens.map((t) => `%${t}%`)
    const searchCondition = whereClauses.join(" OR ")

    const whFilter = warehouse ? " AND warehouse = ?" : ""
    const whParams = warehouse ? [warehouse] : []

    // Search tables
    const tableRows = this.db.prepare(
      `SELECT warehouse, database_name, schema_name, table_name, table_type, row_count
       FROM tables_cache
       WHERE ${searchCondition} ${whFilter}
       ORDER BY table_name
       LIMIT ?`,
    ).all(...searchParams, ...whParams, limit) as any[]

    const tables: SchemaSearchTableResult[] = tableRows.map((row) => {
      const fqnParts = [row.database_name, row.schema_name, row.table_name].filter(Boolean)
      return {
        warehouse: row.warehouse,
        database: row.database_name ?? undefined,
        schema_name: row.schema_name,
        name: row.table_name,
        type: row.table_type,
        row_count: row.row_count ?? undefined,
        fqn: fqnParts.join("."),
      }
    })

    // Search columns
    const colRows = this.db.prepare(
      `SELECT warehouse, database_name, schema_name, table_name, column_name, data_type, nullable
       FROM columns_cache
       WHERE ${searchCondition} ${whFilter}
       ORDER BY column_name
       LIMIT ?`,
    ).all(...searchParams, ...whParams, limit) as any[]

    const columns: SchemaSearchColumnResult[] = colRows.map((row) => {
      const fqnParts = [row.database_name, row.schema_name, row.table_name, row.column_name].filter(Boolean)
      return {
        warehouse: row.warehouse,
        database: row.database_name ?? undefined,
        schema_name: row.schema_name,
        table: row.table_name,
        name: row.column_name,
        data_type: row.data_type ?? undefined,
        nullable: Boolean(row.nullable),
        fqn: fqnParts.join("."),
      }
    })

    // Search entity groups: a group matches if any of its tokens appears in
    // its search_text (which includes the full table_names list, composite
    // column names/types, schema, and sample table). This means the agent
    // can still find a specific collapsed table by name.
    const groupRows = this.db.prepare(
      `SELECT warehouse, database_name, schema_name, pattern, table_count,
              sample_table, composite_columns_json, table_names_json
       FROM entity_groups_cache
       WHERE ${searchCondition} ${whFilter}
       ORDER BY schema_name, sample_table
       LIMIT ?`,
    ).all(...searchParams, ...whParams, limit) as any[]

    const entityGroups: SchemaSearchEntityGroupResult[] = groupRows.map((row) => {
      const compositeColumns = JSON.parse(row.composite_columns_json) as {
        name: string
        data_type: string
      }[]
      const tableNames = JSON.parse(row.table_names_json) as string[]
      // Of the group's table names, return the subset that actually matches
      // any query token. This makes "find me table AAPL" return just AAPL,
      // not all 2754 tickers.
      const lowerTokens = tokens.map((t) => t.toLowerCase())
      const matching = tableNames.filter((name) => {
        const lowerName = name.toLowerCase()
        return lowerTokens.some((tok) => lowerName.includes(tok))
      })
      return {
        warehouse: row.warehouse,
        database: row.database_name ?? undefined,
        schema_name: row.schema_name,
        pattern: row.pattern,
        table_count: row.table_count,
        composite_columns: compositeColumns,
        sample_table: row.sample_table,
        // If query matched on schema or composite columns rather than a
        // specific table, return an empty matching_tables list so callers
        // know it was a structural match.
        matching_tables: matching,
      }
    })

    return {
      tables,
      columns,
      query,
      match_count: tables.length + columns.length + entityGroups.length,
      entity_groups: entityGroups.length > 0 ? entityGroups : undefined,
    }
  }

  /**
   * Return status of all indexed warehouses.
   */
  cacheStatus(): SchemaCacheStatusResult {
    const rows = this.db.prepare("SELECT * FROM warehouses ORDER BY name").all() as any[]
    const warehouses: SchemaCacheWarehouseStatus[] = rows.map((row) => ({
      name: row.name,
      type: row.type,
      last_indexed: row.last_indexed ?? undefined,
      databases_count: row.databases_count,
      schemas_count: row.schemas_count,
      tables_count: row.tables_count,
      columns_count: row.columns_count,
    }))

    // total_tables includes both per-table rows AND tables collapsed into
    // entity-per-table groups (counted via the group's table_count). This
    // matches the pre-collapse behaviour so callers see the real warehouse
    // table count regardless of digest format.
    const perTableCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM tables_cache").get() as any
    ).cnt
    const collapsedCount = (
      this.db
        .prepare("SELECT COALESCE(SUM(table_count), 0) as cnt FROM entity_groups_cache")
        .get() as any
    ).cnt
    const totalTables = perTableCount + collapsedCount

    // total_columns covers physical columns_cache rows. Columns inside
    // entity groups are stored once in the group's composite_columns_json
    // rather than N times per-table; we add (composite_count * table_count)
    // back so the total reflects logical column count.
    const perColumnCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM columns_cache").get() as any
    ).cnt
    const groupRows = this.db
      .prepare(
        "SELECT table_count, composite_columns_json FROM entity_groups_cache",
      )
      .all() as any[]
    let collapsedColumns = 0
    for (const r of groupRows) {
      try {
        const cols = JSON.parse(r.composite_columns_json) as unknown[]
        collapsedColumns += cols.length * r.table_count
      } catch {
        // ignore malformed rows
      }
    }
    const totalColumns = perColumnCount + collapsedColumns

    return {
      warehouses,
      total_tables: totalTables,
      total_columns: totalColumns,
      cache_path: this.dbPath,
    }
  }

  /**
   * List all columns for a given warehouse (no search filter).
   * Used by PII detection to scan all cached columns.
   */
  listColumns(
    warehouse: string,
    limit: number = 10000,
  ): SchemaSearchColumnResult[] {
    const rows = this.db.prepare(
      `SELECT warehouse, database_name, schema_name, table_name, column_name, data_type, nullable
       FROM columns_cache
       WHERE warehouse = ?
       ORDER BY schema_name, table_name, column_name
       LIMIT ?`,
    ).all(warehouse, limit) as any[]

    return rows.map((row) => {
      const fqnParts = [row.database_name, row.schema_name, row.table_name, row.column_name].filter(Boolean)
      return {
        warehouse: row.warehouse,
        database: row.database_name ?? undefined,
        schema_name: row.schema_name,
        table: row.table_name,
        name: row.column_name,
        data_type: row.data_type ?? undefined,
        nullable: Boolean(row.nullable),
        fqn: fqnParts.join("."),
      }
    })
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }
}

// Singleton cache instance (lazy)
let _cache: SchemaCache | null = null

export async function getCache(): Promise<SchemaCache> {
  if (!_cache) {
    _cache = SchemaCache.create()
  }
  return _cache
}

export function resetCache(): void {
  if (_cache) {
    _cache.close()
    _cache = null
  }
}
