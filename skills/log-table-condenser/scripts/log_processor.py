#!/usr/bin/env python3
"""Log Processor: Memory-efficient streaming log analyzer and table condenser.

This script parses large structured line-by-line logs (JSONL, CSV, TSV, or key-value logs)
in streaming mode (O(1) memory) to prevent LLM context-window and memory overflow.
It samples schema fields and condenses log records into compact, structured tables
(CSV, TSV, SQLite, LaTeX, Markdown, or compact JSONL).
"""

import argparse
import csv
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Tuple


def validate_path(path: str, project_path: Optional[str] = None) -> str:
    """Validate and return absolute path, ensuring safety within project_path if provided."""
    if project_path:
        abs_proj = os.path.abspath(project_path)
        abs_path = os.path.abspath(os.path.join(abs_proj, path))
        if not abs_path.startswith(abs_proj):
            print(f"Error: Path '{path}' is outside project directory '{abs_proj}'", file=sys.stderr)
            sys.exit(1)
        return abs_path
    return os.path.abspath(path)


def detect_file_format(file_path: str, sample_lines: List[str]) -> str:
    """Detect file format based on extension and sample content."""
    lower_path = file_path.lower()
    if lower_path.endswith(".jsonl") or lower_path.endswith(".ndjson"):
        return "jsonl"
    if lower_path.endswith(".tsv"):
        return "tsv"
    if lower_path.endswith(".csv"):
        return "csv"

    # Inspect first non-empty lines
    for line in sample_lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("{") and s.endswith("}"):
            return "jsonl"
        if "\t" in s:
            return "tsv"
        if "," in s:
            return "csv"
    return "jsonl"


def iter_log_records(file_path: str, limit: Optional[int] = None) -> Generator[Dict[str, Any], None, None]:
    """Stream records from a log file as dictionaries."""
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    # First inspect sample lines to determine format
    sample_lines: List[str] = []
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        for _ in range(10):
            line = f.readline()
            if not line:
                break
            sample_lines.append(line)

    detected_format = detect_file_format(file_path, sample_lines)
    count = 0

    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        if detected_format in ("csv", "tsv"):
            delimiter = "\t" if detected_format == "tsv" else ","
            reader = csv.DictReader(f, delimiter=delimiter)
            for row in reader:
                if row:
                    yield dict(row)
                    count += 1
                    if limit and count >= limit:
                        return
        else:
            # Assume JSONL or lines of json
            for line in f:
                s = line.strip()
                if not s:
                    continue
                try:
                    obj = json.loads(s)
                    if isinstance(obj, dict):
                        yield obj
                    else:
                        yield {"value": obj}
                    count += 1
                    if limit and count >= limit:
                        return
                except Exception:
                    # Fallback key-value parser for structured logs (e.g. k1=v1 k2=v2)
                    kv_pairs = re.findall(r'(\w+)=(?:"([^"]*)"|(\S+))', s)
                    if kv_pairs:
                        row = {k: v1 or v2 for k, v1, v2 in kv_pairs}
                        yield row
                        count += 1
                        if limit and count >= limit:
                            return
                    else:
                        # Raw message line
                        yield {"raw": s}
                        count += 1
                        if limit and count >= limit:
                            return


def infer_type_name(val: Any) -> str:
    """Infer human-readable type name from a python value."""
    if val is None:
        return "null"
    if isinstance(val, bool):
        return "bool"
    if isinstance(val, int):
        return "int"
    if isinstance(val, float):
        return "float"
    if isinstance(val, dict):
        return "object"
    if isinstance(val, list):
        return "list"
    return "string"


def sample_schema(file_path: str, sample_size: int = 10) -> Dict[str, Any]:
    """Sample the first N lines and infer fields/schema."""
    records: List[Dict[str, Any]] = []
    for r in iter_log_records(file_path, limit=sample_size):
        records.append(r)

    all_keys: Dict[str, Dict[str, Any]] = {}
    for r in records:
        for k, v in r.items():
            if k not in all_keys:
                all_keys[k] = {
                    "name": k,
                    "type": infer_type_name(v),
                    "sample_value": v if not isinstance(v, (dict, list)) else json.dumps(v)[:60],
                    "occurrences": 1,
                }
            else:
                all_keys[k]["occurrences"] += 1

    file_size = os.path.getsize(file_path)
    return {
        "file": os.path.basename(file_path),
        "file_size_bytes": file_size,
        "sample_lines": len(records),
        "fields": list(all_keys.values()),
    }


