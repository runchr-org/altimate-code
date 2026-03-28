---
name: data-parity
description: Validate that two tables or query results are identical — or diagnose exactly how they differ. Discover schema, identify keys, profile cheaply, then diff. Use for migration validation, ETL regression, and query refactor verification.
---

# Data Parity (Table Diff)

## CRITICAL: Always Start With a Plan

**Before doing anything else**, generate a numbered TODO list for the user:

```
Here's my plan:
1. [ ] List available warehouse connections
2. [ ] Inspect schema and discover primary key candidates
3. [ ] Confirm primary keys with you
4. [ ] Check row counts on both sides
5. [ ] Run column-level profile (cheap — no row scan)
6. [ ] Ask whether to proceed with row-level diff (may be expensive for large tables)
7. [ ] Run targeted row-level diff on diverging columns only
8. [ ] Report findings
```

Update each item to `[x]` as you complete it. This plan should be visible before any tool is called.

---

## CRITICAL: Use `data_diff` Tool — Never Write Manual Diff SQL

**NEVER** write SQL to diff tables manually (e.g., `EXCEPT`, `FULL OUTER JOIN`, `MINUS`).
**ALWAYS** use the `data_diff` tool for any comparison operation.

`sql_query` is only for:
- Schema inspection (`information_schema`, `SHOW COLUMNS`, `DESCRIBE`)
- Cardinality checks to identify keys
- Row count estimates

Everything else — profile, row diff, value comparison — goes through `data_diff`.

---

## Step 1: List Connections

Use `warehouse_list` to show the user what connections are available and which warehouses map to source and target.

---

## Step 2: Inspect Schema and Discover Primary Keys

Use `sql_query` to get columns and identify key candidates:

```sql
-- Postgres / Redshift / DuckDB
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orders'
ORDER BY ordinal_position
```

```sql
-- Snowflake
SHOW COLUMNS IN TABLE orders
```

```sql
-- ClickHouse
DESCRIBE TABLE source_db.events
```

**Look for:** columns named `id`, `*_id`, `*_key`, `uuid`, or with `NOT NULL` + unique index.

If no obvious PK, run a cardinality check:

```sql
SELECT
  COUNT(*) AS total_rows,
  COUNT(DISTINCT order_id) AS distinct_order_id,
  COUNT(DISTINCT customer_id) AS distinct_customer_id
FROM orders
```

A valid key column: `distinct_count = total_rows`.

For composite keys:
```sql
SELECT order_id, line_item_id, COUNT(*) AS cnt
FROM order_lines
GROUP BY order_id, line_item_id
HAVING COUNT(*) > 1
LIMIT 5
```
If this returns 0 rows, `(order_id, line_item_id)` is a valid composite key.

## Step 3: Confirm Keys With the User

**Always confirm** the identified key columns before proceeding:

> "I identified `order_id` as the primary key (150,000 distinct values = 150,000 rows, no NULLs). Does that look right, or should I use a different column?"

Do not proceed to diff until the user confirms or corrects.

---

## Step 4: Check Row Counts

```sql
SELECT COUNT(*) FROM orders   -- run on both source and target
```

Use counts to:
- Detect load completeness issues before row-level diff
- Choose the algorithm and decide whether to ask about cost
- If counts differ significantly (>5%), flag it immediately

---

## Step 5: Column-Level Profile (Always Run This First)

Profile is cheap — it runs aggregates, not row scans. **Always run profile before row-level diff.**

```
data_diff(
  source="orders",
  target="orders",
  key_columns=["order_id"],
  source_warehouse="postgres_prod",
  target_warehouse="snowflake_dw",
  algorithm="profile"
)
```

Profile tells you:
- Row count on each side
- Which columns have null count differences → NULL handling bug
- Min/max divergence per column → value transformation bug
- Which columns match exactly → safe to skip in row-level diff

**Example output:**
```
Column Profile Comparison

  ✓ order_id: match
  ✓ customer_id: match
  ✗ amount: DIFFER     ← source min=10.00, target min=10.01 — rounding?
  ✗ status: DIFFER     ← source nulls=0, target nulls=47 — NULL mapping bug?
  ✓ created_at: match
```

---

## Step 6: Ask Before Running Row-Level Diff on Large Tables

After profiling, check row count and **ask the user** before proceeding:

**If table has < 100K rows:** proceed automatically.

**If table has 100K–10M rows:**
> "The table has 1.2M rows. Row-level diff will scan all rows on both sides — this may take 30–60 seconds and consume warehouse compute. Do you want to proceed? You can also provide a `where_clause` to limit the scope (e.g., `created_at >= '2024-01-01'`)."

