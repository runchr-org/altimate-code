---
name: dbt-troubleshoot
description: Debug dbt errors — compilation failures, runtime database errors, test failures, wrong data, performance issues, deprecation warnings, and package-upgrade fallout. Use when: (1) the user mentions an error, says the project is broken, asks to fix or debug something; (2) a package was upgraded and downstream models now fail; (3) `dbt build` reports any ERROR; (4) a previously-working model now produces wrong rows. Triggers on the words: error, broken, fix, debug, failing, deprecated, upgrade, Fivetran, Compilation Error, Database Error. Powered by altimate-dbt.
applyPaths:
  - "dbt_project.yml"
  - "**/dbt_project.yml"
---

# dbt Troubleshooting

## Requirements
**Agent:** any (read-only diagnosis), builder (if applying fixes)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, edit, altimate_core_semantics, altimate_core_column_lineage, altimate_core_correct, altimate_core_fix, sql_fix

## When to Use This Skill

**Use when:**
- A dbt model fails to compile or build
- Tests are failing
- Model produces wrong or unexpected data
- Builds are slow or timing out
- User shares an error message from dbt

**Do NOT use for:**
- Creating new models → use `dbt-develop`
- Adding tests → use `dbt-test`
- Analyzing change impact → use `dbt-analyze`

## Iron Rules

