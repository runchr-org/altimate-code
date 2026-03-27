---
name: data-parity
description: Validate that two tables or query results are identical — or diagnose exactly how they differ. Discover schema, identify keys, profile cheaply, then diff. Use for migration validation, ETL regression, and query refactor verification.
---

# Data Parity (Table Diff)

## Output Style

**Report facts only. No editorializing.**
- Show counts, changed values, missing rows, new rows — that's it.
- Do NOT explain why row-level diffing is valuable, why COUNT(*) is insufficient, or pitch the tool.
- Do NOT add "the dangerous one", "this is exactly why", "this matters" style commentary.
- The user asked for a diff result, not a lecture.

## Requirements
**Agent:** any
**Tools used:** `sql_query` (for schema discovery), `data_diff`

## When to Use This Skill

**Use when the user wants to:**
- Confirm two tables contain the same data after a migration
- Find rows added, deleted, or modified between source and target
- Validate that a dbt model produces the same output as the old query
- Run regression checks after a pipeline change

**Do NOT use for:**
- Schema comparison (column names, types) — check DDL instead
- Performance benchmarking — this runs SELECT queries

---

## The `data_diff` Tool

`data_diff` takes table names and key columns. It generates SQL, routes it through the specified warehouse connections, and reports differences. It **does not discover schema** — you must provide key columns and relevant comparison columns.

**Key parameters:**
- `source` — table name (`orders`, `db.schema.orders`) or full SELECT/WITH query
- `target` — table name or SELECT query
- `key_columns` — primary key(s) uniquely identifying each row (required)
- `source_warehouse` — connection name for source
- `target_warehouse` — connection name for target (omit = same as source)
- `extra_columns` — columns to compare beyond keys (omit = compare all)
- `algorithm` — `auto`, `joindiff`, `hashdiff`, `profile`, `cascade`
- `where_clause` — filter applied to both tables
- `partition_column` — split the table by this column and diff each group independently (recommended for large tables); three modes:
  - **Date column**: set `partition_granularity` → groups by truncated date periods
  - **Numeric column**: set `partition_bucket_size` → groups by equal-width key ranges
  - **Categorical column**: set neither → groups by distinct values (strings, enums, booleans like `status`, `region`, `country`)
- `partition_granularity` — `day` | `week` | `month` | `year` — only for date columns
- `partition_bucket_size` — bucket width for numeric columns (e.g. `100000`)

> **CRITICAL — Algorithm choice:**
> - If `source_warehouse` ≠ `target_warehouse` → **always use `hashdiff`** (or `auto`).
> - `joindiff` runs a single SQL JOIN on ONE connection — it physically cannot see the other table.
>   Using `joindiff` across different servers always reports 0 differences (both sides look identical).
> - When in doubt, use `algorithm="auto"` — it picks `joindiff` for same-warehouse and `hashdiff` for cross-warehouse automatically.

---

## Workflow

The key principle: **the LLM does the identification work using SQL tools first, then calls data_diff with informed parameters.**

### Step 1: Inspect the tables

Before calling `data_diff`, use `sql_query` to understand what you're comparing:

```sql
-- Get columns and types
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orders'
ORDER BY ordinal_position
```

For ClickHouse:
```sql
DESCRIBE TABLE source_db.events
```

For Snowflake:
```sql
SHOW COLUMNS IN TABLE orders
```

**Look for:**
- Columns that look like primary keys (named `id`, `*_id`, `*_key`, `uuid`)
- Columns with `NOT NULL` constraints
- Whether there are composite keys

### Step 2: Identify the key columns

If the primary key isn't obvious from the schema, run a cardinality check:

```sql
SELECT
  COUNT(*) AS total_rows,
  COUNT(DISTINCT order_id) AS distinct_order_id,
  COUNT(DISTINCT customer_id) AS distinct_customer_id,
  COUNT(DISTINCT created_at) AS distinct_created_at
FROM orders
```

**A good key column:** `distinct_count = total_rows` (fully unique) and `null_count = 0`.

If no single column is unique, find a composite key:
```sql
SELECT order_id, line_item_id, COUNT(*) as cnt
FROM order_lines
GROUP BY order_id, line_item_id
HAVING COUNT(*) > 1
LIMIT 5
```
If this returns 0 rows, `(order_id, line_item_id)` is a valid composite key.

### Step 3: Estimate table size

```sql
SELECT COUNT(*) FROM orders
```

Use this to choose the algorithm:
- **< 1M rows**: `joindiff` (same DB) or `hashdiff` (cross-DB) — either is fine
- **1M–100M rows**: `hashdiff` with `partition_column` for faster, more precise results
- **> 100M rows**: `hashdiff` + `partition_column` — required; bisection alone may miss rows at this scale

**When to use `partition_column`:**
- Table has a natural time or key column (e.g. `created_at`, `order_id`, `event_date`)
- Table has > 500K rows and bisection is slow or returning incomplete results
- You need per-partition visibility (which month/range has the problem)

```
// Date column — partition by month
data_diff(source="lineitem", target="lineitem",
  key_columns=["l_orderkey", "l_linenumber"],
  source_warehouse="pg_source", target_warehouse="pg_target",
  partition_column="l_shipdate", partition_granularity="month",
  algorithm="hashdiff")

// Numeric column — partition by key ranges of 100K
data_diff(source="orders", target="orders",
  key_columns=["o_orderkey"],
  source_warehouse="pg_source", target_warehouse="pg_target",
  partition_column="o_orderkey", partition_bucket_size=100000,
  algorithm="hashdiff")

// Categorical column — partition by distinct status values ('O', 'F', 'P')
data_diff(source="orders", target="orders",
  key_columns=["o_orderkey"],
  source_warehouse="pg_source", target_warehouse="pg_target",
  partition_column="o_orderstatus",   // no granularity or bucket_size needed
  algorithm="hashdiff")
```

