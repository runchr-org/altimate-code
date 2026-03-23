/**
 * Native TypeScript handlers for all 34 altimate_core.* bridge methods.
 *
 * This module replaces the Python bridge for altimate-core operations by
 * calling @altimateai/altimate-core napi-rs bindings directly.
 *
 * Each handler wraps the raw altimate-core result into AltimateCoreResult:
 *   { success: boolean, data: Record<string, unknown>, error?: string }
 */

import * as core from "@altimateai/altimate-core"
import { register } from "./dispatcher"
import { schemaOrEmpty, resolveSchema } from "./schema-resolver"
import type { AltimateCoreResult } from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spread a rich TypeScript object into a plain Record for the data field. */
function toData(obj: unknown): Record<string, unknown> {
  if (obj === null || obj === undefined) return {}
  if (typeof obj !== "object") return { value: obj }
  // JSON round-trip to strip class instances / napi references
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>
}

/** Wrap a handler body into the standard AltimateCoreResult envelope. */
function ok(
  success: boolean,
  data: Record<string, unknown>,
): AltimateCoreResult {
  return { success, data }
}

function fail(error: unknown): AltimateCoreResult {
  return { success: false, data: {}, error: String(error) }
}

// ---------------------------------------------------------------------------
// Snowflake → target dialect transpile transforms
// ---------------------------------------------------------------------------

const IFF_PATTERN = /\bIFF\s*\(([^,()]+),\s*([^,()]+),\s*([^()]+)\)/gi

/**
 * Convert Snowflake IFF(cond, a, b) to IF(cond, a, b) for BigQuery,
 * or CASE WHEN cond THEN a ELSE b END for other targets.
 */
export function preprocessIff(sql: string, targetDialect?: string): string {
  const target = targetDialect?.toLowerCase() ?? ""
  const useIf = target === "bigquery"
  let current = sql
  for (let i = 0; i < 10; i++) {
    const next = useIf
      ? current.replace(IFF_PATTERN, "IF($1, $2, $3)")
      : current.replace(IFF_PATTERN, "CASE WHEN $1 THEN $2 ELSE $3 END")
    if (next === current) break
    current = next
  }
  return current
}

/**
 * Convert Snowflake TRY_TO_NUMBER/TRY_TO_DECIMAL/TRY_TO_NUMERIC to SAFE_CAST for BigQuery.
 */
export function preprocessTryToNumber(sql: string): string {
  return sql.replace(
    /\bTRY_TO_(?:NUMBER|DECIMAL|NUMERIC)\s*\(\s*([^()]+?)\s*\)/gi,
    "SAFE_CAST($1 AS NUMERIC)",
  )
}

/**
 * Convert Snowflake ARRAY_AGG(expr) WITHIN GROUP (ORDER BY ...) to
 * ARRAY_AGG(expr ORDER BY ...) for BigQuery.
 */
export function preprocessArrayAggWithinGroup(sql: string): string {
  return sql.replace(
    /\bARRAY_AGG\s*\(\s*([^()]+?)\s*\)\s*WITHIN\s+GROUP\s*\(\s*ORDER\s+BY\s+([^()]+?)\s*\)/gi,
    "ARRAY_AGG($1 ORDER BY $2)",
  )
}

/**
 * Convert Snowflake FLATTEN(input => expr) to UNNEST(expr) for BigQuery.
 */
export function preprocessFlatten(sql: string): string {
  return sql.replace(
    /\bFLATTEN\s*\(\s*(?:input\s*=>\s*)?([^()]+?)\s*\)/gi,
    "UNNEST($1)",
  )
}

/**
 * Apply all Snowflake → BigQuery preprocessing transforms.
 */
export function preprocessSnowflakeToBigQuery(sql: string): string {
  let result = preprocessIff(sql, "bigquery")
  result = preprocessTryToNumber(result)
  result = preprocessArrayAggWithinGroup(result)
  result = preprocessFlatten(result)
  return result
}

