import os
import sys
import tempfile
import subprocess
import contextlib
import io
import traceback
from typing import Literal, Optional, Dict, Any

from pydantic import BaseModel, Field

from agenticblocks.core.block import Block

class PythonCodeExecutorInput(BaseModel):
    code: str = Field(..., description="The python code to execute.")

class PythonCodeExecutorOutput(BaseModel):
    stdout: str
    stderr: str
    exit_code: int
    error: Optional[str] = None
    is_valid: bool = True # Helpful for loops

class PythonCodeExecutorBlock(Block[PythonCodeExecutorInput, PythonCodeExecutorOutput]):
    name: str = "python_code_executor"
    description: str = "Executes Python code either locally or inside a Docker container."
    
    execution_mode: Literal["local", "docker"] = "local"
    docker_image: str = "python:3.10-slim"
    timeout: int = 10  # Timeout in seconds for docker/subprocess
    inject_module: Any = Field(default=None, description="A python module or a list of modules whose namespace will be injected into the local execution environment (only for 'local' execution mode).")

    model_config = {"arbitrary_types_allowed": True}
    
    async def run(self, input: PythonCodeExecutorInput) -> PythonCodeExecutorOutput:
        code = self._extract_code(input.code)
        
        if self.execution_mode == "local":
            return self._run_local(code)
        elif self.execution_mode == "docker":
            return self._run_docker(code)
        else:
            return PythonCodeExecutorOutput(
                stdout="",
                stderr="",
                exit_code=-1,
                error=f"Unsupported execution mode: {self.execution_mode}",
                is_valid=False
            )
            
    def _extract_code(self, text: str) -> str:
        """Extract code from markdown block if present."""
        text = text.strip()
        if "```python" in text:
            start = text.find("```python") + 9
            end = text.find("```", start)
            if end != -1:
                return text[start:end].strip()
        elif "```" in text:
            start = text.find("```") + 3
            end = text.find("```", start)
            if end != -1:
                return text[start:end].strip()
        return text

    def _run_local(self, code: str) -> PythonCodeExecutorOutput:
        """Runs the code locally using exec(). Note: This is insecure."""
        stdout_io = io.StringIO()
        stderr_io = io.StringIO()
        
        # We inject a clean environment
        global_env = {}
        
        if self.inject_module is not None:
            modules_to_inject = self.inject_module if isinstance(self.inject_module, (list, tuple)) else [self.inject_module]
            for mod in modules_to_inject:
                if hasattr(mod, '__name__'):
                    global_env[mod.__name__] = mod

        exit_code = 0
        error_msg = None
        
        with contextlib.redirect_stdout(stdout_io), contextlib.redirect_stderr(stderr_io):
            try:
                exec(code, global_env)
            except Exception as e:
                exit_code = 1
                error_msg = traceback.format_exc()
                # Print traceback to stderr so it's captured
                print(error_msg, file=sys.stderr)
                
        stdout_str = stdout_io.getvalue()
        stderr_str = stderr_io.getvalue()
        
        return PythonCodeExecutorOutput(
            stdout=stdout_str,
            stderr=stderr_str,
            exit_code=exit_code,
            error=error_msg,
            is_valid=(exit_code == 0)
        )

    def _run_docker(self, code: str) -> PythonCodeExecutorOutput:
        """Runs the code inside a docker container using subprocess."""
        with tempfile.TemporaryDirectory() as temp_dir:
            script_path = os.path.join(temp_dir, "script.py")
            with open(script_path, "w") as f:
                f.write(code)
                
            cmd = [
                "docker", "run", "--rm",
                "-v", f"{temp_dir}:/workspace",
                "-w", "/workspace",
                self.docker_image,
                "python", "script.py"
            ]
            
            try:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=self.timeout
                )
                return PythonCodeExecutorOutput(
                    stdout=result.stdout,
                    stderr=result.stderr,
                    exit_code=result.returncode,
                    error=None if result.returncode == 0 else "Execution failed",
                    is_valid=(result.returncode == 0)
                )
            except subprocess.TimeoutExpired:
                return PythonCodeExecutorOutput(
                    stdout="",
                    stderr="Execution timed out.",
                    exit_code=124,
                    error="TimeoutExpired",
                    is_valid=False
                )
            except Exception as e:
                return PythonCodeExecutorOutput(
                    stdout="",
                    stderr=str(e),
                    exit_code=-1,
                    error=str(e),
                    is_valid=False
                )
