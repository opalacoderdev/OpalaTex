import os
import sys
import subprocess
import tempfile
import shutil
import base64

def get_tectonic_path():
    """Find tectonic in the project bin directory or in PATH."""
    local_bin = os.path.join(os.path.dirname(os.path.dirname(__file__)), "bin")
    exe_name = "tectonic.exe" if sys.platform == "win32" else "tectonic"
    local_exe = os.path.join(local_bin, exe_name)
    
    if os.path.exists(local_exe):
        return local_exe
    
    # Fallback to PATH
    return shutil.which("tectonic")

import re

def is_independent(content: str) -> bool:
    """Check if the content contains a \\documentclass declaration."""
    if not content: return False
    content_no_comments = re.sub(r'%.*', '', content)
    return "\\documentclass" in content_no_comments

def get_includes(content: str) -> set:
    """Extract all included/inputted filenames from the content."""
    if not content: return set()
    content_no_comments = re.sub(r'%.*', '', content)
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
    Determine which file should be compiled based on whether it is dependent/independent
    and whether it is included in a main file.
    Returns a path relative to project_dir.
    """
    if not file_path:
        return project_main_file

    # Use relative path from project_dir so subdirectory files are found correctly
    try:
        file_rel_path = os.path.relpath(file_path, project_dir).replace('\\', '/')
    except ValueError:
        # On Windows, relpath fails when paths are on different drives
        file_rel_path = os.path.basename(file_path)
    
    # 1. Independent files compile themselves (have \documentclass)
    if is_independent(file_content):
        return file_rel_path

    # 2. If it's dependent, check if it's included in the project's designated main file
    if project_main_file and project_dir:
        main_full_path = os.path.join(project_dir, project_main_file)
        if os.path.exists(main_full_path):
            if file_rel_path == project_main_file:
                return project_main_file
            if is_recursively_included(main_full_path, file_path, project_dir):
                return project_main_file

    # 3. If not in project_main_file, check other independent files in the project
    if project_dir and os.path.isdir(project_dir):
        try:
            for f in os.listdir(project_dir):
                if f.endswith(".tex") and f != project_main_file:
                    f_path = os.path.join(project_dir, f)
                    if os.path.isfile(f_path):
                        try:
                            with open(f_path, "r", encoding="utf-8", errors="ignore") as file:
                                content = file.read()
                        except Exception:
                            continue
                        if is_independent(content):
                            if is_recursively_included(f_path, file_path, project_dir):
                                return f
        except Exception:
            pass

    # 4. Fallback: use project_main_file if provided, else the file's relative path
    return project_main_file if project_main_file else file_rel_path

def guess_main_file(project_dir: str) -> str:
    """Guess the main LaTeX file by looking for \\documentclass in all .tex files."""
    if not project_dir or not os.path.isdir(project_dir):
        return ""
    try:
        for f in os.listdir(project_dir):
            if f.endswith(".tex"):
                path = os.path.join(project_dir, f)
                if os.path.isfile(path):
                    with open(path, "r", encoding="utf-8", errors="ignore") as file:
                        if is_independent(file.read(4096)):
                            return f
    except Exception:
        pass
    return ""

def compile_latex(tex_content: str, file_path: str = None, main_file: str = "", project_dir: str = "") -> dict:
    """
    Compiles LaTeX content using Tectonic.
    Returns a dictionary with:
    - success (bool): True if compilation succeeded
    - pdf_base64 (str): Base64 encoded PDF string if success
    - log (str): Output log from the compiler
    """
    tectonic_cmd = get_tectonic_path()
    
    # Auto-resolve project_dir and main_file when project_dir or main_file is empty but we have file_path
    if not project_dir and file_path and os.path.isabs(file_path):
        project_dir = os.path.dirname(file_path)
        
    if project_dir and not main_file and file_path:
        guessed = guess_main_file(project_dir)
        main_file = guessed if guessed else os.path.basename(file_path)
            
    if main_file and project_dir:
        # Save the current file's content first to ensure the compiler sees the latest changes
        if file_path:
            try:
                os.makedirs(os.path.dirname(file_path), exist_ok=True)
                with open(file_path, "w", encoding="utf-8") as f:
                    f.write(tex_content)
            except Exception as e:
                pass # Ignore write errors here, might be read-only or not needed
                
        abs_main_file = os.path.abspath(os.path.join(project_dir, main_file))
        base_no_ext = os.path.splitext(os.path.basename(main_file))[0]
        # Tectonic writes the PDF next to the input file, not necessarily at project root
        pdf_path = os.path.join(os.path.dirname(abs_main_file), f"{base_no_ext}.pdf")
        synctex_path = os.path.join(os.path.dirname(abs_main_file), f"{base_no_ext}.synctex.gz")
        
        for p in [pdf_path, synctex_path]:
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass
        
        try:
            result = subprocess.run(
                [tectonic_cmd, "--synctex", abs_main_file],
                cwd=project_dir,
                capture_output=True,
                encoding="utf-8",
                errors="replace"
            )
            success = result.returncode == 0
            log = result.stdout + "\n" + result.stderr
            pdf_base64 = None
            if success and os.path.exists(pdf_path):
                with open(pdf_path, "rb") as pdf_file:
                    pdf_base64 = base64.b64encode(pdf_file.read()).decode('utf-8')
            else:
                success = False
                log += "\nError: PDF file was not generated despite 0 exit code."
            
            return {
                "success": success,
                "pdf_base64": pdf_base64,
                "log": log
            }
        except FileNotFoundError:
            return {
                "success": False,
                "pdf_base64": None,
                "log": "Error: 'tectonic' compiler is not installed or not found in PATH.\nPlease install it from https://tectonic-typesetting.github.io/"
            }
        except Exception as e:
            return {
                "success": False,
                "pdf_base64": None,
                "log": f"An unexpected error occurred: {str(e)}"
            }

    # Fallback: single file compilation in temp directory
    temp_dir = tempfile.mkdtemp()
    
    base_name = os.path.basename(file_path) if file_path else "document.tex"
    base_no_ext = os.path.splitext(base_name)[0]
    tex_file_path = os.path.join(temp_dir, base_name)
    
    if file_path:
        target_pdf = os.path.splitext(file_path)[0] + ".pdf"
        target_synctex = os.path.splitext(file_path)[0] + ".synctex.gz"
        for p in [target_pdf, target_synctex]:
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass
    
    try:
        with open(tex_file_path, "w", encoding="utf-8") as f:
            f.write(tex_content)
            
        # Run tectonic
        result = subprocess.run(
            [tectonic_cmd, "--synctex", tex_file_path],
            cwd=temp_dir,
            capture_output=True,
            encoding="utf-8",
            errors="replace"
        )
        
        success = result.returncode == 0
        pdf_base64 = None
        log = result.stdout + "\n" + result.stderr
        
        if success:
            pdf_path = os.path.join(temp_dir, f"{base_no_ext}.pdf")
            if os.path.exists(pdf_path):
                # If a real file_path was provided, copy the PDF there
                if file_path:
                    try:
                        target_pdf = os.path.splitext(file_path)[0] + ".pdf"
                        shutil.copy2(pdf_path, target_pdf)
                        
                        # Copy synctex file if it exists
                        synctex_path = os.path.join(temp_dir, f"{base_no_ext}.synctex.gz")
                        if os.path.exists(synctex_path):
                            target_synctex = os.path.splitext(file_path)[0] + ".synctex.gz"
                            shutil.copy2(synctex_path, target_synctex)
                    except Exception as copy_err:
                        log += f"\nWarning: could not save PDF to {file_path}'s directory: {copy_err}"
                        
                with open(pdf_path, "rb") as pdf_file:
                    pdf_base64 = base64.b64encode(pdf_file.read()).decode('utf-8')
            else:
                success = False
                log += "\nError: PDF file was not generated despite 0 exit code."
                
        return {
            "success": success,
            "pdf_base64": pdf_base64,
            "log": log
        }
        
    except FileNotFoundError:
        return {
            "success": False,
            "pdf_base64": None,
            "log": "Error: 'tectonic' compiler is not installed or not found in PATH.\nPlease install it from https://tectonic-typesetting.github.io/"
        }
    except Exception as e:
        return {
            "success": False,
            "pdf_base64": None,
            "log": f"An unexpected error occurred: {str(e)}"
        }
    finally:
        # Cleanup temp directory
        try:
            shutil.rmtree(temp_dir)
        except Exception:
            pass
