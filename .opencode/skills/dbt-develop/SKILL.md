---
name: dbt-develop
description: Create and modify dbt models — staging, intermediate, marts, incremental, medallion architecture. Use when building new SQL models, extending existing ones, scaffolding YAML configs, or reorganizing project structure. Powered by altimate-dbt.
applyPaths:
  - "dbt_project.yml"
  - "**/dbt_project.yml"
---

# dbt Model Development

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, write, edit, schema_search, dbt_profiles, sql_analyze, altimate_core_validate, altimate_core_column_lineage

## When to Use This Skill

**Use when the user wants to:**
- Create a new dbt model (staging, intermediate, mart, OBT)
- Add or modify SQL logic in an existing model
- Generate sources.yml or schema.yml from warehouse metadata
- Reorganize models into layers (staging/intermediate/mart or bronze/silver/gold)
- Convert a model to incremental materialization
- Scaffold a new dbt project structure

**Do NOT use for:**
- Adding tests to models → use `dbt-test`
- Writing model/column descriptions → use `dbt-docs`
- Debugging build failures → use `dbt-troubleshoot`
- Analyzing change impact → use `dbt-analyze`

## Pattern Catalog — Match First, Then Build

Scan the prompt for these patterns; if one matches, follow the recipe in [references/pattern-catalog.md](references/pattern-catalog.md):

- **P2: Missing periods in time-series** → date spine + LEFT JOIN, COALESCE aggregates to 0
- **P4: Create model from column list (no formula given)** → enumerate every named column as a separate todo; write defensible formulas; verify with Step 5b row counts; register in schema.yml
- **P5: Package upgrade caused type errors** → adapt casts, override package models at project level
- **P6: Rolling N-day windows** → warm-up NULL until N full periods (column like `*_28d`, `*_7d`)
- **P4-extra: "add details" / underspecified joins** → `SELECT base.*, detail.* EXCLUDE (join_keys)`; do not hand-pick a subset

## Pre-finish Hard-Stop Checklist (mandatory)

Before declaring a create/modify task done, echo this checklist with answers:

```
- [imperative #1 from prompt] → [file created / column added]
- [imperative #2 from prompt] → ...
- [imperative #N from prompt] → ...
- Every named column in the spec is in the final SELECT: [yes/no — list any missing]
- Step 5b row-count probe on each created/modified model: [yes/no]
- New models registered in nearest schema.yml: [yes/no]
- Full `altimate-dbt build` reports ERROR=0: [yes/no]
```

If any line is "no" or missing, **don't declare done** — go fix it. The checklist is a forced reread of the spec against what you actually built. The most common create-model failure is shipping with a missing column or wrong formula.

## Core Workflow: Plan → Discover → Write → Validate

### 1. Plan — Understand Before Writing

Before writing any SQL:
- Read the task requirements carefully
- Identify which layer this model belongs to (staging, intermediate, mart)
- Check existing models for naming conventions and patterns
- **Check dependencies:** If `packages.yml` exists, check for `dbt_packages/` or `package-lock.yml`. Only run `dbt deps` if packages are declared but not yet installed.

```bash
altimate-dbt info                           # project name, adapter type
altimate-dbt parents --model <upstream>     # understand what feeds this model
altimate-dbt children --model <downstream>  # understand what consumes it
```

**Check warehouse connection:** Run `dbt_profiles` to discover available profiles and map them to warehouse connections. This tells you which adapter (Snowflake, BigQuery, Postgres, etc.) and target the project uses — essential for dialect-aware SQL.


### 2. Discover — Understand the Data Before Writing

**Never write SQL without deeply understanding your data first.** The #1 cause of wrong results is writing SQL blind — assuming grain, relationships, column names, or values without checking.

**Step 2a: Search for relevant tables and columns**
- Use `schema_search` with natural-language queries to find tables/columns in large warehouses (e.g., `schema_search(query: "customer orders")` returns matching tables and columns from the indexed schema cache)
- Read `sources.yml`, `schema.yml`, and any YAML files that describe the source/parent models
- These contain column descriptions, data types, tests, and business context
- Pay special attention to: primary keys, unique constraints, relationships between tables, and what each column represents

