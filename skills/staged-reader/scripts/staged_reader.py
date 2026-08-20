"""Planning and reduction helper for the staged-reader skill.

This script never prints file content. Reading a window is `read_content_pos`'s
job (it is the tool that enforces the context budget); this script only answers
the two questions that tool cannot answer:

  plan     How big is the file, how many lines per window fit a char budget,
           and where does each window start/end? Streams the file in O(1)
           memory, so it is safe on files of any size.
  collect  Given the directory of per-window note files a staged read produced,
           concatenate them in line order into a single digest and report the
           coverage (and any gap) so a partial read is never mistaken for a
           complete one.
"""

import argparse
import os
import re
import sys

# Conservative default: ~12k characters is roughly 3k tokens, which fits the
# free-context budget read_content_pos enforces even on a small local window.
DEFAULT_BUDGET_CHARS = 12000
MIN_WINDOW_LINES = 10
MAX_WINDOW_LINES = 5000

NOTE_RE = re.compile(r"^win_(\d+)-(\d+)\.md$")


def _fmt(n):
    return f"{n:,}"


def census(path, sample_bytes_for_binary=8192):
    """Stream *path* once and return (total_lines, bytes, max_len, max_line, total_chars).

    Lengths are counted in decoded characters, because that is the unit
    read_content_pos budgets against.
    """
    total_lines = 0
    total_chars = 0
    max_len = 0
    max_line = 0
    decode_errors = 0
    with open(path, "rb") as f:
        head = f.read(sample_bytes_for_binary)
        if b"\x00" in head:
            raise ValueError(
                f"'{path}' looks binary (NUL bytes in the first {sample_bytes_for_binary} bytes). "
                "A staged read only works on text files."
            )
        f.seek(0)
        for raw in f:
            total_lines += 1
            try:
                line = raw.decode("utf-8")
            except UnicodeDecodeError:
                line = raw.decode("latin-1")
                decode_errors += 1
            n = len(line)
            total_chars += n
            if n > max_len:
                max_len = n
                max_line = total_lines
    size = os.path.getsize(path)
    return total_lines, size, max_len, max_line, total_chars, decode_errors


