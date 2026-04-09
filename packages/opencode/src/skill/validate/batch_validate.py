#!/usr/bin/env python3
"""
Batch Validation Script

Validates traces by calling the Altimate backend directly.

Modes:
  1. Single trace:  --trace-ids <id>
  2. Date range:    --from-time <ISO datetime> --to-time <ISO datetime> --user-id <user_id>
  3. Session ID:    --session-id <session_id>

Output:
  - Writes structured JSON to logs/batch_validation_<timestamp>.json
  - Prints JSON to stdout for Claude to process
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------
def _find_altimate_dir():
    """Find the .altimate-code directory.

    Checks in order:
    1. Walk up from the script's location (for project-local .altimate-code dirs)
    2. Fall back to ~/.altimate-code (global user config)
    """
    current = Path(__file__).resolve()
    for parent in current.parents:
        if parent.name == ".altimate-code" and parent.is_dir():
            return parent
    global_dir = Path.home() / ".altimate-code"
    if global_dir.is_dir():
        return global_dir
    return None


def _find_project_root(override=None):
    """Find project root containing .altimate-code/. Falls back to cwd."""
    if override:
        return Path(override).resolve()
    altimate_dir = _find_altimate_dir()
    if altimate_dir:
        return altimate_dir.parent
    return Path.cwd()


_project_root = _find_project_root()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL = "https://apimi.tryaltimate.com"

LOG_DIR = _project_root / "logs"
LOG_DIR.mkdir(exist_ok=True)


def _load_credentials() -> str:
    """Read api_key from ~/.altimate-code/settings.json.

    Exits with a clear message if credentials are missing.
    """
    settings_path = Path.home() / ".altimate-code" / "settings.json"
    if not settings_path.exists():
        print(
            "ERROR: Altimate credentials not found.\n"
            "Run: altimate validate configure --api-key <key>",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        settings = json.loads(settings_path.read_text())
    except Exception as e:
        print(f"ERROR: Could not read settings.json: {e}", file=sys.stderr)
        sys.exit(1)

    api_key = settings.get("altimate_api_key", "").strip()

    if not api_key:
        print(
            "ERROR: altimate_api_key missing from settings.json.\n"
            "Run: altimate validate configure --api-key <key>",
            file=sys.stderr,
        )
        sys.exit(1)

    return api_key


_API_KEY = _load_credentials()

# ---------------------------------------------------------------------------
# HTTP session — retry adapter handles stale keep-alive connections mid-batch
# ---------------------------------------------------------------------------
_SESSION = requests.Session()
_adapter = HTTPAdapter(
    max_retries=Retry(total=3, allowed_methods=["POST"], backoff_factor=0.5)
)
_SESSION.mount("https://", _adapter)
_SESSION.mount("http://", _adapter)

_HEADERS = {
    "Authorization": f"Bearer {_API_KEY}",
    "Content-Type": "application/json",
}


# ---------------------------------------------------------------------------
# SSE stream parser
# ---------------------------------------------------------------------------
def _parse_sse_stream(response):
    """Parse a Server-Sent Events stream. Yields parsed event dicts."""
    for raw_line in response.iter_lines():
        if isinstance(raw_line, bytes):
            raw_line = raw_line.decode("utf-8")
        line = raw_line.strip()
        if not line or not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if not data:
            continue
        try:
            yield json.loads(data)
        except json.JSONDecodeError:
            print(f"  Warning: could not parse SSE line: {data}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Backend API calls
# ---------------------------------------------------------------------------
_EMPTY_STREAM_RETRIES = 3
_EMPTY_STREAM_BACKOFF = 2  # seconds


def _stream_post(url, payload, timeout):
    """POST to url, stream SSE response. Returns list of trace_result/trace_error events."""
    import time
    for attempt in range(1, _EMPTY_STREAM_RETRIES + 1):
        results = []
        try:
            resp = _SESSION.post(url, json=payload, headers=_HEADERS, stream=True, timeout=timeout)
            resp.raise_for_status()
            for event in _parse_sse_stream(resp):
                _log_event(event)
                if event.get("event") in ("trace_result", "trace_error"):
                    results.append(event)
        except Exception as e:
            print(f"  ERROR: {e}", file=sys.stderr)
            return results

        if results:
            return results

        if attempt < _EMPTY_STREAM_RETRIES:
            print(
                f"  Warning: stream returned no events (attempt {attempt}/{_EMPTY_STREAM_RETRIES}), "
                f"retrying in {_EMPTY_STREAM_BACKOFF}s...",
                file=sys.stderr,
            )
            time.sleep(_EMPTY_STREAM_BACKOFF)

    print(f"  Warning: stream returned no events after {_EMPTY_STREAM_RETRIES} attempts.", file=sys.stderr)
    return []


def validate_single_trace(trace_id):
    """Call POST /validate for a single trace. Returns list of result dicts."""
    print(f"Validating trace: {trace_id}...", file=sys.stderr)
    results = _stream_post(f"{BASE_URL}/validate", {"trace_id": trace_id}, timeout=300)
    if not results:
        results.append({"event": "trace_error", "trace_id": trace_id, "error": "Stream returned no events"})
    return results


def validate_date_range(user_id, from_datetime, to_datetime):
    """Call POST /validate/date-range. Returns list of result dicts."""
    print(
        f"Validating traces for user '{user_id}' from {from_datetime} to {to_datetime}...",
        file=sys.stderr,
    )
    return _stream_post(
        f"{BASE_URL}/validate/date-range",
        {"user_id": user_id, "from_datetime": from_datetime, "to_datetime": to_datetime},
        timeout=600,
    )


def validate_session(session_id):
    """Call POST /validate/session. Returns list of result dicts."""
    print(f"Validating all traces in session: {session_id}...", file=sys.stderr)
    return _stream_post(f"{BASE_URL}/validate/session", {"session_id": session_id}, timeout=600)


def validate_production(from_datetime, to_datetime, limit=500):
    """Call POST /validate/production. Returns list of result dicts."""
    print(
        f"Validating production traces from {from_datetime} to {to_datetime} (limit {limit})...",
        file=sys.stderr,
    )
    return _stream_post(
        f"{BASE_URL}/validate/production",
        {"from_datetime": from_datetime, "to_datetime": to_datetime, "limit": limit},
        timeout=600,
    )


def _log_event(event):
    """Print progress events to stderr."""
    name = event.get("event", "")
    if name == "traces_list":
        print(f"  Found {event.get('total', 0)} traces to validate", file=sys.stderr)
    elif name == "trace_result":
        print(f"  ✓ trace {event.get('trace_id', '')[:12]}... validated", file=sys.stderr)
    elif name == "trace_error":
        print(
            f"  ✗ trace {event.get('trace_id', '')[:12]}... error: {event.get('error', '')}",
            file=sys.stderr,
        )
    elif name == "COMPLETE":
        print(
            f"  Complete: {event.get('completed', 0)}/{event.get('total', 0)} traces "
            f"in {event.get('elapsed_seconds', 0):.1f}s",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# Result normalisation — map SSE trace_result/trace_error to output shape
# ---------------------------------------------------------------------------
def _normalise_results(raw_results):
    """Convert SSE event dicts to the output format expected by SKILL.md."""
    normalised = []
    for event in raw_results:
        if event.get("event") == "trace_result":
            normalised.append({
                "trace_id": event.get("trace_id"),
                "status_code": 200,
                "result": {
                    "trace_id": event.get("trace_id"),
                    "status": event.get("status", "success"),
                    "error_count": event.get("error_count", 0),
                    "observation_count": event.get("observation_count", 0),
                    "elapsed_seconds": event.get("elapsed_seconds", 0),
                    "criteria_results": event.get("criteria_results", {}),
                },
            })
        elif event.get("event") == "trace_error":
            normalised.append({
                "trace_id": event.get("trace_id"),
                "status_code": 0,
                "result": {
                    "trace_id": event.get("trace_id"),
                    "status": "error",
                    "error": event.get("error", "Unknown error"),
                },
            })
    return normalised


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Batch Validation Script")
    parser.add_argument(
        "--trace-ids",
        help="Single trace ID to validate",
    )
    parser.add_argument(
        "--from-time",
        help="Start datetime in ISO format (e.g., 2026-03-01T00:00:00)",
    )
    parser.add_argument(
        "--to-time",
        help="End datetime in ISO format (e.g., 2026-03-10T23:59:59)",
    )
    parser.add_argument(
        "--user-id",
        help="User ID filter for date range queries",
    )
    parser.add_argument(
        "--session-id",
        help="Session ID to validate all traces for",
    )
    parser.add_argument(
        "--production",
        action="store_true",
        help="Validate production traces (requires --from-time and --to-time)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=500,
        help="Max traces to validate in production mode (default: 500, max: 500)",
    )
    parser.add_argument(
        "--output",
        help="Output log file path (defaults to logs/batch_validation_<timestamp>.json)",
    )
    parser.add_argument(
        "--project-root",
        help="Explicit project root directory. If omitted, auto-detected.",
    )
    args = parser.parse_args()

    global _project_root, LOG_DIR
    if args.project_root:
        _project_root = _find_project_root(override=args.project_root)
        LOG_DIR = _project_root / "logs"
        LOG_DIR.mkdir(exist_ok=True)
        print(f"Project root (override): {_project_root}", file=sys.stderr)
    else:
        print(f"Project root (auto-detected): {_project_root}", file=sys.stderr)

    print(f"Backend URL: {BASE_URL}", file=sys.stderr)

    # Dispatch to the correct mode
    raw_results = []

    if args.production:
        if not args.from_time or not args.to_time:
            print("ERROR: --production requires --from-time and --to-time.", file=sys.stderr)
            sys.exit(1)
        raw_results = validate_production(args.from_time, args.to_time, args.limit)

    elif args.session_id:
        raw_results = validate_session(args.session_id)

    elif args.from_time and args.to_time:
        if not args.user_id:
            print("ERROR: --user-id is required for date range validation.", file=sys.stderr)
            sys.exit(1)
        raw_results = validate_date_range(args.user_id, args.from_time, args.to_time)

    elif args.trace_ids:
        trace_id = args.trace_ids.strip()
        raw_results = validate_single_trace(trace_id)

    else:
        print(
            "ERROR: Provide --trace-ids, --session-id, or --from-time/--to-time/--user-id.",
            file=sys.stderr,
        )
        sys.exit(1)

    results = _normalise_results(raw_results)

    # Build output
    timestamp = datetime.now().strftime("%d_%m_%Y__%H_%M_%S")
    report_dir = str(LOG_DIR / f"batch_validation_{timestamp}")
    Path(report_dir).mkdir(exist_ok=True)
    log_file = args.output or str(Path(report_dir) / f"batch_validation_{timestamp}.json")

    output = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_traces": len(results),
        "results": results,
        "log_file": log_file,
        "report_dir": report_dir,
    }

    with open(log_file, "w") as f:
        json.dump(output, f, indent=2, default=str)

    print(f"\nResults written to: {log_file}", file=sys.stderr)
    print(f"Reports folder: {report_dir}", file=sys.stderr)

    print(json.dumps(output, indent=2, default=str))


if __name__ == "__main__":
    main()