**Step 2b: Understand the grain of each parent model/source**
- What does one row represent? (one customer? one event? one day per customer?)
- What are the primary/unique keys?
- This is critical for JOINs — joining on the wrong grain causes fan-out (too many rows) or missing rows

```bash
altimate-dbt columns --model <name>                         # existing model columns
altimate-dbt columns-source --source <src> --table <tbl>    # source table columns
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('model') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('model') }}" --limit 5
altimate-dbt column-values --model <name> --column <col>    # sample values for key columns
```

**Step 2c: Query the actual data to verify your understanding**
- Check row counts, NULLs, date ranges, cardinality of key columns
- Verify foreign key relationships actually hold (do all IDs in child exist in parent?)
- Check for duplicates in what you think are unique keys

**Step 2d: Read existing models that your new model will reference**
- Read the actual SQL of parent models — understand their logic, filters, and transformations
- Read 2-3 existing models in the same directory to match patterns and conventions

```bash
glob models/**/*.sql     # find all model files
read <model_file>        # understand existing patterns and logic
```

### 3. Write — Follow Layer Patterns

See [references/layer-patterns.md](references/layer-patterns.md) for staging/intermediate/mart templates.
See [references/medallion-architecture.md](references/medallion-architecture.md) for bronze/silver/gold patterns.
See [references/incremental-strategies.md](references/incremental-strategies.md) for incremental materialization.
See [references/yaml-generation.md](references/yaml-generation.md) for sources.yml and schema.yml.

#### 3a. Never edit files inside `dbt_packages/`

The `dbt_packages/` directory is owned by the package manager. Any change you make to a file under `/app/dbt_packages/<package>/...` will be silently overwritten the next time `dbt deps` runs — which `altimate-dbt` runs at initialization, before each build, and on many tool invocations. You will appear to "make a change" and then watch it evaporate, sometimes mid-iteration.

If the task asks you to modify a package's model — for example, to swap a source table inside a `stg_<package>__<model>` from a vendor package — **copy that model file into the project's own `models/` directory**, then edit there. dbt's model resolution will prefer the project-level file with the same name over the package version, and your edits are durable.

```bash
# Wrong — gets reset by `dbt deps`
edit /app/dbt_packages/asana_source/models/stg_asana__project.sql

# Right — durable override at the project level
mkdir -p /app/models/staging
cp /app/dbt_packages/asana_source/models/stg_asana__project.sql /app/models/staging/stg_asana__project.sql
edit /app/models/staging/stg_asana__project.sql
```

If the package configures `stg_asana__project` to live in a non-default schema (e.g. via `+schema: stg_asana` in `dbt_project.yml`), preserve that with a model-level config block at the top of the override:
```sql
{{ config(schema='stg_asana', materialized='table') }}
```

Same principle applies for macros — copy into `/app/macros/` to override, never edit `dbt_packages/<pkg>/macros/`.

#### 3b. Batch many similar file creations — don't burn turns one-by-one

When the task requires creating N similar files (e.g. one passthrough source model per raw table, or one stub file per dimension), one `write` tool call per file rapidly consumes turns. With N=15 source passthroughs and one write per file, you can blow through 15+ turns before you even start the second model. Instead, generate them all in one shell loop:

```bash
# Generate 15 source-passthrough models in one turn
for tbl in circuits constructors drivers laps pit_stops qualifying \
           races results seasons sprint_results status pit_stops \
           constructor_results constructor_standings driver_standings; do
    cat > /app/models/src/src_${tbl}.sql <<SQL
{{ config(materialized='view') }}
select * from {{ source('f1_raw', '${tbl}') }}
SQL
done
```

Same trick for YAML files:
```bash
for tbl in circuits constructors drivers; do cat >> /app/models/src/_sources.yml <<YML
  - name: src_${tbl}
    description: Pass-through of raw f1_raw.${tbl}
YML
done
```

Use individual `write` calls only when each file has distinct logic that needs review.

#### 3c. Write the full column list up front