def suggest_window(total_lines, total_chars, max_len, budget_chars):
    """Return a window size in lines that keeps a window under *budget_chars*."""
    if total_lines <= 0:
        return MIN_WINDOW_LINES
    avg = max(1.0, total_chars / total_lines)
    window = int(budget_chars // avg)
    if max_len > budget_chars:
        # A single line already blows the budget; small windows keep the damage
        # (and the truncation read_content_pos will report) localized.
        window = min(window, MIN_WINDOW_LINES)
    return max(MIN_WINDOW_LINES, min(MAX_WINDOW_LINES, window))


def cmd_plan(args):
    path = os.path.abspath(args.file)
    if not os.path.isfile(path):
        print(f"Error: file not found: {path}", file=sys.stderr)
        return 1
    try:
        total_lines, size, max_len, max_line, total_chars, decode_errors = census(path)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    budget = args.budget_chars
    window = args.window or suggest_window(total_lines, total_chars, max_len, budget)
    start = max(1, args.start)
    avg = (total_chars / total_lines) if total_lines else 0

    remaining = max(0, total_lines - start + 1)
    windows = (remaining + window - 1) // window if window else 0

    print(f"FILE: {path}")
    print(f"BYTES: {_fmt(size)}")
    print(f"TOTAL_LINES: {_fmt(total_lines)}")
    print(f"AVG_LINE_CHARS: {avg:.0f}")
    print(f"LONGEST_LINE: {_fmt(max_len)} chars (line {_fmt(max_line)})")
    print(f"BUDGET_CHARS: {_fmt(budget)}")
    print(f"WINDOW_LINES: {_fmt(window)} (~{_fmt(int(window * avg))} chars per window)")
    print(f"WINDOWS_FROM_{_fmt(start)}: {_fmt(windows)}")

    shown = min(windows, args.max_windows)
    if shown:
        print("SCHEDULE:")
        for i in range(shown):
            w_start = start + i * window
            w_end = min(total_lines, w_start + window - 1)
            print(f"  {i + 1}: {w_start}-{w_end}")
        if windows > shown:
            print(f"  ... {_fmt(windows - shown)} more window(s) after line "
                  f"{start + shown * window - 1}")
    print(f"NEXT_START: {start if total_lines >= start else 'none'}")

    if max_len > budget:
        print(f"WARNING: line {_fmt(max_line)} alone is {_fmt(max_len)} chars and will be "
              "truncated by read_content_pos; expect a truncation note on that window.")
    if decode_errors:
        print(f"WARNING: {_fmt(decode_errors)} line(s) are not valid UTF-8 and were read as latin-1.")
    return 0


def _note_files(notes_dir):
    """Return [(start, end, path)] for well-named note files, sorted by start line."""
    entries = []
    unparsed = []
    for name in sorted(os.listdir(notes_dir)):
        full = os.path.join(notes_dir, name)
        if not os.path.isfile(full):
            continue
        m = NOTE_RE.match(name)
        if m:
            entries.append((int(m.group(1)), int(m.group(2)), full))
        else:
            unparsed.append(name)
    entries.sort(key=lambda e: (e[0], e[1]))
    return entries, unparsed


def cmd_collect(args):
    notes_dir = os.path.abspath(args.notes_dir)
    if not os.path.isdir(notes_dir):
        print(f"Error: notes directory not found: {notes_dir}", file=sys.stderr)
        return 1
    entries, unparsed = _note_files(notes_dir)
    if not entries:
        print(f"Error: no window notes named win_<start>-<end>.md found in {notes_dir}", file=sys.stderr)
        return 1

    output = os.path.abspath(args.output or os.path.join(notes_dir, "DIGEST.md"))
    gaps = []
    overlaps = []
    expected = entries[0][0]
    parts = []
    total_chars = 0
    for start, end, path in entries:
        if start > expected:
            gaps.append(f"{expected}-{start - 1}")
        elif start < expected:
            overlaps.append(f"{start}-{min(end, expected - 1)}")
        expected = max(expected, end + 1)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            body = f.read().strip()
        total_chars += len(body)
        parts.append(f"## Lines {start}-{end}\n\n{body}\n")

    header = (
        f"# Staged read digest\n\n"
        f"Source notes: {notes_dir}\n"
        f"Windows: {len(entries)} covering lines {entries[0][0]}-{entries[-1][1]}\n"
        f"Gaps: {', '.join(gaps) if gaps else 'none'}\n\n"
    )
    with open(output, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(parts))

    print(f"NOTES_DIR: {notes_dir}")
    print(f"WINDOWS: {len(entries)}")
    print(f"COVERED: {entries[0][0]}-{entries[-1][1]}")
    print(f"GAPS: {', '.join(gaps) if gaps else 'none'}")
    if overlaps:
        print(f"OVERLAPS: {', '.join(overlaps)}")
    # The digest itself is not a window note; listing it as ignored every re-run
    # would read like a problem when it is just the previous output.
    unparsed = [n for n in unparsed if os.path.join(notes_dir, n) != output]
    if unparsed:
        print(f"IGNORED_FILES: {', '.join(unparsed)}")
    print(f"NOTES_CHARS: {_fmt(total_chars)}")
    print(f"OUTPUT: {output}")
    print(f"OUTPUT_CHARS: {_fmt(os.path.getsize(output))}")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Plan and reduce a staged (windowed) read of a large text file."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_plan = sub.add_parser("plan", help="Census a file and propose the window schedule")
    p_plan.add_argument("file", help="Path to the large text file")
    p_plan.add_argument("--window", type=int, default=0,
                        help="Force a window size in lines (default: derived from the budget)")
    p_plan.add_argument("--budget-chars", type=int, default=DEFAULT_BUDGET_CHARS,
                        help=f"Target characters per window (default {DEFAULT_BUDGET_CHARS})")
    p_plan.add_argument("--start", type=int, default=1, help="First line of the schedule (default 1)")
    p_plan.add_argument("--max-windows", type=int, default=10,
                        help="How many schedule rows to print (default 10)")
    p_plan.set_defaults(func=cmd_plan)

    p_collect = sub.add_parser("collect", help="Merge per-window notes into one digest")
    p_collect.add_argument("notes_dir", help="Directory holding win_<start>-<end>.md note files")
    p_collect.add_argument("--output", default=None,
                           help="Digest path (default: <notes_dir>/DIGEST.md)")
    p_collect.set_defaults(func=cmd_collect)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
