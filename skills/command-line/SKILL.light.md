# Command Line Skill (light)

Manipulate files/directories and run commands, restricted to the project workspace. Never guess a file location or line number — use `get_project_overview` or `search_code` first, unless the context already gives you the exact path/range/command.

## Tools
- `write_file(path, content)` — create or fully overwrite a file. Never build file content with shell echo/cat.
- `read_file(path)` — read a whole small file.
- `read_content_pos(path, start_line, end_line)` — read a line range.
- `write_content_pos(path, content, line_number)` — insert before a line.
- `replace_content_range(path, start_line, end_line, content)` — replace/delete an inclusive line range (empty content deletes).
- `search_code(pattern, path=".", regex=False)` — find text/regex matches with line numbers.
- `run_command(cmd)` — non-interactive shell command (build/test/compile). Never for commands needing input, and never for servers.
- `run_interactive_command(cmd)` — commands needing user input (e.g. `npm init`).
- `run_background_command(cmd)` — long-running servers/dev processes; returns immediately.
- `get_project_overview(depth)` — project file tree; only when the target file is unknown.
- `search_conversation_history(keyword)` — search past chat turns.
- `ask_question(question)` — ask the user for missing info mid-task.

## Large files
Never write a whole large file (~100+ lines) with `write_file` — output limits truncate the call. Use `replace_content_range`/`write_content_pos` for the specific range, or a small Python script run via `run_command` for bulk edits.

## command_executor.py (insert-text, remove/create/rename/copy)
`run_python_script("<command_executor.py_path>", "--project-path <project_path> <subcommand> <args>")`

Subcommands: `insert-text <path> --content-file <tmp_path> [--line <n>]` (write multi-line content to a temp file with `write_file` first), `remove-file <path>`, `create-dir <path>`, `remove-dir <path>`, `rename <from> <to>`, `cp <from> <to>`.
