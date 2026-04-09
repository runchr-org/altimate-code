---
name: validate
description: Run the validation framework against one or more trace IDs, traces in a date range, all traces in a session, or production traces
argument-hint: <trace_id(s) | --from <datetime> --to <datetime> | --session-id <id> | --production --from <datetime> --to <datetime> [--limit N]>
allowed-tools: Bash, Read, Write
---

## Instructions

Run the validation framework using the provided input. The skill supports:
- **Single trace**: `/validate <trace_id>`
- **Date range**: `/validate --from <datetime> --to <datetime> --user-id <user_id>`
- **Session ID**: `/validate --session-id <session_id>`
- **Production**: `/validate --production --from <datetime> --to <datetime> [--limit N]` — validates production traces only (no user ID needed), with an optional limit (default 500, max 500)

---

### Step 1: Determine Input Mode and Run batch_validate.py

**If `$ARGUMENTS` is empty or blank**, read the latest trace ID from the persistent state file before proceeding:

```bash
python3 -c "
import json, pathlib
# Walk up from CWD to find the .claude directory
d = pathlib.Path.cwd()
while d != d.parent:
    candidate = d / '.claude' / 'state' / 'current_trace.json'
    if candidate.exists():
        print(json.loads(candidate.read_text())['trace_id'])
        break
    d = d.parent
"
```

Use the printed trace ID as `$ARGUMENTS` for the rest of this step.

First, resolve the project root directory and the script path:

```bash
# PROJECT_ROOT is the current working directory (the repo root containing .altimate-code/ or .claude/)
PROJECT_ROOT="$(pwd)"
VALIDATE_SCRIPT="$(find "$PROJECT_ROOT/.altimate-code/skills/validate" "$HOME/.altimate-code/skills/validate" "$PROJECT_ROOT/.claude/skills/validate" "$HOME/.claude/skills/validate" -name "batch_validate.py" 2>/dev/null | head -1)"
```

Parse `$ARGUMENTS` to determine the mode and construct the command:
- If it contains `--production` → production mode: `uv run --with requests python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --production --from-time "<from>" --to-time "<to>" --limit <limit>`
  - Extract `--from` and `--to` values from `$ARGUMENTS`. If `--limit` is not specified, omit it (defaults to 500).
- If it contains `--session-id` → session mode: `uv run --with requests python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --session-id "<session_id>"`
- If it contains `--from` → date range mode: `uv run --with requests python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --from-time "<from>" --to-time "<to>" --user-id "<user_id>"`
- Otherwise → single trace ID: `uv run --with requests python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" --trace-ids "$ARGUMENTS"`

Run the command using the Bash tool with `timeout: 28800000` (milliseconds) to allow up to ~8 hours for long-running validations:

```bash
uv run --with requests python "$VALIDATE_SCRIPT" --project-root "$PROJECT_ROOT" <appropriate_args>
```

**IMPORTANT**: Always pass `timeout: 28800000` to the Bash tool when running this command. The default 2-minute bash timeout is too short for validation jobs.

The script will:
- Call the Altimate backend directly
- Stream results via SSE as each trace completes
- Create a report folder `logs/batch_validation_<timestamp>/`
- Write raw JSON results to `logs/batch_validation_<timestamp>/batch_validation_<timestamp>.json`
- Output JSON to stdout

