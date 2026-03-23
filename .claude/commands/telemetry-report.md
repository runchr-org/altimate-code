---
name: telemetry-report
description: "Query Azure App Insights, surface errors, create Jira tickets"
---

You are running the telemetry-report pipeline. Follow every step below in order. Do not skip steps.

Arguments: $ARGUMENTS
- If arguments contain `dry-run`: report only, do not create Jira tickets.
- If arguments contain `lookback=Xh`: replace `2h` in all KQL queries with the specified value (e.g., `lookback=4h` → `ago(4h)`). Default: `2h`.

Parse the lookback value now. If not provided, use `2h`.

---

## Step 1: Preflight

Run this smoke query to verify Azure auth AND Log Analytics workspace access:

```bash
az monitor log-analytics query --workspace "b511e30e-4b93-4093-98a5-b80fc4718111" \
  --analytics-query "AppEvents | take 1" --output json
```

If this command fails, report the exact error to the user and **STOP** — do not proceed to Step 2.

---

## Step 2: Query Log Analytics (7 queries)

Run all 7 queries using `az monitor log-analytics query --workspace "b511e30e-4b93-4093-98a5-b80fc4718111" --analytics-query "..." --output json`.

**IMPORTANT — two KQL dialects:**
- **CLI queries** (this step): use `AppEvents`, `TimeGenerated`, `Name`, `Properties`, `SessionId`
- **Jira ticket queries** (Step 5): use `customEvents`, `timestamp`, `name`, `customDimensions`, `session_Id` — these are for the App Insights portal where people will run them

Replace `2h` with the lookback value from arguments parsing.

**Q1: Core Failures (threshold: >10)**
```kql
AppEvents
| where TimeGenerated > ago(2h) and Name == "core_failure"
| extend err = tostring(Properties.error_message),
         tool = tostring(Properties.tool_name),
         err_class = tostring(Properties.error_class)
| summarize count() by err, tool, err_class
| where count_ > 10
| order by count_ desc
```

**Q2: Provider Errors (threshold: >5)**
```kql
AppEvents
| where TimeGenerated > ago(2h) and Name == "provider_error"
| extend provider = tostring(Properties.provider_id),
         model = tostring(Properties.model_id),
         err_type = tostring(Properties.error_type)
| summarize count() by provider, model, err_type
| where count_ > 5
```

**Q3: Application Errors (threshold: >5)**
```kql
AppEvents
| where TimeGenerated > ago(2h) and Name == "error"
| extend err_name = tostring(Properties.error_name),
         context = tostring(Properties.context)
| summarize count() by err_name, context
| where count_ > 5
```

**Q4: Agent Real Error Rate (threshold: >15% or >10 errors, min 5 sessions)**

IMPORTANT: Only count `outcome == "error"` as real failures. `abandoned` = user closed the session, `aborted` = user cancelled. These are user behavior, NOT bugs.

```kql
AppEvents
| where TimeGenerated > ago(2h) and Name == "agent_outcome"
| extend outcome = tostring(Properties.outcome),
         agent = tostring(Properties.agent)
| summarize total = count(),
            real_errors = countif(outcome == "error"),
            abandoned = countif(outcome == "abandoned"),
            aborted = countif(outcome == "aborted")
            by agent
| where total >= 5
| extend error_rate = round(100.0 * real_errors / total, 1)
| where error_rate > 15 or real_errors > 10
```

**Q5: Engine Errors (threshold: >2)**
```kql
AppEvents
| where TimeGenerated > ago(2h) and Name == "engine_error"
| extend phase = tostring(Properties.phase),
         err = tostring(Properties.error_message)
| summarize count() by phase, err
| where count_ > 2
```

**Q6: SQL Failures (threshold: >5)**
```kql
AppEvents
| where TimeGenerated > ago(2h) and Name == "sql_execute_failure"
| extend err = tostring(Properties.error_message),
         wh_type = tostring(Properties.warehouse_type)
| summarize count() by err, wh_type
| where count_ > 5
```

**Q7: Volume context**
```kql
AppEvents
| where TimeGenerated > ago(2h)
| summarize total_events = count(),
            machines = dcount(tostring(Properties.machine_id)),
            sessions = dcount(SessionId)
```

**IMPORTANT:** Empty results are normal and expected — they mean no issues above threshold. Report "No signals" for empty queries, not failure. Only treat non-zero exit codes as failures.

---

## Step 3: Classify — LLM noise vs code bugs

Before dedup or ticket creation, classify each result into one of two buckets:

