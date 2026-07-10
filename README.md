# OpalaTex

**OpalaTex** is your integrated local Artificial Intelligence assistant and LaTeX editor. It is designed to accelerate academic writing and document typesetting workflows.

It provides a complete environment that combines a split-pane layout (Code Editor + PDF Preview) with an **Artificial Intelligence Assistant** that deeply understands LaTeX, helps you write complex equations, generates tables, and explains compilation errors instantly.

Compilation is powered by **Tectonic**, providing fast local builds without the hassle of manually managing `.sty` packages.

---

## Features

🤖 **Your Personal AI Assistant**

OpalaTex is more than a LaTeX editor; it is a complete assistant that understands your entire document. It helps you format complex tables, write TikZ figures, and automatically fix syntax and logic errors.

🧠 **Local PDF Compilation (Tectonic)**

Powered by Tectonic, OpalaTex compiles your documents locally without requiring you to download style files or manage dependencies manually. You can install Tectonic directly from the application settings (`Settings > Preferences`).

🛠️ **Dynamic LaTeX Mode**

Write your source code on one side and automatically preview the resulting PDF on the other.

☁️ **Local and Cloud AI Models**

Connect to leading commercial models through their APIs, or securely run open-source models entirely offline with Ollama.

---

## Getting Started

### Development Installation

```bash
git clone https://github.com/opalacoderdev/OpalaTex
cd OpalaTex
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/macOS: source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### Running OpalaTex

Start the application:

```bash
python main.py
```

*Optional: Tectonic can be installed through a script or from the application's settings menu.*

---

## Deployment and Builds

After making changes to the project, follow the steps below to build and update its components.

### 1. Build the Interface (Website/GUI)

If you changed any file inside the `gui_src` directory (React/Vite), regenerate the static bundle so the Python backend can serve it and the WebView can display it:

```bash
npm run build --prefix .\gui_src\
```

*This command generates minified files in `opalatex/gui`, which are loaded by the backend.*

### 2. Build the Desktop Executable (.exe)

To generate the final Windows executable version of OpalaTex, which packages the backend and WebView browser, run:

```powershell
.\build_exe.ps1
```

After the script finishes, the compiled executable will be available at `.\dist\OpalaTex\OpalaTex.exe`.

### 3. Deploy the Installer to Users (VPS)

To compress the final Windows build and upload it to your VPS so the installation command (`irm https://opalacoder.com/install.ps1 | iex`) downloads the new version, run:

```powershell
.\binpacking.ps1
```

*The script creates a `.zip` archive of the `dist` directory and uploads it to the VPS through SCP/SSH, updating the public download link.*

### 4. Deploy the Cloud API (Optional)

If your changes affect the cloud version (OpalaTexCloud API) hosted on the VPS:

1. Commit the generated changes and run `git push`.
2. On the server, run `git pull` and restart the service (`systemctl restart opalatex` or equivalent).
