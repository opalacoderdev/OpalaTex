import os
import sys
import subprocess
import asyncio
import threading

class TerminalSession:
    def __init__(self, project_path):
        self.project_path = project_path
        self.is_running = True
        self.queues = []
        self.loop = None
        self.process = None
        self.master_fd = None
        self.slave_fd = None

        if sys.platform == "win32":
            try:
                from winpty import PtyProcess
                # Force PowerShell on Windows
                shell = "powershell.exe"
                self.process = PtyProcess.spawn(shell, cwd=project_path)
            except ImportError:
                self.process = None
        else:
            # Unix implementation
            import pty
            import fcntl
            self.master_fd, self.slave_fd = pty.openpty()
            
            fl = fcntl.fcntl(self.master_fd, fcntl.F_GETFL)
            fcntl.fcntl(self.master_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
            
            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            self.process = subprocess.Popen(
                ["/bin/bash"],
                preexec_fn=os.setsid,
                stdin=self.slave_fd,
                stdout=self.slave_fd,
                stderr=self.slave_fd,
                cwd=project_path,
                env=env
            )
            os.close(self.slave_fd)
            self.slave_fd = None

    def start_reading(self, loop):
        self.loop = loop
        if sys.platform == "win32" and self.process is None:
            msg = "\r\n\x1b[31m[OpalaTex] Para usar o terminal no Windows, instale o pacote: pip install pywinpty\x1b[0m\r\n"
            for q in list(self.queues):
                q.put_nowait(msg.encode('utf-8'))
            return

        # Start a background daemon thread to read from PTY
        t = threading.Thread(target=self._thread_read_loop, daemon=True)
        t.start()

    def _thread_read_loop(self):
        try:
            while self.is_running:
                if sys.platform == "win32":
                    try:
                        data_str = self.process.read(4096)
                    except (ConnectionAbortedError, EOFError, OSError):
                        # WinError 10053 and similar: terminal closed normally
                        break
                    if not data_str:
                        break
                    data = data_str.encode('utf-8')
                else:
                    try:
                        import select
                        r, _, _ = select.select([self.master_fd], [], [], 0.5)
                        if not r:
                            continue
                        data = os.read(self.master_fd, 4096)
                        if not data:
                            break
                    except (BlockingIOError, InterruptedError):
                        continue
                    except Exception:
                        break

                if self.loop and self.is_running:
                    self.loop.call_soon_threadsafe(self._forward_data, data)
        except Exception as e:
            # Only log unexpected errors, not normal close-related ones
            err_str = str(e)
            if "10053" not in err_str and "ConnectionAbortedError" not in err_str:
                import traceback
                print(f"[Terminal] Read loop error: {e}\n{traceback.format_exc()}")
        finally:
            if self.loop:
                self.loop.call_soon_threadsafe(self.close)
            else:
                self.close()

    def _forward_data(self, data):
        for q in list(self.queues):
            q.put_nowait(data)

    def write(self, data):
        if not self.is_running or not self.process:
            return
        try:
            if sys.platform == "win32":
                self.process.write(data)
            else:
                if self.master_fd is not None:
                    os.write(self.master_fd, data.encode('utf-8'))
        except Exception as e:
            print(f"[Terminal] write error: {e}")

    def resize(self, cols, rows):
        if not self.is_running or not self.process:
            return
        try:
            if sys.platform == "win32":
                self.process.setwinsize(rows, cols)
            else:
                if self.master_fd is not None:
                    import termios
                    import struct
                    import fcntl
                    s = struct.pack('HHHH', rows, cols, 0, 0)
                    fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, s)
        except Exception as e:
            print(f"[Terminal] resize error: {e}")

    def close(self):
        if not self.is_running:
            return
        self.is_running = False
        
        if sys.platform == "win32":
            if self.process:
                try:
                    self.process.close()
                except:
                    pass
                self.process = None
        else:
            if self.master_fd is not None:
                try:
                    os.close(self.master_fd)
                except Exception:
                    pass
                self.master_fd = None
                
            if self.process:
                try:
                    import signal
                    pgid = os.getpgid(self.process.pid)
                    os.killpg(pgid, signal.SIGTERM)
                except Exception:
                    try:
                        self.process.terminate()
                    except:
                        pass
                try:
                    self.process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    # Força a finalização caso não responda ao SIGTERM
                    try:
                        pgid = os.getpgid(self.process.pid)
                        os.killpg(pgid, signal.SIGKILL)
                    except:
                        pass
                except Exception:
                    pass
                self.process = None
            
        for q in list(self.queues):
            try:
                q.put_nowait(None)
            except Exception:
                pass
        self.queues.clear()