### LLM noise (do NOT create tickets)
These are expected tool-use friction from the AI agent. They self-resolve and are not code bugs:
- `edit` tool: "Could not find oldString", "No changes to apply", "Found multiple matches", "file modified since last read"
- `write` tool: "You must read file X before overwriting"
- `read` tool: "File not found" (user-specific paths), "Offset X is out of range"
- `question` tool: "The user dismissed this question"
- `webfetch` tool: "Request failed with status code: 404"
- Permission errors: "The user rejected permission", "user has specified a rule which prevents"

Report these in a separate "LLM Noise" section of the report (counts only) but do NOT create Jira tickets for them.

### Code bugs (create tickets)
These are real issues in altimate-code that need fixing:
- "unknown error" on any tool (Python engine sidecar swallowing exceptions)
- Driver not installed errors (duckdb, bigquery, etc.)
- Connection/auth failures (Snowflake key decryption, address not in allow_list)
- Agent real error rates above threshold (after excluding abandoned/aborted)
- TelemetryBufferOverflow or other infrastructure errors

---

## Step 4: Pattern Analysis (before filing tickets)

For each code bug above threshold, run a follow-up query to understand the pattern. Do NOT file tickets based on raw counts alone.

### 4a. For "unknown error" failures — check if multiple tools share a root cause

```kql
AppEvents
| where TimeGenerated > ago(2h) and Name == "core_failure"
| extend err = tostring(Properties.error_message), tool = tostring(Properties.tool_name)
| where err == "unknown error"
| summarize count() by tool
| order by count_ desc
```

If multiple tools (e.g., sql_analyze, altimate_core_validate, altimate_core_semantics) all return "unknown error", they share a root cause (Python engine sidecar). File ONE ticket for the root cause, not separate tickets per tool.

### 4b. For agent failure rates — dig into WHY

For each agent above threshold, find the actual tool errors in those failing sessions:

```kql
AppEvents
| where TimeGenerated > ago(2h) and Name == "agent_outcome"
| extend outcome = tostring(Properties.outcome), agent = tostring(Properties.agent), session = SessionId
| where outcome == "error" and agent == "{agent_name}"
| join kind=inner (
    AppEvents
    | where TimeGenerated > ago(2h) and Name == "core_failure"
    | extend session = SessionId, tool = tostring(Properties.tool_name), err = tostring(Properties.error_message)
) on session
| summarize count() by tool, err
| order by count_ desc
| take 10
```

If the agent failures are caused by an issue that already has a ticket (e.g., Python engine sidecar), do NOT create a separate agent failure ticket. Note it in the report as "caused by {existing_ticket}".

### 4c. For connection/driver errors — group by root cause

Group related driver/connection errors into one ticket:
- All "driver not installed" errors → one ticket about missing drivers
- All connection failures → one ticket about connection config

---

## Step 5: Read Dedup Store & Classify

Read `data/telemetry/seen-issues.json`. If the file is missing or contains invalid JSON, start with `{}`.

For each **code bug** (not LLM noise) above threshold:

### 5a. Normalize the error message

Apply these transformations to produce a normalized error string:
1. Replace file paths (`/path/to/something.ext` patterns) with `<path>`
2. Replace UUIDs (8-4-4-4-12 hex) with `<uuid>`
3. Replace large numbers (>6 digits) with `<num>`
4. Collapse consecutive whitespace to a single space
5. Lowercase
6. Truncate to 80 characters

### 5b. Generate dedup key

Format: `{event_type}::{dimension}::{normalized_error}`

- Q1 rows: `core_failure::{tool}::{normalized_err}`
- Q2 rows: `provider_error::{provider}::{err_type}`
- Q3 rows: `error::{err_name}::{context}`
- Q4 rows: `agent_failure::{agent}::error_rate_{bucket}` (bucket: "high" for >30%, "moderate" for >15%)
- Q5 rows: `engine_error::{phase}::{normalized_err}`
- Q6 rows: `sql_failure::{wh_type}::{normalized_err}`

### 5c. Classify

- Key exists in store → **KNOWN**
- Key not in store → **NEW**

---

## Step 6: Report

Output a markdown report:

```
# Telemetry Report — {current ISO timestamp}

## Summary
- Lookback: {lookback_value} | Events: {total} | Machines: {N} | Sessions: {N}
- Code bugs above threshold: {N} | New: {M} | Known: {K}

## Code Bugs

| Sev | Issue | Count | Trend | Status | Jira |
|-----|-------|-------|-------|--------|------|

## LLM Noise (not actionable)

| Issue | Count |
|-------|-------|
```