Output includes an aggregate diff plus a per-partition table showing exactly which ranges differ.

### Step 4: Profile first for unknown tables

If you don't know what to expect (first-time validation, unfamiliar pipeline), start cheap:

```
data_diff(
  source="orders",
  target="orders_migrated",
  key_columns=["order_id"],
  source_warehouse="postgres_prod",
  target_warehouse="snowflake_dw",
  algorithm="profile"
)
```

Profile output tells you:
- Row count on each side (mismatch = load completeness problem)
- Which columns have null count differences (mismatch = NULL handling bug)
- Min/max divergence per column (mismatch = value transformation bug)
- Which columns match exactly (safe to skip in row-level diff)

**Interpret profile to narrow the diff:**
```
Column Profile Comparison

  ✓ order_id: match
  ✓ customer_id: match
  ✗ amount: DIFFER     ← source min=10.00, target min=10.01 — rounding issue?
  ✗ status: DIFFER     ← source nulls=0, target nulls=47 — NULL mapping bug?
  ✓ created_at: match
```
→ Only diff `amount` and `status` in the next step.

### Step 5: Run targeted row-level diff

```
data_diff(
  source="orders",
  target="orders_migrated",
  key_columns=["order_id"],
  extra_columns=["amount", "status"],    // only the columns profile said differ
  source_warehouse="postgres_prod",
  target_warehouse="snowflake_dw",
  algorithm="hashdiff"
)
```

---

## Algorithm Selection

| Algorithm | When to use |
|-----------|-------------|
| `profile` | First pass — column stats (count, min, max, nulls). No row scan. |
| `joindiff` | Same database — single FULL OUTER JOIN query. Fast. |
| `hashdiff` | Cross-database, or large tables — bisection with checksums. Scales. |
| `cascade` | Auto-escalate: profile → hashdiff on diverging columns. |
| `auto` | JoinDiff if same warehouse, HashDiff if cross-database. |

**JoinDiff constraint:** Both tables must be on the **same database connection**. If source and target are on different servers, JoinDiff will always report 0 diffs (it only sees one side). Use `hashdiff` or `auto` for cross-database.

---

## Output Interpretation

### IDENTICAL
```
✓ Tables are IDENTICAL
  Rows checked: 1,000,000
```
→ Migration validated. Data is identical.

### DIFFER — Diagnose by pattern

```
✗ Tables DIFFER

  Only in source:  2       → rows deleted in target (ETL missed deletes)
  Only in target:  2       → rows added to target (dedup issue or new data)
  Updated rows:    3       → values changed (transform bug, type casting, rounding)
  Identical rows:  15
```

| Pattern | Root cause hypothesis |
|---------|----------------------|
| `only_in_source > 0`, `only_in_target = 0` | ETL dropped rows — check filters, incremental logic |
| `only_in_source = 0`, `only_in_target > 0` | Target has extra rows — check dedup or wrong join |
| `updated_rows > 0`, row counts match | Silent value corruption — check transforms, type casts |
| Row count differs | Load completeness issue — check ETL watermarks |

Sample diffs point to the specific key + column + old→new value:
```
key={"order_id":"4"} col=amount: 300.00 → 305.00
```
Use this to query the source systems directly and trace the discrepancy.

---

## Usage Examples

### Full workflow: unknown migration
```
// 1. Discover schema
sql_query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='orders'", warehouse="postgres_prod")

// 2. Check row count
sql_query("SELECT COUNT(*), COUNT(DISTINCT order_id) FROM orders", warehouse="postgres_prod")

// 3. Profile to find which columns differ
data_diff(source="orders", target="orders", key_columns=["order_id"],
  source_warehouse="postgres_prod", target_warehouse="snowflake_dw", algorithm="profile")

// 4. Row-level diff on diverging columns only
data_diff(source="orders", target="orders", key_columns=["order_id"],
  extra_columns=["amount", "status"],
  source_warehouse="postgres_prod", target_warehouse="snowflake_dw", algorithm="hashdiff")
```

### Same-database query refactor
```
data_diff(
  source="SELECT id, amount, status FROM orders WHERE region = 'us-east'",
  target="SELECT id, amount, status FROM orders_v2 WHERE region = 'us-east'",
  key_columns=["id"]
)
```

### Large table — filter to recent window first
```
data_diff(
  source="fact_events",
  target="fact_events_v2",
  key_columns=["event_id"],
  where_clause="event_date >= '2024-01-01'",
  algorithm="hashdiff"
)
```

### ClickHouse — always qualify with database.table
```
data_diff(
  source="source_db.events",
  target="target_db.events",
  key_columns=["event_id"],
  source_warehouse="clickhouse_source",
  target_warehouse="clickhouse_target",
  algorithm="hashdiff"
)
```

---

## Common Mistakes

**Calling data_diff without knowing the key**
→ Run `sql_query` to check cardinality first. A bad key gives meaningless results.

**Using joindiff for cross-database tables**
→ JoinDiff runs one SQL query on one connection. It can't see the other table. Use `hashdiff` or `auto`.

**Diffing a 1B row table without a date filter**
→ Add `where_clause` to scope to recent data. Validate a window first, then expand.

**Ignoring profile output and jumping to full diff**
→ Profile is free. It tells you which columns actually differ so you can avoid scanning all columns across all rows.

**Forgetting to check row counts before diffing**
→ If source has 1M rows and target has 900K, row-level diff is misleading. Fix the load completeness issue first.