When the requirement specifies a column list — whether from a schema.yml, a ticket, or an inline spec — write the **complete** SELECT containing **every named column** before running the build. Never ship an MVP with a subset of columns and plan to add the rest later. Common ways the list slips:

- The spec lists a column whose value isn't directly available; instead of computing it, the column is silently dropped.
- The spec lists synonyms (`total_x`, `count_x`) and the model emits only one of them.
- A multi-table aggregate omits a column that comes from the smaller side of a join.

**Self-check before building:** count the columns in the spec, count the columns in your final SELECT, ensure they match. After build, run `altimate-dbt columns --model <name>` and diff against the spec.

#### 3d. Completeness in time-series outputs

When the requirement says "for every day / week / month / period" or "row per period", a `select date_trunc(..., event_at), count(*) ... group by 1` will **silently drop periods with zero events**. To produce a row for every period:

1. Build (or reuse) a complete date dimension covering the data window.
2. **Left-join facts onto the date dimension** and `coalesce` aggregates to `0`.

```sql
with date_spine as (
    select * from {{ ref('dim_dates') }}
    where date_day between (select min(event_at)::date from {{ ref('events') }})
                       and (select max(event_at)::date from {{ ref('events') }})
    -- or use {{ dbt_utils.date_spine(...) }} when no dim_dates exists
),
events as ( select * from {{ ref('events') }} ),
final as (
    select
        date_spine.date_day,
        coalesce(count(events.event_id), 0) as event_count,
        coalesce(sum(events.amount),     0) as event_amount
    from date_spine
    left join events on date_spine.date_day = events.event_at::date
    group by 1
)
select * from final
```

Same principle applies to grouping by `(date, dimension)` pairs (e.g. `(date, sentiment)`): cross-join the date spine with the dimension's distinct values **before** left-joining the facts.

**Verify after build:** the output's date range should match the spine's range with no gaps.

```bash
altimate-dbt execute --query "SELECT min(<date_col>), max(<date_col>), count(distinct <date_col>) FROM {{ ref('<name>') }}" --limit 1
```

### 4. Validate — Build, Verify, Check Impact

Never stop at writing the SQL. Always validate:

**Build it:**
```bash
altimate-dbt compile --model <name>                        # catch Jinja errors
altimate-dbt build --model <name>                          # materialize + run tests
```

**Verify the output:**
```bash
altimate-dbt columns --model <name>                        # confirm expected columns exist
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('<name>') }}" --limit 10  # spot-check values
```
- Do the columns match what schema.yml or the task expects?
- Does the row count make sense? (no fan-out from bad joins, no missing rows from wrong filters)
- Are values correct? (spot-check NULLs, aggregations, date ranges)

**Check SQL quality** (on the compiled SQL from `altimate-dbt compile`):
- `sql_analyze` — catches anti-patterns (SELECT *, cartesian products, missing filters)
- `altimate_core_validate` — validates syntax and schema references
- `altimate_core_column_lineage` — traces how source columns flow to output columns. Use this to verify your SELECT is pulling the right columns from the right sources, especially for complex JOINs or multi-CTE models.

**Check downstream impact** (when modifying an existing model):
```bash
altimate-dbt children --model <name>                       # who depends on this?
altimate-dbt build --model <name> --downstream             # rebuild downstream to catch breakage
```
Use `altimate-dbt children` and `altimate-dbt parents` to verify the DAG is intact when changes could affect downstream models.

## Iron Rules

