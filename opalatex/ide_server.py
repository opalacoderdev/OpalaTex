import sys
import os
import io
import base64
from opalatex.i18n import _ as get_translation

# ── Force UTF-8 on all I/O streams (critical for PyInstaller --windowed) ─────
os.environ["PYTHONUTF8"] = "1"

def _force_utf8_stream(stream):
    """Return a UTF-8 stream, or a safe fallback wrapper."""
    if stream is None:
        return stream
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
        return stream
    except Exception:
        pass
    try:
        binary = getattr(stream, "buffer", None)
        if binary is not None:
            wrapper = io.TextIOWrapper(binary, encoding="utf-8", errors="replace", line_buffering=True)
            wrapper.mode = getattr(stream, "mode", "w")
            return wrapper
    except Exception:
        pass
    class _UnicodeSafeStream:
        encoding = "utf-8"
        def __init__(self, s): self._stream = s
        def write(self, text):
            try: self._stream.write(text)
            except UnicodeEncodeError:
                try: self._stream.write(text.encode("utf-8", "replace").decode("ascii", "replace"))
                except Exception: pass
            except Exception: pass
        def flush(self):
            try: self._stream.flush()
            except Exception: pass
        def __getattr__(self, name): return getattr(self._stream, name)
    return _UnicodeSafeStream(stream)

sys.stdout = _force_utf8_stream(sys.stdout)
sys.stderr = _force_utf8_stream(sys.stderr)

import asyncio
import os
import json
import urllib.parse
import mimetypes
import subprocess
def get_file_tree(dir_path, root_path=None):
    if root_path is None:
        root_path = dir_path
    
    files = []
    try:
        items = os.listdir(dir_path)
    except Exception:
        return []
        
    for item in items:
        # Skip heavy/hidden directories
        if item in ['node_modules', '.git', '.venv', '.env', '__pycache__', '.pytest_cache']:
            continue
            
        full_path = os.path.join(dir_path, item)
        rel_path = os.path.relpath(full_path, root_path)
        
        is_dir = os.path.isdir(full_path)
        if is_dir:
            files.append({
                "name": item,
                "path": rel_path,
                "isDirectory": True,
                "children": get_file_tree(full_path, root_path)
            })
        else:
            files.append({
                "name": item,
                "path": rel_path,
                "isDirectory": False
            })
            
    # Sort: directories first, then alphabetical
    files.sort(key=lambda x: (not x["isDirectory"], x["name"].lower()))
    return files

_MODEL_PARAMS_SCHEMA = {
    "temperature": {"type": float, "min": 0.0, "max": 2.0},
    "max_tokens": {"type": int, "min": 1},
    "num_ctx": {"type": int, "min": 1},
    "seed": {"type": int, "min": 0},
    "top_p": {"type": float, "min": 0.0, "max": 1.0},
    "frequency_penalty": {"type": float, "min": -2.0, "max": 2.0},
    "presence_penalty": {"type": float, "min": -2.0, "max": 2.0},
    "top_k": {"type": int, "min": 1},
    "min_p": {"type": float, "min": 0.0, "max": 1.0},
    "repetition_penalty": {"type": float, "min": 0.0},
    "think": {"type": bool},
    "stream": {"type": bool},
    "reasoning_effort": {"type": str, "choices": ["none", "low", "medium", "high", "xhigh"]},
    # Vision / attachment settings
    "force_vision": {"type": bool},
    "pdf_truncate": {"type": bool},
    "pdf_truncate_pct": {"type": int, "min": 1, "max": 100},
    # Agent / MemGPT settings
    "max_heartbeats": {"type": int, "min": 1},
    "max_context_tokens": {"type": int, "min": 1},
    "eviction_threshold": {"type": float, "min": 0.0, "max": 1.0},
    "memory_pressure_threshold": {"type": float, "min": 0.0, "max": 1.0},
    "max_iterations": {"type": int, "min": 1},
    "max_tool_calls": {"type": int, "min": 1},
    "loop_detection": {"type": bool},
    "loop_detection_limit": {"type": int, "min": 1},
    "response_mode": {"type": str, "choices": ["last", "all"]},
    "debug": {"type": bool},
    "tool_role_workaround": {"type": str, "choices": ["user", "assistant", ""]},
}

def sanitize_model_params(params: dict) -> dict:
    """Sanitize and validate model_params to prevent invalid inputs breaking Ollama/LiteLLM."""
    if not isinstance(params, dict):
        return {}
    
    sanitized = {}
    for k, v in params.items():
        if k not in _MODEL_PARAMS_SCHEMA:
            continue
            
        if v is None or v == "":
            continue
            
        spec = _MODEL_PARAMS_SCHEMA[k]
        t = spec["type"]
        
        # Parse string representation
        if isinstance(v, str):
            v_str = v.strip()
            if t is bool:
                v = v_str.lower() in ("true", "1", "yes", "on", "checked")
            elif t is float:
                v_str = v_str.replace(",", ".")
                try:
                    v = float(v_str)
                except ValueError:
                    continue
            elif t is int:
                try:
                    v = int(v_str)
                except ValueError:
                    continue
            elif t is str:
                v = v_str
        
        # Coerce types
        try:
            if t is float:
                v = float(v)
            elif t is int:
                v = int(v)
            elif t is bool:
                v = bool(v)
            elif t is str:
                v = str(v)
                if "choices" in spec and v not in spec["choices"]:
                    continue
        except (ValueError, TypeError):
            continue
            
        # Clamp bounds
        if t in (float, int):
            if "min" in spec and v < spec["min"]:
                v = spec["min"]
            if "max" in spec and v > spec["max"]:
                v = spec["max"]
                
        sanitized[k] = v
        
    return sanitized

def _qt_invoke(fn):
    """Run fn() on the Qt main thread and return its result.

    QClipboard must be accessed from the main thread only.  The HTTP server
    runs on a background asyncio thread, so we marshal the call via a
    QMetaObject.invokeMethod + threading.Event round-trip.
    """
    import threading
    try:
        from PyQt6.QtWidgets import QApplication
        from PyQt6.QtCore import QObject, pyqtSlot, Qt

        app = QApplication.instance()
        if app is None:
            return None

        result_box = [None]
        done = threading.Event()

        class _Caller(QObject):
            @pyqtSlot()
            def call(self):
                try:
                    result_box[0] = fn()
                except Exception:
                    pass
                finally:
                    done.set()

        caller = _Caller()
        # Move to main thread so invokeMethod queues on the Qt event loop
        caller.moveToThread(app.thread())
        from PyQt6.QtCore import QMetaObject
        QMetaObject.invokeMethod(caller, 'call', Qt.ConnectionType.QueuedConnection)
        done.wait(timeout=3)
        return result_box[0]
    except Exception:
        return None


def _read_clipboard() -> str:
    # 1. In-process Qt (GNOME/Wayland): marshal to main thread so QClipboard is
    #    accessed safely from the asyncio background thread.
    result = _qt_invoke(lambda: __import__('PyQt6.QtWidgets', fromlist=['QApplication'])
                        .QApplication.instance().clipboard().text())
    if result is not None:
        return result

    # 2. Subprocess PyQt6 (Cinnamon/X11): a fresh QApplication in a subprocess
    #    can reach the X11 clipboard without needing the main-thread instance.
    try:
        import subprocess, sys, os
        r = subprocess.run(
            [sys.executable, '-c',
             'from PyQt6.QtWidgets import QApplication; app=QApplication([]);'
             ' print(app.clipboard().text(), end="")'],
            capture_output=True, text=True, timeout=3, env=os.environ.copy(),
        )
        if r.returncode == 0:
            return r.stdout
    except Exception:
        pass

    return ''


def _write_clipboard(text: str):
    # 1. In-process Qt (GNOME/Wayland)
    def _do_write():
        from PyQt6.QtWidgets import QApplication
        app = QApplication.instance()
        if app is not None:
            app.clipboard().setText(text)
            return True
        return False

    if _qt_invoke(_do_write):
        return True, ''

    # 2. Subprocess PyQt6 (Cinnamon/X11)
    try:
        import subprocess, sys, os
        escaped = text.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r')
        r = subprocess.run(
            [sys.executable, '-c',
             f'from PyQt6.QtWidgets import QApplication; app=QApplication([]);'
             f' app.clipboard().setText("{escaped}"); app.processEvents()'],
            capture_output=True, text=True, timeout=3, env=os.environ.copy(),
        )
        if r.returncode == 0:
            return True, ''
        return False, r.stderr or 'subprocess write failed'
    except Exception as e:
        return False, str(e)