const QUALIFY_PATTERN =
  /\bQUALIFY\b\s+(.+?)(?=\s*(?:LIMIT\s+\d|ORDER\s+BY|;|$))/is

/**
 * Wrap QUALIFY clause into outer SELECT for targets that lack native support.
 * BigQuery supports QUALIFY natively, so it's excluded.
 */
export function postprocessQualify(sql: string): string {
  const m = QUALIFY_PATTERN.exec(sql)
  if (!m) return sql
  const qualifyExpr = m[1].trim()
  const baseSql = sql.slice(0, m.index).trimEnd()
  const suffix = sql.slice(m.index + m[0].length).trim()
  const wrapped = `SELECT * FROM (${baseSql}) AS _qualify WHERE ${qualifyExpr}`
  return suffix ? `${wrapped} ${suffix}` : wrapped
}

// BigQuery supports QUALIFY natively — only wrap for dialects that don't
const QUALIFY_TARGETS = new Set(["databricks", "spark", "trino"])

// ---------------------------------------------------------------------------
// SQL keyword fuzzy correction
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
  "FULL", "CROSS", "ON", "AND", "OR", "NOT", "IN", "BETWEEN", "LIKE",
  "IS", "NULL", "AS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT",
  "OFFSET", "UNION", "ALL", "DISTINCT", "INSERT", "INTO", "VALUES",
  "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER", "DROP",
  "INDEX", "VIEW", "CASE", "WHEN", "THEN", "ELSE", "END", "EXISTS",
  "WITH", "OVER", "PARTITION", "WINDOW", "ROWS", "RANGE", "UNBOUNDED",
  "PRECEDING", "FOLLOWING", "CURRENT", "ROW", "CAST", "COALESCE",
  "NULLIF", "COUNT", "SUM", "AVG", "MIN", "MAX", "HAVING", "ASC",
  "DESC", "TRUE", "FALSE", "PRIMARY", "KEY", "FOREIGN", "REFERENCES",
  "CONSTRAINT", "DEFAULT", "CHECK", "UNIQUE", "TRIGGER", "PROCEDURE",
  "FUNCTION", "RETURN", "RETURNS", "BEGIN", "DECLARE", "IF", "WHILE",
  "FOR", "EACH", "AFTER", "BEFORE", "INSTEAD", "OF", "EXECUTE",
  "GRANT", "REVOKE", "COMMIT", "ROLLBACK", "SAVEPOINT", "TRUNCATE",
  "MERGE", "USING", "MATCHED", "QUALIFY", "EXCEPT", "INTERSECT",
]

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

/**
 * Pre-process SQL to fix obvious keyword typos before passing to the Rust fix engine.
 * Returns the corrected SQL and a list of corrections made.
 */
export function fixKeywordTypos(sql: string): { sql: string; corrections: string[] } {
  const corrections: string[] = []
  // Tokenize by splitting on whitespace and punctuation boundaries
  const result = sql.replace(/\b([A-Za-z_]\w*)\b/g, (match) => {
    const upper = match.toUpperCase()
    // Skip if it's already a valid keyword
    if (SQL_KEYWORDS.includes(upper)) return match
    // Skip if it looks like an identifier (lowercase, mixed case with underscores)
    if (match.includes("_") || (match[0] === match[0].toLowerCase() && match.length > 3)) return match

    // Only try to fix short all-caps or Title-case tokens that look like keyword typos
    if (match.length < 3 || match.length > 12) return match

    // Find closest keyword by Levenshtein distance
    let bestKeyword = ""
    let bestDist = Infinity
    for (const kw of SQL_KEYWORDS) {
      if (Math.abs(kw.length - upper.length) > 2) continue
      const dist = levenshtein(upper, kw)
      if (dist < bestDist) {
        bestDist = dist
        bestKeyword = kw
      }
    }

    // Accept if edit distance is 1-2 and the token is short enough relative to keyword
    const maxDist = upper.length <= 4 ? 1 : 2
    if (bestDist > 0 && bestDist <= maxDist && bestKeyword) {
      corrections.push(`${match} → ${bestKeyword}`)
      return bestKeyword
    }
    return match
  })
  return { sql: result, corrections }
}

