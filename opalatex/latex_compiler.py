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

def compile_latex(tex_content: str, file_path: str = None) -> dict:
    """
    Compiles LaTeX content using Tectonic.
    Returns a dictionary with:
    - success (bool): True if compilation succeeded
    - pdf_base64 (str): Base64 encoded PDF string if success
    - log (str): Output log from the compiler
    """
    # Create a temporary directory
    temp_dir = tempfile.mkdtemp()
    
    tex_file_path = os.path.join(temp_dir, "document.tex")
    
    try:
        with open(tex_file_path, "w", encoding="utf-8") as f:
            f.write(tex_content)
            
        tectonic_cmd = get_tectonic_path()
        # Run tectonic
        # We use --keep-logs to keep the log file if needed, but stdout/stderr is usually enough
        result = subprocess.run(
            [tectonic_cmd, tex_file_path],
            cwd=temp_dir,
            capture_output=True,
            text=True
        )
        
        success = result.returncode == 0
        pdf_base64 = None
        log = result.stdout + "\n" + result.stderr
        
        if success:
            pdf_path = os.path.join(temp_dir, "document.pdf")
            if os.path.exists(pdf_path):
                # If a real file_path was provided, copy the PDF there
                if file_path:
                    try:
                        target_pdf = os.path.splitext(file_path)[0] + ".pdf"
                        shutil.copy2(pdf_path, target_pdf)
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
