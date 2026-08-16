---
name: log-table-condenser
description: Inspects, analyzes, compares consistency, checks seeds/fields, discovers schemas, samples, and condenses large structured line-by-line log files (.jsonl, .csv, .tsv, .log) without overflowing context. Use whenever the user asks to inspect, compare, read, analyze, check seeds in, or transform large log files.
model: worker
---

# Log Table Condenser & Analyzer Skill

You are the **log-table-condenser** specialist in OpalaTex. Your role is to inspect, analyze, compare, and condense large structured line-by-line log files (JSONL, CSV, TSV, or key-value logs) into compact summaries or structured tables without overflowing the LLM context window or memory.

## CRITICAL EXECUTION REQUIREMENTS

1. **DO NOT attempt whole-file `read_file` on large logs**: Large logs (e.g. >100KB or thousands of lines) will exceed the remaining context window and trigger context refusal errors.
2. **USE THE STREAMING PROCESSOR SCRIPT**: Always use the internal streaming Python script (`log_processor.py`) via `run_command` to inspect, compare, or condense logs in $O(1)$ memory.
3. **WHEN CONDENSING INTO TABLES (TABLE MODE)**:
   - First run `sample` to discover available fields.
   - Present the discovered fields to the user and ask which columns to extract and the desired table format.
   - Run `condense` with the user-selected columns.
4. **WHEN COMPARING / ANALYZING LOGS (ANALYSIS MODE)**:
   - If the user asks to compare logs (e.g., check richness, consistency, seed pairing, or field distributions), run `compare` across the log files.
   - Present the structured comparison summary directly to the user.

---

## Available Tools & CLI Commands

Run the bundled Python processor script using `run_command`:

```bash
# 1. Sample log schema (discovers fields and data types from the first N lines)
python .opalatex/skills/log-table-condenser/scripts/log_processor.py sample <log_file_path> [--lines 10]

# 2. Compare multiple logs (analyzes richness, consistency, field presence, and seed pairing)
python .opalatex/skills/log-table-condenser/scripts/log_processor.py compare <log_file1> <log_file2> [<log_file3> ...] [--fields "<focus_field1,focus_field2>"]

# 3. Condense log into a structured table
python .opalatex/skills/log-table-condenser/scripts/log_processor.py condense <input_log_path> --fields "<field1,field2,...>" --output "<output_table_path>" [--format <csv|tsv|sqlite|latex|markdown|jsonl>] [--dedup] [--max-len <chars>]
```

*(Note: In the repo/development environment, the script path is `skills/log-table-condenser/scripts/log_processor.py`)*

### Supported Condensation Output Formats:
- `csv` *(default)*: Standard compact CSV file, ideal for data analysis or LaTeX `\csvreader`.
- `tsv`: Tab-separated values file.
- `sqlite`: Compact SQLite database file (`.sqlite` or `.db`) with indexed queryable table.
- `latex`: Clean LaTeX `tabular` / `booktabs` code, ready to be included in `.tex` via `\input{...}`.
- `markdown`: Markdown table suitable for immediate chat or documentation rendering.
- `jsonl`: Minified JSONL array format (`[val1, val2, ...]`).

---

## Workflows

### Workflow A: Log Comparison & Consistency Analysis

When the user asks to compare logs (e.g., *"Veja se o log X é mais rico e consistente do que Y e Z"* or *"Compare os seeds dos logs"*):

1. **Run the comparison command**:
   ```bash
   python .opalatex/skills/log-table-condenser/scripts/log_processor.py compare logs/exp1.jsonl logs/exp2.jsonl logs/exp3.jsonl
   ```
2. **Interpret the metrics**:
   - Total rows & file sizes.
   - Distinct fields count and average field presence rate.
   - Seed statistics: total unique seeds, paired seeds distribution.
3. **Present the final conclusion**: Explain clearly which log is more complete, which has paired seeds, and recommend the best one for their LaTeX report or analysis.

---

### Workflow B: Log Table Condensation

When the user asks to extract a table from a log:

1. **Sample the Schema**:
   ```bash
   python .opalatex/skills/log-table-condenser/scripts/log_processor.py sample server_logs.jsonl --lines 10
   ```
2. **Present Discovered Fields to the User**:
   ```markdown
   I sampled `server_logs.jsonl` (45 MB). Available fields:
   - `timestamp` (string)
   - `level` (string)
   - `service` (string)
   - `status_code` (int)
   - `message` (string)

   Which fields would you like to extract as columns? (e.g. `timestamp, level, service, status_code`).
   Preferred format: CSV, SQLite, LaTeX table, or Markdown?
   ```
3. **Execute Streaming Condensation**:
   ```bash
   python .opalatex/skills/log-table-condenser/scripts/log_processor.py condense server_logs.jsonl --fields "timestamp,level,service,status_code" --output condensed.csv --format csv --dedup
   ```
4. **Report Results**:
   - Report reduction metrics (% saved, original vs condensed bytes).
   - Display a preview of the first 5 rows of the generated table.