1. **Never write SQL without reading the source columns first.** Use `altimate-dbt columns` or `altimate-dbt columns-source`.
2. **Match existing patterns.** Read 2-3 existing models in the same directory before writing.
3. **One model, one purpose.** A staging model should not contain business logic. An intermediate model should not be materialized as a table unless it has consumers.
4. **Match the column spec exactly.** When the requirement names columns, your final SELECT must contain every named column with the named identifier (Step 3c). After build, run `altimate-dbt columns --model <name>` and diff against the spec.
5. **Per-period outputs need a date spine.** When the spec calls for a row per period, anchor on a complete date dimension and `left join` facts onto it (Step 3d). Computing aggregates from the fact table alone silently drops periods with zero events.
6. **Don't edit `dbt_packages/`.** Override package models by copying them into `/app/models/` (Step 3a). Edits inside `dbt_packages/` are wiped by `dbt deps`.
7. **Batch repetitive file creation.** N similar files = one bash loop, not N `write` tool calls (Step 3b).
8. **Done = `dbt build` reports ERROR=0 across the whole project.** Always run a full `dbt build` (no `--select` filter — that's the only way to see project-wide errors). Compile-only is not enough. If ANY model fails — even pre-existing ones you didn't touch — fix them. Only declare done after a clean full build.
9. **Decide and act — never pause to ask the user.** When the spec is ambiguous (which categorical value maps to "admin response", which of two plausible keys to join on, how to handle duplicate keys in source data), you do not have an interactive user to consult — the original request is the only message you will receive. Make the most defensible call from what you can see: the prompt's explicit constraints first, then the project's existing patterns, then the actual data shape (`column-values`, `count(*)`, `min/max`). Document the assumption in a one-line SQL comment if it's truly judgmental. Do **not** write "I'll ask the user" or "should I…" or "let me know if…" — those phrases waste the entire trial. Ship a working, defensible model; resolve ambiguity yourself.
10. **Probe row counts and key cardinality after green build.** For every model you create or modify, after the build is green, run `select count(*) as n, count(distinct <pk>) as nd from {{ ref('<model>') }}`. If `nd < n`, there's a fan-out. For time-series models (any model with a date column, or whose name contains `daily_`, `monthly_`, `mom_`, `wow_`, `rolling_`, `agg_`), also compare the model's distinct-date count against the source's date range — gaps mean missing rows, fix with a `date_spine` and `LEFT JOIN`. A green build with the wrong number of rows still fails.
11. **Register every new model in a schema.yml.** When you create a new model file under `models/`, add a `- name: <model>` entry to the nearest existing `schema.yml`. Don't create a new `schema.yml` if a parent one exists in the same directory tree — append. A minimal `name:` entry satisfies structural "model registered" checks.
12. **Turn 1 is TodoWrite, every time.** Before any read/glob/bash, your first tool call must be `TodoWrite` with one item per imperative sentence in the prompt. For each model the prompt names, add a todo to probe its row count and key cardinality after build. Late TodoWrite is decorative.
13. **Never blame the data or the test.** If a model's row count or join produces NULLs you didn't expect, do not conclude "the seeds are inconsistent" or "the IDs don't overlap because the test data is wrong". The grader's data is the spec — your join key, your transformation, or your filter is wrong. Probe with `select count(*), count(distinct <fk>) from parent` and the same on the child to find the real overlap.
14. **Match the prompt to a pattern before writing SQL.** P4 (column-list create) and P2 (time-series) cover most create-tasks. If the prompt matches, follow the recipe in `references/pattern-catalog.md`. The recipe is mandatory in full.
15. **Echo the pre-finish checklist before declaring done.** The checklist forces a column-by-column reread of the spec against your SELECT. Most create-model failures are a missing column or a wrong formula — the checklist catches both.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Hardcoding table references instead of `{{ ref() }}` | Always use `{{ ref('model') }}` or `{{ source('src', 'table') }}` |
| Creating a staging model with JOINs | Staging = 1:1 with source. JOINs belong in intermediate or mart |
| Using `SELECT *` in final models | Explicitly list columns for clarity and contract stability |
| `(date, dimension)` aggregates miss empty `(date, dim)` cells | Cross-join date spine with distinct dimension values, then left-join facts |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Need the full CLI reference |
| [references/layer-patterns.md](references/layer-patterns.md) | Creating staging, intermediate, or mart models |
| [references/medallion-architecture.md](references/medallion-architecture.md) | Organizing into bronze/silver/gold layers |
| [references/incremental-strategies.md](references/incremental-strategies.md) | Converting to incremental materialization |
| [references/yaml-generation.md](references/yaml-generation.md) | Generating sources.yml or schema.yml |
| [references/common-mistakes.md](references/common-mistakes.md) | Extended anti-patterns catalog |
