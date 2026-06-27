import os
import sys
import argparse
import shutil


def validate_path(path, project_path):
    project_path = os.path.abspath(project_path)
    abs_path = os.path.abspath(os.path.join(project_path, path))
    if not abs_path.startswith(project_path):
        print(f"Error: Path '{path}' is outside project directory '{project_path}'", file=sys.stderr)
        sys.exit(1)
    return abs_path


def resolve_content(args):
    """Return content from --content-file if provided, else --content."""
    if hasattr(args, "content_file") and args.content_file:
        with open(args.content_file, "r", encoding="utf-8") as f:
            return f.read()
    return getattr(args, "content", "") or ""


def add_content_args(p, required=False):
    group = p.add_mutually_exclusive_group(required=required)
    group.add_argument("--content", default=None, help="Inline content (avoid for multi-line or HTML)")
    group.add_argument("--content-file", default=None, help="Path to a file whose contents to use (safe for any content)")


def main():
    parser = argparse.ArgumentParser(description="Command-line executor for files and directories")
    parser.add_argument("--project-path", default=os.getcwd(), help="Path to the project workspace")

    subparsers = parser.add_subparsers(dest="command", required=True)

    # create-file
    p_create_file = subparsers.add_parser("create-file")
    p_create_file.add_argument("path", help="Relative file path")
    add_content_args(p_create_file, required=False)

    # insert-text
    p_insert_text = subparsers.add_parser("insert-text")
    p_insert_text.add_argument("path", help="Relative file path")
    add_content_args(p_insert_text, required=True)
    p_insert_text.add_argument("--line", type=int, help="Line number (1-indexed) to insert before. If omitted, appends to the file.")

    # remove-file
    subparsers.add_parser("remove-file").add_argument("path", help="Relative file path")

    # create-dir
    subparsers.add_parser("create-dir").add_argument("path", help="Relative directory path")

    # remove-dir
    subparsers.add_parser("remove-dir").add_argument("path", help="Relative directory path")

    # rename
    p_rename = subparsers.add_parser("rename")
    p_rename.add_argument("origin", help="Relative origin path")
    p_rename.add_argument("dest", help="Relative destination path")

    # cp
    p_cp = subparsers.add_parser("cp")
    p_cp.add_argument("origin", help="Relative origin path")
    p_cp.add_argument("dest", help="Relative destination path")

    args = parser.parse_args()

    if args.command == "create-file":
        target = validate_path(args.path, args.project_path)
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        with open(target, "w", encoding="utf-8") as f:
            f.write(resolve_content(args))
        print(f"File created successfully: {args.path}")

    elif args.command == "insert-text":
        target = validate_path(args.path, args.project_path)
        if not os.path.exists(target):
            print(f"Error: File '{args.path}' does not exist.", file=sys.stderr)
            sys.exit(1)

        with open(target, "r", encoding="utf-8") as f:
            lines = f.readlines()

        content = resolve_content(args)
        if not content.endswith("\n"):
            content += "\n"

        if args.line is not None:
            idx = max(0, min(args.line - 1, len(lines)))
            lines.insert(idx, content)
        else:
            lines.append(content)

        with open(target, "w", encoding="utf-8") as f:
            f.writelines(lines)
        print(f"Text inserted successfully into {args.path}")

    elif args.command == "remove-file":
        target = validate_path(args.path, args.project_path)
        if os.path.isdir(target):
            print(f"Error: Path '{args.path}' is a directory, use remove-dir instead.", file=sys.stderr)
            sys.exit(1)
        if os.path.exists(target):
            os.remove(target)
            print(f"File removed successfully: {args.path}")
        else:
            print(f"Error: File '{args.path}' does not exist.", file=sys.stderr)
            sys.exit(1)

    elif args.command == "create-dir":
        target = validate_path(args.path, args.project_path)
        os.makedirs(target, exist_ok=True)
        print(f"Directory created successfully: {args.path}")

    elif args.command == "remove-dir":
        target = validate_path(args.path, args.project_path)
        if not os.path.isdir(target):
            print(f"Error: Path '{args.path}' is not a directory.", file=sys.stderr)
            sys.exit(1)
        if os.path.exists(target):
            shutil.rmtree(target)
            print(f"Directory removed successfully: {args.path}")
        else:
            print(f"Error: Directory '{args.path}' does not exist.", file=sys.stderr)
            sys.exit(1)

    elif args.command == "rename":
        origin = validate_path(args.origin, args.project_path)
        dest = validate_path(args.dest, args.project_path)
        if not os.path.exists(origin):
            print(f"Error: Origin '{args.origin}' does not exist.", file=sys.stderr)
            sys.exit(1)
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        os.rename(origin, dest)
        print(f"Renamed successfully from {args.origin} to {args.dest}")

    elif args.command == "cp":
        origin = validate_path(args.origin, args.project_path)
        dest = validate_path(args.dest, args.project_path)
        if not os.path.exists(origin):
            print(f"Error: Origin '{args.origin}' does not exist.", file=sys.stderr)
            sys.exit(1)
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        if os.path.isdir(origin):
            shutil.copytree(origin, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(origin, dest)
        print(f"Copied successfully from {args.origin} to {args.dest}")


if __name__ == "__main__":
    main()
