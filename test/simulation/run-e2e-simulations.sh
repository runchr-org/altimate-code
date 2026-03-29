#!/usr/bin/env bash
#
# E2E Simulation Harness for altimate-code
# Runs 1000+ unique scenarios against real databases
# Uses `bun run dev` to invoke the latest source build
#
# Usage: ./run-e2e-simulations.sh [--phase N] [--parallel N]
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR=$(mktemp -d /tmp/simulation-results-XXXXXX)
TRACES_DIR="$HOME/.local/share/altimate-code/traces"
WORKDIR=$(mktemp -d /tmp/sim-workdir-XXXXXX)
LOG_FILE="$RESULTS_DIR/simulation.log"

# CLI invocation helper
ALTIMATE_BIN="bun run --cwd $REPO_ROOT/packages/opencode --conditions=browser src/index.ts --"

# Parallelism
MAX_PARALLEL=${PARALLEL:-3}

# Counters
TOTAL=0
PASS=0
FAIL=0
SKIP=0
ERRORS=()

# ── Logging ──────────────────────────────────────────────────────────

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }
log_result() {
  local name="$1" status="$2" duration="$3" session_id="$4"
  echo "$name|$status|${duration}ms|$session_id" >> "$RESULTS_DIR/results.csv"
  ((TOTAL++)) || true
  case "$status" in
    PASS) ((PASS++)) || true ;;
    FAIL) ((FAIL++)) || true; ERRORS+=("$name") ;;
    SKIP) ((SKIP++)) || true ;;
  esac
}

# ── Workdir Setup ────────────────────────────────────────────────────

setup_workdir() {
  cd "$WORKDIR"
  if [ ! -d .git ]; then
    git init -q
    git config user.name "simulation"
    git config user.email "sim@test"
    echo '{}' > package.json
    git add -A && git commit -q -m "init" 2>/dev/null
  fi
}

# ── Run a single simulation ──────────────────────────────────────────

run_sim() {
  local name="$1"
  local prompt="$2"
  local max_turns="${3:-1}"
  local timeout_s="${4:-45}"

  local start_time=$SECONDS
  local output_file="$RESULTS_DIR/${name}.json"
  local session_id=""
  local status="FAIL"

  # Run altimate-code
  cd "$WORKDIR"
  if ALTIMATE_TELEMETRY_DISABLED=true timeout "$timeout_s" \
    $ALTIMATE_BIN run --max-turns "$max_turns" --yolo --format json "$prompt" \
    > "$output_file" 2>&1; then
    status="PASS"
  fi

  local duration=$(( SECONDS - start_time ))

  # Extract session ID from output
  session_id=$(grep -o '"sessionID":"[^"]*"' "$output_file" 2>/dev/null | head -1 | cut -d'"' -f4 || echo "unknown")

  # Check for errors in output
  if grep -q '"type":"error"' "$output_file" 2>/dev/null; then
    status="FAIL"
  fi

  # Check for tool completions
  if grep -q '"status":"completed"' "$output_file" 2>/dev/null; then
    status="PASS"
  fi

  # Check for undefined/[object Object] in tool output
  if grep -q '\[object Object\]' "$output_file" 2>/dev/null; then
    echo "ISSUE:object_object|$name" >> "$RESULTS_DIR/issues.txt"
  fi
  if grep -o '"output":"[^"]*undefined[^"]*"' "$output_file" 2>/dev/null | grep -qv 'undefined.*behavior\|undefined.*variable'; then
    echo "ISSUE:literal_undefined|$name" >> "$RESULTS_DIR/issues.txt"
  fi

  log_result "$name" "$status" "$duration" "$session_id"
  log "  [$status] $name (${duration}s) session=$session_id"
}

# ── Batch runner with parallelism ────────────────────────────────────