**IMPORTANT**: The stdout output may be very large. Read the output carefully. The JSON structure is:
```json
{
  "total_traces": N,
  "results": [
    {
      "trace_id": "...",
      "status_code": 200,
      "result": {
        "trace_id": "...",
        "status": "success",
        "error_count": 0,
        "observation_count": N,
        "elapsed_seconds": N,
        "criteria_results": {
          "Groundedness": {
            "text_response": "...",
            "node_status": "...",
            "node_score": N,
            "failed_count": N,
            "claim_count": N,
            "claims_psv": "claim_id|claim_text|source_tool_id_reference|input_data|claim_amount|claim_unit|input_claim_conversion_statement|input_transformation_type|status|calculated_claim|error_in_claim|reason\n1|...|...|...|...|...|...|...|SUCCESS|...|...|...\n2|...",
            "input_tokens": ...,
            "output_tokens": ...,
            "total_tokens": ...,
            "model_name": "..."
          },
          "Validity": {"text_response": "...", "node_status": "...", "node_score": N, ...},
          "Coherence": {"text_response": "...", "node_status": "...", "node_score": N, ...},
          "Utility": {"text_response": "...", "node_status": "...", "node_score": N, ...},
          "Tool Validation": {"text_response": "...", "node_status": "...", "node_score": N, ...}
        }
      }
    }
  ],
  "log_file": "logs/batch_validation_...",
  "report_dir": "logs/batch_validation_<timestamp>"
}
```

**Groundedness `claims_psv` format** — pipe-separated values with 12 columns:

| Column | Name | Description |
|---|---|---|
| 1 | `claim_id` | Unique claim identifier |
| 2 | `claim_text` | The actual claim statement |
| 3 | `source_tool_id_reference` | Tool ID that provided source data |
| 4 | `input_data` | Raw data from tool (JSON list) |
| 5 | `claim_amount` | The claimed value |
| 6 | `claim_unit` | Unit of the claim |
| 7 | `input_claim_conversion_statement` | Python formula used to validate |
| 8 | `input_transformation_type` | Type: mathematical, string_match, or range_match |
| 9 | `status` | Final result: SUCCESS or FAILURE |
| 10 | `calculated_claim` | Computed value from formula |
| 11 | `error_in_claim` | Relative error percentage |
| 12 | `reason` | Human-readable explanation of the result |

**Note:** Semantic matching and reason generation are handled server-side. The `status` and `reason` fields in `claims_psv` already reflect deterministic validation, semantic re-evaluation, and reason generation. No client-side post-processing is needed.

---

### Step 2: Write Per-Trace Results to File

For EACH trace, write the results **directly to a markdown file** inside the report directory. Do NOT print the full trace details to the terminal. Read `report_dir` from the batch_validate.py JSON output. Use the trace index (1-based) and first 12 characters of the trace ID for the filename.

Parse the `claims_psv` string by splitting on newlines (skip the header row) and then splitting each row on `|` to extract the 12 fields.

The file content must follow this format:

```
## Trace: `<trace_id>`

### Criteria Summary Table

| Criteria | Status | Score |
|---|---|---|
| **Groundedness** | <node_status> | <node_score>/5 |
| **Validity** | <node_status> | <node_score>/5 |
| **Coherence** | <node_status> | <node_score>/5 |
| **Utility** | <node_status> | <node_score>/5 |
| **Tool Validation** | <node_status> | <node_score>/5 |

P.S. **Consider 'RIGHT NODE' as 'SUCCESS' and 'WRONG NODE' as 'FAILURE' IF PRESENT.**

### Per-Criteria Node Results

For **Validity**, **Coherence**, and **Utility**, show a node-level breakdown table:

| Node | Score | Status |
|---|---|---|
| <node_name> | <score> | <status> |

### Individual Criteria Results

#### Groundedness

<text_response summary from the server>

ALL claims table (parsed from `claims_psv`):

| # | Claim Text | Source Tool ID | Input Data | Claimed | Unit | Conversion Statement | Type | Calculated | Error % | Status | Reason |
|---|---|---|---|---|---|---|---|---|---|---|---|
| <claim_id> | <claim_text> | <source_tool_id_reference> | <input_data> | <claim_amount> | <claim_unit> | <input_claim_conversion_statement> | <input_transformation_type> | <calculated_claim> | <error_in_claim> | SUCCESS/FAILURE | <reason> |

Failed Claims Summary (only claims with status=FAILURE from `claims_psv`):

| # | Claim Text | Claimed | Source Tool ID | Input Data | Calculated | Error % | Reason |
|---|---|---|---|---|---|---|---|
| <claim_id> | <claim_text> | <claim_amount> <claim_unit> | <source_tool_id_reference> | <input_data> | <calculated_claim> | <error_in_claim> | <reason> |

REMEMBER to generate each value COMPLETELY. DO NOT TRUNCATE.

#### Validity
<summary detailing strengths and weaknesses>

#### Coherence
<summary detailing strengths and weaknesses>

#### Utility
<summary detailing strengths and weaknesses>

#### Tool Validation
<summary detailing strengths and weaknesses>

All tool details:

| # | Tool Name | Tool Status |
|---|---|---|
| <id> | <tool name> | <tool status> |
```

