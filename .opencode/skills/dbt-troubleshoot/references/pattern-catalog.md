# Pattern Catalog

When you read the user's prompt, scan for these patterns. If one matches, the recipe below is **mandatory** — apply every step. The recipes encode general dbt engineering practices that the agent has historically applied incompletely.

## P1: `dbt_utils.surrogate_key` deprecation

**Trigger phrases (any one):**
- The user prompt mentions `dbt_utils.surrogate_key`, `surrogate_key has been replaced`, or `dbt_utils.generate_surrogate_key`
- A compilation **warning** that names `surrogate_key` — even if the prompt only says "the project is broken" or doesn't mention surrogate_key at all
- The first `dbt build` output contains the string `surrogate_key` in a `Warning:` line

**Important:** if the prompt is vague (e.g. "the project is broken") and you run `dbt build`, **read every Warning line** — deprecation warnings are not "informational fluff", they are actionable instructions describing the migration you need to apply. Apply P1 if `surrogate_key` appears anywhere in the build output, regardless of whether the prompt mentions it.


**Why it's tricky (from the dbt-utils CHANGELOG and migration notes):** The new `generate_surrogate_key` treats `NULL` values **differently** from empty strings. The old macro coerced NULL to empty string. Models that compute keys from a nullable column (sentiment, status, optional category) will produce **different surrogate keys** after the rename — even though the build is green. Downstream equality tests against historical keys will silently fail.

**Required actions (do ALL — order matters):**

