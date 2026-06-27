import argparse
import os
import json
import sys

def main():
    parser = argparse.ArgumentParser(description="Inspect current editor state (file name, selection, full content).")
    parser.add_argument("--project-path", default=".", help="Path to the active project folder.")
    args, _ = parser.parse_known_args()

    project_path = os.path.abspath(args.project_path)
    state_file = os.path.join(project_path, ".opalatex", "_editor_state.json")

    if not os.path.exists(state_file):
        print(f"No editor state found at '{state_file}'. Check if the IDE has run any commands yet.")
        sys.exit(0)

    try:
        with open(state_file, "r", encoding="utf-8") as f:
            state = json.load(f)
    except Exception as e:
        print(f"Error reading editor state file: {e}")
        sys.exit(1)

    current_file = state.get("current_file", "")
    selected_text = state.get("selected_text", "")
    editor_content = state.get("editor_content", "")

    print("## Editor State")
    if current_file:
        print(f"- **Current File**: `{current_file}`")
    else:
        print("- **Current File**: (No file open in editor)")

    if selected_text:
        print("\n### Selected Text / Highlighted Code")
        print("```")
        print(selected_text)
        print("```")
    else:
        print("\n- **Selected Text**: (No active selection)")

    if editor_content:
        print("\n### Full Editor Content")
        print("```")
        print(editor_content)
        print("```")
    else:
        print("\n- **Full Editor Content**: (Editor is empty)")

if __name__ == "__main__":
    main()