def escape_latex(text: str) -> str:
    """Escape LaTeX special characters for tabular cells."""
    if not isinstance(text, str):
        text = str(text)
    replacements = [
        ("\\", r"\textbackslash{}"),
        ("&", r"\&"),
        ("%", r"\%"),
        ("$", r"\$"),
        ("#", r"\#"),
        ("_", r"\_"),
        ("{", r"\{"),
        ("}", r"\}"),
        ("~", r"\textasciitilde{}"),
        ("^", r"\textasciicircum{}"),
    ]
    for char, rep in replacements:
        text = text.replace(char, rep)
    return text


def format_field_value(val: Any, max_len: Optional[int] = None) -> str:
    """Format and optionally truncate a field value."""
    if val is None:
        s = ""
    elif isinstance(val, (dict, list)):
        s = json.dumps(val, ensure_ascii=False)
    else:
        s = str(val)

    if max_len and len(s) > max_len:
        s = s[: max(0, max_len - 3)] + "..."
    return s


def condense_logs(
    input_path: str,
    output_path: str,
    fields: List[str],
    output_format: str = "csv",
    dedup: bool = False,
    max_len: Optional[int] = None,
    sqlite_table: str = "condensed_logs",
) -> Dict[str, Any]:
    """Stream and condense input log records to the desired output format."""
    start_time = time.time()
    orig_size = os.path.getsize(input_path)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    out_fmt = output_format.lower()

    lines_read = 0
    lines_written = 0

    header_fields = list(fields)
    if dedup:
        header_fields.append("occurrence_count")

    # Helper generator with optional run-length deduplication
    def generate_rows() -> Generator[Tuple[List[str], int], None, None]:
        nonlocal lines_read
        prev_row: Optional[List[str]] = None
        repeat_count = 0

        for record in iter_log_records(input_path):
            lines_read += 1
            extracted = [format_field_value(record.get(f), max_len) for f in fields]

            if dedup:
                if prev_row is not None and extracted == prev_row:
                    repeat_count += 1
                else:
                    if prev_row is not None:
                        yield (prev_row, repeat_count)
                    prev_row = extracted
                    repeat_count = 1
            else:
                yield (extracted, 1)

        if dedup and prev_row is not None:
            yield (prev_row, repeat_count)

    if out_fmt in ("csv", "tsv"):
        delimiter = "\t" if out_fmt == "tsv" else ","
        with open(output_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f, delimiter=delimiter)
            writer.writerow(header_fields)
            for row_vals, count in generate_rows():
                if dedup:
                    row_vals.append(str(count))
                writer.writerow(row_vals)
                lines_written += 1

    elif out_fmt == "sqlite":
        if os.path.exists(output_path):
            os.remove(output_path)
        conn = sqlite3.connect(output_path)
        cur = conn.cursor()

        # Sanitize column names for SQL
        sql_cols = [re.sub(r"\W+", "_", col).strip("_") or f"col_{i}" for i, col in enumerate(header_fields)]
        col_defs = ", ".join([f'"{c}" TEXT' for c in sql_cols])
        cur.execute(f'CREATE TABLE "{sqlite_table}" ({col_defs})')

        placeholders = ", ".join(["?"] * len(sql_cols))
        insert_sql = f'INSERT INTO "{sqlite_table}" VALUES ({placeholders})'

        batch: List[List[str]] = []
        for row_vals, count in generate_rows():
            if dedup:
                row_vals.append(str(count))
            batch.append(row_vals)
            lines_written += 1
            if len(batch) >= 1000:
                cur.executemany(insert_sql, batch)
                batch = []

        if batch:
            cur.executemany(insert_sql, batch)
        conn.commit()
        conn.close()

    elif out_fmt == "latex":
        with open(output_path, "w", encoding="utf-8") as f:
            col_spec = "l" * len(header_fields)
            f.write(f"\\begin{{tabular}}{{{col_spec}}}\n")
            f.write("\\toprule\n")
            f.write(" & ".join([f"\\textbf{{{escape_latex(h)}}}" for h in header_fields]) + " \\\\\n")
            f.write("\\midrule\n")

            for row_vals, count in generate_rows():
                if dedup:
                    row_vals.append(str(count))
                f.write(" & ".join([escape_latex(v) for v in row_vals]) + " \\\\\n")
                lines_written += 1

            f.write("\\bottomrule\n")
            f.write("\\end{tabular}\n")

    elif out_fmt == "markdown":
        with open(output_path, "w", encoding="utf-8") as f:
            f.write("| " + " | ".join(header_fields) + " |\n")
            f.write("| " + " | ".join(["---"] * len(header_fields)) + " |\n")
            for row_vals, count in generate_rows():
                if dedup:
                    row_vals.append(str(count))
                f.write("| " + " | ".join([v.replace("|", "\\|") for v in row_vals]) + " |\n")
                lines_written += 1

    elif out_fmt == "jsonl":
        with open(output_path, "w", encoding="utf-8") as f:
            for row_vals, count in generate_rows():
                if dedup:
                    row_vals.append(count)
                f.write(json.dumps(row_vals, ensure_ascii=False) + "\n")
                lines_written += 1

    else:
        raise ValueError(f"Unsupported output format: {out_fmt}")

    condensed_size = os.path.getsize(output_path)
    reduction_pct = round((1.0 - (condensed_size / max(1, orig_size))) * 100, 2)
    elapsed = round(time.time() - start_time, 3)

    return {
        "input_path": input_path,
        "output_path": output_path,
        "format": out_fmt,
        "lines_read": lines_read,
        "lines_written": lines_written,
        "original_size_bytes": orig_size,
        "condensed_size_bytes": condensed_size,
        "reduction_percentage": reduction_pct,
        "elapsed_seconds": elapsed,
    }