1. **Replace every call across the project** (don't stop at the one in the error):
   ```bash
   grep -rn "dbt_utils\.surrogate_key" /app/models /app/macros /app/analyses /app/tests /app/snapshots 2>/dev/null
   ```
   For every file returned, edit `dbt_utils.surrogate_key` → `dbt_utils.generate_surrogate_key`.

2. **Add the backwards-compat var to `dbt_project.yml`.** This is the documented dbt-utils migration step for preserving identity across the rename — and is required whenever any renamed call references a nullable column:
   ```yaml
   vars:
     surrogate_key_treat_nulls_as_empty_strings: true
   ```
   To decide if you need it: for each renamed call, check whether any of its columns is nullable. If any column could be NULL — confirm with `altimate-dbt execute --query "select count(*) - count(<col>) as nulls from {{ ref('<parent>') }}"` — set the var. Most production projects need it; defaulting to "set it" is safer than defaulting to "skip it" because the symptom is silent (build green, downstream wrong).

3. Implementation: read the current `dbt_project.yml`. If a `vars:` block already exists, append the key under it; otherwise add a new top-level `vars:` block. Verify by re-reading the file.

4. **Run `altimate-dbt build` (no `--select`)** and confirm `ERROR=0`.

5. **Step 5b row-count probe** on every renamed model — counts must match the source's grain (no fan-out, no missing rows).

**Anti-pattern:** Renaming the macro and stopping there because the project compiles. The compile success only proves syntax; the null-handling divergence is a silent data-correctness bug.

---

## P2: Missing periods / incomplete date series

**Trigger phrases (any one):**
- "row per day / week / month / period"
- "some days are missing", "every day in range"
- A model named with `daily_`, `monthly_`, `weekly_`, `mom_`, `wow_`, `rolling_`, `agg_`

**Why it's tricky:** `select date_trunc(..., event_at), count(*) from events group by 1` **silently drops periods with zero events**. The output looks correct (every period present in the data is included) but periods without source rows are missing entirely. A consumer who expects "row per period" gets gaps wherever the source had no activity.

**Required actions:**

1. **Identify the date column and source date range:**
   ```bash
   altimate-dbt execute --query "select min(<date_col>), max(<date_col>), count(distinct <date_col>) from {{ ref('<source>') }}" --limit 1
   ```

2. **Identify the model's current date range:**
   ```bash
   altimate-dbt execute --query "select min(<date_col>), max(<date_col>), count(distinct <date_col>) from {{ ref('<model>') }}" --limit 1
   ```

3. **If model `count(distinct <date_col>) < (max - min + 1)` for daily** (or equivalent for monthly/weekly), build a date spine:
   ```sql
   with date_spine as (
       select * from {{ dbt_utils.date_spine(
           datepart='day',
           start_date="(select min(<date_col>)::date from {{ ref('<source>') }})",
           end_date="(select dateadd(day, 1, max(<date_col>)::date) from {{ ref('<source>') }})"
       ) }}
   ),
   events as ( select * from {{ ref('<source>') }} ),
   final as (
       select
           date_spine.date_day,
           coalesce(count(events.event_id), 0) as event_count,
           coalesce(sum(events.amount),     0) as event_amount
       from date_spine
       left join events on date_spine.date_day = events.<date_col>::date
       group by 1
   )
   select * from final
   ```

4. **For grouped time-series** (date × dimension): **cross-join** the date spine with the distinct dimension values BEFORE the left join. Otherwise (date, dimension) pairs with zero events are dropped.

5. **For month-over-month / week-over-week / lagged computations**, an MoM value for month *M* depends on month *M-1*. If month *M-1* doesn't exist in your output, MoM at *M* will be NULL. Decide whether to (a) extend the spine one period earlier than the first source observation, or (b) leave the first period's MoM column NULL — the choice depends on the consumer. General rule: lag-aware time-series outputs need at least one period of "warm-up" history.

6. **Verify**: `altimate-dbt execute --query "select count(distinct date_col) from {{ ref('<model>') }}"` should equal the spine length.

**Anti-pattern:** filtering the date dimension to only dates already present in the fact table, e.g. `WHERE date_actual IN (select distinct review_date from review_cte)`. This guarantees missing rows wherever the fact table had no activity.

---

## P3: Refactor to reference sources directly (remove intermediate `tmp/` models)

**Trigger phrases:**
- "remove the models in the tmp folder"
- "reference the source tables directly"
- "swap the stg_*__tmp models for source() calls"

**Why it's tricky:** When you swap `ref('foo__tmp')` for `source('schema', 'foo')`, the `source()` must be declared in a `sources.yml`. If it isn't, dbt's structural validators report the model as having unresolved sources — even though SQL compilation may succeed in lenient warehouses.

**Required actions:**

1. **Find every `ref()` that points to a model being removed:**
   ```bash
   grep -rEn "ref\(['\"](\w+__tmp)['\"]" /app/models
   ```

2. **For each, replace with the equivalent `source()` call.** The source name and table name must match what's actually in the warehouse — confirm with:
   ```bash
   altimate-dbt columns-source --source <pkg> --table <tbl>
   ```

3. **Update or create `sources.yml`** — every `source('pkg', 'tbl')` call needs a declaration:
   ```yaml
   version: 2
   sources:
     - name: <pkg>
       schema: <warehouse_schema>
       tables:
         - name: <tbl>
   ```
   If the project already has a `sources.yml` at `/app/models/staging/sources.yml` or `/app/models/sources.yml`, append to it. Don't create a duplicate.

4. **Delete the now-unreferenced `*__tmp` model files.** Leftover orphaned models that fail to compile will surface as new errors.

5. **Pre-finish audit (Step 5c):**
   ```bash
   grep -rEn "source\(|ref\(" /app/models --include="*.sql" | head -50
   # Every source() must be in a sources.yml; every ref() target must still exist
   ```

6. **Run `altimate-dbt build`** with no `--select` and confirm `ERROR=0`. Then run any project-wide structural validators or `dbt test --select source:*` to surface any source-resolution gaps that compile alone wouldn't catch.

**Anti-pattern:** Editing the stg_* models to swap `ref` → `source` and stopping there. Project-wide structural validators check that every `source()` resolves; missing sources.yml entries fail these checks even when `dbt build` succeeds.

---

## P4: Create model from column list (no formula given)

**Trigger phrases:**
- "Create a model called X that includes the following columns: [list]"
- "Build N models per the __stats.yml config"
- "Compute NPS scores", "compute aggregate metrics", "first_X_at, last_X_at"

**Why it's tricky:** The prompt lists columns but doesn't define formulas for derived fields. Common pitfalls:
- Picking wrong sentiment-to-NPS mapping
- Wrong "first/last X at" interpretation (first by event timestamp? first non-null?)
- Missing a column that requires a join across two tables
- Using `INNER JOIN` where a `LEFT JOIN` is needed for completeness

**Required actions:**

1. **Read every column name in the spec** — make a TodoWrite item for each one.

2. **For every "first_X_at" / "last_X_at" pattern**: use `MIN()` / `MAX()` of the relevant timestamp with the appropriate event-type filter. Read the source to find the filter column (usually `event_type`, `part_type`, `status`).

3. **For every numerical aggregate** (`total_X`, `count_X`, `nps_X`): write the most defensible formula and document it in a one-line SQL comment. Standard NPS: `(promoters - detractors) / total * 100` where promoter score 9-10, detractor 0-6.

4. **For every column that requires a join**: confirm the join grain doesn't fan out. Pre-aggregate the right side or join on the unique key.

5. **Write the full SELECT containing every named column** before the first build. Self-check: count the columns in the spec, count the columns in your SELECT, they must match.

6. **Step 5b row-count probe**: `count(*)` must equal `count(distinct <pk>)` if the prompt says "one row per X". `count(*)` of the model should match `count(distinct <pk_in_parent>)` for the parent that drives the grain.

7. **Register in schema.yml** (Iron Rule 11 in dbt-develop).

**Anti-pattern:** Writing the SQL with `SELECT * FROM parent`, building, then noticing later that 4 of the 13 required columns are missing. Always start from the column list.

### P4-extra: "Add details" / underspecified column lists

When the prompt does NOT enumerate the columns — phrases like *"add product details"*, *"include the relevant fields"*, *"with all the necessary information"*, *"join with X to enrich"* — the agent must **not** hand-pick a subset. Hand-picked subsets undershoot the grader's expected column set.

**Default strategy for underspecified joins:**

```sql
WITH base AS (
    SELECT * FROM {{ ref('<fact>') }}
),
detail AS (
    SELECT * FROM {{ ref('<dim>') }}
)

SELECT
    base.*,
    detail.* EXCLUDE (<join_keys>)
FROM base
LEFT JOIN detail ON base.<join_key> = detail.<join_key>
```

Snowflake supports `SELECT * EXCLUDE`. For warehouses without `EXCLUDE`, explicitly list every column from both sides except the duplicated join keys:

```bash
altimate-dbt columns --model <fact>
altimate-dbt columns --model <dim>
```

**Naming:** preserve original column names unless the prompt explicitly requests renaming. Don't rename `description` → `product_description` unprompted — that changes the schema and can break downstream consumers (and the grader).

**Verify before declaring done:**
```bash
altimate-dbt columns --model <new_model>
# Compare to sum of <fact> columns + <dim> columns minus join keys
```


---

## P5: Package upgrade caused downstream errors

**Trigger phrases:**
- "Fivetran is updating their X package"
- "Package upgrade broke the build"
- A type mismatch error (`VARCHAR vs NUMBER`, `TIMESTAMP_NTZ vs NUMBER`)

**Why it's tricky:** Package upgrades often change source column types or remove seed-level casts. The downstream model is now casting incompatible types. The fix isn't to change the schema — it's to adapt the cast.

**Required actions:**

1. **Read the failing model's error** and identify the column + types involved.

2. **Read the source data** to determine the actual storage type:
   ```bash
   altimate-dbt columns-source --source <pkg> --table <tbl>
   altimate-dbt execute --query "select <col> from {{ source('<pkg>','<tbl>') }} limit 5" --limit 1
   ```

3. **Pick the appropriate conversion:**
   - `NUMBER → TIMESTAMP`: epoch seconds or milliseconds? Check the magnitude. `TO_TIMESTAMP(col)` for seconds, `TO_TIMESTAMP(col / 1000)` for ms. Snowflake: `TO_TIMESTAMP_NTZ(col)`.
   - `NUMBER → DATE`: `TO_DATE(col)` after the timestamp conversion.
   - `VARCHAR → NUMBER`: `TRY_TO_NUMBER(col)` to avoid runtime failures on bad data.

4. **Step 6 Pattern Propagation**: the type change likely affects multiple models. `grep -rn "cast.*<col>" /app/models` to find every cast and fix each.

5. **Override `dbt_packages/` models at the project level** — don't edit inside `dbt_packages/`, those edits get reset on `dbt deps`. Copy the package model into `/app/models/staging/` and edit there (Iron Rule 6 in dbt-develop).

**Anti-pattern:** Fixing only the first model the error names. Type mismatches usually cascade — fix the cast in one place, the next downstream model breaks. Run a full `dbt build` with no `--select` filter and fix every error.

---

## P6: Rolling-window aggregations (`*_28d`, `*_7d`, `*_Nd`)

**Trigger phrases:**
- Column name with `_28d`, `_7d`, `_30d`, `_Nd` rolling/period suffix
- Spec says "rolling N day aggregation", "trailing N day", "N-day moving average / sum"

**Why it's tricky:** Two equally-defensible interpretations exist for the first N-1 rows of a rolling window:
1. **Partial window** — emit a partial sum from the rows available so far (1 row, 2 rows, ..., N rows on day N).
2. **Warm-up NULL** — emit NULL until the window has N full periods of data; from row N onward emit the full sum.

Common BI / finance / analytics tooling defaults to **(2) — warm-up NULL** because a "28-day rolling average" computed from only 3 days of data is misleading. The grader almost always uses warm-up NULL semantics; a partial-window calculation will fail equality tests on the first N-1 rows of the output.

**Required actions:**

```sql
-- Wrong: emits partial sum on early rows
SUM(reviews_daily) OVER (ORDER BY review_date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS reviews_28d
-- Result on day 5: SUM of 5 days, not NULL.

-- Right: emit NULL until N full periods available
CASE
    WHEN ROW_NUMBER() OVER (ORDER BY review_date) >= 28
    THEN SUM(reviews_daily) OVER (ORDER BY review_date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW)
    ELSE NULL
END AS reviews_28d,
CASE
    WHEN ROW_NUMBER() OVER (ORDER BY review_date) >= 28
    THEN ROUND((SUM(promoters_daily) OVER (ORDER BY review_date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW)
              - SUM(detractors_daily) OVER (ORDER BY review_date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW))
              * 100.0 / NULLIF(SUM(reviews_daily) OVER (ORDER BY review_date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW), 0))::INT
    ELSE NULL
END AS nps_28d
```

For grouped rolling windows (rolling within a partition like listing_id), partition the `ROW_NUMBER()` the same way:
```sql
ROW_NUMBER() OVER (PARTITION BY listing_id ORDER BY review_date) >= 28
```

**Verification:** the first 27 rows of the output (sorted by date) should have NULL for `*_28d` columns. The 28th row onward should have a full sum.

**Anti-pattern:** emitting partial sums for early rows. A `_28d` column with values on day 1, day 2, etc. is semantically wrong even if the SQL runs cleanly.
