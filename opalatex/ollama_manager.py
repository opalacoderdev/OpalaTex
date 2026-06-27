import subprocess
import json
import urllib.request
import platform
import re

def check_ollama_status():
    """Check if Ollama is installed and running, and get its version."""
    installed = False
    running = False
    version = None
    is_supported = False

    # Check via CLI
    try:
        result = subprocess.run(["ollama", "--version"], capture_output=True, text=True, check=True)
        # Usually outputs: "ollama version is 0.3.14" or "ollama version 0.3.14"
        installed = True
        output = result.stdout.strip()
        parts = output.split()
        for p in parts:
            if p[0].isdigit():
                version = p
                break
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass

    # Check if running (port 11434) and fetch exact version
    try:
        req = urllib.request.Request("http://127.0.0.1:11434/api/version", method="GET")
        with urllib.request.urlopen(req, timeout=1.0) as response:
            if response.status == 200:
                running = True
                installed = True
                data = json.loads(response.read().decode())
                if data and "version" in data:
                    version = data["version"]
    except Exception:
        pass

    # Parse version to check if >= 0.3.5
    if version:
        try:
            match = re.search(r'(\d+)\.(\d+)\.(\d+)', version)
            if match:
                major, minor, patch = map(int, match.groups())
                if major > 0:
                    is_supported = True
                elif major == 0 and minor > 30:
                    is_supported = True
                elif major == 0 and minor == 30 and patch >= 5:
                    is_supported = True
        except Exception:
            pass

    return {
        "installed": installed,
        "running": running,
        "version": version,
        "is_supported": is_supported
    }

def install_ollama_windows():
    """Triggers the Ollama installation script for Windows."""
    if platform.system() != "Windows":
        return {"success": False, "error": "Not running on Windows."}
    
    try:
        cmd = 'irm https://ollama.com/install.ps1 | iex'
        subprocess.Popen(["powershell", "-Command", cmd], creationflags=subprocess.CREATE_NEW_CONSOLE)
        return {"success": True, "message": "Installation started in a new PowerShell window."}
    except Exception as e:
        return {"success": False, "error": str(e)}