class AsyncHTTPServer:
    def __init__(self, host="127.0.0.1", port=3000, static_dir=None):
        self.host = host
        self.port = port
        self.static_dir = static_dir
        self.active_queues = []
        self.active_terminal = None
        self.temp_terminals = {}
        self.active_agent_task = None

    async def start(self):
        self.server = await asyncio.start_server(self.handle_request, self.host, self.port)
        print(f"[IDE Backend] Python Async server running on http://{self.host}:{self.port}")

    def stop(self):
        # Fecha o terminal principal
        if self.active_terminal:
            try:
                self.active_terminal.close()
            except:
                pass
        # Fecha todos os terminais temporários
        for term_id, term in list(self.temp_terminals.items()):
            try:
                term.close()
            except:
                pass
        self.temp_terminals.clear()

    async def handle_request(self, reader, writer):
        import os, sys, subprocess, platform
        try:
            # Read request line
            request_line = await reader.readline()
            if not request_line:
                writer.close()
                return
                
            parts = request_line.decode('utf-8').strip().split()
            if len(parts) < 3:
                writer.close()
                return
                
            method, raw_path, _ = parts
            parsed_url = urllib.parse.urlparse(raw_path)
            path = parsed_url.path
            query = urllib.parse.parse_qs(parsed_url.query)
            
            # Read headers
            headers = {}
            while True:
                line = await reader.readline()
                line = line.decode('utf-8').strip()
                if not line:
                    break
                if ':' in line:
                    k, v = line.split(':', 1)
                    headers[k.strip().lower()] = v.strip()
                
            # Read body if Content-Length exists
            body = b""
            if 'content-length' in headers:
                content_length = int(headers['content-length'])
                body = await reader.readexactly(content_length)
                
            # Handle OPTIONS (CORS)
            if method == 'OPTIONS':
                self.send_cors(writer)
                return
                
            # Route API paths
            if path.startswith('/api/'):
                await self.route_api(method, path, query, headers, body, writer)
            else:
                # Serve static files
                await self.serve_static(path, writer)
                
        except Exception as e:
            print(f"Error handling request: {e}")
            try:
                writer.close()
            except:
                pass

    def send_response(self, writer, status_code, body, content_type="text/plain"):
        status_msg = "OK" if status_code == 200 else ("Not Found" if status_code == 404 else "Error")
        if (content_type.startswith("text/") or 
            content_type in ("application/javascript", "application/json", "image/svg+xml")):
            if "charset=" not in content_type:
                content_type += "; charset=utf-8"
        headers = (
            f"HTTP/1.1 {status_code} {status_msg}\r\n"
            f"Content-Type: {content_type}\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Access-Control-Allow-Origin: *\r\n"
            f"Connection: close\r\n\r\n"
        )
        writer.write(headers.encode('utf-8'))
        writer.write(body)
        writer.close()

    def send_cors(self, writer):
        headers = (
            "HTTP/1.1 200 OK\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Content-Type\r\n"
            "Connection: close\r\n\r\n"
        )
        writer.write(headers.encode('utf-8'))
        writer.close()

    async def serve_static(self, path, writer):
        if not self.static_dir:
            self.send_response(writer, 404, b"Not Found")
            return
            
        # Clean path and prevent directory traversal
        rel_path = path.lstrip('/')
        if not rel_path or rel_path == '':
            rel_path = 'index.html'
            
        full_path = os.path.abspath(os.path.join(self.static_dir, rel_path))
        if not full_path.startswith(os.path.abspath(self.static_dir)):
            self.send_response(writer, 403, b"Forbidden")
            return
            
        if not os.path.exists(full_path) or os.path.isdir(full_path):
            # For SPA router fallback to index.html
            full_path = os.path.join(self.static_dir, 'index.html')
            
        try:
            with open(full_path, 'rb') as f:
                content = f.read()
            mime_type, _ = mimetypes.guess_type(full_path)
            mime_type = mime_type or 'application/octet-stream'
            if (mime_type.startswith("text/") or 
                mime_type in ("application/javascript", "application/json", "image/svg+xml")):
                if "charset=" not in mime_type:
                    mime_type += "; charset=utf-8"
            
            headers = f"HTTP/1.1 200 OK\r\nContent-Type: {mime_type}\r\nContent-Length: {len(content)}\r\nConnection: close\r\n\r\n"
            writer.write(headers.encode('utf-8'))
            writer.write(content)
            await writer.drain()
            writer.close()
        except Exception as e:
            self.send_response(writer, 500, f"Error: {e}".encode('utf-8'))

    async def route_api(self, method, path, query, headers, body, writer):
        # Parse JSON body if present
        data = {}
        if body:
            try:
                data = json.loads(body.decode('utf-8'))
            except:
                pass

        # License Endpoints
        if path == '/api/license/status':
            try:
                from opalatex.licensing import check_license_status
                status = check_license_status()
                self.send_response(writer, 200, json.dumps(status).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
            return
            
        elif path == '/api/license/activate' and method == 'POST':
            try:
                from opalatex.licensing import activate_license
                key = data.get('key', '')
                result = activate_license(key)
                if result.get("success"):
                    self.send_response(writer, 200, json.dumps(result).encode('utf-8'), "application/json")
                else:
                    self.send_response(writer, 400, json.dumps(result).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
            return

        elif path == '/api/license/generate-trial' and method == 'POST':
            try:
                import urllib.request
                import urllib.error
                req = urllib.request.Request(
                    "https://opalacoder.com/api/license/generate-trial",
                    data=b"{}",
                    headers={"Content-Type": "application/json"}
                )
                try:
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        resp_data = json.loads(resp.read().decode('utf-8'))
                        if resp_data.get("success"):
                            from opalatex.licensing import _load_license_data, _save_license_data, get_machine_id
                            import time
                            
                            license_key = resp_data["licenseKey"]
                            expires_at = resp_data["expiresAtTs"]
                            
                            lic_data = _load_license_data()
                            lic_data["license_key"] = license_key
                            lic_data["is_trial"] = True
                            lic_data["expires_at"] = expires_at
                            lic_data["activation_date"] = time.time()
                            lic_data["machine_id"] = get_machine_id()
                            _save_license_data(lic_data)
                            
                            self.send_response(writer, 200, json.dumps({"success": True, "licenseKey": license_key}).encode('utf-8'), "application/json")
                        else:
                            self.send_response(writer, 400, json.dumps({"success": False, "error": "Server failed to generate license"}).encode('utf-8'), "application/json")
                except urllib.error.HTTPError as he:
                    err_msg = he.read().decode('utf-8')
                    try:
                        err_json = json.loads(err_msg)
                        self.send_response(writer, he.code, json.dumps({"success": False, "error": err_json.get("error", err_msg)}).encode('utf-8'), "application/json")
                    except:
                        self.send_response(writer, he.code, json.dumps({"success": False, "error": err_msg}).encode('utf-8'), "application/json")
                except Exception as ex:
                    self.send_response(writer, 500, json.dumps({"success": False, "error": str(ex)}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
            return


        # 0. Compile LaTeX
        if path == '/api/latex/compile':
            from opalatex.latex_compiler import compile_latex
            content = data.get('content', '')
            file_path = data.get('filePath', '')
            project_path = data.get('projectPath', '')
            
            if not content:
                self.send_response(writer, 400, b'{"error":"content is required"}', "application/json")
                return
            
            full_path = ""
            if file_path:
                if os.path.isabs(file_path):
                    full_path = os.path.abspath(file_path)
                elif project_path:
                    full_path = os.path.abspath(os.path.join(project_path, file_path))
                    
            if not project_path and full_path:
                project_path = os.path.dirname(full_path)
                
            main_file = ""
            if project_path:
                from opalatex.project import ProjectStore
                from opalatex.config import DEFAULT_DB_PATH
                store = ProjectStore(db_path=DEFAULT_DB_PATH)
                # Find project by path
                for p in store.list_projects():
                    if p.get("project_path") and os.path.normcase(os.path.abspath(os.path.expanduser(p["project_path"]))) == os.path.normcase(os.path.abspath(os.path.expanduser(project_path))):
                        main_file = p.get("main_file", "")
                        break
                
                from opalatex.latex_compiler import determine_main_file_for_compilation
                main_file = determine_main_file_for_compilation(full_path, content, project_path, main_file)
            
            # run compilation
            result = compile_latex(content, full_path, main_file, project_path)
            
            # Save the pdf bytes in memory to bypass WebView blob restrictions
            if result.get("success") and result.get("pdf_base64"):
                self.last_pdf_bytes = base64.b64decode(result["pdf_base64"])
            else:
                self.last_pdf_bytes = None
                
            self.send_response(writer, 200, json.dumps(result).encode('utf-8'), "application/json")
            return

        # 0.0.c Render a single includegraphics file (PDF/PNG/JPG) to inline
        #      PNG/SVG so the Rich Text editor can show a preview of figures
        #      that simply embed a raster/vector image. PDF inputs are rasterized
        #      to a single-page PNG via PyMuPDF; PNG/JPG/GIF are passed through
        #      (or also rasterized if a page number is requested).
        if path == '/api/latex/render-include' and method == 'GET':
            project_path = query.get('projectPath', [''])[0]
            file_path = query.get('filePath', [''])[0]
            source_tex = query.get('sourceTex', [''])[0]
            # When set, "auto" picks a sensible default per MIME type: PDF -> PNG
            # of page 1, PNG/JPG/GIF -> the file as-is.
            output = (query.get('output', ['auto'])[0] or 'auto').lower()

            if not project_path or not file_path:
                self.send_response(writer, 400, json.dumps({
                    "success": False, "error": "projectPath and filePath are required"
                }).encode('utf-8'), "application/json")
                return

            try:
                from opalatex.latex_compiler import render_include_to_png
                result = render_include_to_png(
                    project_path=project_path,
                    file_path=file_path,
                    source_tex=source_tex or "",
                    output=output,
                )
                if not result.get("success"):
                    self.send_response(writer, 200, json.dumps(result).encode('utf-8'), "application/json")
                    return
                # base64 is imported at the top of the module — no need to
                # re-import it here (and re-importing inside a try/except was
                # the source of "cannot access local variable 'base64'" when
                # the failure path short-circuited before the import ran).
                payload = json.dumps({
                    "success": True,
                    "mime": result["mime"],
                    "data_base64": base64.b64encode(result["data"]).decode("utf-8"),
                }).encode("utf-8")
                self.send_response(writer, 200, payload, "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({
                    "success": False, "error": f"Render include failed: {e}"
                }).encode('utf-8'), "application/json")
            return

        # 0.0.b Render a single LaTeX graphic (tikzpicture / pgfplots) to SVG
        #      Used by the Rich Text editor and the LaTeX live preview to show
        #      inline graphical previews without compiling the whole document.
        if path == '/api/latex/render-graphic' and method == 'POST':
            graphic = data.get('graphic', '')
            project_path = data.get('projectPath', '')
            preamble = data.get('preamble', '')
            cache_key = data.get('cacheKey', '')
            # Engine hint ("tikz", "picture", "chemfig", "pstricks", "forest").
            # The default ("tikz") keeps the original behaviour.
            graphic_engine = data.get('graphicEngine', '')

            if not graphic:
                self.send_response(writer, 400, json.dumps({
                    "success": False, "svg": "", "log": "graphic source is required"
                }).encode('utf-8'), "application/json")
                return

            try:
                from opalatex.latex_compiler import render_graphic_to_svg
                result = render_graphic_to_svg(
                    graphic_source=graphic,
                    project_path=project_path or "",
                    preamble=preamble or "",
                    cache_key=cache_key or "",
                    graphic_engine=graphic_engine or "",
                )
                self.send_response(writer, 200, json.dumps(result).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({
                    "success": False, "svg": "", "log": f"Render failed: {e}"
                }).encode('utf-8'), "application/json")
            return

        # 0.0 Check Tectonic
        elif path == '/api/latex/check-tectonic' and method == 'GET':
            from opalatex.latex_compiler import get_tectonic_path
            tectonic = get_tectonic_path()
            found = tectonic is not None
            self.send_response(writer, 200, json.dumps({"found": found}).encode('utf-8'), "application/json")
            return

        # 0.1 Serve Latest PDF
        if path == '/api/latex/pdf':
            if hasattr(self, 'last_pdf_bytes') and self.last_pdf_bytes:
                self.send_response(writer, 200, self.last_pdf_bytes, "application/pdf")
            else:
                self.send_response(writer, 404, b'No PDF generated yet.', "text/plain")
            return
            
        # 0.2 Check for existing PDF
        elif path == '/api/latex/check-pdf' and method == 'GET':
            file_path = query.get('filePath', [''])[0]
            project_path = query.get('projectPath', [''])[0]
            if file_path and os.path.isabs(file_path) and not project_path:
                project_path = os.path.dirname(file_path)
            if not file_path or not project_path:
                self.send_response(writer, 400, b'{"error":"filePath and projectPath are required"}', "application/json")
                return
            
            try:
                # Find main_file
                main_file = ""
                from opalatex.project import ProjectStore
                from opalatex.config import DEFAULT_DB_PATH
                store = ProjectStore(db_path=DEFAULT_DB_PATH)
                for p in store.list_projects():
                    if p.get("project_path") and os.path.normcase(os.path.abspath(os.path.expanduser(p["project_path"]))) == os.path.normcase(os.path.abspath(os.path.expanduser(project_path))):
                        main_file = p.get("main_file", "")
                        break

                full_path = os.path.abspath(os.path.join(project_path, file_path))
                file_content = ""
                try:
                    with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
                        file_content = f.read()
                except Exception:
                    pass

                from opalatex.latex_compiler import determine_main_file_for_compilation
                main_file = determine_main_file_for_compilation(full_path, file_content, project_path, main_file)
                
                if main_file:
                    full_path = os.path.abspath(os.path.join(project_path, main_file))
                else:
                    full_path = os.path.abspath(os.path.join(project_path, file_path))
                    
                target_pdf = os.path.splitext(full_path)[0] + ".pdf"
                if os.path.exists(target_pdf):
                    with open(target_pdf, "rb") as pdf_file:
                        pdf_base64 = base64.b64encode(pdf_file.read()).decode('utf-8')
                        
                    self.last_pdf_bytes = base64.b64decode(pdf_base64)
                    self.send_response(writer, 200, json.dumps({
                        "found": True,
                        "pdf_base64": pdf_base64
                    }).encode('utf-8'), "application/json")
                else:
                    self.send_response(writer, 200, json.dumps({"found": False}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
            return

        # 0.3 SyncTeX
        elif path == '/api/latex/synctex' and method == 'GET':
            from opalatex.synctex_parser import find_source_line, find_pdf_position
            
            action = query.get('action', [''])[0]
            file_path = query.get('filePath', [''])[0]
            project_path = query.get('projectPath', [''])[0]
            
            if file_path and os.path.isabs(file_path) and not project_path:
                project_path = os.path.dirname(file_path)
            if not file_path or not project_path or not action:
                self.send_response(writer, 400, b'{"error":"action, filePath and projectPath are required"}', "application/json")
                return
                
            try:
                # Resolve main_file from project settings if available
                main_file = ""
                from opalatex.project import ProjectStore
                from opalatex.config import DEFAULT_DB_PATH
                store = ProjectStore(db_path=DEFAULT_DB_PATH)
                for p in store.list_projects():
                    if p.get("project_path") and os.path.normcase(os.path.abspath(os.path.expanduser(p["project_path"]))) == os.path.normcase(os.path.abspath(os.path.expanduser(project_path))):
                        main_file = p.get("main_file", "")
                        break

                target_full_path = os.path.abspath(os.path.join(project_path, file_path))
                file_content = ""
                try:
                    with open(target_full_path, "r", encoding="utf-8", errors="ignore") as f:
                        file_content = f.read()
                except Exception:
                    pass

                from opalatex.latex_compiler import determine_main_file_for_compilation
                main_file = determine_main_file_for_compilation(target_full_path, file_content, project_path, main_file)

                if main_file:
                    main_full_path = os.path.abspath(os.path.join(project_path, main_file))
                else:
                    main_full_path = os.path.abspath(os.path.join(project_path, file_path))
                
                target_full_path = os.path.abspath(os.path.join(project_path, file_path))

                synctex_path = os.path.splitext(main_full_path)[0] + ".synctex.gz"
                
                if not os.path.exists(synctex_path):
                    self.send_response(writer, 404, b'{"error":"synctex file not found"}', "application/json")
                    return
                    
                if action == 'pdf2tex':
                    page = int(query.get('page', ['1'])[0])
                    x = float(query.get('x', ['0'])[0])
                    y = float(query.get('y', ['0'])[0])
                    result = find_source_line(synctex_path, page, x, y)
                    if result and 'file' in result:
                        abs_file = result['file']
                        if not os.path.isabs(abs_file):
                            abs_file = os.path.abspath(os.path.join(project_path, abs_file))
                        result['file'] = abs_file
                        # Also return a project-relative path so the frontend can compare
                        # against selectedFile (which is always relative to project_path)
                        try:
                            rel_file = os.path.relpath(abs_file, project_path).replace('\\', '/')
                        except ValueError:
                            rel_file = abs_file
                        result['relFile'] = rel_file
                    self.send_response(writer, 200, json.dumps({"result": result}).encode('utf-8'), "application/json")
                elif action == 'tex2pdf':
                    line = int(query.get('line', ['1'])[0])
                    result = find_pdf_position(synctex_path, target_full_path, line)
                    self.send_response(writer, 200, json.dumps({"result": result}).encode('utf-8'), "application/json")
                else:
                    self.send_response(writer, 400, b'{"error":"invalid action"}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
            return

        # 1. List Files
        if path == '/api/files':
            project_path = query.get('projectPath', [None])[0]
            if not project_path:
                self.send_response(writer, 400, b'{"error":"projectPath parameter is required"}', "application/json")
                return
            if not os.path.exists(project_path) or not os.path.isdir(project_path):
                self.send_response(writer, 404, b'{"error":"Directory not found"}', "application/json")
                return
            try:
                tree = get_file_tree(project_path)
                self.send_response(writer, 200, json.dumps({"files": tree}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 2. Read File
        elif path == '/api/file/read':
            project_path = query.get('projectPath', [None])[0]
            file_path = query.get('filePath', [None])[0]
            if not project_path or not file_path:
                self.send_response(writer, 400, b'{"error":"projectPath and filePath are required"}', "application/json")
                return
            full_path = os.path.abspath(os.path.join(project_path, file_path))
            if not full_path.startswith(os.path.abspath(project_path)):
                self.send_response(writer, 403, b'{"error":"Forbidden: Path traversal detected"}', "application/json")
                return
            if not os.path.exists(full_path) or os.path.isdir(full_path):
                self.send_response(writer, 404, b'{"error":"File not found"}', "application/json")
                return
            try:
                with open(full_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.send_response(writer, 200, json.dumps({"content": content}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 2.2 Read Raw File (for inline images/assets)
        elif path == '/api/file/raw':
            project_path = query.get('projectPath', [None])[0]
            file_path = query.get('filePath', [None])[0]
            # The .tex file that contains the \includegraphics{} reference.
            # When provided, `..` segments in `file_path` are resolved
            # relative to this file's directory (LaTeX semantics) instead of
            # the project root, which is what users expect when they write
            # \includegraphics{../illustrations/foo.pdf}.
            source_tex = query.get('sourceTex', [None])[0]
            if not project_path or not file_path:
                self.send_response(writer, 400, b'{"error":"projectPath and filePath are required"}', "application/json")
                return
            project_abs = os.path.abspath(project_path)
            # Anchor directory: prefer the .tex file's directory so that
            # `..` is resolved locally; fall back to the project root when
            # the source file is not known.
            anchor_dir = project_abs
            if source_tex:
                candidate = os.path.abspath(os.path.join(project_abs, source_tex))
                if os.path.isdir(candidate):
                    anchor_dir = candidate
                else:
                    anchor_dir = os.path.dirname(candidate)
            full_path = os.path.abspath(os.path.join(anchor_dir, file_path))
            # Final safety: the resolved path must still be inside the
            # project directory tree. This keeps path-traversal hardening
            # intact (e.g. `../../etc/passwd` is still rejected).
            if not full_path.startswith(project_abs + os.sep) and full_path != project_abs:
                self.send_response(writer, 403, b'{"error":"Forbidden: Path traversal detected"}', "application/json")
                return
            if not os.path.exists(full_path) or os.path.isdir(full_path):
                self.send_response(writer, 404, b'{"error":"File not found"}', "application/json")
                return
            try:
                import mimetypes
                content_type, _ = mimetypes.guess_type(full_path)
                if not content_type:
                    content_type = "application/octet-stream"
                with open(full_path, 'rb') as f:
                    content = f.read()
                self.send_response(writer, 200, content, content_type)
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 2.5 Read File from Shadow Git (or normal Git)
        elif path == '/api/git/file-at-head':
            project_path = query.get('projectPath', [None])[0]
            file_path = query.get('filePath', [None])[0]
            use_shadow = query.get('shadow', ['false'])[0].lower() == 'true'
            if not project_path or not file_path:
                self.send_response(writer, 400, b'{"error":"projectPath and filePath are required"}', "application/json")
                return
            
            try:
                # Git show HEAD:file expects file to be relative to the repo root
                if os.path.isabs(file_path):
                    try:
                        rel_path = os.path.relpath(file_path, project_path)
                    except ValueError:
                        rel_path = file_path
                else:
                    rel_path = file_path
                norm_file_path = rel_path.replace('\\', '/')
                
                import subprocess as sp
                if use_shadow:
                    shadow_git_dir = os.path.join(project_path, ".opalatex", ".shadowgit")
                    git_dir_arg = f"--git-dir={shadow_git_dir}"
                    work_tree_arg = f"--work-tree={project_path}"
                    result = sp.run(
                        ["git", git_dir_arg, work_tree_arg, "show", f"HEAD:{norm_file_path}"],
                        capture_output=True, cwd=project_path, text=True
                    )
                    source = "shadowgit"
                else:
                    result = sp.run(
                        ["git", "show", f"HEAD:{norm_file_path}"],
                        capture_output=True, cwd=project_path, text=True
                    )
                    source = "git"
                    
                if result.returncode == 0:
                    self.send_response(writer, 200, json.dumps({"content": result.stdout, "source": source}).encode('utf-8'), "application/json")
                    return
                else:
                    self.send_response(writer, 200, b'{"error":"Not found in git"}', "application/json")
                    return
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 3. Write File
        elif path == '/api/file/write' and method == 'POST':
            project_path = data.get('projectPath')
            file_path = data.get('filePath')
            content = data.get('content', '')
            if not project_path or not file_path:
                self.send_response(writer, 400, b'{"error":"projectPath and filePath are required"}', "application/json")
                return
            full_path = os.path.abspath(os.path.join(project_path, file_path))
            if not full_path.startswith(os.path.abspath(project_path)):
                self.send_response(writer, 403, b'{"error":"Forbidden: Path traversal detected"}', "application/json")
                return
            try:
                dir_path = os.path.dirname(full_path)
                os.makedirs(dir_path, exist_ok=True)
                with open(full_path, 'w', encoding='utf-8') as f:
                    f.write(content)
                
                # If writing an SVG file, automatically generate a PDF copy alongside it using PyMuPDF
                if file_path.endswith('.svg'):
                    try:
                        import fitz
                        pdf_path = os.path.splitext(full_path)[0] + '.pdf'
                        doc = fitz.open("svg", content.encode('utf-8'))
                        pdf_bytes = doc.convert_to_pdf()
                        pdf_doc = fitz.open("pdf", pdf_bytes)
                        pdf_doc.save(pdf_path)
                        pdf_doc.close()
                        doc.close()
                    except Exception as ex:
                        print(f"Error converting SVG to PDF: {ex}")
                
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 3.2. Create Directory
        elif path == '/api/file/mkdir' and method == 'POST':
            project_path = data.get('projectPath')
            dir_path = data.get('dirPath')
            if not project_path or not dir_path:
                self.send_response(writer, 400, b'{"error":"projectPath and dirPath are required"}', "application/json")
                return
            full_path = os.path.abspath(os.path.join(project_path, dir_path))
            if not full_path.startswith(os.path.abspath(project_path)):
                self.send_response(writer, 403, b'{"error":"Forbidden: Path traversal detected"}', "application/json")
                return
            try:
                os.makedirs(full_path, exist_ok=True)
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 3.4.5. Copy File/Directory
        elif path == '/api/file/copy' and method == 'POST':
            project_path = data.get('projectPath')
            source_path = data.get('sourcePath')
            target_path = data.get('targetPath')
            if not project_path or not source_path or not target_path:
                self.send_response(writer, 400, b'{"error":"projectPath, sourcePath and targetPath are required"}', "application/json")
                return
            full_source = os.path.abspath(os.path.join(project_path, source_path))
            full_target = os.path.abspath(os.path.join(project_path, target_path))
            if not full_source.startswith(os.path.abspath(project_path)) or not full_target.startswith(os.path.abspath(project_path)):
                self.send_response(writer, 403, b'{"error":"Forbidden: Path traversal detected"}', "application/json")
                return
            try:
                if not os.path.exists(full_source):
                    self.send_response(writer, 404, b'{"error":"Source file not found"}', "application/json")
                    return
                import shutil
                if os.path.exists(full_target):
                    base, ext = os.path.splitext(full_target)
                    counter = 1
                    while os.path.exists(full_target):
                        full_target = f"{base}_copy{counter if counter > 1 else ''}{ext}"
                        counter += 1
                
                os.makedirs(os.path.dirname(full_target), exist_ok=True)
                if os.path.isdir(full_source):
                    shutil.copytree(full_source, full_target)
                else:
                    shutil.copy2(full_source, full_target)
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 3.5. Delete File
        elif path == '/api/file/delete' and method == 'POST':
            project_path = data.get('projectPath')
            file_path = data.get('filePath')
            if not project_path or not file_path:
                self.send_response(writer, 400, b'{"error":"projectPath and filePath are required"}', "application/json")
                return
            full_path = os.path.abspath(os.path.join(project_path, file_path))
            if not full_path.startswith(os.path.abspath(project_path)):
                self.send_response(writer, 403, b'{"error":"Forbidden: Path traversal detected"}', "application/json")
                return
            try:
                if os.path.exists(full_path):
                    if os.path.isdir(full_path):
                        import shutil
                        shutil.rmtree(full_path)
                    else:
                        os.remove(full_path)
                    self.send_response(writer, 200, b'{"success":true}', "application/json")
                else:
                    self.send_response(writer, 404, b'{"error":"File not found"}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 3.6. Rename File/Directory
        elif path == '/api/file/rename' and method == 'POST':
            project_path = data.get('projectPath')
            old_path = data.get('oldPath')
            new_path = data.get('newPath')
            if not project_path or not old_path or not new_path:
                self.send_response(writer, 400, b'{"error":"projectPath, oldPath and newPath are required"}', "application/json")
                return
            full_old_path = os.path.abspath(os.path.join(project_path, old_path))
            full_new_path = os.path.abspath(os.path.join(project_path, new_path))
            if not full_old_path.startswith(os.path.abspath(project_path)) or not full_new_path.startswith(os.path.abspath(project_path)):
                self.send_response(writer, 403, b'{"error":"Forbidden: Path traversal detected"}', "application/json")
                return
            try:
                if os.path.exists(full_old_path):
                    os.makedirs(os.path.dirname(full_new_path), exist_ok=True)
                    os.rename(full_old_path, full_new_path)
                    self.send_response(writer, 200, b'{"success":true}', "application/json")
                else:
                    self.send_response(writer, 404, b'{"error":"Source file not found"}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 3.6.5. Open OS Explorer / Default App
        elif path == '/api/file/open-explorer' and method == 'POST':
            project_path = data.get('projectPath')
            file_path = data.get('filePath') # Optional
            
            if not project_path or not os.path.exists(project_path):
                self.send_response(writer, 400, b'{"error":"Valid projectPath is required"}', "application/json")
                return
                
            target_path = project_path
            if file_path:
                target_path = os.path.abspath(os.path.join(project_path, file_path))
                if not target_path.startswith(os.path.abspath(project_path)):
                    self.send_response(writer, 403, b'{"error":"Forbidden: Path traversal detected"}', "application/json")
                    return
                if not os.path.exists(target_path):
                    self.send_response(writer, 404, b'{"error":"File not found"}', "application/json")
                    return

            try:
                import subprocess, platform
                system = platform.system()
                
                # Strip PyInstaller's LD_LIBRARY_PATH so system apps (like nautilus or image viewers) don't crash
                env = os.environ.copy()
                if 'LD_LIBRARY_PATH_ORIG' in env:
                    env['LD_LIBRARY_PATH'] = env['LD_LIBRARY_PATH_ORIG']
                elif 'LD_LIBRARY_PATH' in env:
                    del env['LD_LIBRARY_PATH']

                if system == "Windows":
                    os.startfile(target_path)
                elif system == "Darwin":
                    subprocess.Popen(["open", target_path], env=env)
                else:
                    # Check if it's WSL (Windows Subsystem for Linux)
                    release = platform.uname().release.lower()
                    if "microsoft" in release or "wsl" in release:
                        # For WSL, we might need different logic if opening a file vs folder
                        if os.path.isdir(target_path):
                            subprocess.Popen(["explorer.exe", "."], cwd=target_path, env=env)
                        else:
                            # Not ideal but explorer.exe can open files in WSL if converted to win path, 
                            # easiest is wslview if available, otherwise xdg-open might work inside some WSL distros
                            subprocess.Popen(["xdg-open", target_path], env=env)
                    else:
                        subprocess.Popen(["xdg-open", target_path], env=env)
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 3.7. List subdirectories of a filesystem path
        elif path == '/api/fs/dirs':
            req_path = data.get('path')
            if not req_path or req_path == '~':
                try:
                    from opalatex.config import get_opalatex_home
                    req_path = os.path.dirname(get_opalatex_home())
                except ImportError:
                    req_path = os.path.expanduser('~')
            
            req_path = os.path.abspath(os.path.expanduser(req_path))
            
            if not os.path.exists(req_path) or not os.path.isdir(req_path):
                try:
                    from opalatex.config import get_opalatex_home
                    req_path = os.path.dirname(get_opalatex_home())
                except ImportError:
                    req_path = os.path.expanduser('~')
                if not os.path.exists(req_path) or not os.path.isdir(req_path):
                    req_path = os.path.expanduser('~')

            try:
                entries = []
                # Parent directory entry (except filesystem root)
                parent = os.path.dirname(req_path)
                if parent != req_path:
                    entries.append({"name": "..", "path": parent})
                else:
                    # At filesystem root. If Windows, list available drives so user can switch.
                    import sys
                    if sys.platform == 'win32':
                        import string
                        for d in string.ascii_uppercase:
                            drive = f"{d}:\\"
                            if drive != req_path and os.path.exists(drive):
                                entries.append({"name": f".. (Unidade {d}:)", "path": drive})

                for name in sorted(os.listdir(req_path)):
                    if name.startswith('.'):
                        continue
                    full = os.path.join(req_path, name)
                    if os.path.isdir(full):
                        entries.append({"name": name, "path": full})
                self.send_response(writer, 200, json.dumps({"current": req_path, "dirs": entries}).encode('utf-8'), "application/json")
            except PermissionError:
                self.send_response(writer, 403, json.dumps({"error": "Permission denied", "current": req_path, "dirs": []}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e), "current": req_path, "dirs": []}).encode('utf-8'), "application/json")

        # 3.8. Load refined model config from .opalatex/modelsconfig/<provider>/<model>.yaml
        elif path == '/api/opalatex/model-config':
            project_path = data.get('projectPath') or query.get('projectPath', [None])[0]
            model_id = data.get('model') or query.get('model', [None])[0]
            if not project_path or not model_id:
                self.send_response(writer, 400, b'{"error":"projectPath and model are required"}', "application/json")
                return

            # Normalise provider: ollama_chat/ and ollama/ both → "ollama"
            _PROVIDER_ALIASES = {"ollama_chat": "ollama"}
            if '/' in model_id:
                raw_provider, model_name = model_id.split('/', 1)
            else:
                raw_provider, model_name = "", model_id
            provider_dir = _PROVIDER_ALIASES.get(raw_provider, raw_provider)

            # Normalise model name: ':' → '__'
            yaml_name = model_name.replace(':', '__') + '.yaml'
            provider_dir_path = os.path.join(
                os.path.abspath(project_path),
                '.opalatex', 'modelsconfig', provider_dir
            )
            config_path = os.path.join(provider_dir_path, yaml_name)

            if not os.path.isfile(config_path):
                import re
                def normalize_for_match(name: str) -> str:
                    return re.sub(r'[-:_\s]+', '_', name).lower()
                
                target_norm = normalize_for_match(model_name)
                best_match = None
                best_len = 0
                
                if os.path.isdir(provider_dir_path):
                    for file in os.listdir(provider_dir_path):
                        if not file.endswith('.yaml'): continue
                        cand_name = file[:-5]
                        cand_norm = normalize_for_match(cand_name)
                        if target_norm.startswith(cand_norm):
                            if len(cand_norm) > best_len:
                                best_len = len(cand_norm)
                                best_match = file
                
                if best_match:
                    config_path = os.path.join(provider_dir_path, best_match)
                else:
                    # Fallback to checking the global assetstore
                    from opalatex.assetstore import list_assets
                    import zipfile
                    
                    modelconfigs = list_assets(asset_type="modelconfig")
                    global_match_meta = None
                    global_best_len = 0
                    for mcfg in modelconfigs:
                        m_id = mcfg.get("model", "")
                        if not m_id: continue
                        if '/' in m_id:
                            _, m_name = m_id.split('/', 1)
                        else:
                            m_name = m_id
                        c_norm = normalize_for_match(m_name)
                        if target_norm.startswith(c_norm):
                            if len(c_norm) > global_best_len:
                                global_best_len = len(c_norm)
                                global_match_meta = mcfg
                                
                    if global_match_meta:
                        try:
                            zpath = global_match_meta["_zip"]
                            import yaml as _yaml
                            with zipfile.ZipFile(zpath, "r") as zf:
                                yaml_files = [n for n in zf.namelist() if n.endswith('.yaml')]
                                if len(yaml_files) == 1:
                                    with zf.open(yaml_files[0]) as yf:
                                        config = _yaml.safe_load(yf) or {}
                                        
                                        # "Install" this config into the project's local folder
                                        try:
                                            os.makedirs(provider_dir_path, exist_ok=True)
                                            with open(os.path.join(provider_dir_path, yaml_name), "w", encoding="utf-8") as out_f:
                                                _yaml.dump(config, out_f, allow_unicode=True, default_flow_style=False)
                                        except Exception:
                                            pass

                                        new_model = None
                                        if 'provider' in config:
                                            new_provider = config.pop('provider')
                                            new_model = f"{new_provider}/{model_name}"
                                            
                                        self.send_response(writer, 200, json.dumps({
                                            "found": True,
                                            "model_params": config,
                                            "model": new_model,
                                        }).encode('utf-8'), "application/json")
                                        return
                        except Exception:
                            pass

                    self.send_response(writer, 404, json.dumps({
                        "found": False,
                        "message": f"--- ainda não temos parâmetros refinados para este modelo"
                    }).encode('utf-8'), "application/json")
                    return

            try:
                import yaml as _yaml
                with open(config_path, 'r', encoding='utf-8') as f:
                    config = _yaml.safe_load(f) or {}

                # Extract optional provider override and compute new model identity
                new_model = None
                if 'provider' in config:
                    new_provider = config.pop('provider')
                    new_model = f"{new_provider}/{model_name}"

                self.send_response(writer, 200, json.dumps({
                    "found": True,
                    "model_params": config,
                    "model": new_model,   # None if no provider override
                }).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 3.9. Export modelconfig package
        elif path == '/api/opalatex/export-modelconfig' and method == 'POST':
            project_path = data.get('projectPath')
            model_id = data.get('model')
            dest_path = data.get('destPath')
            if not project_path or not model_id or not dest_path:
                self.send_response(writer, 400, b'{"error":"projectPath, model and destPath are required"}', "application/json")
                return

            _PROVIDER_ALIASES = {"ollama_chat": "ollama"}
            if '/' in model_id:
                raw_provider, model_name = model_id.split('/', 1)
            else:
                raw_provider, model_name = "", model_id
            provider_dir = _PROVIDER_ALIASES.get(raw_provider, raw_provider)
            yaml_name = model_name.replace(':', '__') + '.yaml'
            model_params = data.get('modelParams') or {}

            try:
                import yaml as _yaml
                import tempfile
                import shutil
                from opalatex.assetstore import register_asset
                
                tmp_dir = tempfile.mkdtemp()
                try:
                    provider_path = os.path.join(tmp_dir, ".opalatex", "modelsconfig", provider_dir)
                    os.makedirs(provider_path, exist_ok=True)
                    yaml_path = os.path.join(provider_path, yaml_name)
                    
                    with open(yaml_path, 'w', encoding='utf-8') as tmp:
                        _yaml.dump(model_params, tmp, allow_unicode=True)
    
                    asset_id = f"{model_name.replace(':', '_')}"
                    metadata = {
                        "id": asset_id,
                        "type": "modelconfig",
                        "model": model_id,
                        "desc": f"Exported modelconfig for {model_id}"
                    }
                    
                    source_path = os.path.join(tmp_dir, ".opalatex")
                    dest_zip_file = os.path.join(os.path.abspath(dest_path), f"{asset_id}.zip")
                    dest_meta_file = os.path.join(os.path.abspath(dest_path), f"{asset_id}.metadata")
                    
                    import zipfile
                    with zipfile.ZipFile(dest_zip_file, "w", zipfile.ZIP_DEFLATED) as zf:
                        for root, dirs, files in os.walk(tmp_dir):
                            for f in files:
                                file_path = os.path.join(root, f)
                                arcname = os.path.relpath(file_path, tmp_dir)
                                zf.write(file_path, arcname)
                                
                    with open(dest_meta_file, "w", encoding="utf-8") as f:
                        _yaml.dump(metadata, f, allow_unicode=True, default_flow_style=False)
                        
                finally:
                    shutil.rmtree(tmp_dir)
                    
                self.send_response(writer, 200, json.dumps({
                    "success": True,
                    "dest": dest_zip_file
                }).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # Hardware Inference Endpoints
        elif path == '/api/hardware' and method == 'GET':
            from opalatex.hardware_store import get_or_detect_hardware
            info = get_or_detect_hardware()
            self.send_response(writer, 200, json.dumps(info).encode('utf-8'), "application/json")

        elif path == '/api/hardware/detect' and method == 'POST':
            from opalatex.hardware_detect import get_hardware_info
            from opalatex.hardware_store import save_hardware_info
            info = get_hardware_info()
            save_hardware_info(info)
            self.send_response(writer, 200, json.dumps(info).encode('utf-8'), "application/json")

        elif path == '/api/hardware/save' and method == 'POST':
            from opalatex.hardware_store import save_hardware_info
            try:
                save_hardware_info(data)
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # Onboarding / Ollama status endpoints
        elif path == '/api/onboarding/status' and method == 'GET':
            from opalatex.onboarding import is_onboarding_completed
            self.send_response(writer, 200, json.dumps({"completed": is_onboarding_completed()}).encode('utf-8'), "application/json")
        elif path == '/api/onboarding/complete' and method == 'POST':
            from opalatex.onboarding import complete_onboarding
            self.send_response(writer, 200, json.dumps({"success": complete_onboarding()}).encode('utf-8'), "application/json")
        elif path == '/api/ollama/status' and method == 'GET':
            from opalatex.ollama_manager import check_ollama_status
            self.send_response(writer, 200, json.dumps(check_ollama_status()).encode('utf-8'), "application/json")
        elif path == '/api/ollama/install' and method == 'POST':
            from opalatex.ollama_manager import install_ollama_windows
            self.send_response(writer, 200, json.dumps(install_ollama_windows()).encode('utf-8'), "application/json")

        elif path == '/api/settings/opalatexhome' and method == 'GET':
            from opalatex.config import get_opalatex_home
            current_home = get_opalatex_home()
            is_custom = False
            try:
                import pathlib
                pointer_file = pathlib.Path.home() / ".opalatexhome"
                if pointer_file.exists():
                    is_custom = True
            except Exception:
                pass
            self.send_response(writer, 200, json.dumps({"path": current_home, "is_custom": is_custom}).encode('utf-8'), "application/json")

        elif path == '/api/settings/opalatexhome' and method == 'POST':
            new_path = data.get("path", "").strip()
            try:
                import pathlib
                pointer_file = pathlib.Path.home() / ".opalatexhome"
                if new_path:
                    # Validate path
                    os.makedirs(new_path, exist_ok=True)
                    pointer_file.write_text(new_path, encoding="utf-8")
                else:
                    # Remove custom pointer if empty
                    if pointer_file.exists():
                        pointer_file.unlink()
                self.send_response(writer, 200, json.dumps({"success": True, "requiresRestart": True}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        elif path == '/api/settings/install-tectonic' and method == 'POST':
            try:
                import sys
                import urllib.request
                import zipfile
                import tarfile
                import tempfile
                
                os_name = sys.platform
                bin_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin")
                os.makedirs(bin_dir, exist_ok=True)
                
                if os_name == "win32":
                    url = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-pc-windows-msvc.zip"
                    filename = "tectonic.zip"
                elif os_name == "darwin":
                    import platform
                    if platform.machine() == "arm64":
                        url = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-aarch64-apple-darwin.tar.gz"
                    else:
                        url = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-apple-darwin.tar.gz"
                    filename = "tectonic.tar.gz"
                else:
                    url = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-gnu.tar.gz"
                    filename = "tectonic.tar.gz"
                    
                with tempfile.TemporaryDirectory() as tmpdir:
                    archive_path = os.path.join(tmpdir, filename)
                    urllib.request.urlretrieve(url, archive_path)
                    
                    if filename.endswith(".zip"):
                        with zipfile.ZipFile(archive_path, 'r') as zip_ref:
                            zip_ref.extractall(bin_dir)
                    else:
                        with tarfile.open(archive_path, 'r:gz') as tar_ref:
                            tar_ref.extractall(bin_dir)
                            
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        elif path == '/api/models/info' and method == 'GET':
            model_name = query.get('model', [''])[0]
            if not model_name:
                self.send_response(writer, 400, b'{"error":"model parameter is required"}', "application/json")
                return
            
            clean_name = model_name
            if '/' in clean_name:
                clean_name = clean_name.split('/', 1)[1]
            
            try:
                import urllib.request as urllib_req
                import json as _json
                req = urllib_req.Request("http://127.0.0.1:11434/api/tags")
                with urllib_req.urlopen(req, timeout=2) as response:
                    data_obj = _json.loads(response.read().decode())
                    models = data_obj.get("models", [])
                    
                    found_model = None
                    for m in models:
                        if m.get("name") == clean_name or m.get("name").startswith(clean_name + ":"):
                            found_model = m
                            break
                    
                    if found_model:
                        size_bytes = found_model.get("size", 0)
                        size_gb = size_bytes / (1024**3)
                        self.send_response(writer, 200, json.dumps({
                            "found": True,
                            "size_gb": round(size_gb, 2),
                            "details": found_model.get("details", {})
                        }).encode('utf-8'), "application/json")
                        return
            except Exception:
                pass
                
            self.send_response(writer, 200, json.dumps({"found": False}).encode('utf-8'), "application/json")

        elif path == '/api/opalatex/list-projects':
            from opalatex.config import DEFAULT_DB_PATH
            from opalatex.project import ProjectStore
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            projects = store.list_projects()
            for p in projects:
                raw_path = p.get('project_path', '')
                if raw_path:
                    p['exists'] = os.path.exists(os.path.abspath(os.path.expanduser(raw_path)))
                else:
                    p['exists'] = False
            self.send_response(writer, 200, json.dumps({"projects": projects}).encode('utf-8'), "application/json")

        # 5. Create Project
        elif path == '/api/opalatex/create-project' and method == 'POST':
            from opalatex.config import DEFAULT_DB_PATH, DEFAULT_MODEL
            from opalatex.project import ProjectStore
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            
            project_name = data.get("project_name")
            project_path = data.get("project_path") or os.getcwd()
            description = data.get("description", "")
            model = data.get("model") or DEFAULT_MODEL
            worker_model = data.get("worker_model", "")
            mode = data.get("mode") or "auto"
            skills = data.get("skills", [])
            api_key = data.get("api_key")
            api_base = data.get("api_base")
            worker_api_key = data.get("worker_api_key")
            worker_api_base = data.get("worker_api_base")

            
            if not project_name:
                self.send_response(writer, 400, b'{"error":"project_name is required"}', "application/json")
                return
                
            abs_path = os.path.abspath(os.path.expanduser(project_path)) if project_path else os.getcwd()
            if os.path.exists(abs_path):
                if not os.path.isdir(abs_path):
                    self.send_response(writer, 400, json.dumps({"error": f"The path '{project_path}' exists but is not a directory."}).encode('utf-8'), "application/json")
                    return
                if not os.access(abs_path, os.W_OK):
                    self.send_response(writer, 400, json.dumps({"error": f"Permission denied: No write access to directory '{project_path}'."}).encode('utf-8'), "application/json")
                    return
            else:
                try:
                    os.makedirs(abs_path, exist_ok=True)
                except PermissionError:
                    self.send_response(writer, 400, json.dumps({"error": f"Permission denied: Cannot create directory '{project_path}'."}).encode('utf-8'), "application/json")
                    return
                except Exception as e:
                    self.send_response(writer, 400, json.dumps({"error": f"Failed to create directory: {str(e)}"}).encode('utf-8'), "application/json")
                    return
                
            model_params_raw = data.get("model_params")
            model_params = sanitize_model_params(model_params_raw) if isinstance(model_params_raw, dict) else None
            worker_model_params_raw = data.get("worker_model_params")
            worker_model_params = sanitize_model_params(worker_model_params_raw) if isinstance(worker_model_params_raw, dict) else None

            existing_name = store.find_by_path(abs_path)
            if existing_name:
                existing_proj = store.load(existing_name)
                existing_project_name = existing_proj.project_name if existing_proj else existing_name
                err_msg = get_translation("project_exists_in_folder", name=existing_project_name)
                self.send_response(writer, 400, json.dumps({"error": err_msg}).encode('utf-8'), "application/json")
                return

            db_key = project_name.replace(" ", "_").lower()
            original_db_key = db_key
            counter = 1
            while store.exists(db_key):
                db_key = f"{original_db_key}_{counter}"
                counter += 1

            try:
                project = store.create(
                    name=db_key,
                    mode=mode,
                    model=model,
                    worker_model=worker_model,
                    project_name=project_name,
                    project_path=abs_path,
                    skills=skills,
                    description=description,
                    api_key=api_key,
                    api_base=api_base,
                    worker_api_key=worker_api_key,
                    worker_api_base=worker_api_base,
                    model_params=model_params,
                    worker_model_params=worker_model_params,
                )
            except Exception as e:
                import traceback
                traceback.print_exc()
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
                return
                
            if model and model.startswith("ollama/"):
                m_name = model.split("ollama/", 1)[1]
                import threading
                import subprocess
                def pull_model():
                    try:
                        subprocess.run(["ollama", "pull", m_name], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    except Exception:
                        pass
                threading.Thread(target=pull_model, daemon=True).start()
            
            if "piloto" in project_name.lower() or "pilot" in project_name.lower():
                from opalatex.onboarding import PILOT_SKILL_CONTENT_PT, PILOT_SKILL_CONTENT_EN
                from opalatex.ui_settings import load_ui_settings
                from opalatex.skills import write_skills_yaml
                
                cfg = load_ui_settings()
                lang = cfg.get("lang", "pt")
                skill_content = PILOT_SKILL_CONTENT_EN if lang.startswith("en") else PILOT_SKILL_CONTENT_PT
                
                skill_dir = os.path.join(abs_path, ".opalatex", "skills", "tutorial_opalatex")
                os.makedirs(skill_dir, exist_ok=True)
                with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as f:
                    f.write(skill_content.strip() + "\n")
                
                # Activate the skill without overwriting command-line
                from opalatex.skills import read_skills_yaml
                existing_skills = read_skills_yaml(abs_path)
                if "tutorial_opalatex" not in existing_skills:
                    existing_skills.append("tutorial_opalatex")
                write_skills_yaml(abs_path, existing_skills)
                
                if "tutorial_opalatex" not in project.skills:
                    project.skills.append("tutorial_opalatex")
                    store.save(project)

            from opalatex.project import create_contextual_skills_defaults
            create_contextual_skills_defaults(abs_path)

            res_data = {
                "project_name": project.project_name,
                "project_path": project.project_path,
                "skills": project.skills
            }
            self.send_response(writer, 200, json.dumps(res_data).encode('utf-8'), "application/json")

        elif path == '/api/opalatex/load-contextual-skills' and method == 'POST':
            project_path = data.get("project_path")
            if not project_path:
                self.send_response(writer, 400, b'{"error":"project_path is required"}', "application/json")
                return
            
            from opalatex.project import create_contextual_skills_defaults
            create_contextual_skills_defaults(project_path)
            self.send_response(writer, 200, b'{"status":"ok"}', "application/json")

        # 5b. Import existing project
        elif path == '/api/opalatex/import-project' and method == 'POST':
            from opalatex.config import DEFAULT_DB_PATH, DEFAULT_MODEL
            from opalatex.project import ProjectStore
            store = ProjectStore(db_path=DEFAULT_DB_PATH)

            project_path = data.get("project_path", "")
            if not project_path:
                self.send_response(writer, 400, b'{"error":"project_path is required"}', "application/json")
                return

            abs_path = os.path.abspath(os.path.expanduser(project_path))
            if not os.path.isdir(abs_path):
                self.send_response(writer, 400, json.dumps({"error": f"Directory does not exist: {project_path}"}).encode('utf-8'), "application/json")
                return

            # Validate: must have .opalatex/ directory to be a valid project
            opalatex_dir = os.path.join(abs_path, ".opalatex")
            if not os.path.isdir(opalatex_dir):
                self.send_response(writer, 400, json.dumps({
                    "error": "This directory is not a valid OpalaTex project. A valid project must contain a .opalatex/ directory."
                }).encode('utf-8'), "application/json")
                return

            # Check if project is already registered (by path)
            existing_projects = store.list_projects()
            for ep in existing_projects:
                ep_path = os.path.abspath(os.path.expanduser(ep.get("project_path", "")))
                if os.path.normcase(ep_path) == os.path.normcase(abs_path):
                    self.send_response(writer, 400, json.dumps({
                        "error": f"This project is already registered as '{ep.get('project_name', ep.get('name', ''))}'."
                    }).encode('utf-8'), "application/json")
                    return

            # Derive project name from directory name
            project_name = os.path.basename(abs_path) or "Imported Project"

            # Try to read model and API info from .env
            api_key = ""
            api_base = ""
            worker_api_key = ""
            worker_api_base = ""
            env_path = os.path.join(abs_path, ".env")
            if os.path.isfile(env_path):
                try:
                    with open(env_path, "r", encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if line.startswith("OPENAI_API_KEY="):
                                api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                            elif line.startswith("OPENAI_API_BASE="):
                                api_base = line.split("=", 1)[1].strip().strip('"').strip("'")
                            elif line.startswith("WORKER_API_KEY="):
                                worker_api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                            elif line.startswith("WORKER_API_BASE="):
                                worker_api_base = line.split("=", 1)[1].strip().strip('"').strip("'")
                except Exception:
                    pass

            # Try to detect model from modelconfig files
            model = DEFAULT_MODEL
            modelsconfig_dir = os.path.join(opalatex_dir, "modelsconfig")
            if os.path.isdir(modelsconfig_dir):
                try:
                    import yaml
                    for provider_dir in os.listdir(modelsconfig_dir):
                        provider_path = os.path.join(modelsconfig_dir, provider_dir)
                        if os.path.isdir(provider_path):
                            for cfg_file in os.listdir(provider_path):
                                if cfg_file.endswith('.yaml'):
                                    model_name = cfg_file[:-5]  # Remove .yaml extension
                                    model = f"{provider_dir}/{model_name}"
                                    break
                            if model != DEFAULT_MODEL:
                                break
                except Exception:
                    pass

            # Read skills from skills.yaml
            skills = ["opalatex"]
            try:
                from opalatex.skills import read_skills_yaml
                found_skills = read_skills_yaml(abs_path)
                if found_skills:
                    skills = found_skills
                    if "opalatex" not in skills:
                        skills = ["opalatex"] + skills
            except Exception:
                pass

            existing_name = store.find_by_path(abs_path)
            if existing_name:
                existing_proj = store.load(existing_name)
                existing_project_name = existing_proj.project_name if existing_proj else existing_name
                err_msg = get_translation("project_exists_in_folder", name=existing_project_name)
                self.send_response(writer, 400, json.dumps({"error": err_msg}).encode('utf-8'), "application/json")
                return

            db_key = project_name.replace(" ", "_").lower()
            original_db_key = db_key
            counter = 1
            while store.exists(db_key):
                db_key = f"{original_db_key}_{counter}"
                counter += 1

            try:
                project = store.create(
                    name=db_key,
                    mode="auto",
                    model=model,
                    project_name=project_name,
                    project_path=abs_path,
                    skills=skills,
                    description="",
                    api_key=api_key or None,
                    api_base=api_base or None,
                    worker_api_key=worker_api_key or None,
                    worker_api_base=worker_api_base or None,
                    apply_modelconfig=False,
                )
            except Exception as e:
                import traceback
                traceback.print_exc()
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
                return

            res_data = {
                "project_name": project.project_name,
                "project_path": project.project_path,
                "skills": project.skills,
                "model": project.model,
            }
            self.send_response(writer, 200, json.dumps(res_data).encode('utf-8'), "application/json")

        # 6. Delete Project
        elif path == '/api/opalatex/delete' and method == 'POST':
            from opalatex.config import DEFAULT_DB_PATH
            from opalatex.project import ProjectStore
            import shutil
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            project_name = data.get("project_name")
            delete_dir = data.get("delete_dir", False)
            if not project_name:
                self.send_response(writer, 400, b'{"error":"project_name is required"}', "application/json")
                return
            if store.exists(project_name):
                proj = store.load(project_name)
                
                # Ensure resources are released before deleting directory to avoid file locks
                if proj and proj.project_path:
                    try:
                        # 1. Close main terminal
                        if self.active_terminal and getattr(self.active_terminal, 'project_path', None) == proj.project_path:
                            try:
                                self.active_terminal.close()
                            except:
                                pass
                            self.active_terminal = None
                            
                        # 2. Close temp terminals
                        for tid, term in list(self.temp_terminals.items()):
                            if getattr(term, 'project_path', None) == proj.project_path:
                                try:
                                    term.close()
                                except:
                                    pass
                                del self.temp_terminals[tid]
                                
                        # 3. Close SQLite databases
                        from opalatex.code_index import CODE_INDEX
                        if getattr(CODE_INDEX, '_root', None) == proj.project_path:
                            try:
                                CODE_INDEX.close()
                            except:
                                pass
                                
                        from opalatex.vector_index import get_vector_index
                        v_idx = get_vector_index()
                        if v_idx and str(getattr(v_idx, '_root', '')) == proj.project_path:
                            try:
                                v_idx.close()
                            except:
                                pass
                    except Exception as e:
                        print(f"Error releasing resources before deletion: {e}")

                if delete_dir:
                    if proj and proj.project_path and os.path.exists(proj.project_path):
                        try:
                            import stat
                            def remove_readonly(func, path, excinfo):
                                try:
                                    os.chmod(path, stat.S_IWRITE)
                                    func(path)
                                except Exception:
                                    pass
                            shutil.rmtree(proj.project_path, onerror=remove_readonly)
                        except Exception as e:
                            print(f"Error deleting project directory: {e}")
                store.delete(project_name)
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            else:
                self.send_response(writer, 404, json.dumps({"error": f"Project '{project_name}' not found"}).encode('utf-8'), "application/json")

        elif path == '/api/chat/delete' and method == 'POST':
            from opalatex.config import DEFAULT_DB_PATH
            from opalatex.project import ProjectStore
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            project_name = data.get("project_name")
            chat_id = data.get("chat_id")
            if not project_name or not chat_id:
                self.send_response(writer, 400, b'{"error":"project_name and chat_id required"}', "application/json")
                return
            if chat_id == "main":
                self.send_response(writer, 400, b'{"error":"Cannot delete main chat"}', "application/json")
                return
            store.delete_chat(project_name, chat_id)
            from opalatex.archival import clear_archival_chat
            clear_archival_chat(project_name, chat_id)
            self.send_response(writer, 200, b'{"status":"ok"}', "application/json")

        elif path == '/api/chat/rename' and method == 'POST':
            from opalatex.config import DEFAULT_DB_PATH
            from opalatex.project import ProjectStore
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            project_name = data.get("project_name")
            chat_id = data.get("chat_id")
            new_name = data.get("new_name")
            if not project_name or not chat_id or not new_name:
                self.send_response(writer, 400, b'{"error":"project_name, chat_id and new_name required"}', "application/json")
                return
            store.rename_chat(project_name, chat_id, new_name)
            self.send_response(writer, 200, b'{"status":"ok"}', "application/json")

        elif path == '/api/chat/branch' and method == 'POST':
            from opalatex.config import DEFAULT_DB_PATH
            from opalatex.project import ProjectStore
            import uuid
            
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            project_name = data.get("project_name")
            source_chat_id = data.get("source_chat_id")
            new_chat_name = data.get("new_chat_name")
            message_index = data.get("message_index")
            
            if not project_name or not source_chat_id or not new_chat_name or message_index is None:
                self.send_response(writer, 400, b'{"error":"project_name, source_chat_id, new_chat_name and message_index required"}', "application/json")
                return
                
            new_chat_id = str(uuid.uuid4())
            try:
                store.branch_chat(project_name, source_chat_id, new_chat_id, new_chat_name, int(message_index))
                self.send_response(writer, 200, json.dumps({"status": "success", "new_chat_id": new_chat_id}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
            return


        elif path == '/api/chat/history' and method == 'GET':
            from opalatex.config import DEFAULT_DB_PATH
            from opalatex.project import ProjectStore
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            project_name = query.get("project_name", [""])[0]
            chat_id = query.get("chat_id", ["main"])[0]
            if not project_name:
                self.send_response(writer, 400, b'{"error":"project_name required"}', "application/json")
                return
            project = store.load(project_name, chat_id=chat_id)
            if not project:
                self.send_response(writer, 404, b'{"error":"project not found"}', "application/json")
                return
            self.send_response(writer, 200, json.dumps({"history": project.history}).encode(), "application/json")

        elif path == '/api/chat/list' and method == 'GET':
            from opalatex.config import DEFAULT_DB_PATH
            from opalatex.project import ProjectStore
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            project_name = query.get("project_name", [""])[0]
            if not project_name:
                self.send_response(writer, 400, b'{"error":"project_name required"}', "application/json")
                return
            project = store.load(project_name)
            if not project:
                self.send_response(writer, 404, b'{"error":"project not found"}', "application/json")
                return
            self.send_response(writer, 200, json.dumps({"chats": project.chats}).encode(), "application/json")

        elif path == '/api/chat/search' and method == 'GET':
            from opalatex.config import DEFAULT_DB_PATH
            from opalatex.project import ProjectStore
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            project_name = query.get("project_name", [""])[0]
            q = query.get("q", [""])[0]
            if not project_name or not q:
                self.send_response(writer, 400, b'{"error":"project_name and q required"}', "application/json")
                return
            results = store.search_chat_content(project_name, q)
            self.send_response(writer, 200, json.dumps({"results": results}).encode(), "application/json")

        # 6c. Upload attachment (image or PDF) for chat
        elif path == '/api/chat/upload' and method == 'POST':
            filename = data.get("filename", "attachment")
            data_b64 = data.get("data_b64", "")
            mime = data.get("mime", "application/octet-stream")
            if not data_b64:
                self.send_response(writer, 400, b'{"error":"data_b64 is required"}', "application/json")
                return
            try:
                from opalatex.attachments import build_attachment_descriptor
                project_name = data.get("project_name")
                # Resolve optional PDF truncation settings from project
                max_chars = None
                if project_name and mime == "application/pdf":
                    from opalatex.config import DEFAULT_DB_PATH
                    from opalatex.project import ProjectStore
                    _store = ProjectStore(db_path=DEFAULT_DB_PATH)
                    if _store.exists(project_name):
                        _proj = _store.load(project_name)
                        _mp = getattr(_proj, "model_params", {}) or {}
                        if _mp.get("pdf_truncate", True):
                            # max_chars is applied later in agent_stdin with context info;
                            # here we apply a hard cap of 200 000 chars to protect memory.
                            max_chars = 200_000
                descriptor = build_attachment_descriptor(filename, data_b64, mime, max_chars=max_chars)
                self.send_response(writer, 200, json.dumps(descriptor).encode(), "application/json")
            except ImportError as imp_err:
                missing = str(imp_err).replace("No module named ", "").strip("'\"")
                pkg_hint = "Pillow pymupdf4llm"
                msg = (
                    f"Missing dependency '{missing}' required for attachment processing. "
                    f"Please install it: pip install {pkg_hint}"
                )
                self.send_response(writer, 503, json.dumps({"error": msg}).encode(), "application/json")
            except Exception as exc:
                import traceback
                self.send_response(writer, 500, json.dumps({"error": str(exc), "trace": traceback.format_exc()}).encode(), "application/json")

        elif path == '/api/chat/create' and method == 'POST':

            from opalatex.config import DEFAULT_DB_PATH
            from opalatex.project import ProjectStore
            import uuid
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            project_name = data.get("project_name")
            chat_name = data.get("chat_name")
            if not project_name or not chat_name:
                self.send_response(writer, 400, b'{"error":"project_name and chat_name required"}', "application/json")
                return
            chat_id = str(uuid.uuid4())
            store.create_chat(project_name, chat_id, chat_name)
            self.send_response(writer, 200, json.dumps({"id": chat_id, "name": chat_name}).encode(), "application/json")

        # 6b. Update Project (patch fields without resetting history)
        elif path == '/api/opalatex/update-project' and method == 'POST':
            from opalatex.config import DEFAULT_DB_PATH
            from opalatex.project import ProjectStore
            store = ProjectStore(db_path=DEFAULT_DB_PATH)
            project_name = data.get("project_name")  # internal key (db name)
            if not project_name:
                self.send_response(writer, 400, b'{"error":"project_name is required"}', "application/json")
                return
            if not store.exists(project_name):
                self.send_response(writer, 404, json.dumps({"error": f"Project '{project_name}' not found"}).encode(), "application/json")
                return
            chat_id = data.get("chat_id") or data.get("current_chat_id") or "main"
            project = store.load(project_name, chat_id=chat_id)
            # Patch only supplied fields
            if "display_name" in data:
                project.project_name = data["display_name"]
            if "model" in data and data["model"]:
                project.model = data["model"]
            if "worker_model" in data:
                project.worker_model = data["worker_model"]
            if "description" in data:
                project.description = data["description"]
            if "mode" in data and data["mode"]:
                project.mode = data["mode"]
            if "project_path" in data and data["project_path"]:
                new_path = data["project_path"]
                if not os.path.exists(new_path) or not os.path.isdir(new_path):
                    self.send_response(writer, 400, b'{"error":"Project path does not exist or is not a directory"}', "application/json")
                    return
                project.project_path = os.path.abspath(new_path)
            
            if "main_file" in data:
                project.main_file = data["main_file"]

            if "use_shared_memory" in data:
                project.use_shared_memory = bool(data["use_shared_memory"])

            if "model_params" in data:
                params = data["model_params"]
                if not isinstance(params, dict):
                    self.send_response(writer, 400, b'{"error":"model_params must be a JSON object"}', "application/json")
                    return
                # Reject keys with invalid characters (not letters/digits/underscores/hyphens).
                import re as _re
                for k in params.keys():
                    if not k or not _re.fullmatch(r'[A-Za-z0-9_-]+', k):
                        self.send_response(writer, 400, f'{{"error":"invalid parameter name: {k}"}}'.encode('utf-8'), "application/json")
                        return
                project.model_params = sanitize_model_params(params)

            if "worker_model_params" in data:
                params = data["worker_model_params"]
                if not isinstance(params, dict):
                    self.send_response(writer, 400, b'{"error":"worker_model_params must be a JSON object"}', "application/json")
                    return
                import re as _re
                for k in params.keys():
                    if not k or not _re.fullmatch(r'[A-Za-z0-9_-]+', k):
                        self.send_response(writer, 400, f'{{"error":"invalid parameter name: {k}"}}'.encode('utf-8'), "application/json")
                        return
                project.worker_model_params = sanitize_model_params(params)

            if "api_key" in data:
                project.api_key = data["api_key"]
            if "api_base" in data:
                project.api_base = data["api_base"]
            if "worker_api_key" in data:
                project.worker_api_key = data["worker_api_key"]
            if "worker_api_base" in data:
                project.worker_api_base = data["worker_api_base"]

            store.save(project)
            
            if project.model and project.model.startswith("ollama/"):
                m_name = project.model.split("ollama/", 1)[1]
                import threading
                import subprocess
                def pull_model_update():
                    try:
                        subprocess.run(["ollama", "pull", m_name], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    except Exception:
                        pass
                threading.Thread(target=pull_model_update, daemon=True).start()
            
            # Propagate updated project settings to in-memory state and rebuild orchestrator
            import opalatex.agent_stdin as agent_stdin
            if agent_stdin.current_project and agent_stdin.current_project.name == project.name:
                agent_stdin.current_project = project
                from .tools import set_project_context
                set_project_context(project, store)
                from .memgpt_runtime import build_chat_orchestrator
                agent_stdin.current_memgpt = build_chat_orchestrator(project, store)

            res_data = {
                "name": project.name,
                "project_name": project.project_name,
                "project_path": project.project_path,
                "model": project.model,
                "worker_model": project.worker_model,
                "mode": project.mode,
                "description": project.description,
                "model_params": project.model_params,
                "api_key": getattr(project, "api_key", ""),
                "api_base": getattr(project, "api_base", ""),
                "worker_api_key": getattr(project, "worker_api_key", ""),
                "worker_api_base": getattr(project, "worker_api_base", ""),
                "current_chat_id": project.current_chat_id,
            }
            self.send_response(writer, 200, json.dumps(res_data).encode(), "application/json")

        # 6c. Slash Command
        elif path == '/api/opalatex/slash-command' and method == 'POST':

                    
            from opalatex.agent_stdin import handle_slash_command
            try:
                result = await handle_slash_command(data)
                self.send_response(writer, 200, json.dumps(result).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 6d. Slash Command Continue (after confirm)
        elif path == '/api/opalatex/slash-command/continue' and method == 'POST':
            from opalatex.agent_stdin import handle_slash_command_continue
            try:
                result = await handle_slash_command_continue(data)
                self.send_response(writer, 200, json.dumps(result).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 7a. Input Response (resolves a pending GUI confirm/ask request)

        elif path == '/api/opalatex/input_response' and method == 'POST':
            req_id = data.get("id", "")
            value = data.get("value", "")
            from opalatex.agent_stdin import _gui_input_pending
            fut = _gui_input_pending.get(req_id)
            if fut and not fut.done():
                fut.get_loop().call_soon_threadsafe(fut.set_result, value)
                self.send_response(writer, 200, b'{"ok":true}', "application/json")
            else:
                self.send_response(writer, 404, b'{"error":"No pending request with that id"}', "application/json")
            return

        # 7b. Run Agent (Streaming)
        elif path == '/api/opalatex/run' and method == 'POST':
            from opalatex.ui_settings import load_ui_settings
            from opalatex.licensing import _load_license_data
            
            ui_cfg = load_ui_settings()


            headers = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: text/event-stream\r\n"
                "X-Content-Type-Options: nosniff\r\n"
                "Transfer-Encoding: chunked\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Cache-Control: no-cache\r\n"
                "Connection: keep-alive\r\n\r\n"
            )
            writer.write(headers.encode('utf-8'))
            await writer.drain()

            event_queue = asyncio.Queue()
            self.active_queues.append(event_queue)

            def send_chunk(text: str):
                if len(text) < 4096:
                    text = text.rstrip('\n') + (" " * (4096 - len(text))) + "\n"
                chunk = text.encode('utf-8')
                if not chunk:
                    return
                writer.write(f"{len(chunk):X}\r\n".encode('utf-8'))
                writer.write(chunk)
                writer.write(b"\r\n")

            from opalatex.agent_stdin import handle_run
            
            async def run_agent():
                try:
                    await handle_run(data)
                except asyncio.CancelledError:
                    event_queue.put_nowait({"event": "cancelled", "message": "Agent execution was interrupted."})
                except Exception as e:
                    import traceback
                    err_msg = traceback.format_exc()
                    event_queue.put_nowait({"event": "error", "message": str(e), "trace": err_msg})
                finally:
                    event_queue.put_nowait(None)

            agent_task = asyncio.create_task(run_agent())
            self.active_agent_task = agent_task

            try:
                while True:
                    event = await event_queue.get()
                    if event is None:
                        break
                    send_chunk(json.dumps(event) + "\n")
                    await writer.drain()
            except asyncio.CancelledError:
                if not agent_task.done():
                    agent_task.cancel()
                try:
                    await agent_task
                except Exception:
                    pass
                event_queue.put_nowait({"event": "cancelled", "message": "Agent execution was interrupted."})
            except Exception as e:
                print(f"Streaming error: {e}")
            finally:
                if self.active_agent_task == agent_task:
                    self.active_agent_task = None
                if event_queue in self.active_queues:
                    self.active_queues.remove(event_queue)
                writer.write(b"0\r\n\r\n")
                await writer.drain()
                writer.close()
                try:
                    await agent_task
                except Exception:
                    pass

        # 7b2. Interrupt Agent
        elif path == '/api/opalatex/interrupt' and method == 'POST':
            if self.active_agent_task and not self.active_agent_task.done():
                self.active_agent_task.cancel()
                self.send_response(writer, 200, b'{"success":true,"message":"Agent execution interrupted"}', "application/json")
            else:
                self.send_response(writer, 200, b'{"success":false,"message":"No active agent running"}', "application/json")
            return

        # 7c. Terminal stream
        elif path == '/api/terminal/stream':
            term_id = query.get('term_id', ['main'])[0]
            project_path = query.get('projectPath', [None])[0]
            
            if term_id == 'main':
                if not self.active_terminal or (project_path and self.active_terminal.project_path != project_path) or not self.active_terminal.is_running:
                    if self.active_terminal:
                        try:
                            self.active_terminal.close()
                        except:
                            pass
                    if not project_path or not os.path.exists(project_path):
                        self.send_response(writer, 400, b'{"error":"Project path required"}', "application/json")
                        return
                    from opalatex.terminal_manager import TerminalSession
                    try:
                        self.active_terminal = TerminalSession(project_path)
                        self.active_terminal.start_reading(asyncio.get_running_loop())
                    except Exception as e:
                        import traceback
                        print(f"Failed to start terminal: {e}\n{traceback.format_exc()}")
                        with open("terminal_error.log", "a", encoding="utf-8") as f:
                            f.write(f"Failed to start terminal: {e}\n{traceback.format_exc()}\n")
                        self.send_response(writer, 500, f'{{"error": "{str(e)}"}}'.encode('utf-8'), "application/json")
                        return
                active_term = self.active_terminal
            else:
                if term_id not in self.temp_terminals:
                    if term_id.startswith('main-') and project_path and os.path.exists(project_path):
                        from opalatex.terminal_manager import TerminalSession
                        try:
                            term = TerminalSession(project_path)
                            term.start_reading(asyncio.get_running_loop())
                            self.temp_terminals[term_id] = term
                        except Exception as e:
                            self.send_response(writer, 500, f'{{"error": "{str(e)}"}}'.encode('utf-8'), "application/json")
                            return
                    else:
                        self.send_response(writer, 404, b'{"error":"Temp terminal not found"}', "application/json")
                        return
                active_term = self.temp_terminals[term_id]

            headers = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: text/event-stream\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Cache-Control: no-cache\r\n"
                "Connection: keep-alive\r\n\r\n"
            )
            writer.write(headers.encode('utf-8'))
            await writer.drain()

            term_queue = asyncio.Queue()
            active_term.queues.append(term_queue)

            def send_data(data_bytes: bytes):
                # base64 is imported at the top of the module — no need to
                # re-import it here. Re-importing inside a function would
                # shadow the module-level name and cause
                # "cannot access local variable 'base64'" errors elsewhere.
                payload = f"data: {base64.b64encode(data_bytes).decode('utf-8')}\n\n"
                writer.write(payload.encode('utf-8'))

            try:
                while True:
                    data = await term_queue.get()
                    if data is None:
                        break
                    send_data(data)
                    await writer.drain()
            except (ConnectionResetError, BrokenPipeError):
                pass  # normal client disconnect
            except Exception as e:
                print(f"Terminal stream error: {e}")
            finally:
                if active_term and term_queue in active_term.queues:
                    active_term.queues.remove(term_queue)
                try:
                    writer.close()
                except:
                    pass

        # 7d. Terminal input (keys, resize)
        elif path == '/api/terminal/input' and method == 'POST':
            term_id = data.get("term_id", "main")
            project_path = data.get("projectPath")
            
            if term_id == "main":
                if not self.active_terminal or not self.active_terminal.is_running:
                    if project_path:
                        from opalatex.terminal_manager import TerminalSession
                        try:
                            self.active_terminal = TerminalSession(project_path)
                            self.active_terminal.start_reading(asyncio.get_running_loop())
                        except Exception as e:
                            self.send_response(writer, 500, f'{{"error": "{str(e)}"}}'.encode('utf-8'), "application/json")
                            return
                    else:
                        self.send_response(writer, 400, b'{"error":"No active terminal session"}', "application/json")
                        return
                active_term = self.active_terminal
            else:
                if term_id not in self.temp_terminals:
                    if term_id.startswith('main-') and project_path and os.path.exists(project_path):
                        from opalatex.terminal_manager import TerminalSession
                        try:
                            term = TerminalSession(project_path)
                            term.start_reading(asyncio.get_running_loop())
                            self.temp_terminals[term_id] = term
                        except Exception as e:
                            self.send_response(writer, 500, f'{{"error": "{str(e)}"}}'.encode('utf-8'), "application/json")
                            return
                    else:
                        self.send_response(writer, 404, b'{"error":"Temp terminal not found"}', "application/json")
                        return
                active_term = self.temp_terminals[term_id]

            action = data.get("action", "input")
            if action == "input":
                text = data.get("text", "")
                active_term.write(text)
                self.send_response(writer, 200, b'{"ok":true}', "application/json")
            elif action == "resize":
                cols = data.get("cols", 80)
                rows = data.get("rows", 24)
                active_term.resize(cols, rows)
                self.send_response(writer, 200, b'{"ok":true}', "application/json")
            else:
                self.send_response(writer, 400, b'{"error":"Invalid action"}', "application/json")
                
        elif path == '/api/terminal/start' and method == 'POST':
            term_id = data.get("term_id")
            project_path = data.get("projectPath")
            
            if not term_id or not project_path:
                self.send_response(writer, 400, b'{"error":"term_id and projectPath required"}', "application/json")
                return
                
            from opalatex.terminal_manager import TerminalSession
            try:
                term = TerminalSession(project_path)
                term.start_reading(asyncio.get_running_loop())
                self.temp_terminals[term_id] = term
                self.send_response(writer, 200, b'{"ok":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, f'{{"error": "{str(e)}"}}'.encode('utf-8'), "application/json")
                
        elif path == '/api/terminal/temp/start' and method == 'POST':
            term_id = data.get("term_id")
            command = data.get("command")
            project_path = data.get("projectPath")
            
            if not term_id or not command or not project_path:
                self.send_response(writer, 400, b'{"error":"term_id, command and projectPath required"}', "application/json")
                return
                
            from opalatex.terminal_manager import TerminalSession
            try:
                term = TerminalSession(project_path)
                term.start_reading(asyncio.get_running_loop())
                self.temp_terminals[term_id] = term
                
                # Write command to start it
                term.write(command + "\r")
                self.send_response(writer, 200, b'{"ok":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, f'{{"error": "{str(e)}"}}'.encode('utf-8'), "application/json")
                
        elif path == '/api/terminal/temp/kill' and method == 'POST':
            term_id = data.get("term_id")
            if term_id in self.temp_terminals:
                try:
                    self.temp_terminals[term_id].close()
                except:
                    pass
                del self.temp_terminals[term_id]
            self.send_response(writer, 200, b'{"ok":true}', "application/json")

        # 7e. Git status
        elif path == '/api/git/status':
            project_path = query.get('projectPath', [None])[0]
            is_shadow = query.get('shadow', ['false'])[0].lower() == 'true'
            if not project_path or not os.path.exists(project_path):
                self.send_response(writer, 400, b'{"error":"Invalid project path"}', "application/json")
                return
            import subprocess
            try:
                git_cmd = ["git", f"--git-dir={os.path.join(project_path, '.opalatex', '.shadowgit')}", f"--work-tree={project_path}"] if is_shadow else ["git"]
                res = subprocess.run(
                    git_cmd + ["status", "--porcelain"],
                    cwd=project_path,
                    capture_output=True,
                    text=True
                )
                files = []
                for line in res.stdout.splitlines():
                    if len(line) > 3:
                        index_status = line[0]    # staged status (X in XY)
                        worktree_status = line[1]  # unstaged status (Y in XY)
                        filepath = line[3:].strip()
                        if " -> " in filepath:
                            filepath = filepath.split(" -> ")[1].strip()
                        # Determine effective display status and staged flag
                        if index_status == '?' and worktree_status == '?':
                            # Untracked
                            status = '??'
                            staged = False
                        elif index_status != ' ' and index_status != '?':
                            # File has a staged change (index modified)
                            status = index_status
                            staged = True
                        else:
                            # Only unstaged changes
                            status = worktree_status
                            staged = False
                        files.append({"path": filepath, "status": status, "staged": staged})
                self.send_response(writer, 200, json.dumps({"files": files}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 7f. Git commit
        elif path == '/api/git/commit' and method == 'POST':
            project_path = data.get("projectPath")
            message = data.get("message", "update")
            is_shadow = data.get("shadow", False)
            if not project_path:
                self.send_response(writer, 400, b'{"error":"projectPath is required"}', "application/json")
                return
            import subprocess
            try:
                git_cmd = ["git", f"--git-dir={os.path.join(project_path, '.opalatex', '.shadowgit')}", f"--work-tree={project_path}"] if is_shadow else ["git"]
                # Commit only what is already staged (no implicit git add .)
                res = subprocess.run(git_cmd + ["commit", "-m", message], cwd=project_path, capture_output=True, text=True)
                if res.returncode == 0:
                    self.send_response(writer, 200, b'{"success":true}', "application/json")
                elif "nothing to commit" in res.stdout or "nothing added to commit" in res.stdout:
                    from opalatex.i18n import _
                    self.send_response(writer, 400, json.dumps({"error": _("commit_nothing")}).encode('utf-8'), "application/json")
                else:
                    raise Exception(res.stderr or res.stdout or "Git commit failed")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
        # 7g. Git diff (single file or full)
        elif path == '/api/git/diff':
            project_path = query.get('projectPath', [None])[0]
            file_path_param = query.get('filePath', [None])[0]
            is_shadow = query.get('shadow', ['false'])[0].lower() == 'true'
            if not project_path or not os.path.exists(project_path):
                self.send_response(writer, 400, b'{"error":"Invalid project path"}', "application/json")
                return
            import subprocess
            try:
                git_cmd = ["git", f"--git-dir={os.path.join(project_path, '.opalatex', '.shadowgit')}", f"--work-tree={project_path}"] if is_shadow else ["git"]
                diff = ""
                if file_path_param:
                    # Check if file is untracked
                    ls = subprocess.run(
                        git_cmd + ["ls-files", "--", file_path_param],
                        cwd=project_path, capture_output=True, text=True
                    )
                    full_path = os.path.join(project_path, file_path_param)
                    if not ls.stdout.strip() and os.path.isfile(full_path):
                        # Untracked file: show as new file diff
                        res = subprocess.run(
                            git_cmd + ["diff", "--no-index", "/dev/null", file_path_param],
                            cwd=project_path, capture_output=True, text=True
                        )
                        diff = res.stdout
                    elif not ls.stdout.strip() and os.path.isdir(full_path):
                        diff = f"(diretório não rastreado: {file_path_param})"
                    else:
                        res = subprocess.run(git_cmd + ["diff", "--", file_path_param], cwd=project_path, capture_output=True, text=True)
                        res_staged = subprocess.run(git_cmd + ["diff", "--cached", "--", file_path_param], cwd=project_path, capture_output=True, text=True)
                        diff = res.stdout + res_staged.stdout
                else:
                    res = subprocess.run(git_cmd + ["diff"], cwd=project_path, capture_output=True, text=True)
                    res_staged = subprocess.run(git_cmd + ["diff", "--cached"], cwd=project_path, capture_output=True, text=True)
                    diff = res.stdout + res_staged.stdout
                self.send_response(writer, 200, json.dumps({"diff": diff}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 7h. Git log
        elif path == '/api/git/log':
            project_path = query.get('projectPath', [None])[0]
            limit = query.get('limit', ['20'])[0]
            is_shadow = query.get('shadow', ['false'])[0].lower() == 'true'
            if not project_path or not os.path.exists(project_path):
                self.send_response(writer, 400, b'{"error":"Invalid project path"}', "application/json")
                return
            import subprocess
            try:
                git_cmd = ["git", f"--git-dir={os.path.join(project_path, '.opalatex', '.shadowgit')}", f"--work-tree={project_path}"] if is_shadow else ["git"]
                res = subprocess.run(
                    git_cmd + ["log", f"--max-count={limit}", "--pretty=format:%H|%h|%an|%ar|%s"],
                    cwd=project_path, capture_output=True, text=True
                )
                commits = []
                for line in res.stdout.splitlines():
                    parts = line.split("|", 4)
                    if len(parts) == 5:
                        commits.append({"hash": parts[0], "short": parts[1], "author": parts[2], "date": parts[3], "message": parts[4]})
                self.send_response(writer, 200, json.dumps({"commits": commits}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 7i. Git stage / unstage
        elif path == '/api/git/stage' and method == 'POST':
            project_path = data.get("projectPath")
            file_path_param = data.get("filePath")
            action = data.get("action", "stage")  # "stage" or "unstage"
            is_shadow = data.get("shadow", False)
            if not project_path or not file_path_param:
                self.send_response(writer, 400, b'{"error":"projectPath and filePath required"}', "application/json")
                return
            import subprocess
            try:
                git_cmd = ["git", f"--git-dir={os.path.join(project_path, '.opalatex', '.shadowgit')}", f"--work-tree={project_path}"] if is_shadow else ["git"]
                if action == "stage":
                    subprocess.run(git_cmd + ["add", "--", file_path_param], cwd=project_path, check=True)
                else:
                    subprocess.run(git_cmd + ["restore", "--staged", "--", file_path_param], cwd=project_path, check=True)
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 7j. Git discard changes
        elif path == '/api/git/discard' and method == 'POST':
            project_path = data.get("projectPath")
            file_path_param = data.get("filePath")
            is_shadow = data.get("shadow", False)
            if not project_path or not file_path_param:
                self.send_response(writer, 400, b'{"error":"projectPath and filePath required"}', "application/json")
                return
            import subprocess
            try:
                git_cmd = ["git", f"--git-dir={os.path.join(project_path, '.opalatex', '.shadowgit')}", f"--work-tree={project_path}"] if is_shadow else ["git"]
                # For untracked files, remove them; for tracked files, restore
                res = subprocess.run(
                    git_cmd + ["ls-files", "--error-unmatch", "--", file_path_param],
                    cwd=project_path, capture_output=True
                )
                if res.returncode != 0:
                    # Untracked — delete file or directory
                    import shutil
                    full = os.path.join(project_path, file_path_param)
                    if os.path.isdir(full):
                        shutil.rmtree(full)
                    elif os.path.exists(full):
                        os.remove(full)
                else:
                    subprocess.run(git_cmd + ["restore", "--", file_path_param], cwd=project_path, check=True)
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 7k. Install Optional Dependencies (Streaming)
        elif path == '/api/settings/install-dependencies' and method == 'POST':
            headers = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: text/event-stream\r\n"
                "X-Content-Type-Options: nosniff\r\n"
                "Transfer-Encoding: chunked\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Cache-Control: no-cache\r\n"
                "Connection: keep-alive\r\n\r\n"
            )
            writer.write(headers.encode('utf-8'))
            await writer.drain()

            def send_chunk(text: str):
                if len(text) < 4096:
                    text = text.rstrip('\n') + (" " * (4096 - len(text))) + "\n"
                chunk = text.encode('utf-8')
                if not chunk:
                    return
                writer.write(f"{len(chunk):X}\r\n".encode('utf-8'))
                writer.write(chunk)
                writer.write(b"\r\n")

            import sys
            import subprocess

            cmd = [sys.executable, "-m", "pip", "install", "sentence-transformers"]
            
            proc = None
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT
                )
                
                send_chunk(json.dumps({"status": "running", "output": f"Starting: {' '.join(cmd)}\n"}) + "\n")
                await writer.drain()
                
                while True:
                    line_bytes = await proc.stdout.readline()
                    if not line_bytes:
                        break
                    line = line_bytes.decode('utf-8', errors='replace')
                    send_chunk(json.dumps({"status": "running", "output": line}) + "\n")
                    await writer.drain()
                
                await proc.wait()
                if proc.returncode == 0:
                    send_chunk(json.dumps({"status": "success", "output": "\nInstallation completed successfully!\n"}) + "\n")
                else:
                    send_chunk(json.dumps({"status": "error", "output": f"\nInstallation failed with code {proc.returncode}\n"}) + "\n")
            except Exception as e:
                send_chunk(json.dumps({"status": "error", "output": f"\nError starting installation: {e}\n"}) + "\n")
            finally:
                if proc and proc.returncode is None:
                    try:
                        proc.terminate()
                        await proc.wait()
                    except:
                        pass
                writer.write(b"0\r\n\r\n")
                await writer.drain()
                writer.close()
        # 7h. Check Optional Dependencies Status
        elif path == '/api/settings/check-dependencies' and method == 'GET':
            try:
                from sentence_transformers import SentenceTransformer
                installed = True
            except ImportError:
                installed = False
            self.send_response(writer, 200, json.dumps({"installed": installed}).encode('utf-8'), "application/json")
            
        # 7h2. Models Store Endpoints
        elif path == '/api/settings/models' and method == 'GET':
            from opalatex.models_store import load_models
            try:
                models = load_models()
                self.send_response(writer, 200, json.dumps({"models": models}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
                
        elif path == '/api/settings/models' and method == 'POST':
            from opalatex.models_store import add_or_update_model
            try:
                add_or_update_model(data)
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")
                
        elif path == '/api/settings/models' and method == 'DELETE':
            from opalatex.models_store import delete_model
            try:
                model_id = data.get("id")
                if not model_id:
                    self.send_response(writer, 400, b'{"error":"id is required"}', "application/json")
                    return
                success = delete_model(model_id)
                self.send_response(writer, 200, json.dumps({"success": success}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 7i. Problems scan
        elif path == '/api/opalatex/problems' and method == 'GET':
            project_path = query.get('projectPath', [None])[0]
            if not project_path:
                self.send_response(writer, 400, b'{"error":"projectPath parameter is required"}', "application/json")
                return
            if not os.path.exists(project_path) or not os.path.isdir(project_path):
                self.send_response(writer, 404, b'{"error":"Directory not found"}', "application/json")
                return
            try:
                self.send_response(writer, 200, json.dumps({"problems": []}).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")


        # 7j. Web search config — GET
        elif path == '/api/settings/web-search' and method == 'GET':
            from opalatex.web_search_config import load_config
            try:
                cfg = load_config()
                self.send_response(writer, 200, json.dumps(cfg).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 7k. Web search config — POST (save)
        elif path == '/api/settings/web-search' and method == 'POST':
            from opalatex.web_search_config import save_config
            try:
                save_config(data)
                self.send_response(writer, 200, b'{"success":true}', "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"error": str(e)}).encode('utf-8'), "application/json")

        # 7m. Language — GET
        elif path == '/api/settings/language' and method == 'GET':
            from opalatex.ui_settings import load_ui_settings
            cfg = load_ui_settings()
            self.send_response(writer, 200, json.dumps({"lang": cfg.get("lang", "")}).encode('utf-8'), "application/json")

        # 7n. Language — POST (set)
        elif path == '/api/settings/language' and method == 'POST':
            from opalatex.i18n import set_lang
            from opalatex.ui_settings import save_ui_settings
            lang = data.get("lang", "")
            save_ui_settings({"lang": lang})
            # map frontend locale to backend lang key
            backend_lang = "pt" if (lang or "").startswith("pt") else "en"
            set_lang(backend_lang)
            self.send_response(writer, 200, b'{"success":true}', "application/json")

        # 7o. AI Provider — GET
        elif path == '/api/settings/ai-provider' and method == 'GET':
            from opalatex.ui_settings import load_ui_settings
            cfg = load_ui_settings()
            self.send_response(writer, 200, json.dumps({"provider": cfg.get("ai_provider", "local")}).encode('utf-8'), "application/json")

        # 7p. AI Provider — POST (set)
        elif path == '/api/settings/ai-provider' and method == 'POST':
            from opalatex.ui_settings import save_ui_settings
            provider = data.get("provider", "local")
            save_ui_settings({"ai_provider": provider})
            self.send_response(writer, 200, b'{"success":true}', "application/json")

        # 7q. Token Balance — GET
        elif path == '/api/settings/token-balance' and method == 'GET':
            from opalatex.licensing import _load_license_data
            import urllib.request
            license_data = _load_license_data()
            license_key = license_data.get("license_key")
            if not license_key:
                self.send_response(writer, 200, json.dumps({"balance": 0, "error": "No license key"}).encode('utf-8'), "application/json")
                return
            
            try:
                # Local proxy testing
                # In production, point to https://www.opalacoder.com/api/get-balance
                req = urllib.request.Request("https://opalacoder.com/api/get-balance")
                req.add_header('Authorization', f'Bearer {license_key}')
                with urllib.request.urlopen(req, timeout=3) as resp:
                    resp_data = json.loads(resp.read().decode('utf-8'))
                    self.send_response(writer, 200, json.dumps(resp_data).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 200, json.dumps({"balance": 0, "error": str(e)}).encode('utf-8'), "application/json")

        # 7l. Web search MCP test
        elif path == '/api/settings/web-search/test' and method == 'POST':
            from opalatex.web_search_config import test_mcp
            mcp_url = data.get("mcp_url", "").strip()
            mcp_tool = data.get("mcp_tool", "web_search") or "web_search"
            mcp_api_key = data.get("mcp_api_key", "").strip()
            try:
                result = await test_mcp(mcp_url, mcp_tool, mcp_api_key)
                self.send_response(writer, 200, json.dumps(result).encode('utf-8'), "application/json")
            except Exception as e:
                self.send_response(writer, 500, json.dumps({"ok": False, "error": str(e)}).encode('utf-8'), "application/json")

        elif path == '/api/clipboard/read' and method == 'GET':
            text = _read_clipboard()
            self.send_response(writer, 200, json.dumps({'text': text}).encode('utf-8'), "application/json")

        elif path == '/api/clipboard/write' and method == 'POST':
            text_to_write = data.get('text', '') if isinstance(data, dict) else ''
            ok, err = _write_clipboard(text_to_write)
            if ok:
                self.send_response(writer, 200, b'{"ok":true}', "application/json")
            else:
                self.send_response(writer, 500, json.dumps({'ok': False, 'error': err}).encode(), "application/json")

        else:
            self.send_response(writer, 404, b'{"error":"Not Found"}', "application/json")

def find_available_port(host, start_port, max_port=3050):
    import socket
    for p in range(start_port, max_port + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, p))
                return p
            except OSError:
                continue
    raise RuntimeError(f"No available ports found between {start_port} and {max_port}")

def start_gui_server(host="127.0.0.1", port=3000):
    import os
    from opalatex.config import DEFAULT_LANG
    from opalatex.i18n import set_lang
    from opalatex.ui_settings import load_ui_settings
    
    try:
        port = find_available_port(host, port)
    except Exception as e:
        print(f"Warning: could not find available port using fallback logic: {e}")

    saved_lang = load_ui_settings().get("lang", "")
    if saved_lang:
        backend_lang = "pt" if saved_lang.startswith("pt") else "en"
        set_lang(backend_lang)
    else:
        set_lang(DEFAULT_LANG)
    # Path to gui directory inside opalatex package
    package_dir = os.path.dirname(os.path.abspath(__file__))
    static_dir = os.path.join(package_dir, "gui")

    if not os.path.exists(static_dir):
        print(f"Warning: GUI static assets directory not found at {static_dir}. Server will run API-only.")
        static_dir = None

    server = AsyncHTTPServer(host=host, port=port, static_dir=static_dir)

    import opalatex.agent_stdin as agent_stdin

    def web_event_hook(payload):
        for q in server.active_queues:
            q.put_nowait(payload)

    agent_stdin.event_hook = web_event_hook
    import litellm
    litellm.event_hook = web_event_hook

    # --- Run asyncio server in a background daemon thread so the main thread
    # is free for the desktop window toolkit (GTK/pywebview requires main thread).
    import threading

    server_ready = threading.Event()

    def _run_asyncio_server():
        async def _inner():
            await server.start()
            server_ready.set()        # signal: server is accepting connections
            while True:
                await asyncio.sleep(3600)

        asyncio.run(_inner())

    t = threading.Thread(target=_run_asyncio_server, daemon=True)
    t.start()

    # Wait until the server is ready before opening the window
    server_ready.wait(timeout=10)

    url = f"http://{host}:{port}"

    try:
        import os as _os
        # Force Qt backend on all platforms (including Windows). 
        # PythonNet and WinForms are extremely fragile when packaged with PyInstaller on some Windows machines.
        if 'PYWEBVIEW_GUI' not in _os.environ:
            _os.environ['PYWEBVIEW_GUI'] = 'qt'

        import webview  # pywebview
        
        # Allow file downloads (like export markdown/pdf)
        webview.settings['ALLOW_DOWNLOADS'] = True

        # Monkey-patch pywebview's Qt backend to use proper Qt enum values
        # instead of raw ints for setFeaturePermission. Modern Qt wrappers (PyQt6/PySide6)
        # no longer accept int in place of PermissionPolicy, causing a TypeError + crash.
        try:
            from webview.platforms import qt as _wv_qt
            _QWP = _wv_qt.QWebPage

            if hasattr(_QWP, "PermissionPolicy"):
                _granted = _QWP.PermissionPolicy.PermissionGrantedByUser
                _denied = _QWP.PermissionPolicy.PermissionDeniedByUser
            else:
                _granted = 1
                _denied = 2

            def _onFeaturePermissionRequested(self, url, feature):
                if feature in (
                    _QWP.Feature.MediaAudioCapture,
                    _QWP.Feature.MediaVideoCapture,
                    _QWP.Feature.MediaAudioVideoCapture,
                ):
                    self.setFeaturePermission(url, feature, _granted)
                else:
                    self.setFeaturePermission(url, feature, _denied)

            # Patch only if the broken version (using int literals) is present
            import inspect as _inspect
            _src = _inspect.getsource(_wv_qt)
            if "setFeaturePermission(url, feature, 2)" in _src:
                if hasattr(_wv_qt, "BrowserView") and hasattr(_wv_qt.BrowserView, "WebPage"):
                    _wv_qt.BrowserView.WebPage.onFeaturePermissionRequested = _onFeaturePermissionRequested

        except Exception:
            pass

        # Suppress Qt's native context menu by patching BrowserView.__init__
        # to add a second loadFinished connection that sets NoContextMenu policy.
        try:
            from webview.platforms import qt as _wv_qt2
            from qtpy.QtCore import Qt as _Qt

            if hasattr(_wv_qt2, "BrowserView"):
                _orig_init = _wv_qt2.BrowserView.__init__

                def _patched_init(self, window):
                    # print('[patch] BrowserView.__init__ called')
                    _orig_init(self, window)
                    def _disable_context_menu(_ok=None):
                        # print('[patch] loadFinished fired, applying NoContextMenu')
                        self.webview.setContextMenuPolicy(_Qt.ContextMenuPolicy.NoContextMenu)
                    self.webview.page().loadFinished.connect(_disable_context_menu)
                    # print('[patch] loadFinished connected')
                    
                    # Handle window.print() triggered from JavaScript
                    try:
                        def _handle_print():
                            try:
                                from PyQt6.QtWidgets import QFileDialog
                                file_path, _ = QFileDialog.getSaveFileName(self.webview, "Salvar PDF", "", "PDF Files (*.pdf)")
                                if file_path:
                                    if not file_path.lower().endswith('.pdf'):
                                        file_path += '.pdf'
                                    self.webview.page().printToPdf(file_path)
                            except ImportError as e:
                                pass
                                # print('[patch] PyQt6.QtWidgets not found, cannot print:', e)
                        self.webview.page().printRequested.connect(_handle_print)
                        # print('[patch] printRequested connected')
                    except Exception as pe:
                        pass
                        # print('[patch] Failed to bind printRequested:', pe)

                _wv_qt2.BrowserView.__init__ = _patched_init
                # print('[patch] BrowserView.__init__ patched successfully')
                
                # Patch on_download_requested for PyQt6 compatibility
                _orig_on_download_requested = getattr(_wv_qt2.BrowserView, "on_download_requested", None)
                if _orig_on_download_requested:
                    def _patched_on_download_requested(self, download):
                        try:
                            from PyQt6.QtWidgets import QFileDialog
                            import os
                            old_path = download.url().path() if hasattr(download, 'url') else ""
                            if hasattr(download, 'suggestedFileName'):
                                default_name = download.suggestedFileName()
                            else:
                                default_name = os.path.basename(old_path)
                            path, _ = QFileDialog.getSaveFileName(
                                self, getattr(self, 'localization', {}).get('global.saveFile', 'Salvar Arquivo'), default_name
                            )
                            if path:
                                if hasattr(download, 'setDownloadDirectory') and hasattr(download, 'setDownloadFileName'):
                                    download.setDownloadDirectory(os.path.dirname(path))
                                    download.setDownloadFileName(os.path.basename(path))
                                elif hasattr(download, 'setPath'):
                                    download.setPath(path)
                                download.accept()
                        except Exception as e:
                            print('[patch download] FAILED:', e)
                    _wv_qt2.BrowserView.on_download_requested = _patched_on_download_requested
        except Exception as e:
            print('[patch init] FAILED:', e)

        # Ensure WebKit2GTK GObject introspection is available on Linux
        try:
            import gi
            gi.require_version("WebKit2", "4.1")
        except Exception:
            pass

        # Determine screen dimensions dynamically if possible
        os.environ["QT_LOGGING_RULES"] = "*.debug=false;qt.qpa.*=false"
        width = 1000
        height = 650
        try:
            screens = webview.screens
            if screens:
                primary = screens[0]
                width = max(800, int(primary.width * 0.80))
                height = max(600, int(primary.height * 0.75))
        except Exception:
            pass

        window = webview.create_window(
            title="OpalaTex",
            url=url,
            width=width,
            height=height,
            resizable=True,
            text_select=True,
            zoomable=True,
        )

        # print(f"[OpalaTex] Launching desktop window -> {url}")

        icon_path = os.path.join(os.path.dirname(__file__), "icon.png")
        if not os.path.exists(icon_path):
            icon_path = os.path.join(os.getcwd(), "icon.png")
        if not os.path.exists(icon_path):
            icon_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icon.png")
        if not os.path.exists(icon_path):
            icon_path = None

        import sys
        if icon_path and sys.platform == "win32" and not icon_path.lower().endswith(".ico"):
            icon_path = None

        # webview.start() blocks the main thread until the window is closed.
        storage_path = os.path.expanduser("~/.opalatex/webview")
        os.makedirs(storage_path, exist_ok=True)
        
        gui_engine = 'qt' if getattr(sys, 'frozen', False) and sys.platform == 'win32' else None
        webview.start(gui=gui_engine, debug=False, icon=icon_path, private_mode=False, storage_path=storage_path)

    except (ImportError, Exception) as e:
        import traceback
        with open("pywebview_error.log", "w", encoding="utf-8") as f:
            f.write(f"Error type: {type(e).__name__}\n")
            f.write(f"Error msg: {e}\n")
            f.write(traceback.format_exc())

        # Graceful fallback: open in the default web browser
        import webbrowser
        print(f"[OpalaTex] pywebview failed to launch ({type(e).__name__}: {e}) — opening browser at {url}")
        webbrowser.open(url)
        # Keep the server alive
        try:
            t.join()
        except KeyboardInterrupt:
            pass

    print("\nStopping OpalaTex Server...")
    try:
        server.stop()
    except Exception as e:
        print(f"Error stopping server: {e}")
    os._exit(0)