// ---------------------------------------------------------------------------
// Handler registrations
// ---------------------------------------------------------------------------

/** Register all 34 altimate_core.* native handlers with the Dispatcher.
 *  Exported so tests can re-register after Dispatcher.reset(). */
export function registerAll(): void {

// 1. altimate_core.validate
register("altimate_core.validate", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.validate(params.sql, schema)
    const data = toData(raw)
    return ok(data.valid !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 2. altimate_core.lint
register("altimate_core.lint", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.lint(params.sql, schema)
    const data = toData(raw)
    return ok(data.clean !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 3. altimate_core.safety
register("altimate_core.safety", async (params) => {
  try {
    const raw = core.scanSql(params.sql)
    const data = toData(raw)
    return ok(data.safe !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 4. altimate_core.transpile — with IFF/QUALIFY transforms
register("altimate_core.transpile", async (params) => {
  try {
    const sourceLower = params.from_dialect.toLowerCase()
    const targetLower = params.to_dialect.toLowerCase()

    // Apply dialect-specific preprocessing
    let processed = params.sql
    if (sourceLower === "snowflake" && targetLower === "bigquery") {
      processed = preprocessSnowflakeToBigQuery(processed)
    } else {
      processed = preprocessIff(processed, targetLower)
    }

    const raw = core.transpile(processed, params.from_dialect, params.to_dialect)
    const data = toData(raw)

    // Post-process QUALIFY for targets that lack native support
    if (QUALIFY_TARGETS.has(targetLower)) {
      // Rust returns transpiled_sql as string[] — use first element
      const transpiled = Array.isArray(data.transpiled_sql)
        ? (data.transpiled_sql as string[])[0]
        : (data.transpiled_sql as string) || (data.sql as string) || (data.translated_sql as string) || ""
      if (transpiled && transpiled.toUpperCase().includes("QUALIFY")) {
        const fixed = postprocessQualify(transpiled)
        if (Array.isArray(data.transpiled_sql)) {
          ;(data.transpiled_sql as string[])[0] = fixed
        } else if ("sql" in data) {
          data.sql = fixed
        } else {
          data.translated_sql = fixed
        }
      }
    }

    return ok(data.success !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 5. altimate_core.explain
register("altimate_core.explain", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.explain(params.sql, schema)
    const data = toData(raw)
    return ok(data.valid !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 6. altimate_core.check — composite: validate + lint + scan_sql
register("altimate_core.check", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const validation = await core.validate(params.sql, schema)
    const lintResult = core.lint(params.sql, schema)
    const safety = core.scanSql(params.sql)
    const data: Record<string, unknown> = {
      validation: toData(validation),
      lint: toData(lintResult),
      safety: toData(safety),
    }
    return ok(true, data)
  } catch (e) {
    return fail(e)
  }
})

// 7. altimate_core.fix — with keyword typo correction
register("altimate_core.fix", async (params) => {
  try {
    // Pre-fix keyword typos before passing to Rust
    const { sql: preprocessed, corrections } = fixKeywordTypos(params.sql)

    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.fix(
      preprocessed,
      schema,
      params.max_iterations ?? undefined,
    )
    const data = toData(raw)

    // If we fixed keyword typos and Rust didn't change anything further,
    // report the keyword fixes as the result
    if (corrections.length > 0 && !data.fixed && preprocessed !== params.sql) {
      return ok(true, {
        ...data,
        fixed: true,
        original_sql: params.sql,
        fixed_sql: data.fixed_sql ?? preprocessed,
        fixes_applied: [
          ...(data.fixes_applied as any[] ?? []),
          ...corrections.map((c) => ({
            action: "replace_keyword",
            original: c.split(" → ")[0],
            replacement: c.split(" → ")[1],
            confidence: 0.95,
            explanation: `Fixed keyword typo: ${c}`,
          })),
        ],
      })
    }

    // If Rust fixed it, ensure we preserve the keyword corrections too
    if (corrections.length > 0 && data.fixed) {
      data.original_sql = params.sql
      data.fixes_applied = [
        ...corrections.map((c) => ({
          action: "replace_keyword",
          original: c.split(" → ")[0],
          replacement: c.split(" → ")[1],
          confidence: 0.95,
          explanation: `Fixed keyword typo: ${c}`,
        })),
        ...(data.fixes_applied as any[] ?? []),
      ]
    }

    return ok(data.fixed !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 8. altimate_core.policy
register("altimate_core.policy", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.checkPolicy(params.sql, schema, params.policy_json)
    const data = toData(raw)
    return ok(data.allowed !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 9. altimate_core.semantics
register("altimate_core.semantics", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.checkSemantics(params.sql, schema)
    const data = toData(raw)
    return ok(data.valid !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 10. altimate_core.testgen
register("altimate_core.testgen", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.generateTests(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 11. altimate_core.equivalence — with normalization for = vs IN
register("altimate_core.equivalence", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)

    // First try direct equivalence check
    const raw = await core.checkEquivalence(params.sql1, params.sql2, schema)
    const data = toData(raw)

    // If Rust says "not equivalent", try normalizing = X to IN (X) and vice versa
    if (data.equivalent === false) {
      const normalizeEqToIn = (sql: string): string =>
        sql.replace(
          /(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?)\b/g,
          "$1 IN ($2)",
        )
      const normalizeInToEq = (sql: string): string =>
        sql.replace(
          /(\w+)\s+IN\s*\(\s*('(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?)\s*\)/gi,
          "$1 = $2",
        )

      // Normalize both to IN form and re-check
      const norm1 = normalizeEqToIn(params.sql1)
      const norm2 = normalizeEqToIn(params.sql2)
      if (norm1 !== params.sql1 || norm2 !== params.sql2) {
        const retryRaw = await core.checkEquivalence(norm1, norm2, schema)
        const retryData = toData(retryRaw)
        if (retryData.equivalent) {
          return ok(true, {
            ...retryData,
            equivalent: true,
            normalization_applied: "= X ↔ IN (X)",
          })
        }
      }

      // Also try normalizing both to = form
      const eq1 = normalizeInToEq(params.sql1)
      const eq2 = normalizeInToEq(params.sql2)
      if (eq1 !== params.sql1 || eq2 !== params.sql2) {
        const retryRaw = await core.checkEquivalence(eq1, eq2, schema)
        const retryData = toData(retryRaw)
        if (retryData.equivalent) {
          return ok(true, {
            ...retryData,
            equivalent: true,
            normalization_applied: "IN (X) ↔ = X",
          })
        }
      }
    }

    return ok(data.equivalent !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 12. altimate_core.migration
register("altimate_core.migration", async (params) => {
  try {
    // Build schema from old_ddl, analyze new_ddl against it
    const schema = core.Schema.fromDdl(
      params.old_ddl,
      params.dialect || undefined,
    )
    const raw = core.analyzeMigration(params.new_ddl, schema)
    const data = toData(raw)
    return ok(data.safe !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 13. altimate_core.schema_diff
register("altimate_core.schema_diff", async (params) => {
  try {
    const s1 = schemaOrEmpty(params.schema1_path, params.schema1_context)
    const s2 = schemaOrEmpty(params.schema2_path, params.schema2_context)
    const raw = core.diffSchemas(s1, s2)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 14. altimate_core.rewrite
register("altimate_core.rewrite", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.rewrite(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 15. altimate_core.correct — with keyword typo correction
register("altimate_core.correct", async (params) => {
  try {
    // Pre-fix keyword typos before passing to Rust
    const { sql: preprocessed, corrections } = fixKeywordTypos(params.sql)

    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.correct(preprocessed, schema)
    const data = toData(raw)

    // If we fixed keyword typos, merge that info
    if (corrections.length > 0) {
      data.original_sql = params.sql
      if (data.status === "unfixable" && preprocessed !== params.sql) {
        // Rust couldn't fix further, but keyword corrections succeeded
        data.status = corrections.length > 0 ? "fixed" : data.status
        data.corrected_sql = data.corrected_sql ?? preprocessed
      }
      data.changes = [
        ...corrections.map((c) => ({
          description: `Fixed keyword typo: ${c}`,
        })),
        ...((data.changes as any[]) ?? []),
      ]
    }

    return ok(data.status !== "unfixable", data)
  } catch (e) {
    return fail(e)
  }
})

// 16. altimate_core.grade
register("altimate_core.grade", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.evaluate(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 17. altimate_core.classify_pii
register("altimate_core.classify_pii", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.classifyPii(schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 18. altimate_core.query_pii
register("altimate_core.query_pii", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.checkQueryPii(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 19. altimate_core.resolve_term — returns array, must wrap
register("altimate_core.resolve_term", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.resolveTerm(params.term, schema)
    // Rust returns an array of matches — wrap for consistent object shape
    const matches = Array.isArray(raw) ? JSON.parse(JSON.stringify(raw)) : []
    return ok(matches.length > 0, { matches })
  } catch (e) {
    return fail(e)
  }
})

// 20. altimate_core.column_lineage
register("altimate_core.column_lineage", async (params) => {
  try {
    const schema = resolveSchema(params.schema_path, params.schema_context)
    const raw = core.columnLineage(
      params.sql,
      params.dialect || undefined,
      schema ?? undefined,
    )
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 21. altimate_core.track_lineage
register("altimate_core.track_lineage", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.trackLineage(params.queries, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 22. altimate_core.format
register("altimate_core.format", async (params) => {
  try {
    const raw = core.formatSql(params.sql, params.dialect || undefined)
    const data = toData(raw)
    return ok(data.success !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 23. altimate_core.metadata
register("altimate_core.metadata", async (params) => {
  try {
    const raw = core.extractMetadata(params.sql, params.dialect || undefined)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 24. altimate_core.compare
register("altimate_core.compare", async (params) => {
  try {
    const raw = core.compareQueries(
      params.left_sql,
      params.right_sql,
      params.dialect || undefined,
    )
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 25. altimate_core.complete
register("altimate_core.complete", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.complete(params.sql, params.cursor_pos, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 26. altimate_core.optimize_context
register("altimate_core.optimize_context", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.optimizeContext(schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 27. altimate_core.optimize_for_query
register("altimate_core.optimize_for_query", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.optimizeForQuery(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 28. altimate_core.prune_schema
register("altimate_core.prune_schema", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.pruneSchema(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 29. altimate_core.import_ddl — returns Schema, must serialize
register("altimate_core.import_ddl", async (params) => {
  try {
    const schema = core.importDdl(params.ddl, params.dialect || undefined)
    const jsonObj = schema.toJson()
    return ok(true, { success: true, schema: toData(jsonObj) })
  } catch (e) {
    return fail(e)
  }
})

// 30. altimate_core.export_ddl — returns string
register("altimate_core.export_ddl", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const ddl = core.exportDdl(schema)
    return ok(true, { success: true, ddl })
  } catch (e) {
    return fail(e)
  }
})

// 31. altimate_core.fingerprint — returns string hash
register("altimate_core.fingerprint", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const fingerprint = core.schemaFingerprint(schema)
    return ok(true, { success: true, fingerprint })
  } catch (e) {
    return fail(e)
  }
})

// 32. altimate_core.introspection_sql
register("altimate_core.introspection_sql", async (params) => {
  try {
    const raw = core.introspectionSql(
      params.db_type,
      params.database,
      params.schema_name ?? undefined,
    )
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 33. altimate_core.parse_dbt
register("altimate_core.parse_dbt", async (params) => {
  try {
    const raw = core.parseDbtProject(params.project_dir)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 34. altimate_core.is_safe — returns boolean
register("altimate_core.is_safe", async (params) => {
  try {
    const safe = core.isSafe(params.sql)
    return ok(true, { safe })
  } catch (e) {
    return fail(e)
  }
})

} // end registerAll

// Auto-register on module load
registerAll()
