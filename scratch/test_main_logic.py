import os
import re

def is_independent(content: str) -> bool:
    """Check if the content contains a \\documentclass declaration."""
    # Remove all comments to avoid matching commented \documentclass
    content_no_comments = re.sub(r'%.*', '', content)
    return "\\documentclass" in content_no_comments

def get_includes(content: str) -> set:
    """Extract all included/inputted filenames from the content."""
    content_no_comments = re.sub(r'%.*', '', content)
    # Match \input{file}, \include{file}, \subfile{file}, \import{dir}{file}
    # This regex is simplified but covers most common cases.
    matches = re.findall(r'\\(?:input|include|subfile)\s*\{([^}]+)\}', content_no_comments)
    return set(matches)

def is_recursively_included(main_file_path: str, target_file_path: str, project_dir: str, visited=None) -> bool:
    """Check if target_file_path is included in main_file_path directly or indirectly."""
    if visited is None:
        visited = set()
    
    if main_file_path in visited:
        return False
    visited.add(main_file_path)

    if not os.path.exists(main_file_path):
        return False

    try:
        with open(main_file_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except Exception:
        return False

    includes = get_includes(content)
    target_basename = os.path.basename(target_file_path)
    target_no_ext = os.path.splitext(target_basename)[0]

    for inc in includes:
        inc_basename = os.path.basename(inc)
        inc_no_ext = os.path.splitext(inc_basename)[0]
        
        # Direct match
        if inc_basename == target_basename or inc_no_ext == target_no_ext:
            return True
            
        # Recursive match
        # Resolving include path relative to project_dir
        # TeX usually searches relative to the main file or project root
        possible_paths = [
            os.path.join(project_dir, inc),
            os.path.join(project_dir, inc + '.tex'),
            os.path.join(os.path.dirname(main_file_path), inc),
            os.path.join(os.path.dirname(main_file_path), inc + '.tex')
        ]
        
        for p in possible_paths:
            if os.path.exists(p) and os.path.isfile(p):
                if is_recursively_included(p, target_file_path, project_dir, visited):
                    return True

    return False

def determine_main_file_for_compilation(file_path: str, file_content: str, project_dir: str, project_main_file: str) -> str:
    """
    Determine which file should be compiled.
    Returns the basename of the file that should be passed to tectonic as the main file.
    """
    file_basename = os.path.basename(file_path)
    
    # 1. Independent files compile themselves
    if is_independent(file_content):
        return file_basename

    # 2. If it's dependent, check if it's included in the project's designated main file
    if project_main_file:
        main_full_path = os.path.join(project_dir, project_main_file)
        if os.path.exists(main_full_path):
            if file_basename == project_main_file:
                return project_main_file
            if is_recursively_included(main_full_path, file_path, project_dir):
                return project_main_file

    # 3. If not in project_main_file, check other independent files in the project
    try:
        for f in os.listdir(project_dir):
            if f.endswith(".tex") and f != project_main_file:
                f_path = os.path.join(project_dir, f)
                if os.path.isfile(f_path):
                    with open(f_path, "r", encoding="utf-8", errors="ignore") as file:
                        content = file.read()
                        if is_independent(content):
                            if is_recursively_included(f_path, file_path, project_dir):
                                return f
    except Exception:
        pass

    # 4. Fallback: use project_main_file if it exists, otherwise the file itself
    return project_main_file if project_main_file else file_basename

# test
if __name__ == "__main__":
    pass