Write the content using the Write tool to `<report_dir>/trace_<N>_<first_12_chars_of_id>.md`.

After writing each file, tell the user:
> Trace `<trace_id>` result written to `<report_dir>/trace_<N>_<first_12_chars_of_id>.md`

---

### Step 3: Write Cross-Trace Comprehensive Summary to File

After processing all individual traces, write a comprehensive summary **directly to `<report_dir>/SUMMARY.md`** using the Write tool. Do NOT print the full summary to the terminal.

The file content must follow this format:

```
## Validation Summary

### Overall Score Summary

| Criteria | Average Score | Min | Max | Traces Evaluated |
|---|---|---|---|---|
| **Groundedness** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Validity** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Coherence** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Utility** | <avg>/5 | <min>/5 | <max>/5 | <count> |
| **Tool Validation** | <avg>/5 | <min>/5 | <max>/5 | <count> |

### Per-Trace Score Breakdown

| Trace ID | Groundedness | Validity | Coherence | Utility | Tool Validation |
|---|---|---|---|---|---|
| <id> | <score>/5 | <score>/5 | <score>/5 | <score>/5 | <score>/5 |

### Category-Wise Analysis

For EACH category:
- **Common Strengths**: Patterns of success observed across traces
- **Common Weaknesses**: Recurring issues found across traces
- **Recommendations**: Actionable improvements based on the analysis

Finally generate all the failed claims in the below markdown format from all the traces (parsed from `claims_psv` where status=FAILURE):

| # | Trace ID | Claim Text | Claimed | Source Tool ID | Input Data | Calculated | Error % | Reason |
|---|---|---|---|---|---|---|---|---|
| <claim_id> | <trace_id> | <claim_text> | <claim_amount> <claim_unit> | <source_tool_id_reference> | <input_data> | <calculated_claim> | <error_in_claim> | <reason> |

REMEMBER that no claim should be truncated. ALL THE VALUES MUST BE COMPLETE.

```

After writing the file, tell the user:
> Summary written to `<report_dir>/SUMMARY.md`

---

### Step 4: Write Groundedness Failure Categories to File

After writing the summary, analyse all failed Groundedness claims across every trace and group them into failure categories. Write the result **directly to `<report_dir>/GROUNDEDNESS_FAILURES.md`** using the Write tool.

To derive categories, read the `reason` fields from every failed claim (status=FAILURE in `claims_psv`) across all traces and group semantically similar failures under a single category label (e.g. "Unit Conversion Error", "Wrong Metric Used", "Rounding Error", "Missing Data", "Calculation Error", etc.).

The file content must follow this format:

```
## Groundedness Failure Categories

### Category Summary

| # | Category | Failure Count | Trace IDs |
|---|---|---|---|
| 1 | <category_name> | <count> | <trace_id_1>, <trace_id_2>, ... |
| 2 | <category_name> | <count> | <trace_id_1>, ... |
| ... | | | |
| **Total** | | <total_count> | |

### Category Details

For each category, list every failed claim that belongs to it:

#### <Category Name>

**Description:** <one-sentence explanation of what this category of failure represents>

| # | Trace ID | Claim Text | Claimed | Calculated | Error % | Reason |
|---|---|---|---|---|---|---|
| <claim_id> | <trace_id> | <claim_text> | <claim_amount> <claim_unit> | <calculated_claim> | <error_in_claim> | <reason> |
```