1. **Never modify a test to make it pass without understanding why it's failing.**
2. **Fix ALL errors, not just the reported one.** After fixing the specific issue, run a full `dbt build`. If other models fail — even ones not mentioned in the error report — fix them too. Your job is to leave the project in a fully working state. Never dismiss errors as "pre-existing" or "out of scope".
3. **One reported error usually has siblings.** A deprecation warning, breaking package upgrade, or removed column rarely affects only one model. Before declaring fixed, scan the whole project for the same pattern (Step 6) and re-run a full `dbt build` (no `--select` filter — that's what surfaces project-wide errors).
4. **Done = green build, nothing more.** When the originally-reported error is resolved AND `dbt build` reports `ERROR=0`, the task is complete. Do not refactor unrelated models, clean up YAML warnings, remove orphaned doc entries, or add tests/docs that the user did not ask for. Warnings ≠ errors. Stop when the build is green.
5. **Decide and act — never pause to ask the user.** When the data or the prompt is ambiguous (duplicate keys, multiple plausible interpretations, missing context about a business rule), you do not have an interactive user to consult — the original request is the only message you will receive. Make the most defensible call from what you can see: the prompt's explicit constraints first, then the project's existing patterns, then the data's actual shape (`column-values`, `count(*)`, `min/max`). Document the assumption in a one-line comment in the SQL if it's truly judgmental. Do **not** write "I'll ask the user" or "should I…" or "let me know if…" — those phrases waste the entire trial. The job is to ship a working, defensible fix; ambiguity gets resolved by you, not by waiting.
6. **Green build is necessary but not sufficient — verify row counts.** After the build is green, for every model the prompt explicitly named and every model whose SQL you modified, run a row-count and key-cardinality probe (Step 5b). A green build with the wrong number of rows still fails the task. Time-series models especially: a daily/monthly/mom/wow model whose distinct-date count is less than the source's date span is missing rows and is **not** fixed.
7. **Audit refs and sources before declaring done.** When the task involves moving, removing, or renaming models, run the ref/source audit (Step 5c). Every `source('x', 'y')` call must have a matching entry in a `sources.yml`; every model you created must be registered in a `schema.yml`; every `ref()` to a removed model must be updated.
8. **Never blame the data or the test.** When equality tests fail, the grader's expectation is the spec. Don't write "the seeds are inconsistent" or "this is a dataset mismatch" or "the test is wrong". Re-probe the data: cardinality, join-key overlap, NULLs. The bug is in your SQL. Always assume your model is the variable; the benchmark is frozen.
9. **Turn 1 is TodoWrite, every time.** Before any read/glob/bash, your first tool call must be `TodoWrite` with one item per imperative sentence in the prompt (see the "Plan first" rule). Then add verification todos for Step 5b (row counts on touched models) and, if relevant, Step 5c (ref/source audit). Late TodoWrite is decorative.
10. **Match the prompt to a pattern before acting.** Scan the pattern catalog (references/pattern-catalog.md). If the prompt matches P1-P5, follow the recipe verbatim. The recipe is mandatory in full — do not cherry-pick steps. Catalog patterns encode constraints the agent has missed before; following them changes pass rate, not following them doesn't.
11. **Echo the pre-finish checklist before declaring done.** Step 5d. The checklist forces a reread of the prompt against your edits. The most common cause of a "green build / failed test" outcome is an unaddressed imperative; the checklist surfaces it.

## Pattern Catalog — Match First, Then Diagnose

Before diving into Step 1, scan the prompt for one of the well-known patterns documented in [references/pattern-catalog.md](references/pattern-catalog.md). The catalog contains concrete recipes for failure shapes the agent has missed before:

| Pattern | Trigger | What's tricky |
|---------|---------|---------------|
| **P1: `dbt_utils.surrogate_key` deprecation** | Prompt mentions `surrogate_key` or `generate_surrogate_key` | Null-handling differs between old/new macro — silent identity divergence after a clean rename. The full migration requires **both** the rename AND adding `surrogate_key_treat_nulls_as_empty_strings: true` to `dbt_project.yml` whenever any renamed call references a nullable column. See P1 recipe for the decision rule. |
| **P2: Missing periods in time-series** | "row per day/week/month", missing days, `daily_`/`monthly_`/`mom_`/`wow_`/`agg_` model | Group-by aggregations silently drop zero-event periods. Fix is a date spine + LEFT JOIN. Lag-aware (MoM/WoW) outputs may need warm-up history — see P2 recipe. |
| **P3: Source-direct refactor** | "remove tmp models", "reference sources directly" | Swapping `ref()` → `source()` requires registering the source in a `sources.yml`. Missing entry → structural source-resolution check fails even when `dbt build` succeeds. |
| **P4: Create model from column list, no formula** | "Create X with columns [list]", "first_X_at", "compute NPS" | Spec gives columns but not derivations. Read every column name as a separate todo. Match each to source data; pick the most defensible formula and document it. |
| **P5: Package upgrade type errors** | "Fivetran updating", "package upgrade", type-mismatch errors | Underlying source types changed; downstream casts need updating. Override package models at the project level — don't edit `dbt_packages/`. |
| **P6: Rolling N-day windows** (`*_28d`, `*_7d`) | Column name like `nps_28d`, `reviews_28d`; spec says "rolling 28 day" | Standard convention: emit NULL for the first N-1 rows (warm-up). Partial-window emissions fail equality tests. See P6 recipe. |

**If the prompt matches a pattern, follow that recipe verbatim.** The catalog encodes constraints the agent has historically missed; the Iron Rules state principles but the catalog gives concrete actions.

## Diagnostic Workflow

### Step 1: Health Check

```bash
altimate-dbt doctor
altimate-dbt info
```

If `doctor` fails, fix the environment first. Common issues:
- Python not found → reinstall or set `--python-path`
- dbt-core not installed → `pip install dbt-core`
- No `dbt_project.yml` → wrong directory
- Missing packages → if `packages.yml` exists but `dbt_packages/` doesn't, run `dbt deps`

### Step 2: Classify the Error

| Error Type | Symptom | Jump To |
|-----------|---------|---------|
| Compilation Error | Jinja/YAML parse failure | [references/compilation-errors.md](references/compilation-errors.md) |
| Runtime/Database Error | SQL execution failure | [references/runtime-errors.md](references/runtime-errors.md) |
| Test Failure | Tests return failing rows | [references/test-failures.md](references/test-failures.md) |
| Wrong Data | Model builds but data is incorrect | Step 3 below |

### Step 3: Isolate the Problem

```bash
# Compile only — catches Jinja errors without hitting the database
altimate-dbt compile --model <name>

# If compile succeeds, try building
altimate-dbt build --model <name>

# Probe the data directly
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('<name>') }}" --limit 5
```

### Step 3b: Offline SQL Analysis

Before hitting the database, analyze the compiled SQL offline:

```bash
# Check for semantic issues (wrong joins, cartesian products, NULL comparisons)
altimate_core_semantics --sql <compiled_sql>

# Trace column lineage to find where wrong data originates
altimate_core_column_lineage --sql <compiled_sql>

# Auto-suggest fixes for SQL errors
altimate_core_correct --sql <compiled_sql>
```

**Quick-fix tools** — use these when the error type is clear:

```
# Schema-based fix: fuzzy-matches table/column names against schema to fix typos and wrong references
altimate_core_fix(sql: <compiled_sql>, schema_context: <schema_object>)

# Error-message fix: given a failing query + database error, analyzes root cause and proposes corrections
sql_fix(sql: <compiled_sql>, error_message: <error_message>, dialect: <dialect>)
```

`altimate_core_fix` is best for compilation errors (wrong names, missing objects). `sql_fix` is best for runtime errors (the database told you what's wrong). Use `altimate_core_correct` for iterative multi-round correction when the first fix doesn't resolve the issue.


Common findings:
- **Wrong join type**: `INNER JOIN` dropping rows that should appear → switch to `LEFT JOIN`
- **Fan-out**: One-to-many join inflating row counts → add deduplication or aggregate
- **Column mismatch**: Output columns don't match schema.yml definition → reorder SELECT
- **NULL comparison**: Using `= NULL` instead of `IS NULL` → silent data loss

### Step 3c: Wrong Data Diagnosis — Deep Data Exploration

When a model builds but produces wrong results, the bug is almost always in the data assumptions, not the SQL syntax. **You must explore the actual data to find it.**

```bash
# 1. Check the output for unexpected NULLs
altimate-dbt execute --query "SELECT count(*) as total, count(<col>) as non_null, count(*) - count(<col>) as nulls FROM {{ ref('<name>') }}" --limit 1

# 2. Check value ranges — are metrics within expected bounds?
altimate-dbt execute --query "SELECT min(<metric>), max(<metric>), avg(<metric>) FROM {{ ref('<name>') }}" --limit 1

# 3. Check distinct values for key columns — do they look right?
altimate-dbt execute --query "SELECT <col>, count(*) FROM {{ ref('<name>') }} GROUP BY 1 ORDER BY 2 DESC" --limit 20

# 4. Compare row counts between model output and parent tables
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<parent>') }}" --limit 1
```

**Common wrong-data root causes:**
- **Fan-out from joins**: If row count is higher than expected, a join key isn't unique — check with `SELECT key, count(*) ... GROUP BY 1 HAVING count(*) > 1`
- **Missing rows from INNER JOIN**: If row count is lower than expected, switch to LEFT JOIN and check for NULL join keys
- **Date spine issues**: If using `current_date` or `dbt_utils.date_spine`, output changes daily — check min/max dates

### Step 4: Check Upstream

Most errors cascade from upstream models:

```bash
altimate-dbt parents --model <name>
```

Read the parent models. Build them individually. **Query the parent data** — don't assume it's correct:
```bash
altimate-dbt execute --query "SELECT count(*), count(DISTINCT <pk>) FROM {{ ref('<parent>') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('<parent>') }}" --limit 5
```

### Step 5: Fix and Verify

After applying a fix:

```bash
altimate-dbt build --model <name> --downstream
```

Always build with `--downstream` to catch cascading impacts.

**Then verify the fix with data queries** — don't just trust the build:
```bash
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('<name>') }}" --limit 10
# Check the specific metric/column that was wrong:
altimate-dbt execute --query "SELECT min(<col>), max(<col>), count(*) - count(<col>) as nulls FROM {{ ref('<name>') }}" --limit 1
```

### Step 5b: Row-count and key-cardinality sanity on every touched model

After build is green, for every model the prompt explicitly named **and** every model whose SQL you modified, run the following probes and reason about whether each result is sane. Do not skip this — equality-graded tasks frequently pass build and fail row count.

```bash
# Row count + key cardinality
altimate-dbt execute --query "select count(*) as n, count(distinct <pk>) as nd from {{ ref('<model>') }}" --limit 1

# Null ratios on every column the prompt named
altimate-dbt execute --query "select count(*) - count(<col>) as nulls, count(distinct <col>) as nd from {{ ref('<model>') }}" --limit 1
```

If the model has any date or time column **or** its name contains `daily_`, `monthly_`, `mom_`, `wow_`, `rolling_`, `agg_`, `dim_dates`, or any period-aggregation pattern, also run:

```bash
# Source range
altimate-dbt execute --query "select min(<date_col>), max(<date_col>), count(distinct <date_col>) from {{ ref('<source>') }}" --limit 1

# Model range — compare against source
altimate-dbt execute --query "select min(<date_col>), max(<date_col>), count(distinct <date_col>) from {{ ref('<model>') }}" --limit 1
```

Interpret the result:

- `count(distinct <pk>) < count(*)` → fan-out from a non-unique join key. Deduplicate, pre-aggregate the right side, or revisit join grain.
- Model's `count(distinct <date_col>)` is less than `(max_date - min_date + 1)` for daily (or the equivalent month/week count) → date-spine gap. Build a `date_spine` and `LEFT JOIN` facts; `COALESCE` aggregates to 0.
- Model `min(<date_col>) > source min` or `max(<date_col>) < source max` → filter narrower than source. Remove or extend the window.
- Row count much higher than source distinct keys → unintended cross-join. Inspect `altimate_core_semantics` output.
- `nulls = count(*)` for a named column → column never populated. Re-read source columns with `altimate-dbt columns-source`.

Do not declare done until every touched model passes these probes. A 6-row discrepancy on an 11000-row model is still wrong.

### Step 5c: Ref/source audit before declaring done

When the task involved moving models, removing models, or changing where data comes from (refactoring `tmp/` models to reference sources directly, removing intermediate models, swapping a `ref()` for a `source()`, or vice versa), run the following audit before declaring done:

```bash
# Every source() and ref() call across project models
grep -rEn "source\(|ref\(" models/ --include="*.sql" --include="*.yml" | grep -v target/

# Every model with a schema.yml entry
grep -rE "^\s*-\s*name:" models/ --include="*.yml"
```

Verify by hand:

- Every `source('pkg', 'tbl')` call has `pkg` declared as a source with `tbl` as a table in some `sources.yml`. A missing entry causes structural failures and `Compilation Error: source ... not found` at runtime.
- Every model file under `/app/models/` that you created has a `- name: <model>` entry in the nearest `schema.yml`. Don't create a new `schema.yml` if a parent one already exists in the same directory tree; append to the closest one.
- If you removed model `X`, no `ref('X')` remains in any other model. Run `grep -rn "ref('X')" models/` to confirm.
- If the task says "reference the source tables directly", confirm that every `ref()` you replaced now points to `source()` and the source is registered in `sources.yml`.

Schema-registration template (append to an existing `models/.../schema.yml`):

```yaml
version: 2

models:
  - name: <new_model>
    description: <one-line description from the prompt or your understanding>
    columns:
      - name: <pk_or_first_column>
```

A minimal `name:` entry satisfies structural "model is registered" checks even without descriptions or column-level tests.

### Step 5d: Pre-finish hard-stop checklist (mandatory)

Before declaring done, **echo the following checklist explicitly** (one line each, with the answer):

```
- [imperative #1 from prompt] → [file you edited / config you set]
- [imperative #2 from prompt] → [file you edited / config you set]
- [imperative #N from prompt] → [file you edited / config you set]
- Pattern matched from catalog: [P1/P2/P3/P4/P5 or "none"]
- If pattern matched, all recipe steps applied: [yes/no]
- Step 5b row-count probe on each named model: [yes/no — list models]
- Step 5c ref/source audit (if refactor): [yes/no/n.a.]
- Full `altimate-dbt build` reports ERROR=0: [yes/no]
```

If any checklist line is missing or "no", **do not declare done** — go fix it. The user does not see your summary if a checklist line is unchecked; they see the failed grader.

This is not optional flavor. The model has historically declared done after the first imperative, leaving the second unaddressed. The checklist is a forced reread of the prompt against what you actually changed.

### Step 6: Pattern Propagation Check

A single error message is often the **first** symptom, not the only one. Before declaring fixed, propagate the fix across the whole project. This applies especially to:

- **Deprecated macros** — `dbt_utils.surrogate_key` → `generate_surrogate_key`, `dbt_utils.current_timestamp` → `dbt.current_timestamp_backcompat`, etc.
- **Renamed dispatched functions** — package upgrades that move `{{ dbt_utils.<x> }}` to `{{ dbt.<x> }}`
- **Removed source columns** — a column dropped upstream typically breaks every model that referenced it
- **Renamed `ref` targets** — when a model is renamed, every reference must update
- **Schema changes** — type changes, NOT NULL additions, key rotations
- **Breaking config changes** — `materialized` config keys, var names, target profile keys

**Always run before declaring done:**

```bash
# Scan the entire project for the bug pattern
grep -rn "<old_pattern>" models/ macros/ analyses/ tests/ snapshots/ seeds/ dbt_project.yml *.yml

# Then re-run the full build (no --select) to surface ALL remaining errors at once.
# Prefer `dbt build` over `dbt parse` — parse catches Jinja but misses runtime errors
# that only show during materialization.
dbt build
# or
altimate-dbt build
```

If `build` (or `parse`) reports any error, **read every error**, fix each one, repeat. Compilation errors are typically present simultaneously across many models — the database driver just stops at the first reported one but more may surface after that fix.

**Anti-pattern:** "I fixed the file the error mentioned and the project compiled some models successfully — I'm done." This is wrong if `dbt build` (no `--select` filter) still reports any error elsewhere.

## Rationalizations to Resist

| You're Thinking... | Reality |
|--------------------|---------|
| "Just make the test pass" | The test is telling you something. Investigate first. |
| "Let me delete this test" | Ask WHY it exists before removing it. |
| "It works on my machine" | Check the adapter, Python version, and profile config. |
| "I'll fix it later" | Later never comes. Fix it now. |
| "I fixed the file the error mentioned, I'm done" | Run `dbt build` with no `--select` filter. The first reported error is rarely the only instance. |
| "While I'm here, let me clean up these warnings too" | Don't. Warnings ≠ errors. Stop when the build is green; unrelated cleanup is scope creep. |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Changing tests before understanding failures | Read the error. Query the data. Understand the root cause. |
| Fixing symptoms instead of root cause | Trace the problem upstream. The bug is often 2 models back. |
| Not checking upstream models | Run `altimate-dbt parents` and build parents individually |
| Ignoring warnings | Warnings often become errors. Fix them proactively. |
| Not running offline SQL analysis | Use `altimate_core_semantics` before building to catch join issues |
| Column names/order don't match schema | Use `altimate_core_column_lineage` to verify output columns match schema.yml |
| Not querying the actual data when debugging wrong results | Always run data exploration queries — check NULLs, value ranges, distinct values |
| Trusting build success as proof of correctness | Build only checks syntax and constraints — wrong values pass silently |
| Fixing only the model the error names | Run a project-wide grep for the deprecated/renamed pattern; fix every match |
| Refactoring unrelated code while debugging | Stop at green build. Cleanup belongs in a separate task. |
| Pausing to "ask the user" about ambiguous data or business rules | Make the most defensible call from the prompt + data + project patterns; document any assumption in a one-line SQL comment; ship the fix |
| Declaring done after green build without checking row counts | Run Step 5b on every touched/named model — a 6-row discrepancy on 11000 is still wrong |
| Skipping Step 5c after a refactor | Every `source()` must be in `sources.yml`; every created model in `schema.yml`; every `ref()` to a removed model updated |
| Reading the prompt as one sentence | Extract every imperative as a separate TodoWrite item before planning — second sentences like "add var X to dbt_project.yml" or "make it backwards compatible" are top failure modes |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Need the full CLI reference |
| [references/compilation-errors.md](references/compilation-errors.md) | Jinja, YAML, or parse errors |
| [references/runtime-errors.md](references/runtime-errors.md) | Database execution errors |
| [references/test-failures.md](references/test-failures.md) | Understanding and fixing test failures |