**If table has > 10M rows:**
> "The table has 50M rows. Full row-level diff could be expensive. Options:
> 1. Diff a recent window only (e.g., last 30 days)
> 2. Partition by a date/key column — shows which partition has problems without scanning everything
> 3. Proceed with full diff (may take several minutes)
> Which would you prefer?"

---

## Step 7: Run Targeted Row-Level Diff

Use only the columns that the profile said differ. This is faster and produces cleaner output.

```
data_diff(
  source="orders",
  target="orders",
  key_columns=["order_id"],
  extra_columns=["amount", "status"],    // only diverging columns from profile
  source_warehouse="postgres_prod",
  target_warehouse="snowflake_dw",
  algorithm="hashdiff"
)
```

### For large tables — use partition_column

Split the table into groups and diff each independently. Three modes:

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

// Categorical column — partition by distinct values (string, enum, boolean)
data_diff(source="orders", target="orders",
  key_columns=["o_orderkey"],
  source_warehouse="pg_source", target_warehouse="pg_target",
  partition_column="o_orderstatus",
  algorithm="hashdiff")
```

Output includes aggregate diff + per-partition breakdown showing which group has problems.

---

## Algorithm Selection

| Algorithm | When to use |
|-----------|-------------|
| `profile` | **Always run first** — column stats (count, min, max, nulls). No row scan. |
| `joindiff` | Same database — single FULL OUTER JOIN. Fast, exact. |
| `hashdiff` | Cross-database or large tables — bisection with checksums. Scales to billions. |
| `cascade` | Auto-escalate: profile → hashdiff on diverging columns. |
| `auto` | JoinDiff if same warehouse, HashDiff if cross-database. |

> **CRITICAL:** If `source_warehouse` ≠ `target_warehouse`, **never use `joindiff`** — it only sees one connection and always reports 0 differences. Use `hashdiff` or `auto`.

---

## Output Interpretation

### IDENTICAL
```
✓ Tables are IDENTICAL
  Rows checked: 1,000,000
```

### DIFFER
```
✗ Tables DIFFER

  Source rows:      150,000
  Target rows:      149,950
  Only in source:   50       → rows deleted in target (ETL missed deletes)
  Only in target:   0
  Updated rows:     0
  Identical rows:   149,950
```

| Pattern | Root cause |
|---------|-----------|
| `only_in_source > 0`, target = 0 | ETL dropped rows — check filters, incremental logic |
| `only_in_target > 0`, source = 0 | Target has extra rows — dedup issue or wrong join |
| `updated_rows > 0`, counts match | Silent value corruption — check type casts, rounding |
| Row counts differ significantly | Load completeness — check ETL watermarks |

---

## CRITICAL: `extra_columns` Behavior

The Rust engine **only compares columns listed in `extra_columns`**. If the list is empty, it compares key existence only — rows that match on key but differ in values will be silently reported as "identical". This is the most common source of false positives.

**Auto-discovery (default for table names):** When `extra_columns` is omitted and the source is a plain table name, `data_diff` auto-discovers all non-key columns from `information_schema` and excludes audit/timestamp columns (like `updated_at`, `created_at`, `inserted_at`, `modified_at`, `publisher_last_updated_epoch_ms`, ETL metadata columns like `_fivetran_synced`, etc.). The output will list which columns were auto-excluded.

**SQL queries:** When source is a SQL query (not a table name), auto-discovery cannot work. You **must** provide `extra_columns` explicitly. If you don't, only key-level matching occurs.

**When to override auto-exclusion:** If the user specifically wants to compare audit columns (e.g., verifying that `created_at` was preserved during migration), pass those columns explicitly in `extra_columns`.

---

## Common Mistakes

**Writing manual diff SQL instead of calling data_diff**
→ Never use EXCEPT, MINUS, or FULL OUTER JOIN to diff tables. Use `data_diff`.

**Calling data_diff without confirming the key**
→ Confirm cardinality with the user first. A bad key gives meaningless results.

**Using joindiff for cross-database tables**
→ JoinDiff can't see the remote table. Always returns 0 diffs. Use `hashdiff` or `auto`.

**Skipping the profile step and jumping to full row diff**
→ Profile is free. It tells you which columns actually differ so you avoid scanning everything.

**Running full diff on a billion-row table without asking**
→ Always ask the user before expensive operations. Offer filtering and partition options.

**Omitting extra_columns when source is a SQL query**
→ Auto-discovery only works for table names. For SQL queries, always list the columns to compare explicitly.