**Severity:** P0 = count >100 or error rate >30% | P1 = 20-100 or 15-30% | P2 = all other

**Trend:** ↑ = >1.2× last | ↓ = <0.8× last | → = within 20% | (new) = first time

If all clear: `All clear — no code bugs above threshold in the last {lookback_value}.`

---

## Step 7: Create Jira Tickets (NEW code bugs only)

**If `dry-run`, skip this step.** Output: "Dry-run mode — skipping ticket creation."

**Cap: maximum 5 tickets per run.** Prioritize: P0 first, then count descending.

**CRITICAL: Consolidate root causes.** If multiple issues share a root cause (e.g., all "unknown error" tools → Python engine sidecar), create ONE ticket for the root cause. Do not file separate symptom tickets.

### 7a. JQL backstop search

Use `mcp__atlassian__searchJiraIssuesUsingJql` with:
- `cloudId`: `ae6de7ce-ca58-46e8-b583-1468bf597470`
- `jql`: `project = AI AND labels = "altimate-code" AND summary ~ "{event_type}: {short_desc}" AND status != Done AND created >= -30d`
- `maxResults`: `1`

If found: treat as KNOWN, record ticket ID, skip creation.

### 7b. Create ticket

Use `mcp__atlassian__createJiraIssue` with:
- `cloudId`: `ae6de7ce-ca58-46e8-b583-1468bf597470`
- `projectKey`: `AI`
- `issueTypeName`: `Bug` (use `Task` for agent_outcome issues)
- `summary`: `[altimate-code] {root_cause_description}` (max 100 chars)
- `contentFormat`: `markdown`
- `additional_fields`: `{ "labels": ["altimate-code", "telemetry-auto"] }`

**Description template — include raw log queries, not just counts:**

```
## Telemetry Alert

**Severity:** {P0/P1/P2}
**Impact ({lookback}):** {count} failures across {N} machines, {M} sessions
**Root cause:** {description of the actual problem, not just "X errors occurred"}

### Affected tools / components
{table of tools and counts}

### Downstream impact
{e.g., "Drives 7.4% real error rate for builder agent"}

### Recommended fix
{actionable suggestions}

## KQL Queries (run in App Insights > Logs)

**Browse actual error logs:**
\`\`\`kql
customEvents
| where timestamp > ago({lookback}) and name == "{event_name}"
| extend err = tostring(customDimensions.error_message),
         tool = tostring(customDimensions.tool_name),
         input = tostring(customDimensions.masked_args),
         cli_version = tostring(customDimensions.cli_version),
         machine = tostring(customDimensions.machine_id)
| where {filter_condition}
| project timestamp, session_Id, tool, err, input, cli_version, machine
| order by timestamp desc
| take 50
\`\`\`

**Full session timeline (paste a session_Id from above):**
\`\`\`kql
customEvents
| where session_Id == "<paste_session_id_here>"
| extend tool = tostring(customDimensions.tool_name),
         err = tostring(customDimensions.error_message),
         outcome = tostring(customDimensions.outcome)
| project timestamp, name, tool, err, outcome
| order by timestamp asc
\`\`\`

---
Auto-generated by /telemetry-report
```

**IMPORTANT:** Jira KQL queries MUST use `customEvents`, `timestamp`, `name`, `customDimensions`, `session_Id` — NOT `AppEvents`/`Properties`/`TimeGenerated`. People run these in the App Insights portal, not the CLI.

**If Atlassian MCP is not available**, output the report with a warning: "Jira MCP not connected — ticket creation skipped."

---

## Step 8: Update Dedup Store

Ensure the directory exists: `mkdir -p data/telemetry`

Write updated `data/telemetry/seen-issues.json`:
- **NEW entries**: add with `jira_ticket`, `first_seen`, `last_count`, `last_checked`
- **KNOWN entries**: update `last_count` and `last_checked`
- **30-day cleanup**: remove entries where `last_checked` > 30 days ago

```json
{
  "dedup_key_here": {
    "jira_ticket": "AI-6000",
    "first_seen": "2026-03-20T00:00:00Z",
    "last_count": 512,
    "last_checked": "2026-03-20T02:00:00Z"
  }
}
```

Write with 2-space indented JSON.

---

## Done

Output:
- Total code bugs / tickets created / known updated
- LLM noise summary (total count, not actionable)
- Reminder: `/loop 2h /telemetry-report`