REMEMBER: every failed claim from every trace must appear in exactly one category. No claim should be omitted or truncated.

After writing the file, tell the user:
> Groundedness failure categories written to `<report_dir>/GROUNDEDNESS_FAILURES.md`

---

### Step 5: Write Visual Dashboard to File

After writing the failure categories, generate a **self-contained HTML dashboard** and write it **directly to `<report_dir>/DASHBOARD.html`** using the Write tool. No external dependencies — all CSS, SVG charts, and JavaScript must be inline.

The dashboard serves two audiences: **executives** (CTO, founders, sales) who glance at the top, and **engineers** who drill into details. Structure accordingly: verdict at the top, proof at the bottom.

---

#### 5.1 Model Pricing Lookup

Use this table to compute costs from `model_name`, `input_tokens`, and `output_tokens` in each criteria result:

| Model (match substring) | Input (per 1M tokens) | Output (per 1M tokens) |
|---|---|---|
| `claude-sonnet` | $3.00 | $15.00 |
| `claude-haiku` | $0.80 | $4.00 |
| `claude-opus` | $15.00 | $75.00 |
| `gpt-4o-mini` | $0.15 | $0.60 |
| `gpt-4o` | $2.50 | $10.00 |
| `gpt-4.1` | $2.00 | $8.00 |
| `gpt-4.1-mini` | $0.40 | $1.60 |
| `gpt-4.1-nano` | $0.10 | $0.40 |
| `o3` | $2.00 | $8.00 |
| `o3-mini` | $1.10 | $4.40 |
| `o4-mini` | $1.10 | $4.40 |

**Cost formula:** `cost = (input_tokens / 1_000_000) * input_price + (output_tokens / 1_000_000) * output_price`

If `model_name` does not match any known model, show token counts but display cost as "N/A".

---

#### 5.2 Dashboard Layout

Generate the HTML following this exact section order. Use a clean, professional design: dark header (`#1a1a2e`), light body (`#f4f6f9`), card-based layout, consistent color system throughout.

**Color system for scores:**
- Score >= 4.0 → green (`#38a169` / `#c6f6d5`)
- Score 2.5–3.9 → yellow (`#d69e2e` / `#fefcbf`)
- Score < 2.5 → red (`#e53e3e` / `#fed7d7`)

**Pass rate** = % of traces scoring >= 3.0 for that criteria. **Fully passing** = all 5 criteria >= 3.0 for that trace.

---

##### Section 1: Executive Banner

Dark header bar containing:
- **Title**: "Validation Dashboard"
- **Timestamp**: generation time
- **Traces evaluated**: total count
- **Overall verdict**: one-line summary, e.g. "4/5 traces fully passing — 1 trace has groundedness issues"
- **Total evaluation cost**: sum of all criteria across all traces, formatted as `$X.XX`

##### Section 2: Radar Chart — Criteria Averages

An inline SVG radar/spider chart with 5 axes (Groundedness, Validity, Coherence, Utility, Tool Validation). Plot the average score for each criteria across all traces. The chart should:
- Use a regular pentagon for the 5-axis grid with concentric rings at 1, 2, 3, 4, 5
- Fill the scored area with a semi-transparent blue (`rgba(66, 153, 225, 0.3)`) and a solid blue stroke
- Label each axis with the criteria name and its average score
- Be centered, approximately 400x400px

If there are multiple traces, overlay each trace as a separate semi-transparent polygon (different colors) with a legend below.

##### Section 3: Criteria Heatmap Table

A table where:
- **Rows** = traces (show first 12 chars of trace ID in monospace)
- **Columns** = Groundedness, Validity, Coherence, Utility, Tool Validation
- **Cells** = score value with background color (green/yellow/red gradient)
- Last row = **Average** across all traces (bold)

