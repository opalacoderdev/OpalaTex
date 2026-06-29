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
                        # read first 4096 bytes to find \documentclass
                        if "\\documentclass" in file.read(4096):
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
        if file_path and os.path.exists(file_path):
            try:
                with open(file_path, "w", encoding="utf-8") as f:
                    f.write(tex_content)
            except Exception as e:
                pass # Ignore write errors here, might be read-only or not needed
                
        abs_main_file = os.path.abspath(os.path.join(project_dir, main_file))
        base_no_ext = os.path.splitext(os.path.basename(main_file))[0]
        pdf_path = os.path.join(project_dir, f"{base_no_ext}.pdf")
        
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
