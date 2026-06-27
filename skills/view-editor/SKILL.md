---
name: view-editor
description: Allows inspecting the current file OPENED IN THE EDITOR, as well as the active text selection or full content.
---

# View Editor Skill

This skill allows you to inspect what file is currently open in the IDE editor, the full code content of the file, and any text highlighted/selected by the user.

## Usage

You may inspect the editor state by running the `run_view_editor.py` script.

Consider using the `run_python_script` tool:
`run_python_script("skills/view-editor/scripts/run_view_editor.py", "--project-path <project_path>")`

**Argument Explanation:**
- `<project_path>`: The absolute or relative path to the root directory of the current project you are working on. Usually, this is just `.` (the current directory) if you are already inside the project.

**Concrete Examples:**

1. If you are already at the root of the project:
`run_python_script("skills/view-editor/scripts/run_view_editor.py", "--project-path .")`

2. If your project is located at `/var/www/my-app`:
`run_python_script("skills/view-editor/scripts/run_view_editor.py", "--project-path /var/www/my-app")`

3. If you want to inspect a project located in a relative subfolder named `frontend`:
`run_python_script("skills/view-editor/scripts/run_view_editor.py", "--project-path ./frontend")`

This script locates the staged editor state inside the project folder at `.opalatex/_editor_state.json` and outputs the path, current selection, and full content in markdown.
