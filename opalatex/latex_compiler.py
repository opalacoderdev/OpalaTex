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


def render_graphic_to_svg(graphic_source: str, project_path: str = "", preamble: str = "",
                          cache_key: str = "", graphic_engine: str = "") -> dict:
    """
    Render a single LaTeX graphic (tikzpicture / pgfplots / picture / chemfig
    / pstricks / forest) to inline SVG by compiling a minimal standalone
    document with Tectonic and converting the first page to SVG via PyMuPDF.

    This is used by the Rich Text editor (and the LaTeX preview) to display a
    live preview of figures inline, without needing to compile the full
    document.

    Args:
        graphic_source: The raw LaTeX body of the graphic environment, e.g.
            "\\begin{tikzpicture}\\draw ... \\end{tikzpicture}".
        project_path: Optional project directory used to discover a main file
            preamble (\\usepackage{tikz}, \\begin{document}, etc.).
        preamble: Optional explicit LaTeX preamble to inject before the
            graphic. Overrides auto-detection from the project main file.
        cache_key: Optional content-based cache key. When provided, identical
            cache_keys return the previously rendered SVG without re-compiling.
        graphic_engine: Optional hint for which engine the graphic uses
            ("tikz", "picture", "chemfig", "pstricks", "forest"). Only used
            to pick the auto-generated preamble when the caller did not pass
            one.

    Returns:
        dict with:
          - success (bool)
          - svg (str): SVG markup (XML) when success=True
          - log (str): compiler log on failure
          - cached (bool): True if result was served from cache
    """
    # ── In-process cache ────────────────────────────────────────────────────
    if not hasattr(render_graphic_to_svg, "_cache"):
        render_graphic_to_svg._cache = {}  # key -> {"svg": str, "ts": float}
    cache = render_graphic_to_svg._cache

    if cache_key and cache_key in cache:
        entry = cache[cache_key]
        return {"success": True, "svg": entry["svg"], "log": "", "cached": True}

    tectonic_cmd = get_tectonic_path()
    if not tectonic_cmd:
        return {
            "success": False,
            "svg": "",
            "log": "Error: 'tectonic' compiler is not installed or not found in PATH.",
            "cached": False,
        }

    # ── Build the standalone document ───────────────────────────────────────
    # Minimal article + standalone document class is the safest container
    # for arbitrary graphic snippets. `standalone` ensures the PDF bounding
    # box tightly fits the graphic, which gives a clean SVG.
    body = (graphic_source or "").strip()
    if not body:
        return {"success": False, "svg": "", "log": "Empty graphic source.", "cached": False}

    # Pick a default preamble per engine. Only used when the caller did not
    # supply one (either explicitly or via auto-detect from the project).
    engine = (graphic_engine or "tikz").lower()
    engine_preambles = {
        "tikz": (
            "\\documentclass[tikz,border=4pt]{standalone}\n"
            "\\usepackage{tikz}\n"
            "\\usepackage{pgfplots}\n"
            "\\pgfplotsset{compat=1.18}\n"
        ),
        "picture": (
            "\\documentclass[border=4pt]{standalone}\n"
        ),
        "chemfig": (
            "\\documentclass[border=4pt]{standalone}\n"
            "\\usepackage{tikz}\n"
            "\\usepackage{chemfig}\n"
        ),
        "pstricks": (
            "\\documentclass[border=4pt]{standalone}\n"
            "\\usepackage{pstricks}\n"
            "\\usepackage{pst-plot}\n"
        ),
        "forest": (
            "\\documentclass[border=4pt]{standalone}\n"
            "\\usepackage{tikz}\n"
            "\\usepackage{forest}\n"
        ),
    }
    default_preamble = engine_preambles.get(engine, engine_preambles["tikz"])

    # Auto-derive preamble from the project main file when the caller did not
    # supply one. This lets the user keep \\usepackage{tikz}, color libraries,
    # custom styles, etc. in their project's preamble and have them respected
    # by the inline preview.
    if not preamble and project_path and os.path.isdir(project_path):
        try:
            from opalatex.latex_compiler import guess_main_file
            main_rel = guess_main_file(project_path)
            if main_rel:
                main_full = os.path.abspath(os.path.join(project_path, main_rel))
                with open(main_full, "r", encoding="utf-8", errors="ignore") as f:
                    src = f.read()
                # Slice from the start to \\begin{document}: that holds the
                # \\documentclass line and all \\usepackage declarations.
                doc_idx = src.find("\\begin{document}")
                if doc_idx > 0:
                    preamble = src[:doc_idx]
        except Exception:
            preamble = preamble or ""

    if not preamble:
        preamble = default_preamble
    elif "\\documentclass" not in preamble:
        # Wrap the user preamble with a standalone class that fits the
        # graphic tight to its bounding box.
        preamble = default_preamble + preamble

    full_doc = (
        preamble
        + "\n\\begin{document}\n"
        + body
        + "\n\\end{document}\n"
    )

    # ── Compile in a fresh temp directory ───────────────────────────────────
    temp_dir = tempfile.mkdtemp(prefix="opalatex_graphic_")
    tex_path = os.path.join(temp_dir, "graphic.tex")
    pdf_path = os.path.join(temp_dir, "graphic.pdf")

    try:
        with open(tex_path, "w", encoding="utf-8") as f:
            f.write(full_doc)

        result = subprocess.run(
            [tectonic_cmd, tex_path],
            cwd=temp_dir,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode != 0 or not os.path.exists(pdf_path):
            return {
                "success": False,
                "svg": "",
                "log": (result.stdout or "") + "\n" + (result.stderr or ""),
                "cached": False,
            }

        # ── Convert first page to SVG via PyMuPDF ───────────────────────────
        try:
            import fitz  # PyMuPDF
        except ImportError:
            return {
                "success": False,
                "svg": "",
                "log": "Error: PyMuPDF (fitz) is not installed; required for SVG conversion.",
                "cached": False,
            }

        doc = fitz.open(pdf_path)
        if not doc or len(doc) == 0:
            return {
                "success": False,
                "svg": "",
                "log": "Error: PDF produced by tectonic has no pages.",
                "cached": False,
            }
        page = doc[0]
        # `get_svg_image(text_as_path=True)` embeds glyphs as <path> for
        # portable rendering in any browser.
        svg = page.get_svg_image(text_as_path=True)
        doc.close()

        if cache_key:
            import time as _t
            cache[cache_key] = {"svg": svg, "ts": _t.time()}
            # Cap cache size to avoid unbounded growth
            if len(cache) > 256:
                oldest = min(cache.items(), key=lambda kv: kv[1]["ts"])
                cache.pop(oldest[0], None)

        return {"success": True, "svg": svg, "log": "", "cached": False}
    except FileNotFoundError:
        return {
            "success": False,
            "svg": "",
            "log": "Error: 'tectonic' compiler is not installed or not found in PATH.",
            "cached": False,
        }
    except Exception as e:
        return {
            "success": False,
            "svg": "",
            "log": f"Unexpected error rendering graphic: {e}",
            "cached": False,
        }
    finally:
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass


def _resolve_include_path(project_path: str, file_path: str, source_tex: str) -> str:
    """Resolve a \\includegraphics file path against the project, honouring
    `..` relative to the .tex file that references it (LaTeX semantics).

    Returns the absolute path on disk if it exists, or an empty string when
    the file cannot be found / the project path escapes the project tree.
    """
    if not project_path or not file_path:
        return ""
    project_abs = os.path.abspath(project_path)
    anchor_dir = project_abs
    if source_tex:
        candidate = os.path.abspath(os.path.join(project_abs, source_tex))
        if os.path.isdir(candidate):
            anchor_dir = candidate
        else:
            anchor_dir = os.path.dirname(candidate)
    full_path = os.path.abspath(os.path.join(anchor_dir, file_path))
    # Safety: the resolved path must remain inside the project tree.
    if not full_path.startswith(project_abs + os.sep) and full_path != project_abs:
        return ""
    if not os.path.exists(full_path) or os.path.isdir(full_path):
        return ""
    return full_path


def render_include_to_png(project_path: str, file_path: str, source_tex: str = "",
                          output: str = "auto", page: int = 0, dpi: int = 144) -> dict:
    """
    Render an \\includegraphics target (PDF / PNG / JPG / GIF) to a
    browser-displayable payload so the Rich Text editor can show a preview of
    figures that simply embed a raster/vector image.

    For PDF inputs (and any vector format PyMuPDF can open) the requested
    page (default 0 = first) is rasterized at the given DPI to a PNG
    payload. For raster inputs (PNG / JPG / GIF / WEBP) the file is returned
    as-is when ``output == 'auto'`` so the browser can display it without a
    conversion round-trip.

    Args:
        project_path: project root (used as the security boundary).
        file_path: path of the asset, possibly with `..` segments relative
            to the source .tex file.
        source_tex: project-relative path of the .tex that contains the
            \\includegraphics (used as the anchor for `..`).
        output: "auto" (default) chooses per MIME type; "png" forces
            rasterization (returns a PNG even for raster inputs).
        page: 0-indexed page number for multi-page PDFs.
        dpi: rasterization resolution (default 144).

    Returns:
        dict with:
          - success (bool)
          - mime (str): MIME type of the returned payload
          - data (bytes): the payload bytes (PNG or original image)
          - error (str): error message on failure
    """
    full_path = _resolve_include_path(project_path, file_path, source_tex)
    if not full_path:
        return {
            "success": False,
            "mime": "",
            "data": b"",
            "error": f"File not found: {file_path}",
        }

    ext = os.path.splitext(full_path)[1].lower()
    raster_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

    # ── Raster inputs: pass through when "auto", force PNG otherwise ───────
    if ext in raster_exts and output == "auto":
        try:
            with open(full_path, "rb") as f:
                content = f.read()
            import mimetypes
            mime = mimetypes.guess_type(full_path)[0] or "application/octet-stream"
            return {"success": True, "mime": mime, "data": content, "error": ""}
        except Exception as e:
            return {"success": False, "mime": "", "data": b"", "error": str(e)}

    # ── Vector / multi-page inputs: rasterize with PyMuPDF ────────────────
    try:
        import fitz
    except ImportError:
        return {
            "success": False,
            "mime": "",
            "data": b"",
            "error": "PyMuPDF (fitz) is not installed; required for image preview.",
        }

    try:
        doc = fitz.open(full_path)
        if not doc or len(doc) == 0:
            return {
                "success": False,
                "mime": "",
                "data": b"",
                "error": f"Empty document: {file_path}",
            }
        idx = max(0, min(page, len(doc) - 1))
        page_obj = doc[idx]
        # Default zoom = dpi/72 (PDF points per inch).
        zoom = max(0.5, dpi / 72.0)
        matrix = fitz.Matrix(zoom, zoom)
        pix = page_obj.get_pixmap(matrix=matrix, alpha=False)
        png_bytes = pix.tobytes("png")
        doc.close()
        return {"success": True, "mime": "image/png", "data": png_bytes, "error": ""}
    except Exception as e:
        return {"success": False, "mime": "", "data": b"", "error": f"Render failed: {e}"}