def compare_logs(
    file_paths: List[str],
    focus_fields: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Compare multiple log files regarding schema richness, field presence, and consistency."""
    results: List[Dict[str, Any]] = []
    all_discovered_fields: set = set()

    for fp in file_paths:
        if not os.path.isfile(fp):
            raise FileNotFoundError(f"File not found for comparison: {fp}")

        file_size = os.path.getsize(fp)
        total_rows = 0
        field_counts: Dict[str, int] = {}
        field_types: Dict[str, set] = {}
        unique_samples: Dict[str, set] = {}
        seed_frequencies: Dict[Any, int] = {}

        for rec in iter_log_records(fp):
            total_rows += 1
            for k, v in rec.items():
                all_discovered_fields.add(k)
                field_counts[k] = field_counts.get(k, 0) + 1
                tname = infer_type_name(v)
                if k not in field_types:
                    field_types[k] = set()
                field_types[k].add(tname)

                if k not in unique_samples:
                    unique_samples[k] = set()
                if len(unique_samples[k]) < 50 and v is not None:
                    unique_samples[k].add(str(v)[:40])

                # Seed tracking (common in ML/experiment benchmarks)
                if k.lower() in ("seed", "seeds", "random_seed", "seed_pair", "seed_paired"):
                    seed_frequencies[v] = seed_frequencies.get(v, 0) + 1

        fields_info: Dict[str, Dict[str, Any]] = {}
        for k, cnt in field_counts.items():
            pct = round((cnt / max(1, total_rows)) * 100, 1)
            types_str = "/".join(sorted(field_types.get(k, {"unknown"})))
            fields_info[k] = {
                "count": cnt,
                "presence_pct": pct,
                "types": types_str,
                "unique_sample_count": len(unique_samples.get(k, set())),
            }

        # Check seed pairing consistency
        is_seed_paired = False
        paired_seed_count = 0
        if seed_frequencies:
            paired_seeds = [s for s, count in seed_frequencies.items() if count == 2]
            is_seed_paired = len(paired_seeds) > 0 and (len(paired_seeds) == len(seed_frequencies))
            paired_seed_count = len(paired_seeds)

        # Consistency score: average presence percentage of all discovered fields
        avg_field_presence = (
            round(sum(f["presence_pct"] for f in fields_info.values()) / max(1, len(fields_info)), 1)
            if fields_info
            else 0.0
        )

        results.append({
            "file": os.path.basename(fp),
            "file_path": fp,
            "file_size_bytes": file_size,
            "total_rows": total_rows,
            "distinct_fields_count": len(fields_info),
            "fields": fields_info,
            "seed_stats": {
                "total_unique_seeds": len(seed_frequencies),
                "is_seed_paired": is_seed_paired,
                "paired_seeds_count": paired_seed_count,
            },
            "avg_field_presence_pct": avg_field_presence,
        })

    # Sort files by richness (more fields + higher presence + more rows)
    ranked = sorted(
        results,
        key=lambda r: (r["distinct_fields_count"], r["avg_field_presence_pct"], r["total_rows"]),
        reverse=True,
    )
    richness_ranking = [r["file"] for r in ranked]

    return {
        "files_compared": len(file_paths),
        "all_fields": sorted(list(all_discovered_fields)),
        "richness_ranking": richness_ranking,
        "most_consistent_file": ranked[0]["file"] if ranked else None,
        "details": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Log Processor: Schema sampling, comparison, and streaming log condensation.")
    parser.add_argument("--project-path", default=None, help="Root directory for path validation.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Subcommand: sample
    p_sample = subparsers.add_parser("sample", help="Sample N lines and infer available fields.")
    p_sample.add_argument("input", help="Relative or absolute path to log file.")
    p_sample.add_argument("--lines", type=int, default=10, help="Number of sample lines (default 10).")

    # Subcommand: compare
    p_compare = subparsers.add_parser("compare", help="Compare schema richness, consistency, and seed distributions across multiple logs.")
    p_compare.add_argument("inputs", nargs="+", help="Two or more log file paths to compare.")
    p_compare.add_argument("--fields", default=None, help="Optional comma-separated list of focus fields.")

    # Subcommand: condense
    p_condense = subparsers.add_parser("condense", help="Condense log records into a compact table.")
    p_condense.add_argument("input", help="Relative or absolute path to input log file.")
    p_condense.add_argument("--fields", required=True, help="Comma-separated list of fields to extract as columns.")
    p_condense.add_argument("--output", required=True, help="Destination output file path.")
    p_condense.add_argument(
        "--format",
        default="csv",
        choices=["csv", "tsv", "sqlite", "latex", "markdown", "jsonl"],
        help="Target table format (default: csv).",
    )
    p_condense.add_argument("--dedup", action="store_true", help="Collapse repeated consecutive rows with count.")
    p_condense.add_argument("--max-len", type=int, default=None, help="Max length per field value before truncation.")
    p_condense.add_argument("--sqlite-table", default="condensed_logs", help="SQLite table name if format is sqlite.")

    args = parser.parse_args()

    if args.command == "sample":
        input_abs = validate_path(args.input, args.project_path)
        schema = sample_schema(input_abs, sample_size=args.lines)
        print("--- SCHEMA SAMPLE ---")
        print(f"File: {schema['file']} ({schema['file_size_bytes']} bytes)")
        print(f"Sampled Lines: {schema['sample_lines']}")
        print("Discovered Fields:")
        for f in schema["fields"]:
            print(f"  - {f['name']} ({f['type']}): {f['sample_value']}")
        print("\nJSON Summary:")
        print(json.dumps(schema, indent=2))

    elif args.command == "compare":
        input_files_abs = [validate_path(f, args.project_path) for f in args.inputs]
        focus = [f.strip() for f in args.fields.split(",") if f.strip()] if args.fields else None
        comp = compare_logs(input_files_abs, focus_fields=focus)

        print("--- LOG COMPARISON SUMMARY ---")
        print(f"Files Compared: {comp['files_compared']}")
        print(f"Most Consistent & Rich Log: {comp['most_consistent_file']}")
        print(f"Richness Ranking: {' > '.join(comp['richness_ranking'])}")
        print("\nPer-File Metrics:")
        for det in comp["details"]:
            seed_info = det["seed_stats"]
            print(f"\n* File: {det['file']}")
            print(f"  - Size: {det['file_size_bytes']} bytes | Total Rows: {det['total_rows']}")
            print(f"  - Distinct Fields: {det['distinct_fields_count']} (Avg presence: {det['avg_field_presence_pct']}%)")
            if seed_info["total_unique_seeds"] > 0:
                paired_str = "YES (paired seeds)" if seed_info["is_seed_paired"] else f"Partial ({seed_info['paired_seeds_count']} paired)"
                print(f"  - Seeds: {seed_info['total_unique_seeds']} unique seeds | Paired: {paired_str}")
            print(f"  - Fields: {', '.join(sorted(det['fields'].keys())[:15])}")

        print("\nJSON Summary:")
        print(json.dumps(comp, indent=2))

    elif args.command == "condense":
        input_abs = validate_path(args.input, args.project_path)
        output_abs = validate_path(args.output, args.project_path)
        field_list = [f.strip() for f in args.fields.split(",") if f.strip()]
        if not field_list:
            print("Error: --fields must specify at least one field.", file=sys.stderr)
            sys.exit(1)

        result = condense_logs(
            input_path=input_abs,
            output_path=output_abs,
            fields=field_list,
            output_format=args.format,
            dedup=args.dedup,
            max_len=args.max_len,
            sqlite_table=args.sqlite_table,
        )

        print("--- CONDENSATION COMPLETE ---")
        print(f"Output File: {result['output_path']}")
        print(f"Format: {result['format']}")
        print(f"Lines Read: {result['lines_read']} -> Rows Written: {result['lines_written']}")
        print(f"Original Size: {result['original_size_bytes']} bytes")
        print(f"Condensed Size: {result['condensed_size_bytes']} bytes")
        print(f"Space Reduction: {result['reduction_percentage']}%")
        print(f"Elapsed: {result['elapsed_seconds']}s")
        print("\nJSON Result:")
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
