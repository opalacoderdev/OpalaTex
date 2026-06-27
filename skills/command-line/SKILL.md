---
name: command-line
description: Executes command-line operations to read, create, insert text, remove files and directories securely inside the project workspace.
---

# Command Line Skill

This skill provides the sub-agent with tools to manipulate files and directories securely, restricted to the project directory.

**FINDING FILES (CRITICAL):** Do not try to guess where files are located in the project. Always use tools like `get_project_overview` to find the correct file paths. As a last resort, if you cannot find the file, stop your turn and use the `send_message` tool to ask the user for the file's location.

## AVAILABLE TOOLS

        get_project_overview,
        read_file,
        read_content_pos,
        write_content_pos,
        run_command,
        run_background_command,
        run_interactive_command,
        search_conversation_history,
        exec


1. write_file: **Use `write_file` directly to create or overwrite any file.** Do NOT use `command_executor.py` for writing file content — shell quoting breaks with multi-line, HTML, CSS, or JavaScript content.

```
write_file("<relative_or_absolute_path>", "<full file content>")
```
Examples:
```
write_file("tictactoe.html", "<!DOCTYPE html>...")
write_file("src/utils.js", "function foo() {...}")
```

2. read_file: use read_file for directly access files without shell. For example:
```
read_file("<relative_or_absolute_path>")
```
Examples:
```
read_file("tictactoe.html")
read_file("src/utils.js")
```

3. read_content_pos: use read_content_pos for directly access file content at a specific line range without shell. For example:
```
read_content_pos("<relative_or_absolute_path>", "<start_line>", "<end_line>")
```
Examples:
```
read_content_pos("tictactoe.html", "1", "10")
read_content_pos("src/utils.js", "10", "20")
```

4. write_content_pos: write_content_pos for directly access file content at a specific line range without shell. For example:
```
write_content_pos("<relative_or_absolute_path>", "<start_line>", "<end_line>", "<content>")
```
Examples:
```
write_content_pos("tictactoe.html", "1", "10", "<content>")
write_content_pos("src/utils.js", "10", "20", "<content>")
```

6. exec: use exec for directly access shell without shell. For example:
```
exec("<command>")
```
Examples (NON-INTERACTIVE commands only):
```
exec("ls -l")
exec("pwd")
exec("node --version")
exec("uv pip install django")
```
WARNING: Do NOT use `exec` for commands that require user input (like `npm create`, `npm init`, etc). For those, you MUST use `run_interactive_command`.

7. run_interactive_command: use this specifically for commands that require human interaction, choices, or input. It will open a popup terminal for the user.
```
run_interactive_command("npm create vite@latest app -- --template react")
run_interactive_command("npm init")
```

8. run_background_command: use this to start long-running servers or background processes in the main IDE terminal. It returns immediately and does not block.
```
run_background_command("npm run dev")
run_background_command("python manage.py runserver")
```

9. get_project_overview: use get_project_overview for directly access project tree of files. Try with a minimum depth of 5.
Example:
```
get_project_overview(5)
```

7. search_conversation_history: use search_conversation_history for directly search conversation history without shell. For example:
```
search_conversation_history("<keyword>")
```
Examples:
```
search_conversation_history("tictactoe")
search_conversation_history("src")
```

## Available Commands via command_executor.py

Consider using `run_python_script` to call `scripts/command_executor.py`  (insert text at a line, remove files/dirs, create empty directories). The syntax uses subcommands:

```
run_python_script("<command_executor.py_path>", "--project-path <project_path> <subcommand> <args>")
```

**Argument Explanation:**
- `<command_executor.py_path>`: The absolute path to the `command_executor.py` script.
- `<project_path>`: The path to the project root (e.g., `.`).
- `<subcommand> <args>`: The specific action you want to take (e.g., `remove-file`, `create-dir`) followed by its arguments.

**Concrete Examples:**

1. Creating a new directory:
`run_python_script("/home/user/skills/command-line/scripts/command_executor.py", "--project-path . create-dir src/components")`

2. Removing a file:
`run_python_script("/home/user/skills/command-line/scripts/command_executor.py", "--project-path . remove-file temp_debug.log")`

3. Renaming a directory:
`run_python_script("/home/user/skills/command-line/scripts/command_executor.py", "--project-path . rename old_folder new_folder")`

### 1. Insert Text

```
run_python_script("<command_executor.py_path>", "--project-path <project_path> insert-text <relative_file_path> --content-file /tmp/_opalatex_content.txt [--line <line_number>]")
```

For multi-line content, write it first with `write_file` to a temp path, then use `--content-file`.

### 2. Remove File
```
run_python_script("<command_executor.py_path>", "--project-path <project_path> remove-file <relative_file_path>")
```

### 3. Create Directory
```
run_python_script("<command_executor.py_path>", "--project-path <project_path> create-dir <relative_directory_path>")
```

### 4. Remove Directory
```
run_python_script("<command_executor.py_path>", "--project-path <project_path> remove-dir <relative_directory_path>")
```

### 5. Rename / Move File or Directory
```
run_python_script("<command_executor.py_path>", "--project-path <project_path> rename <relative_origin_path> <relative_dest_path>")
```

### 6. Copy File or Directory
```
run_python_script("<command_executor.py_path>", "--project-path <project_path> cp <relative_origin_path> <relative_dest_path>")
```