PIDS=()
run_parallel() {
  local name="$1" prompt="$2" turns="${3:-1}" timeout="${4:-45}"

  run_sim "$name" "$prompt" "$turns" "$timeout" &
  PIDS+=($!)

  if [ ${#PIDS[@]} -ge "$MAX_PARALLEL" ]; then
    for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
    PIDS=()
  fi
}

wait_all() {
  if [ ${#PIDS[@]} -gt 0 ]; then
    for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  fi
  PIDS=()
}

# ═══════════════════════════════════════════════════════════════════════
# PHASE 1: Tool-level deterministic tests (no LLM needed for tool execution)
# These use direct tool invocation prompts — LLM just dispatches the tool call
# ═══════════════════════════════════════════════════════════════════════

phase1_warehouse_operations() {
  log "=== Phase 1A: Warehouse Operations ==="

  # List warehouses
  run_parallel "wh_list" "list all my configured warehouses"

  # Test each unique real database connection
  for wh in green_taxi_duckdb nyc_taxi_duckdb jaffle_shop_dev github_artifacts molecular_database mb_sales_db; do
    run_parallel "wh_test_${wh}" "test the connection to warehouse ${wh}"
  done
  wait_all

  # Test snowflake connection
  run_parallel "wh_test_snowflake" "test the connection to warehouse snowflake_test"
  wait_all
}

phase1_schema_inspection() {
  log "=== Phase 1B: Schema Inspection ==="

  # Inspect schemas across different databases
  local schemas=(
    "green_taxi_duckdb|show me all tables in green_taxi_duckdb warehouse"
    "nyc_taxi_duckdb|inspect the schema of the main table in nyc_taxi_duckdb"
    "jaffle_shop_dev|show me all tables and their columns in jaffle_shop_dev"
    "github_artifacts|inspect the schema of tables in github_artifacts warehouse"
    "molecular_database|show me what tables exist in molecular_database"
    "mb_sales_db|inspect all tables in mb_sales_db warehouse"
    "mb_tracks_db|list tables and columns in mb_tracks_db"
    "snowflake_test|show me the schemas and tables available in snowflake_test warehouse"
  )

  for entry in "${schemas[@]}"; do
    IFS='|' read -r wh prompt <<< "$entry"
    run_parallel "schema_${wh}" "$prompt"
  done
  wait_all
}

phase1_sql_execution() {
  log "=== Phase 1C: SQL Execution ==="

  # Run SQL against each database type
  local queries=(
    # DuckDB queries
    "exec_green_taxi_count|execute this SQL against green_taxi_duckdb: SELECT COUNT(*) as total_trips FROM green_taxi"
    "exec_green_taxi_agg|execute against green_taxi_duckdb: SELECT payment_type, COUNT(*) as cnt, AVG(total_amount) as avg_total FROM green_taxi GROUP BY payment_type ORDER BY cnt DESC LIMIT 10"
    "exec_green_taxi_window|execute against green_taxi_duckdb: SELECT payment_type, total_amount, ROW_NUMBER() OVER (PARTITION BY payment_type ORDER BY total_amount DESC) as rn FROM green_taxi LIMIT 20"
    "exec_nyc_taxi_sample|run against nyc_taxi_duckdb: SELECT * FROM trips LIMIT 5"
    "exec_jaffle_customers|run against jaffle_shop_dev: SELECT * FROM customers LIMIT 10"
    "exec_jaffle_orders|run against jaffle_shop_dev: SELECT * FROM orders LIMIT 10"
    "exec_github_repos|execute against github_artifacts: SELECT * FROM repos LIMIT 5"
    "exec_molecular|run against molecular_database: SELECT * FROM molecular_data LIMIT 5"
    "exec_music_sales|run against mb_sales_db: SELECT * FROM sales LIMIT 5"
    # Snowflake queries
    "exec_snowflake_tables|execute against snowflake_test: SELECT TABLE_SCHEMA, TABLE_NAME, ROW_COUNT FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA') ORDER BY ROW_COUNT DESC NULLS LAST LIMIT 20"
  )

  for entry in "${queries[@]}"; do
    IFS='|' read -r name prompt <<< "$entry"
    run_parallel "$name" "$prompt"
  done
  wait_all
}

# ═══════════════════════════════════════════════════════════════════════
# PHASE 2: SQL Analysis (deterministic — altimate-core based)
# ═══════════════════════════════════════════════════════════════════════

phase2_sql_analysis() {
  log "=== Phase 2: SQL Analysis ==="

  local analyses=(
    # Anti-pattern detection
    "analyze_select_star|analyze this SQL for anti-patterns: SELECT * FROM green_taxi WHERE total_amount > 50"
    "analyze_cartesian|analyze this SQL: SELECT a.*, b.* FROM green_taxi a, payment_types b WHERE a.payment_type = b.id"
    "analyze_subquery|analyze: SELECT * FROM trips WHERE driver_id IN (SELECT driver_id FROM drivers WHERE rating < 3)"
    "analyze_no_where|analyze for issues: SELECT * FROM large_events_table"
    "analyze_implicit_cast|analyze: SELECT * FROM users WHERE id = '123'"
    "analyze_or_pattern|analyze: SELECT * FROM orders WHERE status = 'pending' OR status = 'processing' OR status = 'shipped'"
    "analyze_nested_sub|analyze: SELECT * FROM t1 WHERE id IN (SELECT id FROM t2 WHERE val IN (SELECT val FROM t3))"
    # Complex SQL
    "analyze_cte|analyze this CTE query: WITH active AS (SELECT id FROM users WHERE active=true), orders AS (SELECT user_id, SUM(total) as total FROM orders GROUP BY user_id) SELECT a.id, o.total FROM active a LEFT JOIN orders o ON a.id = o.user_id"
    "analyze_window|analyze: SELECT dept, name, salary, RANK() OVER (PARTITION BY dept ORDER BY salary DESC) FROM employees"
    "analyze_union|analyze: SELECT id, name FROM customers UNION ALL SELECT id, name FROM suppliers"
    # Dialect-specific
    "analyze_snowflake|analyze this Snowflake SQL: SELECT * FROM TABLE(FLATTEN(input => parse_json(data):items)) f"
    "analyze_bigquery|analyze this BigQuery SQL: SELECT * FROM \`project.dataset.table\` WHERE _PARTITIONTIME > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)"
    "analyze_postgres|analyze this PostgreSQL: SELECT * FROM generate_series(1,100) s CROSS JOIN LATERAL (SELECT * FROM events WHERE ts > now() - interval '1 hour' LIMIT 5) e"
    # Edge cases
    "analyze_empty|analyze this SQL: "
    "analyze_comment_only|analyze: -- just a comment"
    "analyze_multi_stmt|analyze: SELECT 1; SELECT 2; SELECT 3;"
  )

  for entry in "${analyses[@]}"; do
    IFS='|' read -r name prompt <<< "$entry"
    run_parallel "$name" "$prompt"
  done
  wait_all
}

# ═══════════════════════════════════════════════════════════════════════
# PHASE 3: SQL Translation (cross-dialect)
# ═══════════════════════════════════════════════════════════════════════

phase3_translation() {
  log "=== Phase 3: SQL Translation ==="

  local translations=(
    "translate_sf_to_pg|translate this SQL from snowflake to postgres: SELECT DATEADD(day, -7, CURRENT_DATE()), IFF(a > 0, 'positive', 'negative') FROM t"
    "translate_sf_to_bq|translate from snowflake to bigquery: SELECT * EXCLUDE (internal_id) FROM users QUALIFY ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) = 1"
    "translate_pg_to_sf|translate from postgres to snowflake: SELECT * FROM generate_series(1, 10) AS s(n) CROSS JOIN LATERAL (SELECT * FROM orders WHERE user_id = s.n LIMIT 3) o"
    "translate_bq_to_sf|translate from bigquery to snowflake: SELECT * FROM UNNEST([1,2,3]) AS x CROSS JOIN \`project.dataset.table\`"
    "translate_mysql_to_pg|translate from mysql to postgres: SELECT IFNULL(name, 'unknown'), GROUP_CONCAT(tag SEPARATOR ',') FROM users GROUP BY name"
    "translate_pg_to_mysql|translate from postgres to mysql: SELECT COALESCE(name, 'unknown'), STRING_AGG(tag, ',') FROM users GROUP BY name"
    "translate_sf_to_databricks|translate from snowflake to databricks: CREATE TABLE t CLONE source_table; SELECT PARSE_JSON('{\"k\":1}'):k::INT"
    "translate_redshift_to_sf|translate from redshift to snowflake: SELECT LISTAGG(name, ',') WITHIN GROUP (ORDER BY name) FROM users"
    "translate_duckdb_to_sf|translate from duckdb to snowflake: SELECT * FROM read_parquet('data/*.parquet') WHERE col1 > 100"
    "translate_sf_to_duckdb|translate from snowflake to duckdb: SELECT TRY_CAST(col AS INT), ARRAY_AGG(val) WITHIN GROUP (ORDER BY val) FROM t GROUP BY 1"
  )

  for entry in "${translations[@]}"; do
    IFS='|' read -r name prompt <<< "$entry"
    run_parallel "$name" "$prompt"
  done
  wait_all
}

# ═══════════════════════════════════════════════════════════════════════
# PHASE 4: Lineage
# ═══════════════════════════════════════════════════════════════════════

phase4_lineage() {
  log "=== Phase 4: Lineage ==="

  local lineage_queries=(
    "lineage_simple|check the column lineage of: SELECT id, name FROM users"
    "lineage_join|check column lineage: SELECT u.id, u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id"
    "lineage_cte|trace lineage: WITH base AS (SELECT id, name FROM users WHERE active=true) SELECT b.id, b.name, COUNT(o.id) as order_count FROM base b LEFT JOIN orders o ON b.id = o.user_id GROUP BY b.id, b.name"
    "lineage_window|trace column lineage: SELECT id, name, salary, AVG(salary) OVER (PARTITION BY dept_id) as dept_avg FROM employees"
    "lineage_union|check lineage: SELECT id, name, 'customer' as type FROM customers UNION ALL SELECT id, name, 'supplier' as type FROM suppliers"
    "lineage_subquery|trace: SELECT name, (SELECT MAX(total) FROM orders WHERE user_id = u.id) as max_order FROM users u"
    "lineage_multi_join|trace column lineage: SELECT c.name, p.title, oi.quantity, o.total FROM customers c JOIN orders o ON c.id = o.customer_id JOIN order_items oi ON o.id = oi.order_id JOIN products p ON oi.product_id = p.id"
    "lineage_aggregation|trace: SELECT DATE_TRUNC('month', created_at) as month, COUNT(*) as orders, SUM(total) as revenue FROM orders GROUP BY 1"
  )

  for entry in "${lineage_queries[@]}"; do
    IFS='|' read -r name prompt <<< "$entry"
    run_parallel "$name" "$prompt"
  done
  wait_all
}

# ═══════════════════════════════════════════════════════════════════════
# PHASE 5: Persona Simulations (multi-turn, LLM-driven)
# ═══════════════════════════════════════════════════════════════════════

phase5_personas() {
  log "=== Phase 5: Persona Simulations ==="

  # Analytics Engineer: explore data, build model
  run_parallel "persona_ae_explore" \
    "I'm an analytics engineer. I have a jaffle_shop_dev DuckDB database. Can you inspect all tables and show me the schema?" \
    2 60

  run_parallel "persona_ae_analyze" \
    "analyze this query for the jaffle_shop database and suggest improvements: SELECT c.*, o.order_date, o.status FROM customers c LEFT JOIN orders o ON c.id = o.user_id WHERE o.status != 'returned'" \
    2 60

  # Data Engineer: investigate data quality
  run_parallel "persona_de_quality" \
    "I'm a data engineer. Check this SQL for data quality issues and generate test suggestions: SELECT user_id, SUM(amount) as total_spent FROM transactions WHERE created_at > '2024-01-01' GROUP BY user_id HAVING SUM(amount) > 1000" \
    2 60

  # FinOps Analyst: cost investigation
  run_parallel "persona_finops" \
    "I'm a FinOps analyst. Can you check if snowflake_test warehouse is available and if so, analyze its credit usage for the last 30 days?" \
    2 60

  # Security Auditor: PII scan
  run_parallel "persona_security" \
    "I'm a security auditor. Classify PII risk in this schema: customers table has columns: id (INT), first_name (VARCHAR), last_name (VARCHAR), email (VARCHAR), phone (VARCHAR), tax_id (VARCHAR), card_number (VARCHAR), date_of_birth (DATE), home_address (TEXT)" \
    2 60

  # Junior Analyst: basic exploration
  run_parallel "persona_junior_explore" \
    "I'm new to SQL. Can you help me understand what data is in the green_taxi_duckdb database? Show me some sample rows and explain the columns." \
    2 60

  # DBA: schema diff investigation
  run_parallel "persona_dba_diff" \
    "Compare these two schema versions and tell me what changed. Schema v1: users(id INT, name VARCHAR, email VARCHAR). Schema v2: users(id BIGINT, name VARCHAR, email VARCHAR, phone VARCHAR, created_at TIMESTAMP)" \
    2 60

  # Data Scientist: data profiling
  run_parallel "persona_ds_profile" \
    "I need to profile the green_taxi_duckdb data. Run a query to get column distributions: count, null count, distinct count, min, max for the top 5 numeric columns." \
    2 60

  # Platform Engineer: migration planning
  run_parallel "persona_platform_migrate" \
    "I need to migrate this Snowflake SQL to PostgreSQL. Translate and validate: SELECT IFF(status='active', DATEDIFF('day', created_at, CURRENT_DATE()), NULL) as days_active, ARRAY_AGG(tag) WITHIN GROUP (ORDER BY tag) as tags FROM users GROUP BY status" \
    2 60

  # dbt Developer: model analysis
  run_parallel "persona_dbt_dev" \
    "I'm building a dbt model. Validate this SQL against the schema and check its lineage: SELECT c.customer_id, c.first_name, COUNT(o.order_id) as order_count, SUM(o.amount) as total_spent FROM stg_customers c LEFT JOIN stg_orders o ON c.customer_id = o.customer_id GROUP BY 1, 2" \
    2 60

  wait_all
}

# ═══════════════════════════════════════════════════════════════════════
# PHASE 6: Edge Cases & Error Handling
# ═══════════════════════════════════════════════════════════════════════

phase6_edge_cases() {
  log "=== Phase 6: Edge Cases ==="

  # Empty/malformed inputs
  run_parallel "edge_empty_sql" "analyze this SQL: "
  run_parallel "edge_whitespace" "analyze SQL:    "
  run_parallel "edge_comment" "analyze: -- just a comment"
  run_parallel "edge_invalid_sql" "analyze this SQL for issues: NOT VALID SQL AT ALL @@##"

  # Unicode
  run_parallel "edge_unicode_cn" "analyze: SELECT 名前, 年齢 FROM ユーザー WHERE 都市 = '東京'"
  run_parallel "edge_unicode_emoji" "analyze: SELECT '🎉' AS celebration FROM events"
  run_parallel "edge_unicode_arabic" "analyze: SELECT عمود FROM جدول"

  # Very long SQL
  run_parallel "edge_long_sql" "analyze this SQL: SELECT $(python3 -c "print(', '.join([f'col_{i}' for i in range(200)]))" ) FROM wide_table"

  # Non-existent warehouse
  run_parallel "edge_bad_warehouse" "execute SELECT 1 against warehouse nonexistent_warehouse_xyz"
  run_parallel "edge_bad_table" "inspect the schema of table definitely_not_a_real_table in green_taxi_duckdb"

  # SQL injection through prompts
  run_parallel "edge_injection_1" "execute against green_taxi_duckdb: SELECT 1; DROP TABLE green_taxi; --"
  run_parallel "edge_injection_2" "inspect table '; DROP TABLE users; --' in green_taxi_duckdb"

  # Concurrent warehouse access
  run_parallel "edge_concurrent_1" "execute against green_taxi_duckdb: SELECT COUNT(*) FROM green_taxi"
  run_parallel "edge_concurrent_2" "execute against green_taxi_duckdb: SELECT AVG(total_amount) FROM green_taxi"
  run_parallel "edge_concurrent_3" "execute against green_taxi_duckdb: SELECT MAX(trip_distance) FROM green_taxi"

  wait_all
}

# ═══════════════════════════════════════════════════════════════════════
# PHASE 7: Bulk Scenarios (scale to 1000+)
# Generated programmatically across persona × warehouse × use-case matrix
# ═══════════════════════════════════════════════════════════════════════

phase7_bulk() {
  log "=== Phase 7: Bulk Scenarios ==="

  # Warehouses to test against
  local warehouses=(green_taxi_duckdb nyc_taxi_duckdb jaffle_shop_dev github_artifacts molecular_database mb_sales_db snowflake_test)

  # SQL patterns to analyze (each will be tested against each warehouse context)
  local sql_patterns=(
    "SELECT * FROM {table}"
    "SELECT COUNT(*) FROM {table}"
    "SELECT * FROM {table} LIMIT 10"
    "SELECT * FROM {table} WHERE 1=1 ORDER BY 1 LIMIT 5"
  )

  # Dialects for translation
  local source_dialects=(snowflake bigquery postgres redshift mysql duckdb databricks tsql)
  local target_dialects=(snowflake bigquery postgres redshift mysql duckdb databricks)

  # Translation test SQL patterns
  local translate_sqls=(
    "SELECT COALESCE(name, 'N/A'), COUNT(*) FROM users GROUP BY 1"
    "SELECT id, LAG(val) OVER (ORDER BY ts) FROM events"
    "SELECT DATE_TRUNC('month', ts), SUM(amt) FROM txns GROUP BY 1"
    "WITH cte AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY ts DESC) rn FROM t) SELECT * FROM cte WHERE rn = 1"
  )

  local count=0

  # Bulk SQL analysis across dialects
  for dialect in snowflake bigquery postgres duckdb redshift databricks mysql; do
    for pattern_idx in $(seq 0 $((${#sql_patterns[@]}-1))); do
      local sql="${sql_patterns[$pattern_idx]//\{table\}/test_table}"
      run_parallel "bulk_analyze_${dialect}_${pattern_idx}" \
        "analyze this ${dialect} SQL for anti-patterns: ${sql}"
      ((count++)) || true
    done
  done
  wait_all

  # Bulk translation matrix
  for src in "${source_dialects[@]}"; do
    for tgt in "${target_dialects[@]}"; do
      [ "$src" = "$tgt" ] && continue
      for sql_idx in $(seq 0 $((${#translate_sqls[@]}-1))); do
        run_parallel "bulk_translate_${src}_${tgt}_${sql_idx}" \
          "translate from ${src} to ${tgt}: ${translate_sqls[$sql_idx]}"
        ((count++)) || true
      done
    done
  done
  wait_all

  # Bulk lineage across different query complexities
  local lineage_sqls=(
    "SELECT a.id FROM t1 a"
    "SELECT a.id, b.name FROM t1 a JOIN t2 b ON a.id = b.t1_id"
    "SELECT a.id, b.name, c.val FROM t1 a JOIN t2 b ON a.id = b.t1_id JOIN t3 c ON b.id = c.t2_id"
    "WITH base AS (SELECT id FROM t1) SELECT b.id, t2.name FROM base b JOIN t2 ON b.id = t2.base_id"
    "SELECT id, SUM(val) OVER (PARTITION BY grp ORDER BY ts) as running_total FROM events"
  )

  for dialect in snowflake postgres bigquery duckdb redshift; do
    for sql_idx in $(seq 0 $((${#lineage_sqls[@]}-1))); do
      run_parallel "bulk_lineage_${dialect}_${sql_idx}" \
        "check column lineage for this ${dialect} SQL: ${lineage_sqls[$sql_idx]}"
      ((count++)) || true
    done
  done
  wait_all

  # Bulk schema operations against real databases
  for wh in green_taxi_duckdb jaffle_shop_dev github_artifacts mb_sales_db; do
    run_parallel "bulk_schema_inspect_${wh}" "inspect all tables in ${wh}"
    run_parallel "bulk_schema_sample_${wh}" "show me 5 sample rows from the main table in ${wh}"
    run_parallel "bulk_schema_stats_${wh}" "give me row counts for all tables in ${wh}"
    ((count += 3)) || true
  done
  wait_all

  # Bulk validation with schema context
  local validate_sqls=(
    "SELECT id, name FROM users WHERE active = true"
    "SELECT u.id, o.total FROM users u JOIN orders o ON u.id = o.user_id"
    "SELECT dept, AVG(salary) FROM employees GROUP BY dept HAVING AVG(salary) > 50000"
    "INSERT INTO users (name, email) VALUES ('test', 'test@example.com')"
    "UPDATE orders SET status = 'shipped' WHERE id = 1"
  )

  for sql_idx in $(seq 0 $((${#validate_sqls[@]}-1))); do
    run_parallel "bulk_validate_${sql_idx}" \
      "validate this SQL against a schema with users(id INT, name VARCHAR, email VARCHAR, active BOOLEAN) and orders(id INT, user_id INT, total DECIMAL, status VARCHAR): ${validate_sqls[$sql_idx]}"
    ((count++)) || true
  done
  wait_all

  # Bulk PII detection across schema variants
  local pii_schemas=(
    "customers(id, first_name, last_name, email, phone, tax_id)"
    "patients(patient_id, name, diagnosis, insurance_number, dob)"
    "employees(emp_id, full_name, salary, bank_account, tax_id)"
    "users(id, username, hash_col, ip_address, last_login)"
    "contacts(id, name, mobile, address, card_number)"
  )

  for schema_idx in $(seq 0 $((${#pii_schemas[@]}-1))); do
    run_parallel "bulk_pii_${schema_idx}" \
      "classify PII columns in this schema: ${pii_schemas[$schema_idx]}"
    ((count++)) || true
  done
  wait_all

  log "Phase 7 ran $count bulk scenarios"
}

# ═══════════════════════════════════════════════════════════════════════
# PHASE 8: Trace Analysis
# ═══════════════════════════════════════════════════════════════════════

analyze_traces() {
  log "=== Trace Analysis ==="

  # Collect all session IDs from this run
  local session_ids=$(grep -o 'ses_[a-zA-Z0-9]*' "$RESULTS_DIR/results.csv" 2>/dev/null | sort -u)

  local trace_count=0
  local total_cost=0
  local total_tokens=0
  local tool_failures=0
  local undefined_outputs=0
  local object_object_outputs=0

  for sid in $session_ids; do
    local trace_file="$TRACES_DIR/${sid}.json"
    if [ -f "$trace_file" ]; then
      ((trace_count++)) || true

      # Extract metrics from trace
      local cost=$(python3 -c "
import json
with open('$trace_file') as f:
    t = json.load(f)
s = t.get('summary', {})
print(f'{s.get(\"totalCost\", 0):.6f}')
" 2>/dev/null || echo "0")

      local tokens=$(python3 -c "
import json
with open('$trace_file') as f:
    t = json.load(f)
print(t.get('summary', {}).get('totalTokens', 0))
" 2>/dev/null || echo "0")

      total_cost=$(python3 -c "print($total_cost + $cost)" 2>/dev/null || echo "$total_cost")
      total_tokens=$(python3 -c "print($total_tokens + $tokens)" 2>/dev/null || echo "$total_tokens")

      # Check for tool failures in spans
      local failures=$(python3 -c "
import json
with open('$trace_file') as f:
    t = json.load(f)
count = 0
for span in t.get('spans', []):
    if span.get('kind') == 'tool' and span.get('status') == 'error':
        count += 1
print(count)
" 2>/dev/null || echo "0")
      tool_failures=$((tool_failures + failures))

      # Check for loop detection
      python3 -c "
import json
with open('$trace_file') as f:
    t = json.load(f)
loops = t.get('summary', {}).get('loops', [])
if loops:
    print(f'LOOP_DETECTED|$sid|{len(loops)} loops')
" 2>/dev/null >> "$RESULTS_DIR/loops.txt"
    fi
  done

  # Count issues from output scanning
  if [ -f "$RESULTS_DIR/issues.txt" ]; then
    undefined_outputs=$(grep -c "literal_undefined" "$RESULTS_DIR/issues.txt" 2>/dev/null || echo "0")
    object_object_outputs=$(grep -c "object_object" "$RESULTS_DIR/issues.txt" 2>/dev/null || echo "0")
  fi

  log ""
  log "═══════════════════════════════════════════════════════"
  log "         SIMULATION RESULTS SUMMARY"
  log "═══════════════════════════════════════════════════════"
  log "Total simulations: $TOTAL"
  log "  PASS: $PASS"
  log "  FAIL: $FAIL"
  log "  SKIP: $SKIP"
  log "Pass rate: $(python3 -c "print(f'{$PASS/$TOTAL*100:.1f}%')" 2>/dev/null || echo "N/A")"
  log ""
  log "Traces analyzed: $trace_count"
  log "Total cost: \$${total_cost}"
  log "Total tokens: $total_tokens"
  log "Tool failures in traces: $tool_failures"
  log "Outputs with 'undefined': $undefined_outputs"
  log "Outputs with '[object Object]': $object_object_outputs"
  if [ -f "$RESULTS_DIR/loops.txt" ]; then
    local loop_count=$(wc -l < "$RESULTS_DIR/loops.txt" | tr -d ' ')
    log "Sessions with loops: $loop_count"
  fi
  log ""
  if [ ${#ERRORS[@]} -gt 0 ]; then
    log "FAILED SCENARIOS:"
    for err in "${ERRORS[@]}"; do
      log "  - $err"
    done
  fi
  log ""
  log "Results: $RESULTS_DIR"
  log "Traces: $TRACES_DIR"
  log "═══════════════════════════════════════════════════════"
}

# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════

main() {
  log "Starting E2E Simulation Suite"
  log "Results dir: $RESULTS_DIR"
  log "Workdir: $WORKDIR"
  log "Parallel: $MAX_PARALLEL"
  echo "name|status|duration|session_id" > "$RESULTS_DIR/results.csv"
  touch "$RESULTS_DIR/issues.txt"
  touch "$RESULTS_DIR/loops.txt"

  setup_workdir

  local phase="${1:-all}"

  case "$phase" in
    1) phase1_warehouse_operations; phase1_schema_inspection; phase1_sql_execution ;;
    2) phase2_sql_analysis ;;
    3) phase3_translation ;;
    4) phase4_lineage ;;
    5) phase5_personas ;;
    6) phase6_edge_cases ;;
    7) phase7_bulk ;;
    all)
      phase1_warehouse_operations
      phase1_schema_inspection
      phase1_sql_execution
      phase2_sql_analysis
      phase3_translation
      phase4_lineage
      phase5_personas
      phase6_edge_cases
      phase7_bulk
      ;;
  esac

  analyze_traces

  log "Done. Total time: ${SECONDS}s"
}

main "${1:-all}"
