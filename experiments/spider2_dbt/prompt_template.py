"""Prompt template for Spider 2.0-DBT benchmark tasks.

Injects structured project context (YAML model definitions, existing SQL
models, DuckDB source schema) so the agent knows exactly what to build.
"""

from __future__ import annotations

import re
from pathlib import Path

from schema_introspect import introspect_duckdb_schema


# ── YAML parsing helpers ─────────────────────────────────────────────────────


def _parse_yaml_models(project_dir: Path) -> list[dict]:
    """Extract model definitions from YAML files using PyYAML or regex fallback.

    Returns a list of dicts: {name, description, columns: [{name, description}], yaml_path}
    """
    yaml_files = sorted(
        f
        for f in project_dir.rglob("*.yml")
        if "dbt_packages" not in f.parts
        and "target" not in f.parts
        and "dbt_project.yml" not in f.name
        and "packages.yml" not in f.name
        and "profiles.yml" not in f.name
    )

    models: list[dict] = []

    try:
        import yaml

        for yf in yaml_files:
            try:
                docs = list(yaml.safe_load_all(yf.read_text()))
            except Exception:
                continue
            for doc in docs:
                if not isinstance(doc, dict):
                    continue
                for model_def in doc.get("models", []):
                    if not isinstance(model_def, dict) or "name" not in model_def:
                        continue
                    cols = []
                    for c in model_def.get("columns", []):
                        if isinstance(c, dict) and "name" in c:
                            cols.append({
                                "name": c["name"],
                                "description": c.get("description", ""),
                            })
                    rel_path = str(yf.relative_to(project_dir))
                    models.append({
                        "name": model_def["name"],
                        "description": model_def.get("description", ""),
                        "columns": cols,
                        "yaml_path": rel_path,
                    })
    except ImportError:
        # Fallback: regex-based extraction (less accurate but functional)
        for yf in yaml_files:
            try:
                text = yf.read_text()
            except Exception:
                continue
            # Match top-level model name entries under 'models:'
            for m in re.finditer(
                r"^\s{2,4}-\s+name:\s*(.+)$", text, re.MULTILINE
            ):
                name = m.group(1).strip().strip("\"'")
                rel_path = str(yf.relative_to(project_dir))
                models.append({
                    "name": name,
                    "description": "",
                    "columns": [],
                    "yaml_path": rel_path,
                })

    return models


def _find_existing_sql_models(project_dir: Path) -> list[str]:
    """List relative paths of all .sql model files in the project."""
    return sorted(
        str(f.relative_to(project_dir))
        for f in project_dir.rglob("*.sql")
        if "dbt_packages" not in f.parts
        and "target" not in f.parts
    )


# ── Prompt assembly ──────────────────────────────────────────────────────────

# Hard cap on total injected context to avoid overwhelming the model
_MAX_CONTEXT_CHARS = 8000


def build_task_prompt(
    instance_id: str,
    instruction: str,
    project_dir: str,
) -> str:
    """Build the prompt for a Spider2-DBT task.

    Pre-computes and injects structured project context before the
    instruction so the agent knows what models to create, what tables
    exist, and what naming conventions to follow.

    Args:
        instance_id: Unique task identifier (e.g., "ga4_001").
        instruction: The natural language task instruction from the benchmark.
        project_dir: Absolute path to the dbt project working directory.

    Returns:
        The full prompt string with context + instruction.
    """
    pd = Path(project_dir)
    sections: list[str] = []

    # ── 1. Task instruction ──────────────────────────────────────────────
    sections.append(f"## Task\n\n{instruction}")

    # ── 2. Missing model discovery ───────────────────────────────────────
    yaml_models = _parse_yaml_models(pd)
    existing_sql = _find_existing_sql_models(pd)

    # Build set of model names that already have SQL files
    existing_model_names: set[str] = set()
    for sql_path in existing_sql:
        # Extract model name from path: "models/foo/bar.sql" -> "bar"
        stem = Path(sql_path).stem
        existing_model_names.add(stem)

    missing_models = [m for m in yaml_models if m["name"] not in existing_model_names]

    if missing_models:
        lines = [
            "## Models That Need Implementation",
            "",
            "These models are defined in YAML schema files but have no corresponding "
            "SQL file. You MUST create SQL files for them. Model names MUST match "
            "exactly as listed below.",
            "",
        ]
        for i, m in enumerate(missing_models, 1):
            lines.append(
                f"{i}. **{m['name']}** (defined in `{m['yaml_path']}`)"
            )
            if m["description"]:
                lines.append(f"   Description: {m['description']}")
            if m["columns"]:
                col_strs = []
                for c in m["columns"]:
                    s = c["name"]
                    if c["description"]:
                        s += f" — {c['description']}"
                    col_strs.append(s)
                lines.append(f"   Columns: {', '.join(col_strs)}")
            lines.append("")
        sections.append("\n".join(lines))

    # ── 3. Existing SQL models ───────────────────────────────────────────
    if existing_sql:
        lines = ["## Existing SQL Models", ""]
        for sql_path in existing_sql:
            lines.append(f"- `{sql_path}`")
        sections.append("\n".join(lines))

    # ── 4. DuckDB schema summary ─────────────────────────────────────────
    schema_summary = introspect_duckdb_schema(pd)
    if schema_summary:
        sections.append(schema_summary)

    # ── 5. Execution guidelines ──────────────────────────────────────────
    guidelines = [
        "## Execution Guidelines",
        "",
        "1. Read existing SQL models to understand patterns and conventions.",
        "2. Create SQL files for each missing model listed above, placing them "
        "in the same directory as their YAML definition.",
        "3. Use `{{ ref('model_name') }}` for references to other dbt models "
        "and `{{ source('source_name', 'table_name') }}` for raw source tables.",
        "4. Run `dbt build` to materialize all models. If a model fails, fix "
        "the SQL and rebuild.",
        "5. Verify that the expected output tables exist in the database.",
        "",
        "**Important:**",
        "- Model file names must match the model names exactly "
        "(e.g., model `my_model` → `my_model.sql`).",
    ]
    sections.append("\n".join(guidelines))

    # ── Assemble and cap ─────────────────────────────────────────────────
    prompt = "\n\n".join(sections)

    # If context is too long, truncate the schema section first
    if len(prompt) > _MAX_CONTEXT_CHARS:
        # Rebuild without schema to stay within budget
        sections_no_schema = [s for s in sections if not s.startswith("## Source Database")]
        prompt = "\n\n".join(sections_no_schema)

    if len(prompt) > _MAX_CONTEXT_CHARS:
        prompt = prompt[:_MAX_CONTEXT_CHARS] + "\n\n... (context truncated)"

    return prompt