This gives the full matrix at a glance.

##### Section 4: Cost & Token Breakdown

**4a — Summary cards row:**
- Total Input Tokens (formatted with commas)
- Total Output Tokens (formatted with commas)
- Total Tokens (formatted with commas)
- Total Cost (`$X.XX`)

**4b — Per-criteria cost table:**

| Criteria | Model | Input Tokens | Output Tokens | Total Tokens | Cost |
|---|---|---|---|---|---|
| Groundedness | <model_name> | <input_tokens> | <output_tokens> | <total_tokens> | $X.XX |
| Validity | ... | ... | ... | ... | ... |
| Coherence | ... | ... | ... | ... | ... |
| Utility | ... | ... | ... | ... | ... |
| Tool Validation | ... | ... | ... | ... | ... |
| **Total** | | **...** | **...** | **...** | **$X.XX** |

If multiple traces, show the **aggregate** table above, then a **collapsible per-trace breakdown** below it.

**4c — Stacked bar chart (inline SVG):**
- One bar per criteria
- Each bar split into input tokens (lighter shade) and output tokens (darker shade)
- X-axis labels = criteria names, Y-axis = token count
- Legend: "Input Tokens" / "Output Tokens"
- Approximately 600px wide, 250px tall

##### Section 5: Groundedness Deep-Dive (collapsible)

Wrap in a `<details>` tag, open by default.

**5a — Donut chart (inline SVG):**
- Two segments: passed claims (green) vs failed claims (red)
- Center text: "X/Y passed" or pass percentage
- Approximately 200x200px, positioned left with stats to the right

**5b — Failed claims table:**
Only claims with `status=FAILURE` from `claims_psv` across all traces:

| # | Trace ID | Claim Text | Claimed | Calculated | Error % | Reason |
|---|---|---|---|---|---|---|

If no failed claims, show a green banner: "All claims passed validation."

**5c — Failure categories summary:**
If there are failed claims, show a compact category table (from Step 4 data):

| Category | Count | Affected Traces |
|---|---|---|

##### Section 6: Per-Criteria Summaries (each collapsible)

For **Validity**, **Coherence**, **Utility**, and **Tool Validation**, generate a `<details>` section (collapsed by default) containing:
- Score bar: a horizontal progress bar (width = score/5 * 100%), color-coded
- Node-level breakdown table (if available): Node | Score | Status
- Key findings: 2-3 bullet points summarizing strengths/weaknesses from `text_response`

For **Tool Validation** specifically, also include the tool details table:

| # | Tool Name | Tool Status |
|---|---|---|

##### Section 7: Per-Trace Detail (each collapsible)

For each trace, generate a `<details>` section (collapsed by default) containing:
- Trace ID (monospace)
- Mini scorecard: 5 criteria as inline colored badges
- Token usage for this trace: small table with criteria | model | tokens | cost
- Full Groundedness claims table (all 12 PSV columns)
- `text_response` summaries for each criteria

---

#### 5.3 Styling Requirements

The `<style>` block must include:

```
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f6f9; color: #1a1a2e; }
```

Additional requirements:
- **Cards**: `background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.08);`
- **Section titles**: left border accent (`border-left: 4px solid #4299e1`), uppercase label style
- **Tables**: full-width, collapsed borders, alternating row hover, sticky header
- **Badges**: pill-shaped (`border-radius: 999px`), colored by score
- **`<details>`/`<summary>`**: styled as expandable cards with chevron indicator, cursor pointer
- **Print-friendly**: add `@media print` rules that expand all `<details>`, hide decorative elements, use black text
- **Responsive**: cards grid uses `repeat(auto-fit, minmax(180px, 1fr))`
- **Number formatting**: use commas for thousands in token counts

---

#### 5.4 Output

Write the complete HTML file using the Write tool to `<report_dir>/DASHBOARD.html`.

After writing the file, tell the user:
> Dashboard written to `<report_dir>/DASHBOARD.html`
